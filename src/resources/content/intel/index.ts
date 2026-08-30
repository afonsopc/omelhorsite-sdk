/** The `intel` namespace and everything under it. */

import { type ApiClient, Resource } from "../../../http";
import { IntelArticlesNamespace } from "./articles";
import { IntelConfigNamespace } from "./config";
import { IntelItemsNamespace } from "./items";
import { IntelReportsNamespace } from "./reports";
import { IntelScriptsNamespace } from "./scripts";
import { IntelSourcesNamespace } from "./sources";
import { IntelStatsNamespace } from "./stats";

export * from "./articles";
export * from "./config";
export * from "./items";
export * from "./reports";
export * from "./scripts";
export * from "./sources";
export * from "./stats";
export * from "./types";

/**
 * The `intel` namespace, reachable as `oms.content.intel`.
 *
 * A tour of the data model, because the names do not give it away:
 *
 * 1. a {@link IntelScript} knows HOW to fetch one kind of feed;
 * 2. an {@link IntelSource} is that script plus its settings - a feed you
 *    actually follow;
 * 3. polling a source writes {@link IntelItem} rows: raw, unprocessed, one per
 *    thing the feed published;
 * 4. the analysis pipeline groups items into {@link IntelArticle} stories,
 *    scores them against your {@link IntelConfig} rubric, enriches the
 *    important ones and links related ones together;
 * 5. {@link IntelReport} digests summarise a closed time window of stories.
 *
 * Only steps 1 and 2 are yours to write. Everything from step 3 on is produced
 * by background jobs and is read-only over HTTP - a delete is the only mutation
 * you get, and it is a hide, not an undo.
 */
export class IntelNamespace extends Resource {
  /** Stories: the analysed, grouped, scored output. Read plus delete. */
  readonly articles: IntelArticlesNamespace;
  /** Generated digests over closed time windows. Read plus delete. */
  readonly reports: IntelReportsNamespace;
  /** The feeds you follow. Full CRUD, plus a manual run. */
  readonly sources: IntelSourcesNamespace;
  /** The fetchers. Full CRUD over yours; the built-ins are read-only. */
  readonly scripts: IntelScriptsNamespace;
  /** The raw material behind the stories. Read plus delete. */
  readonly items: IntelItemsNamespace;
  /** Your rubric, thresholds and prompt overrides. */
  readonly config: IntelConfigNamespace;
  /** Dashboard counters, in one expensive call. */
  readonly stats: IntelStatsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.articles = new IntelArticlesNamespace(http);
    this.reports = new IntelReportsNamespace(http);
    this.sources = new IntelSourcesNamespace(http);
    this.scripts = new IntelScriptsNamespace(http);
    this.items = new IntelItemsNamespace(http);
    this.config = new IntelConfigNamespace(http);
    this.stats = new IntelStatsNamespace(http);
  }
}
