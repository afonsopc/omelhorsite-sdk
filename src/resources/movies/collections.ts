/** The `movies.collections` area: the favourites row, the hand-made lists, and the titles filed into them. */

import type { ApiClient } from "../../http";
import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { ListParams } from "../../listing";
import type { BaseRecord, Id, Paginated, RequestOptions } from "../../types";
import { DEFAULT_PAGE_SIZE } from "../../types";
import type { MovieType } from "./types";
import { assertPresent, pickOptional } from "./types";

/** The manual kind: a collection the user created and may rename or delete. */
export const MOVIE_COLLECTION_MANUAL_KIND = "manual";

/**
 * The one system kind. There is exactly one favourites collection per user,
 * enforced by a partial unique index on `(user_id, kind) WHERE kind <> 'manual'`.
 */
export const MOVIE_COLLECTION_FAVORITES_KIND = "favorites";

/** Every kind the server allows. Anything else is a `400`. */
export const MOVIE_COLLECTION_KINDS = [
  MOVIE_COLLECTION_MANUAL_KIND,
  MOVIE_COLLECTION_FAVORITES_KIND,
] as const;

/** One of {@link MOVIE_COLLECTION_KINDS}. */
export type MovieCollectionKind = (typeof MOVIE_COLLECTION_KINDS)[number];

/**
 * A user's list of titles: the auto-created favourites row, or a playlist they
 * made by hand.
 */
export interface MovieCollection extends BaseRecord {
  readonly user_id: Id;
  readonly name: string;
  readonly kind: MovieCollectionKind;
  /**
   * Sort key inside the sidebar. Favourites is minted at `-1` so it sorts
   * first; manual collections start at `max + 1`.
   *
   * The index has NO order of its own, so this only sorts if you ask for it -
   * pass `order: "position:asc"`.
   */
  readonly position: number;
  /**
   * `true` for the favourites row. Mirrors `kind != "manual"`, so it is `true`
   * for any future system kind too. Use {@link isSystemMovieCollection}.
   */
  readonly system: boolean;
  /**
   * How many items are in it. Exact - but a snapshot, and adding an item does
   * not refresh the collection row you are holding.
   */
  readonly items_count: number;
}

/** One title filed into a collection. */
export interface MovieCollectionItem extends BaseRecord {
  readonly movie_collection_id: Id;
  /** `"movie"`, `"series"`, whatever the addon called it. */
  readonly movie_type: MovieType;
  /** The addon's own id for the title, e.g. an IMDb id. Not a database id. */
  readonly movie_id: string;
  /** Denormalised metadata, so a grid renders without hitting the addon. */
  readonly name: string | null;
  readonly poster: string | null;
  readonly background: string | null;
  readonly release_info: string | null;
  /** Sort key inside the collection, dense from `0`. See {@link MovieCollectionsNamespace.reorder}. */
  readonly position: number;
}

/** Arguments for {@link MovieCollectionsNamespace.create}. */
export interface CreateMovieCollectionInput {
  /**
   * Required. It is the ONLY field create reads: the owner is always the
   * caller, `kind` is forced to `"manual"` and `position` is computed as
   * `max(position) + 1`, so passing a kind or a position is silently ignored
   * rather than rejected. There is no way to mint a second system collection.
   */
  readonly name: string;
}

/** Arguments for {@link MovieCollectionsNamespace.update}. */
export interface UpdateMovieCollectionInput {
  readonly name?: string;
  /**
   * Sidebar order. Nothing normalises it: two collections can hold the same
   * position and the server will not complain, so the client owns keeping the
   * sequence sane.
   */
  readonly position?: number;
}

/**
 * Filters for {@link MovieCollectionsNamespace.list}.
 *
 * Allowlist: `id`, `name`, `kind`, `created_at`, `updated_at`. Anything else is
 * `400 "Unknown search filter: ..."`.
 */
export interface ListMovieCollectionsParams extends ListParams<(typeof MOVIE_COLLECTION_FILTER_COLUMNS)[number]> {
  /** Exact match, or `IN (...)` when given an array. */
  readonly id?: Id | readonly Id[];
  /**
   * Partial, accent-folded, case-insensitive match - the `LIKE` a search box
   * wants. NOT equality: `"fav"` matches `"Favoritos"`.
   */
  readonly name?: string;
  /** Exact match. `"favorites"` finds the one system row. */
  readonly kind?: MovieCollectionKind;
}

