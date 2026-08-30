/** Admin storage reports. */

import { Resource } from "../../http";
import type { RequestOptions } from "../../types";
import type { FsNode } from "../storage";

/** One day in a daily-count series. */
export interface AnalysisDailyPoint {
  /** `YYYY-MM-DD`, server timezone. */
  readonly date: string;
  /** Rows created that day. `0` for a day with none - the series has no gaps. */
  readonly count: number;
}

/** Days covered by {@link AnalysisNamespace.filesDaily}. Mirrors `DAILY_WINDOW_DAYS`. */
export const ANALYSIS_DAILY_WINDOW_DAYS = 30;

/**
 * The `analysis` namespace: two admin reports about storage.
 *
 * **Admin only, and the refusal is unusual.** `require_admin!` answers `403`
 * whose body is a long quotation from Monster House rather than an error code,
 * so do not try to match on the message - check the status. An anonymous
 * caller is stopped earlier, by the authentication filter, with the ordinary
 * `401 "Session required to access this resource."`.
 *
 * Paths like `GET /analysis` and `GET /analysis/:id` exist in the router with
 * no action behind them: calling one is a `404` carrying an HTML error page
 * rather than this API's usual bare string. There are exactly two usable
 * routes here and they are both below.
 */
export class AnalysisNamespace extends Resource {
  /**
   * `GET /analysis/storages` - every root directory in the system, with its
   * recursive size.
   *
   * Every node with no parent, for every user, which in practice means each
   * account's home, trash and vault roots. Rendered in the DEFAULT view, which
   * is what {@link FsNode} describes.
   *
   * Two things to expect:
   *
   * - **No owner.** The payload does not carry `user_id`, so it tells you
   *   that a root called `"home"` holds 40 GB and not whose it is.
   *   Correlating means another query.
   * - **No limit and no paging.** The scope is unbounded, so the response
   *   grows linearly with the number of accounts. It is an admin report, not
   *   something to poll.
   *
   * The `size` on a root is the recursive total maintained by the storage
   * layer; it has drifted from the true sum before, so read it as an estimate.
   */
  async storages(options: RequestOptions = {}): Promise<FsNode[]> {
    return this.http.get<FsNode[]>("/analysis/storages", options);
  }

  /**
   * `GET /analysis/files_daily` - files created per day over the last
   * {@link ANALYSIS_DAILY_WINDOW_DAYS} days. Unwraps `{"creations_daily": [...]}`.
   *
   * Exactly 30 entries, oldest first, zero-filled: a day with no uploads is
   * present with `count: 0`. The last entry is today and is partial.
   *
   * Counts `fs_nodes` of kind `file` by `DATE(created_at)`, so it measures
   * node creation and not bytes - a folder copy that mints 50 000 nodes shows
   * up here as 50 000 files.
   */
  async filesDaily(options: RequestOptions = {}): Promise<AnalysisDailyPoint[]> {
    const body = await this.http.get<{ creations_daily: AnalysisDailyPoint[] }>("/analysis/files_daily", options);
    return body.creations_daily;
  }
}
