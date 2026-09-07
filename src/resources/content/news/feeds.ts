/** News feeds: the named sets of sources a person follows. */

import { Resource } from "../../../http";
import { listQuery, paginate } from "../../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../../listing";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../../types";

/** At most this many feeds per account; one more is a `400`. */
export const NEWS_FEEDS_PER_ACCOUNT = 10;
/** `retention_days` outside this range is a `400`. */
export const NEWS_FEED_MIN_RETENTION_DAYS = 7;
export const NEWS_FEED_MAX_RETENTION_DAYS = 3650;

/**
 * A feed: a named set of {@link NewsSource}s and the {@link NewsItem}s they
 * produce. Several per account, unique by name; the oldest is the default
 * one a source lands in when it names no feed. A feed may INCLUDE other
 * feeds of yours (one level): listing its items also returns theirs, so
 * sources can be grouped by kind ("Newspapers", "TV news") and reused.
 */
export interface NewsFeed {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Up to 80 characters, whitespace-squished, unique per account. */
  readonly name: string;
  /** Up to 500 characters. */
  readonly description: string | null;
  /** Items older than this are pruned. Default 90. */
  readonly retention_days: number;
  /** A disabled feed's sources are not polled. */
  readonly enabled: boolean;
  /** Feeds of yours whose items this feed also lists (one level, no chaining). */
  readonly included_feed_ids: Id[];
}

/** `GET /news_feeds/:id` adds two live counters (this feed's own sources and items) and who includes it. */
export interface NewsFeedDetail extends NewsFeed {
  readonly sources_count: number;
  readonly items_count: number;
  readonly included_by_feed_ids: Id[];
}

/** Filter columns of `GET /news_feeds`, on top of {@link BASE_FILTER_COLUMNS}. */
export const NEWS_FEED_FILTER_COLUMNS = Object.freeze(["name", "enabled"] as const);

export interface ListNewsFeedsParams extends ListParams<(typeof NEWS_FEED_FILTER_COLUMNS)[number]> {}

export interface CreateNewsFeedInput {
  readonly name: string;
  readonly description?: string | null;
  readonly retentionDays?: number;
  readonly enabled?: boolean;
  /** REPLACES the list. Your own feeds only, the feed itself is dropped; anything else is a `400`. */
  readonly includedFeedIds?: readonly Id[];
}

export type UpdateNewsFeedInput = Partial<CreateNewsFeedInput>;

/** `/news_feeds` - your feeds. Needs `news:read` to read and `news:write` to change. */
export class NewsFeedsNamespace extends Resource {
  /** `GET /news_feeds` - your feeds, oldest first. */
  async list(params: ListNewsFeedsParams = {}, options: RequestOptions = {}): Promise<Paginated<NewsFeed>> {
    const base = { order: "created_at:asc" };
    return paginate(params, 50, (at) =>
      this.http.get<NewsFeed[]>("/news_feeds", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /** `GET /news_feeds/:id` - one feed with its counters. 404 when it is not yours. */
  async get(id: Id, options: RequestOptions = {}): Promise<NewsFeedDetail> {
    return this.http.get<NewsFeedDetail>(`/news_feeds/${encodeURIComponent(id)}`, options);
  }

  /** `POST /news_feeds`. `201`. 400 for a duplicate name or past the cap. */
  async create(input: CreateNewsFeedInput, options: RequestOptions = {}): Promise<NewsFeed> {
    return this.http.post<NewsFeed>("/news_feeds", feedBody(input), { retry: false, ...options });
  }

  /** `PATCH /news_feeds/:id`. */
  async update(id: Id, input: UpdateNewsFeedInput, options: RequestOptions = {}): Promise<NewsFeed> {
    return this.http.patch<NewsFeed>(`/news_feeds/${encodeURIComponent(id)}`, feedBody(input), options);
  }

  /** `DELETE /news_feeds/:id` - the feed, its sources and every item. `204`. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/news_feeds/${encodeURIComponent(id)}`, options);
  }
}

function feedBody(input: UpdateNewsFeedInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body["name"] = input.name;
  if (input.description !== undefined) body["description"] = input.description;
  if (input.retentionDays !== undefined) body["retention_days"] = input.retentionDays;
  if (input.enabled !== undefined) body["enabled"] = input.enabled;
  if (input.includedFeedIds !== undefined) body["included_feed_ids"] = [...input.includedFeedIds];
  return body;
}
