/** News items: what the sources produced, raw. */

import { Resource } from "../../../http";
import { listQuery, paginate } from "../../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../../listing";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../../types";

/**
 * A raw item, exactly as a script returned it.
 *
 * Written only by the ingest job; over HTTP it is read-only plus a delete.
 * Items are the substrate everything downstream (a report, a story, a cron
 * script) is built from - nothing copies the body, it points here.
 */
export interface NewsItem {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** The feed the source belonged to when the item was written. */
  readonly news_feed_id: Id;
  /** Which source produced it. */
  readonly news_source_id: Id;
  /**
   * The script's own id for this item, unique per source. This is the
   * de-duplication key: a second poll that returns the same `external_id` does
   * not create a second row.
   */
  readonly external_id: string;
  readonly title: string | null;
  /** The body the script extracted. Can be large; a listing carries all of it. */
  readonly content: string | null;
  readonly url: string | null;
  readonly author: string | null;
  /** Publication time as the feed reported it, not as we saw it. */
  readonly published_at: Timestamp | null;
  /** When the poll that produced this item ran. Never null. */
  readonly fetched_at: Timestamp;
  /**
   * Set when the item is a VIDEO the script discovered (YouTube, RTP Play):
   * the server downloads the audio, transcribes it and splits it into news
   * items. The video row itself stays as it is; the news it yields are child
   * items pointing back via {@link parent_id}.
   */
  readonly media_url: string | null;
  /**
   * Transcription state of a video row: `pending` → `processing` →
   * `transcribed` (the `content` now holds the `[m:ss] text` transcript) →
   * `done`, or `failed` with {@link media_error}. `null` on non-video items.
   */
  readonly media_status: NewsMediaStatus | null;
  readonly media_error: string | null;
  /** On a news item cut from a video: the video (parent) item's id. */
  readonly parent_id: Id | null;
  /** On a news item cut from a video: where in the video it starts, in seconds. */
  readonly media_offset_s: number | null;
}

/** Lifecycle of a video item's transcription. */
export type NewsMediaStatus = "pending" | "processing" | "transcribed" | "done" | "failed";

/** Filter columns of `GET /news_items`, on top of {@link BASE_FILTER_COLUMNS}. */
export const NEWS_ITEM_FILTER_COLUMNS = Object.freeze([
  "news_feed_id", "news_source_id", "external_id", "title", "content", "url", "media_status", "parent_id",
] as const);

/** Filters for {@link NewsItemsNamespace.list}. */
export interface ListNewsItemsParams extends ListParams<(typeof NEWS_ITEM_FILTER_COLUMNS)[number]> {
  /** Only items of one feed. Sent as `exact_search[news_feed_id]`. */
  readonly feedId?: Id;
  /** Only items produced by one source. Sent as `exact_search[news_source_id]`. */
  readonly sourceId?: Id;
  /**
   * Full-text search over title and body, in Portuguese (stemmed, so
   * `mesquitas` finds `mesquita`). Web-search syntax: quotes for a phrase,
   * `-` to exclude, `or` between words. Results come by relevance when this
   * is set, whatever `order` says.
   */
  readonly query?: string;
  /** Only items written at or after this instant (ISO 8601). The incremental read a script wants. */
  readonly since?: string;
  /** Only items written at or before this instant (ISO 8601). */
  readonly until?: string;
}

/**
 * `/news_items` - the raw material.
 *
 * Read-only plus a delete: items are written by the ingest job and by
 * nothing else.
 */
export class NewsItemsNamespace extends Resource {
  /**
   * `GET /news_items` - raw items, newest first.
   *
   * **Heavy.** Every row carries {@link NewsItem.content} in full - the whole
   * article text a script scraped - and there is no lighter view. The SDK
   * defaults to a page of 25 for that reason; raising it is how you get a
   * multi-megabyte response.
   *
   * For an incremental reader, remember the newest `created_at` you saw and
   * pass it back as `since` with `order: "created_at:asc"`.
   *
   * The controller sets no ordering; the SDK sends `created_at:desc`.
   *
   * @throws {OmsApiError} 400 when `since` or `until` is not ISO 8601.
   */
  async list(params: ListNewsItemsParams = {}, options: RequestOptions = {}): Promise<Paginated<NewsItem>> {
    const top: Record<string, string> = {};
    if (params.query !== undefined) top["query"] = params.query;
    if (params.since !== undefined) top["since"] = params.since;
    if (params.until !== undefined) top["until"] = params.until;
    const base = {
      order: "created_at:desc",
      exactSearch: { news_feed_id: params.feedId, news_source_id: params.sourceId },
      top,
    };
    return paginate(params, 25, (at) =>
      this.http.get<NewsItem[]>("/news_items", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /news_items/:id` - one raw item. Same shape a listing row has.
   *
   * @throws {OmsApiError} 404 when the item is not yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<NewsItem> {
    return this.http.get<NewsItem>(`/news_items/${encodeURIComponent(id)}`, options);
  }

  /**
   * `DELETE /news_items/:id`. `204`, empty body.
   *
   * Rarely what you want. The item's `external_id` uniqueness is what stops the
   * next poll re-fetching it, so deleting one invites it straight back on the
   * following run. Delete the SOURCE, or leave items alone.
   *
   * @throws {OmsApiError} 404 when the item is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/news_items/${encodeURIComponent(id)}`, options);
  }
}