/** Filter columns of `GET /movie_collections`. */
export const MOVIE_COLLECTION_FILTER_COLUMNS = Object.freeze(["id", "name", "kind", "created_at", "updated_at"] as const);

/** Arguments for {@link MovieCollectionItemsNamespace.create}. */
export interface CreateMovieCollectionItemInput {
  readonly movie_collection_id: Id;
  readonly movie_type: MovieType;
  /** The addon's id for the title. Required, and part of the uniqueness key. */
  readonly movie_id: string;
  readonly name?: string | null;
  readonly poster?: string | null;
  readonly background?: string | null;
  readonly release_info?: string | null;
}

/**
 * Filters for {@link MovieCollectionItemsNamespace.list}.
 *
 * Allowlist: `id`, `movie_collection_id`, `movie_type`, `movie_id`,
 * `position`, `created_at`, `updated_at`.
 */
export interface ListMovieCollectionItemsParams
  extends ListParams<(typeof MOVIE_COLLECTION_ITEM_FILTER_COLUMNS)[number]> {
  /** Exact match, or `IN (...)` when given an array. */
  readonly id?: Id | readonly Id[];
  /**
   * Exact match, or `IN (...)` for several collections at once. Almost always
   * what you want: the bare index returns the items of EVERY collection the
   * caller owns, interleaved.
   */
  readonly collectionId?: Id | readonly Id[];
  /** Exact match. */
  readonly movieType?: MovieType;
  /** Exact match on the addon's title id. */
  readonly movieId?: string;
  /** Exact match on the sort key. */
  readonly position?: number;
}

/** Filter columns of `GET /movie_collection_items`. */
export const MOVIE_COLLECTION_ITEM_FILTER_COLUMNS = Object.freeze([
  "id",
  "movie_collection_id",
  "movie_type",
  "movie_id",
  "position",
  "created_at",
  "updated_at",
] as const);

/**
 * Whether a collection is the server-managed favourites row.
 *
 * Prefer this over `collection.kind === "favorites"`: the server's own test is
 * `kind != "manual"`, so a future system kind reads as system there and would
 * read as manual in a hand-written equality check. The `system` flag already
 * carries it; this just keeps the test in one place.
 */
export function isSystemMovieCollection(collection: Pick<MovieCollection, "kind">): boolean {
  return collection.kind !== MOVIE_COLLECTION_MANUAL_KIND;
}

/**
 * The `movies.collections.items` namespace: the titles filed into a collection.
 *
 * Index and create and delete; there is no `show` and no `update`. To change a
 * title's stored metadata, {@link create} it again - it upserts.
 */
export class MovieCollectionItemsNamespace extends Resource {
  /**
   * `GET /movie_collection_items` - items across the caller's collections.
   *
   * **Pass `collectionId` unless you really mean everything.** With no filter
   * this returns the items of EVERY collection the caller owns, and because
   * the default order is `position:asc` they come back interleaved by position
   * rather than grouped by collection - position 0 of each list, then
   * position 1 of each, and so on. Grouping that back together client-side
   * works but reads like a bug when you first see it.
   *
   * `collectionId` accepts an array, which becomes `IN (...)`: one request for
   * the three lists a screen shows.
   *
   * The default order is `position:asc` and it is the useful one, so leave
   * `order` alone unless you want something else. Note that passing `order`
   * REPLACES the default, it does not add to it, so `order: "created_at:desc"`
   * loses the position ordering entirely.
   *
   * @throws {OmsApiError} 400 `"Unknown search filter: ..."` outside the
   *   allowlist in {@link ListMovieCollectionItemsParams}.
   */
  async list(
    params: ListMovieCollectionItemsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<MovieCollectionItem>> {
    const base = {
      exactSearch: {
        id: params.id,
        movie_collection_id: params.collectionId,
        movie_type: params.movieType,
        movie_id: params.movieId,
        position: params.position,
      },
    };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<MovieCollectionItem[]>("/movie_collection_items", {
        ...options,
        query: listQuery(params, at, base),
      }),
    );
  }

