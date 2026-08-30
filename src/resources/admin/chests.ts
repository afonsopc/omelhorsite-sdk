/** `oms.admin.chests` - aggregate chest statistics. Administrators only. */

import { Resource } from "../../http";
import type { RequestOptions } from "../../types";
import type { AdminDailyCount } from "./types";

/** What {@link AdminChestsNamespace.stats} answers with. Counts only, never a chest. */
export interface AdminChestStats {
  /** Chests that have not expired. */
  readonly active_count: number;
  /** Creation is refused server-wide once `active_count` reaches it. */
  readonly active_limit: number;
  /** Entries in active chests, split by kind. */
  readonly entries_file: number;
  readonly entries_note: number;
  /** Sum of `current_size` across active chests. */
  readonly active_size_bytes: number;
  readonly created_last_1h: number;
  readonly created_last_24h: number;
  readonly created_last_7d: number;
  /** Rounded to two decimals; `0` when there are no active chests. */
  readonly avg_entries_per_chest: number;
  /** Rounded to whole bytes; `0` when there are no active chests. */
  readonly avg_chest_size_bytes: number;
  /** Active chests with an owner, and without one. */
  readonly active_auth_count: number;
  readonly active_anon_count: number;
  /** Active chests expiring within the next 15 minutes. */
  readonly expiring_soon: number;
  /**
   * Creations per day. Counted over ALL chests, expired ones included, unlike
   * every other number here.
   */
  readonly creations_daily: AdminDailyCount[];
}

/**
 * `oms.admin.chests` - **administrators only**. Aggregate chest statistics.
 *
 * `stats` is the ONLY route: there is no admin listing of chests and no way to
 * read one from here. A chest is opened by knowing its code, and the admin
 * surface deliberately does not become a second way in.
 */
export class AdminChestsNamespace extends Resource {
  /**
   * `GET /admin/chests/stats`.
   *
   * Several full-table aggregates in one request. Cheap enough for a dashboard,
   * not cheap enough for a tight poll.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async stats(options: RequestOptions = {}): Promise<AdminChestStats> {
    return this.http.get<AdminChestStats>("/admin/chests/stats", options);
  }
}
