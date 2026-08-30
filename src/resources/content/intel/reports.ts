/** Intel reports: generated digests over closed time windows. */

import { Resource } from "../../../http";
import { listQuery, paginate } from "../../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../../listing";
import type { Id, Json, Paginated, RequestOptions, Timestamp } from "../../../types";
import type { IntelArticleCategory, IntelReportKind } from "./types";

/** A story as a report inlines it. Four keys, no summary and no body. */
export interface IntelReportArticleRef {
  readonly id: Id;
  readonly title: string | null;
  readonly importance: number;
  readonly category: IntelArticleCategory | null;
}

/**
 * A generated report over one closed time window.
 *
 * The index shape. `GET /intel_reports/:id` adds three keys - see
 * {@link IntelReportDetail}.
 *
 * There is at most ONE report per `(user, kind, period_end)`: the migration
 * puts a unique index on that triple precisely so a re-run of
 * `GenerateReportJob` cannot mint a duplicate. Windows are the last CLOSED
 * period, computed by `IntelReport.last_window`, so a `"day"` report covers
 * yesterday and never the day in progress.
 */
export interface IntelReport {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Which window: see {@link INTEL_REPORT_KINDS}. */
  readonly kind: IntelReportKind;
  /** Title the model wrote. Nullable. */
  readonly title: string | null;
  /** Start of the window, inclusive. */
  readonly period_start: Timestamp;
  /** End of the window, exclusive. Also the sort key of the listing. */
  readonly period_end: Timestamp;
  /** LLM that wrote it, as configured at generation time. Nullable. */
  readonly model: string | null;
}

/** `GET /intel_reports/:id` - the `:extended` view. */
export interface IntelReportDetail extends IntelReport {
  /** The report body, usually Markdown. `null` if generation failed halfway. */
  readonly content: string | null;
  /**
   * Whatever the generator chose to record about the run. A free-form JSON
   * object with no schema on either side, defaulting to `{}` - which is why it
   * is typed as a bag rather than as fields. Read it defensively.
   */
  readonly stats: Record<string, Json> | null;
  /** The stories the report covered, most important first. */
  readonly articles: IntelReportArticleRef[];
}

/** Filter columns of `GET /intel_reports`, on top of {@link BASE_FILTER_COLUMNS}. */
export const INTEL_REPORT_FILTER_COLUMNS = Object.freeze(["kind"] as const);

/** Filters for {@link IntelReportsNamespace.list}. */
export interface ListIntelReportsParams extends ListParams<(typeof INTEL_REPORT_FILTER_COLUMNS)[number]> {
  /**
   * Narrow to one window, e.g. `"day"`. Sent as `exact_search[kind]`, so it is
   * equality rather than a prefix match - `"6h"` will not also match `"6hx"`.
   *
   * Passing it through {@link ListParams.search} instead would be a
   * partial match and would work too; `kind` is on this controller's
   * `search_params` allowlist. Equality is what you want.
   */
  readonly kind?: IntelReportKind;
}

/**
 * `GET /intel_reports` - the generated digests.
 *
 * Read-only plus a delete, for the same reason as the stories: reports come
 * from `Intel::GenerateReportJob`. There is no way to ask for one to be
 * generated over HTTP.
 */
export class IntelReportsNamespace extends Resource {
  /**
   * `GET /intel_reports` - your reports, newest window first.
   *
   * `period_end DESC` is applied by the controller; as with the stories, a
   * `order` of your own becomes the PRIMARY key and this becomes the
   * tie-breaker.
   *
   * `kind` is the only declared filter beyond the inherited three. Use
   * {@link ListIntelReportsParams.kind}, which sends it as an exact match.
   *
   * @throws {OmsApiError} 403 `"Intel access is restricted."` outside the
   *   allowlist.
   */
  async list(params: ListIntelReportsParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelReport>> {
    const base = { exactSearch: { kind: params.kind } };
    return paginate(params, 50, (at) =>
      this.http.get<IntelReport[]>("/intel_reports", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /intel_reports/:id` - the report with its body and its stories.
   *
   * @throws {OmsApiError} 404 when the report is not yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelReportDetail> {
    return this.http.get<IntelReportDetail>(`/intel_reports/${encodeURIComponent(id)}`, options);
  }

  /**
   * `DELETE /intel_reports/:id`. `204`, empty body.
   *
   * The stories it cited are untouched - only the join rows go.
   *
   * A deleted report can come back: `GenerateReportJob` is keyed by the unique
   * `(user, kind, period_end)` index, and deleting the row frees that key, so
   * the next dispatcher pass over the same window will regenerate it. Delete a
   * report to re-run it, not to suppress it.
   *
   * @throws {OmsApiError} 404 when the report is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_reports/${encodeURIComponent(id)}`, options);
  }
}