  /**
   * `POST /movie_collection_items` - adds a title to a collection, or refreshes
   * the one already there. **`201` either way.**
   *
   * Adding the same title twice is a no-op-with-an-update rather than a `400`
   * off the unique index. This is deliberate: the heart button and the "add
   * to list" dialog both fire blind, holding only the collection they already
   * loaded. The upshot is that this call is safe to repeat and safe to fire
   * optimistically.
   *
   * Two consequences worth knowing:
   *
   * - `position` is only computed for a NEW row (`max(position) + 1`, starting
   *   at `0`). Re-adding an existing title keeps its place in the list rather
   *   than moving it to the end.
   * - the denormalised metadata (`name`, `poster`, `background`,
   *   `release_info`) IS overwritten every time, so re-posting is how you
   *   refresh a poster that the addon has since changed. Sending `null` for one
   *   clears it; omitting the key leaves the stored value alone.
   *
   * A `movie_collection_id` that does not exist, or belongs to somebody else,
   * is `401 "You are not authorized to create this resource"` and NOT a `404`:
   * the ownership check fails the same way for a missing collection as for
   * somebody else's. Do not read that `401` as "the session expired".
   *
   * Adding to the favourites collection is allowed - the system flag blocks
   * renaming, reordering and deleting the COLLECTION, not writing items into
   * it. That is how the heart button works.
   *
   * @throws {OmsError} `invalid_request` when the collection id, type or movie
   *   id is blank.
   * @throws {OmsApiError} 400 `"Movie type can't be blank"` /
   *   `"Movie can't be blank"`, 401 for a collection that is not yours.
   */
  async create(
    input: CreateMovieCollectionItemInput,
    options: RequestOptions = {},
  ): Promise<MovieCollectionItem> {
    assertPresent("movie_collection_id", input.movie_collection_id);
    assertPresent("movie_type", input.movie_type);
    assertPresent("movie_id", input.movie_id);
    return this.http.post<MovieCollectionItem>(
      "/movie_collection_items",
      {
        movie_collection_id: input.movie_collection_id,
        movie_type: input.movie_type,
        movie_id: input.movie_id,
        ...pickOptional(input, ["name", "poster", "background", "release_info"] as const),
      },
      options,
    );
  }

  /**
   * `DELETE /movie_collection_items/:id` - `204`, empty body.
   *
   * The id is the ITEM's primary key, not the `movie_id` the addon uses. If
   * all you hold is a title, {@link list} it with `collectionId` and `movieId`
   * first, or keep the item rows the collection screen already loaded.
   *
   * Removing leaves a gap in `position`: nothing renumbers the survivors, and
   * the next {@link create} takes `max + 1`, so positions drift sparse over
   * time. Only {@link MovieCollectionsNamespace.reorder} makes them dense
   * again. Nothing depends on them being dense.
   *
   * @throws {OmsApiError} 404 for an item outside your collections.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/movie_collection_items/${encodeURIComponent(id)}`, options);
  }
}

/**
 * The `movies.collections` namespace: the favourites row plus whatever lists
 * the user built by hand.
 */
export class MovieCollectionsNamespace extends Resource {
  /** The titles inside a collection. */
  readonly items: MovieCollectionItemsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.items = new MovieCollectionItemsNamespace(http);
  }

