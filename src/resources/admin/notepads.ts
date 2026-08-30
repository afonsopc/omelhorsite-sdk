/** `oms.admin.notepads` - aggregate notepad statistics. Administrators only. */

import { Resource } from "../../http";
import type { RequestOptions } from "../../types";
import type { AdminDailyCount } from "./types";

/** Content length distribution, in characters. */
export interface AdminNotepadContentSize {
  /** Rounded to a whole number. `0` when there are no pads. */
  readonly avg: number;
  /** Median. Nearest-rank, not interpolated. */
  readonly p50: number;
  readonly p95: number;
}

/** What {@link AdminNotepadsNamespace.stats} answers with. Counts only, never content. */
export interface AdminNotepadStats {
  readonly total: number;
  /** Pads whose content starts with the client-side encryption marker. */
  readonly encrypted_count: number;
  /** Already a percentage, `0` to `100`, one decimal. */
  readonly encrypted_percent: number;
  /** Pads longer than 256 characters, i.e. probably not a stray keystroke. */
  readonly meaningful_count: number;
  readonly meaningful_percent: number;
  readonly created_last_24h: number;
  readonly created_last_7d: number;
  readonly created_last_30d: number;
  readonly content_size: AdminNotepadContentSize;
  /** Clicks on every `n/` short link, i.e. how often pads were opened through their link. */
  readonly short_link_clicks_total: number;
  readonly creations_daily: AdminDailyCount[];
}

/**
 * `oms.admin.notepads` - **administrators only**. Aggregate notepad statistics.
 *
 * `stats` is the ONLY route, for the same reason as
 * {@link AdminChestsNamespace}: a pad's slug IS its authorisation, so there is
 * no admin listing that would hand out slugs, and no content crosses the wire
 * here. Only lengths are measured.
 */
export class AdminNotepadsNamespace extends Resource {
  /**
   * `GET /admin/notepads/stats`.
   *
   * The length distribution is computed over every pad, so this request grows
   * linearly with the number of pads. It is a dashboard call, not a poll.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async stats(options: RequestOptions = {}): Promise<AdminNotepadStats> {
    return this.http.get<AdminNotepadStats>("/admin/notepads/stats", options);
  }
}
