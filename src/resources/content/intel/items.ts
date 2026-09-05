/** Intel items: the raw material behind the stories. */

import { Resource } from "../../../http";
import { listQuery, paginate } from "../../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../../listing";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../../types";

/**
 * A raw item, exactly as a script returned it.
 *
 * Written only by `Intel::FetchSourceJob`; over HTTP it is read-only plus a
 * delete. Items are the substrate the stories are built from - the story never
 * copies the body, it points here.
 */
export interface IntelItem {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Which source produced it. */
  readonly intel_source_id: Id;
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
   * the backend downloads the audio, transcribes it and splits it into news
   * items. The video row itself never reaches the analysis; the news it
   * yields do, as child items pointing back via {@link parent_id}.
   */
  readonly media_url: string | null;
  /**
   * Transcription state of a video row: `pending` → `processing` →
   * `transcribed` (the `content` now holds the `[m:ss] text` transcript) →
   * `done`, or `failed` with {@link media_error}. `null` on non-video items.
   */
  readonly media_status: IntelMediaStatus | null;
  readonly media_error: string | null;
  /** On a news item cut from a video: the video (parent) item's id. */
  readonly parent_id: Id | null;
  /** On a news item cut from a video: where in the video it starts, in seconds. */
  readonly media_offset_s: number | null;
}

/** Lifecycle of a video item's transcription. */
export type IntelMediaStatus = "pending" | "processing" | "transcribed" | "done" | "failed";

/** Filter columns of `GET /intel_items`, on top of {@link BASE_FILTER_COLUMNS}. */
export const INTEL_ITEM_FILTER_COLUMNS = Object.freeze([
  "intel_source_id", "external_id", "title", "content", "url", "media_status", "parent_id",
] as const);

/** Filters for {@link IntelItemsNamespace.list}. */
export interface ListIntelItemsParams extends ListParams<(typeof INTEL_ITEM_FILTER_COLUMNS)[number]> {
  /** Only items produced by one source. Sent as `exact_search[intel_source_id]`. */
  readonly sourceId?: Id;
}

/**
 * `/intel_items` - the raw material.
 *
 * Read-only plus a delete: `creatable_by?` and `updatable_by?` are hard `false`
 * and the route is `only: [:index, :show, :destroy]`. Items are written by
 * `Intel::FetchSourceJob` and by nothing else.
 *
 * It is here because the stories only carry a citation stub
 * ({@link IntelArticleSourceRef}) and this is the only way to read the body
 * behind one.
 */
export class IntelItemsNamespace extends Resource {
  /**
   * `GET /intel_items` - raw items, newest first.
   *
   * **Heavy.** Every row carries {@link IntelItem.content} in full - the whole
   * article text a script scraped - and there is no lighter view. The SDK
   * defaults to a page of 25 for that reason; raising it is how you get a
   * multi-megabyte response.
   *
   * Declared filters: `intel_source_id`, `external_id`, `title`, `content`,
   * `url`, plus the inherited three. Note `processed_at` is NOT among them and
   * is not on the payload either, so there is no way to list only the
   * unprocessed items - {@link IntelStats.totals.pending_items} is the only
   * window onto that backlog.
   *
   * The controller sets no ordering; the SDK sends `created_at:desc`.
   */
  async list(params: ListIntelItemsParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelItem>> {
    const base = { order: "created_at:desc", exactSearch: { intel_source_id: params.sourceId } };
    return paginate(params, 25, (at) =>
      this.http.get<IntelItem[]>("/intel_items", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /intel_items/:id` - one raw item.
   *
   * There are no `:extended` extras, so this is the same shape a listing row
   * has. Use it to expand one {@link IntelArticleSourceRef} without
   * pulling a page of bodies.
   *
   * @throws {OmsApiError} 404 when the item is not yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelItem> {
    return this.http.get<IntelItem>(`/intel_items/${encodeURIComponent(id)}`, options);
  }

  /**
   * `DELETE /intel_items/:id`. `204`, empty body.
   *
   * Rarely what you want. The item's `external_id` uniqueness is what stops the
   * next poll re-fetching it, so deleting one invites it straight back on the
   * following run - and if the story built from it survives, you get a second
   * citation of the same thing. Delete the SOURCE, or leave items alone.
   *
   * @throws {OmsApiError} 404 when the item is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_items/${encodeURIComponent(id)}`, options);
  }
}
