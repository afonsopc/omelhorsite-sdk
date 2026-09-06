/** The `news` namespace and everything under it. */

import { type ApiClient, Resource } from "../../../http";
import { NewsFeedsNamespace } from "./feeds";
import { NewsItemsNamespace } from "./items";
import { NewsScriptsNamespace } from "./scripts";
import { NewsSourcesNamespace } from "./sources";

export * from "./feeds";
export * from "./items";
export * from "./scripts";
export * from "./sources";

/**
 * The `news` namespace, reachable as `oms.content.news`: the ingestion side
 * of following the web.
 *
 * 1. a {@link NewsScript} knows HOW to fetch one kind of source (RSS, a
 *    Telegram channel, a YouTube channel, a page with a selector);
 * 2. a {@link NewsSource} is that script plus its settings, inside a
 *    {@link NewsFeed} - a named set of sources;
 * 3. polling a source writes {@link NewsItem} rows: raw, one per thing the
 *    source published, full-text searchable and readable incrementally.
 *
 * Open to every account within its quotas (`news_sources` in
 * `oms.quotas.list()`). Needs the `news:read` and `news:write` scopes on an
 * OAuth token. Ids are strings throughout.
 */
export class NewsNamespace extends Resource {
  /** Named sets of sources. Full CRUD. */
  readonly feeds: NewsFeedsNamespace;
  /** The sources you follow. Full CRUD, plus a manual run. */
  readonly sources: NewsSourcesNamespace;
  /** The fetchers. Full CRUD over yours; the built-ins are read-only. */
  readonly scripts: NewsScriptsNamespace;
  /** What the sources produced. Read plus delete. */
  readonly items: NewsItemsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.feeds = new NewsFeedsNamespace(http);
    this.sources = new NewsSourcesNamespace(http);
    this.scripts = new NewsScriptsNamespace(http);
    this.items = new NewsItemsNamespace(http);
  }
}
