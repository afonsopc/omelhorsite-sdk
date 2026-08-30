/** Intel stats: the dashboard counters. */

import { Resource } from "../../../http";
import type { RequestOptions } from "../../../types";

/** One category bucket of {@link IntelStats}. */
export interface IntelCategoryCount {
  readonly category: string;
  /** Named `c`, not `count`. */
  readonly c: number;
}

/** One day of the {@link IntelStats} histogram. */
export interface IntelDayCount {
  /** `YYYY-MM-DD`, from Postgres `DATE(last_seen_at)`. Not a full timestamp. */
  readonly day: string;
  readonly c: number;
}

/**
 * The importance histogram, with the backend's own Portuguese bucket names.
 *
 * The boundaries are hard-coded server-side and are not
 * configurable: `critico` >=9, `alta` 7-8, `media` 5-6, `baixa` 3-4, `ruido`
 * <3. Note they are NOT the same thresholds as
 * {@link IntelConfig.report_min_importance} or
 * {@link IntelConfig.enrich_min_importance} - those are yours, these are the
 * dashboard's.
 */
export interface IntelImportanceBuckets {
  readonly critico: number;
  readonly alta: number;
  readonly media: number;
  readonly baixa: number;
  readonly ruido: number;
}

/** Row counts on the {@link IntelStats} answer. */
export interface IntelStatsTotals {
  /** Stories you own. */
  readonly articles: number;
  /**
   * **Not the number of feeds you have configured.** This counts the
   * story-to-item POINTER rows, so this is "how many citations exist across
   * all my stories" and it grows without bound as
   * stories accumulate. If you want the number of configured sources, read the
   * length of {@link IntelSourcesNamespace.list}. The name is the backend's and
   * the SDK does not rename it, but do not put it under a "Sources" label.
   */
  readonly sources: number;
  readonly reports: number;
  /** Raw items you own, processed or not. */
  readonly items: number;
  /**
   * Items the analysis pipeline has not consumed yet (`processed_at IS NULL`).
   *
   * The one number worth watching: a figure that climbs and never falls means
   * the pipeline is not running - most often because `Intel::LlmClient` is
   * disabled for want of an API key, in which case `AnalysisDispatcherJob`
   * returns immediately and silently.
   */
  readonly pending_items: number;
}

/**
 * `GET /intel_stats` - counters for the intel dashboard.
 *
 * Not a record: it has no `id`, no timestamps and no `:extended` view.
 */
export interface IntelStats {
  readonly totals: IntelStatsTotals;
  /**
   * Categories by story count, descending. Stories with a `null` category are
   * EXCLUDED, so these do not sum to `totals.articles`.
   */
  readonly by_category: IntelCategoryCount[];
  /**
   * The last 30 days by `last_seen_at`, ascending.
   *
   * Sparse: a day with no activity is simply ABSENT, not present with zero.
   * Fill the gaps before plotting or the line will lie about its own x-axis.
   */
  readonly by_day: IntelDayCount[];
  readonly by_importance: IntelImportanceBuckets;
  /** Stories touched in the last 24 hours. */
  readonly last24h: number;
}

/** `/intel_stats` - the dashboard counters. One route, one verb. */
export class IntelStatsNamespace extends Resource {
  /**
   * `GET /intel_stats` - every counter the intel dashboard shows, in one call.
   *
   * Also a Rails singular resource, so the path is `/intel_stats` with no id
   * despite the plural spelling.
   *
   * **Cost, and the reason not to poll this.** The controller does
   * `articles.pluck(:importance)` - it loads the importance of EVERY story you
   * own into Ruby memory to build {@link IntelStats.by_importance} - and then
   * runs five more aggregate queries beside it. There is no cache, no `ETag`
   * (the hand-written action never calls `stale?`, unlike every list in this
   * file) and therefore no `304`. Cost grows linearly with your story count for
   * ever. Fetch it on a dashboard open, not on a timer.
   *
   * Read {@link IntelStatsTotals.sources} before you label it: it does not
   * count your feeds.
   *
   * @throws {OmsApiError} 403 `"Intel access is restricted."` outside the
   *   allowlist.
   */
  async get(options: RequestOptions = {}): Promise<IntelStats> {
    return this.http.get<IntelStats>("/intel_stats", options);
  }
}
