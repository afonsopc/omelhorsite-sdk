/** The `intel` namespace and everything under it. */

import { type ApiClient, Resource } from "../../../http";
import { IntelArticlesNamespace } from "./articles";
import { IntelConfigNamespace } from "./config";
import { IntelReportsNamespace } from "./reports";
import { IntelStatsNamespace } from "./stats";

export * from "./articles";
export * from "./config";
export * from "./reports";
export * from "./stats";
export * from "./types";

/**
 * The `intel` namespace, reachable as `oms.content.intel`: the analysis
 * built on top of `oms.content.news`.
 *
 * 1. the analysis pipeline groups {@link NewsItem}s into {@link IntelArticle}
 *    stories, scores them against your {@link IntelConfig} rubric, enriches
 *    the important ones and links related ones together;
 * 2. {@link IntelReport} digests summarise a closed time window of stories.
 *
 * Everything here is produced by background jobs and is read-only over HTTP
 * - a delete is the only mutation you get, and it is a hide, not an undo. The
 * sources, scripts and items that feed it live under `oms.content.news`.
 */
export class IntelNamespace extends Resource {
  /** Stories: the analysed, grouped, scored output. Read plus delete. */
  readonly articles: IntelArticlesNamespace;
  /** Generated digests over closed time windows. Read plus delete. */
  readonly reports: IntelReportsNamespace;
  /** Your rubric, thresholds and prompt overrides. */
  readonly config: IntelConfigNamespace;
  /** Dashboard counters, in one expensive call. */
  readonly stats: IntelStatsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.articles = new IntelArticlesNamespace(http);
    this.reports = new IntelReportsNamespace(http);
    this.config = new IntelConfigNamespace(http);
    this.stats = new IntelStatsNamespace(http);
  }
}