  /**
   * `GET /movie_collections` - the caller's collections, each with its
   * `items_count`.
   *
   * **This call has a side effect, and it is the only one that does.**
   * Before anything else it finds or creates the "Favoritos" row (kind
   * `favorites`, position `-1`). The index is the only place that knows the
   * user has opened the movies app, so it is where the row gets minted. Two
   * consequences: a brand new account's first listing WRITES to the database,
   * and there is no other way to make favourites exist - a client that goes
   * straight to the heart button without ever listing has no collection to put
   * the title in. List first.
   *
   * A concurrent second tab racing the same first listing is handled: the
   * partial unique index makes the loser read the winner's row back.
   *
   * `items_count` is exact here and in {@link get}. Neither is a snapshot you
   * can trust after a write.
   *
   * No default order. Pass `order: "position:asc"` to get the sidebar's own
   * order, which puts favourites first by virtue of its `-1`.
   *
   * @throws {OmsApiError} 401 for an anonymous caller, 403 for an OAuth token.
   */
  async list(
    params: ListMovieCollectionsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<MovieCollection>> {
    const base = { search: { name: params.name }, exactSearch: { id: params.id, kind: params.kind } };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<MovieCollection[]>("/movie_collections", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * Reads the caller's favourites collection, creating it if this is the first
   * time they have opened the app.
   *
   * A one-line convenience over {@link list} that exists because "get me the
   * heart list" is the single most common reason to call the index, and
   * because doing it by hand invites filtering on `kind` client-side after a
   * listing that may have been paged.
   *
   * Resolves to `null` only if the server somehow answered without the row,
   * which should not happen - the listing mints it.
   */
  async favorites(options: RequestOptions = {}): Promise<MovieCollection | null> {
    const page = await this.list(
      { kind: MOVIE_COLLECTION_FAVORITES_KIND, pageSize: 1 },
      options,
    );
    return page.items[0] ?? null;
  }

  /**
   * `GET /movie_collections/:id` - one collection.
   *
   * The only `show` route in this whole namespace. Its payload is
   * byte-identical to one row of the index: `show` is not a richer payload,
   * only a single-row one.
   *
   * Unlike {@link list} it does NOT mint the favourites row.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` for a collection that is
   *   not yours. Ownership is the lookup scope, so somebody else's collection
   *   and a non-existent one are indistinguishable.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<MovieCollection> {
    return this.http.get<MovieCollection>(`/movie_collections/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /movie_collections` - a new manual list. `201`.
   *
   * `name` is the only field that survives: the owner is always the caller,
   * `kind` is pinned to `"manual"` and `position` is set to
   * `max(position) + 1`. Passing `kind: "favorites"` does not fail, it is just
   * ignored, which is the point - there is exactly one system collection and
   * only the listing may mint it.
   *
   * Names are not unique.
   *
   * @throws {OmsApiError} 400 `"Name can't be blank"`.
   */
  async create(
    input: CreateMovieCollectionInput | string,
    options: RequestOptions = {},
  ): Promise<MovieCollection> {
    const name = typeof input === "string" ? input : input.name;
    assertPresent("name", name);
    return this.http.post<MovieCollection>("/movie_collections", { name }, options);
  }

  /**
   * `PATCH /movie_collections/:id` - renames or repositions. `200`.
   *
   * A real partial update: `name` and `position` are the only keys accepted,
   * and an omitted key is left alone.
   *
   * Refused for the favourites row with
   * `401 "You are not authorized to update this resource"` - the GENERIC
   * message; the friendlier "The favourites collection cannot be renamed,
   * reordered or deleted" is never reached here. Only {@link reorder}
   * produces that sentence. Test with {@link isSystemMovieCollection} and hide
   * the control instead.
   *
   * @throws {OmsApiError} 404 for a collection that is not yours, 401 for the
   *   favourites row.
   */
  async update(
    id: Id,
    input: UpdateMovieCollectionInput,
    options: RequestOptions = {},
  ): Promise<MovieCollection> {
    return this.http.patch<MovieCollection>(
      `/movie_collections/${encodeURIComponent(id)}`,
      pickOptional(input, ["name", "position"] as const),
      options,
    );
  }

  /**
   * `DELETE /movie_collections/:id` - `204`, empty body.
   *
   * Cascades: every title in the list goes with it. Nothing is recoverable and
   * nothing is asked.
   *
   * Refused for the favourites row with the same generic `401` as
   * {@link update}, for the same reason.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/movie_collections/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /movie_collections/:id/reorder` - rewrites the order of the items
   * inside a collection. Answers `200` with the COLLECTION, not the items.
   *
   * Send the full ordered list of item ids. The server keeps a stale client
   * from losing rows: ids it recognises are laid out first in the order given,
   * then every item you did NOT mention is appended in its existing relative
   * order, and the whole sequence is renumbered densely from `0`. So an item
   * added by another tab between your read and your write sinks to the bottom
   * instead of vanishing. Ids that are not in this collection are ignored, not
   * rejected.
   *
   * Positions are written inside one transaction and - the part that catches
   * people - the write does NOT touch each item's `updated_at`. A client that
   * syncs on `updated_at` will not see a reorder. Refetch by position.
   *
   * The whole rewrite is one transaction, and items already at the right
   * position are skipped, so a reorder that changes nothing costs no writes.
   *
   * Refused for the favourites row with
   * `401 "The favourites collection cannot be renamed, reordered or deleted"` -
   * this is the one action that produces that message rather than the generic
   * one, because the system check runs before any authorisation.
   *
   * @throws {OmsApiError} 404 for a collection that is not yours, 401 for the
   *   favourites row.
   */
  async reorder(
    id: Id,
    itemIds: readonly Id[],
    options: RequestOptions = {},
  ): Promise<MovieCollection> {
    return this.http.post<MovieCollection>(
      `/movie_collections/${encodeURIComponent(id)}/reorder`,
      { item_ids: [...itemIds] },
      options,
    );
  }
}
