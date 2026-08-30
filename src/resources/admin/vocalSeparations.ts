/** `oms.admin.vocalSeparations` - every separation run on the server. Administrators only. */

import type { VocalSeparation } from "../tools/vocalSeparation";
import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { ListParams } from "../../listing";
import type { Id, Paginated, RequestOptions } from "../../types";

/**
 * A separation run as the admin surface renders it.
 *
 * The same shape the tool namespace reads, so the type is the same:
 * every key of {@link VocalSeparation}, `user_id` and `ip_address` included.
 * What changes is the SCOPE - an administrator sees every run on the server
 * rather than their own.
 */
export type AdminVocalSeparation = VocalSeparation;

/** Filter columns of `GET /admin/vocal_separations`. */
export const ADMIN_VOCAL_SEPARATION_FILTER_COLUMNS = Object.freeze([
  "id",
  "status",
  "model_id",
  "created_at",
  "finished_at",
  "user_id",
  "song_id",
] as const);

/** Filters for {@link AdminVocalSeparationsNamespace.list}. */
export interface ListAdminVocalSeparationsParams
  extends ListParams<(typeof ADMIN_VOCAL_SEPARATION_FILTER_COLUMNS)[number]> {
  /** Exact status. An array becomes an `IN`. */
  readonly status?: string | readonly string[];
  /** Exact model id. An array becomes an `IN`. */
  readonly modelId?: string | readonly string[];
  /**
   * `"song"` for runs started from the music library, `"tool"` for uploads.
   *
   * A top-level parameter, not a search bucket: the server turns it into a
   * `song_id IS NOT NULL` test. Omitting it means both.
   */
  readonly source?: "song" | "tool";
  /** `exact_search[user_id]`. */
  readonly userId?: Id;
  /** `modifiers[order]`. Defaults to `"created_at:desc"`. */
  readonly order?: string;
}

/**
 * `oms.admin.vocalSeparations` - **administrators only**. Every separation run
 * on the server.
 *
 * The unprivileged half is `oms.tools.vocalSeparation`, which is scoped to the
 * caller's own runs and the songs they own.
 */
export class AdminVocalSeparationsNamespace extends Resource {
  /**
   * `GET /admin/vocal_separations` - every run, newest first.
   *
   * A bare JSON array through the generic list DSL, with ETag and `304`.
   *
   * **This listing is not cheap and the cost is not in the database.** The
   * server computes `progress_percent` by calling the separator sidecar,
   * synchronously, ONCE PER ROW THAT IS `"processing"`. A page with twenty live
   * runs is twenty sidecar round trips inside one request, and if the sidecar
   * is slow or down the whole listing is slow with it. Filter to terminal
   * statuses when you only want history, and keep the page size modest when you
   * are polling a dashboard.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(
    params: ListAdminVocalSeparationsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<AdminVocalSeparation>> {
    const base = {
      order: "created_at:desc",
      exactSearch: { status: params.status, model_id: params.modelId, user_id: params.userId },
      top: params.source === undefined ? {} : { source: params.source },
    };
    return paginate(params, 100, (at) =>
      this.http.get<AdminVocalSeparation[] | undefined>("/admin/vocal_separations", {
        ...options,
        query: listQuery(params, at, base),
      }),
    );
  }

  /**
   * `GET /admin/vocal_separations/:id` - one run, anybody's.
   *
   * @throws {OmsApiError} 404 `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<AdminVocalSeparation> {
    return this.http.get<AdminVocalSeparation>(
      `/admin/vocal_separations/${encodeURIComponent(id)}`,
      options,
    );
  }

  /**
   * `POST /admin/vocal_separations/:id/cancel` - stops a run.
   *
   * **The row lands on `"failed"`, not on a cancelled status, and there is no
   * cancelled status for a separation.** The `error` field is set to
   * `"Canceled by admin"` and that string is the only way to tell an
   * administrative stop from a genuine failure. Anything counting failures will
   * count this, so match on the message if that matters.
   *
   * A run attached to a song also clears that song's
   * `vocal_separation_started_at`, which is what lets the owner start a new
   * separation instead of being told one is already running.
   *
   * Like every cancel in this API, it marks the row rather than reaching into
   * the worker.
   *
   * @throws {OmsApiError} 400 `"Already terminal"`; 404 `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async cancel(id: Id, options: RequestOptions = {}): Promise<AdminVocalSeparation> {
    return this.http.post<AdminVocalSeparation>(
      `/admin/vocal_separations/${encodeURIComponent(id)}/cancel`,
      undefined,
      options,
    );
  }

  /**
   * `DELETE /admin/vocal_separations/:id` - deletes a run. Answers `204`, empty.
   *
   * The stems go with it: the attached audio is destroyed with the row, and a
   * complete run's download URLs stop working immediately. Deleting a run that
   * is still processing does not stop the worker, it removes the row the worker
   * is going to write to.
   *
   * @throws {OmsApiError} 404 `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async destroy(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/admin/vocal_separations/${encodeURIComponent(id)}`, options);
  }
}
