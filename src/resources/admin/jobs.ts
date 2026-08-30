/** `oms.admin.jobs` - every background job on the server. Administrators only. */

import type { Job } from "../jobs";
import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { ListParams } from "../../listing";
import type { Id, Paginated, RequestOptions } from "../../types";

/**
 * A job row, as `/admin/jobs` renders it.
 *
 * Identical to the {@link Job} an ordinary caller reads through `oms.jobs`: the
 * only difference is the SCOPE, since an administrator sees every row and
 * everybody else only their own.
 */
export type AdminJob = Job;

/** Filter columns of `GET /admin/jobs`. */
export const ADMIN_JOB_FILTER_COLUMNS = Object.freeze([
  "id",
  "job_type",
  "status",
  "created_at",
  "updated_at",
  "finished_at",
] as const);

/** Filters for {@link AdminJobsNamespace.list}. */
export interface ListAdminJobsParams extends ListParams<(typeof ADMIN_JOB_FILTER_COLUMNS)[number]> {
  /** Exact status. An array becomes an `IN`. */
  readonly status?: string | readonly string[];
  /** Exact job type. An array becomes an `IN`. */
  readonly jobType?: string | readonly string[];
  /** Defaults to `"created_at:desc"`. */
  readonly order?: string | null;
}

/** What {@link AdminJobsNamespace.cleanupStuck} answers with. */
export interface AdminStuckJobCleanup {
  /** Ids of the jobs that were canceled. String ids: `jobs` is one of the string-keyed tables. */
  readonly canceled_job_ids: Id[];
  /** `canceled_job_ids.length`. `0` when there was nothing stuck. */
  readonly count: number;
}

/**
 * `oms.admin.jobs` - **administrators only**. Every background job on the
 * server.
 *
 * The unprivileged half of this is `oms.jobs`, which is the same endpoints
 * narrowed to the caller's own jobs. What an administrator gains is the scope,
 * plus {@link cancel} and {@link cleanupStuck}.
 */
export class AdminJobsNamespace extends Resource {
  /**
   * `GET /admin/jobs` - every job, newest first.
   *
   * A bare JSON array through the generic list DSL: it paginates (a default
   * page size is forced even when you do not ask, so this can never enumerate
   * the whole table) and it answers ETag and `304`.
   *
   * **The filters have to go inside the filter buckets, and the failure mode if
   * they do not is silent.** `status` and `job_type` are declared as search
   * columns, which means `exact_search[status]`; a plain top-level
   * `?status=pending` is read by nothing and you get the unfiltered first page
   * back, with no error to tell you the narrowing was dropped. This method
   * builds the buckets for you.
   *
   * Unknown filter keys inside a bucket DO fail, with a `400`, on purpose: a
   * dropped filter is a wider result nobody notices.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(
    params: ListAdminJobsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<AdminJob>> {
    const base = { order: "created_at:desc", exactSearch: { status: params.status, job_type: params.jobType } };
    return paginate(params, 100, (at) =>
      this.http.get<AdminJob[] | undefined>("/admin/jobs", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `POST /admin/jobs/:id/cancel` - stops a job.
   *
   * The row lands on `status: "canceled"` with `error: "Canceled by admin"` and
   * a `finished_at`, and the change is broadcast over the job channel, so
   * anything watching that job sees it immediately.
   *
   * **This marks the row, it does not reach into the worker.** A job that is
   * already executing keeps executing until it next looks at its own status;
   * cancelling is a request, not a kill signal.
   *
   * @throws {OmsApiError} 400 `"Already terminal"` for a job that is complete,
   *   failed or already canceled. Idempotency has to be your side: check
   *   `isJobTerminal(job.status)` first rather than swallowing the 400. 404
   *   `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async cancel(id: Id, options: RequestOptions = {}): Promise<AdminJob> {
    return this.http.post<AdminJob>(
      `/admin/jobs/${encodeURIComponent(id)}/cancel`,
      undefined,
      options,
    );
  }

  /**
   * `POST /admin/jobs/cleanup_stuck` - cancels every job the server considers
   * stuck.
   *
   * A sweep with NO arguments and no dry run: it decides what is stuck and acts
   * on all of it in one request. There is no preview and no undo. Read
   * {@link list} filtered to `"processing"` first if you want to know what you
   * are about to hit.
   *
   * Answers `{ canceled_job_ids, count }`. `count: 0` is the normal, healthy
   * answer and is not an error.
   *
   * Retries are disabled: the sweep is not free, and a replay after a lost
   * response reports a second, smaller set as if it were the whole answer.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async cleanupStuck(options: RequestOptions = {}): Promise<AdminStuckJobCleanup> {
    return this.http.post<AdminStuckJobCleanup>(
      "/admin/jobs/cleanup_stuck",
      undefined,
      { retry: false, ...options },
    );
  }
}
