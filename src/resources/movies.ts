/**
 * The `movies` namespace: the Stremio-style movie and series app.
 *
 * Six endpoint families live here because they are one app's worth of API:
 * the addons that supply catalogues and streams, the groups and grants that
 * share those addons with friends, the collections a user files titles into,
 * and the watch progress that drives "Continuar a ver". They are exposed as
 * one entry class ({@link MoviesNamespace}) with sub-namespaces hanging off it
 * ({@link MoviesNamespace.addons}, `.addons.groups`, `.addons.grants`,
 * `.collections`, `.collections.items`, `.watchProgress`), and every
 * sub-namespace is also exported on its own so a host that prefers
 * `oms.movieCollections` can mount it there instead.
 *
 * ## Seven things that have already cost bugs
 *
 * 1. **Every id here is an opaque 12-character STRING**, minted by
 *    `RandomIdentifier`, not an auto-increment integer like the music tables.
 *    They do not sort by creation and there is no arithmetic to do on one.
 * 2. **The whole namespace requires a session.** `ApplicationController`
 *    requires authentication by default and none of the six controllers opts
 *    out, so an anonymous call is `401 "Session required to access this
 *    resource."` - not an empty list. Worse for OAuth: no movies controller
 *    declares an `oauth_scope`, and the scope gate denies by omission, so an
 *    OAuth access token gets `403 {"error":"insufficient_scope"}` on every
 *    route in this file. Cookie sessions and personal tokens work; third-party
 *    OAuth clients do not. See {@link MoviesNamespace}.
 * 3. **Listing collections has a side effect**: it is the only place that
 *    creates the user's "Favoritos" row. See
 *    {@link MovieCollectionsNamespace.list}.
 * 4. **`POST /movie_watch_progresses` is an upsert that answers `200`, not
 *    `201`**, and its identity is `(user, movie_id, video_id)` - `movie_type`
 *    is NOT part of the key. It is one of the very few creates in the API that
 *    breaks the 201 convention, because it is not really a create.
 * 5. **`finished` is a three-state field, not a boolean.** Omitted means "you
 *    decide from the position"; `true`/`false` means "the user said so". A
 *    `null` is deleted by the controller and reads as omitted, which is
 *    exactly the bug that once made "marcar como nao visto" silently do
 *    nothing. See {@link MovieWatchProgressInput.finished}.
 * 6. **`last_watched_at` is only defaulted on INSERT.** The model does
 *    `self.last_watched_at ||= Time.current`, so an upsert onto an existing row
 *    that omits it keeps the OLD timestamp - and the Continue Watching list is
 *    ordered by exactly that column. Always send one. See
 *    {@link MovieWatchProgressInput.last_watched_at}.
 *
 * Everything here rides the general ceiling: **600 requests per minute** for an
 * authenticated caller. There is no movie-specific rack-attack bucket, and
 * since anonymous callers cannot reach any of it, the 120/min anonymous bucket
 * never applies.
 */

import { ApiClient, Resource } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../listing";
import { OmsError } from "../errors";
import type {
  BaseRecord,
  Id,
  PageLoader,
  PageParams,
  Paginated,
  QueryParams,
  RequestOptions,
  Timestamp,
} from "../types";
import { DEFAULT_PAGE_SIZE } from "../types";
import type { User } from "./account";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * What a title is. Stremio's own vocabulary, and the backend stores it as a
 * free string with no inclusion validation, so an addon may invent one.
 * Compare against this union for the cases you handle and fall through for the
 * rest rather than assuming the list is closed.
 */
export type MovieType = "movie" | "series" | "channel" | "tv" | (string & {});

/** The four resource names a Stremio manifest may advertise. */
export type StremioResourceName = "catalog" | "meta" | "stream" | "subtitles";

/** One catalogue an addon offers, as declared in its manifest. */
export interface StremioCatalog {
  readonly type: string;
  readonly id: string;
  readonly name?: string;
  readonly extra?: ReadonlyArray<{
    readonly name: string;
    readonly isRequired?: boolean;
    readonly options?: readonly string[];
  }>;
}

/**
 * An addon's `manifest.json`, stored verbatim in a `jsonb` column.
 *
 * The backend does not validate a single key of it beyond "not blank": it is
 * `params[:manifest_json].to_unsafe_h`, written straight to the column and read
 * straight back. So the fields below are what a well-behaved Stremio addon
 * sends, not a contract the server enforces - `id` and `name` can be missing
 * on a hostile or broken manifest even though they are typed as required here,
 * and the index signature is there because whatever else the addon declared
 * round-trips untouched.
 *
 * Never trust `logo`, `background` or any URL inside one without checking the
 * origin: this blob is user-supplied content that the app renders.
 */
export interface StremioManifest {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly resources?: ReadonlyArray<
    StremioResourceName | { readonly name: StremioResourceName; readonly types?: readonly string[] }
  >;
  readonly types?: readonly string[];
  readonly catalogs?: readonly StremioCatalog[];
  readonly logo?: string;
  readonly background?: string;
  /** Anything else the manifest carried. `jsonb` keeps it all. */
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Addons
// ---------------------------------------------------------------------------

/**
 * An installed addon: a manifest URL plus the manifest fetched from it.
 *
 * Rows reach a caller two ways, and {@link MovieAddon.shared} is how you tell
 * them apart: the ones the caller installed, and the ones somebody granted
 * them (directly, or through a group). A shared addon is read-only in
 * practice - `updatable_by?` and `destroyable_by?` both require ownership, so
 * every write against one is a `401`.
 */
export interface MovieAddon extends BaseRecord {
  /** Owner. Compare against your own id, or just read {@link shared}. */
  readonly user_id: Id;
  /** Group the owner filed it under, or `null` when it is ungrouped. */
  readonly movie_addon_group_id: Id | null;
  /** Where the manifest was fetched from. Unique per owner. */
  readonly manifest_url: string;
  /** The manifest itself, stored verbatim. */
  readonly manifest_json: StremioManifest;
  /**
   * `true` when this row belongs to somebody else and reached you through a
   * grant. Computed against the CALLER, so the same row is `false` for its
   * owner and `true` for everyone it is shared with - never cache it across
   * identities.
   */
  readonly shared: boolean;
}

/** Arguments for {@link MovieAddonsNamespace.create}. */
export interface CreateMovieAddonInput {
  /**
   * Absolute `http`/`https` URL of the manifest. Validated with
   * `URI::DEFAULT_PARSER.make_regexp`, so anything else is
   * `400 "Manifest url must be a valid URL"`.
   */
  readonly manifest_url: string;
  /**
   * The fetched manifest. Required: `presence: true` rejects both `nil` and
   * `{}`, so an addon whose manifest failed to download cannot be stored as a
   * placeholder.
   */
  readonly manifest_json: StremioManifest;
  /**
   * Group to file it under. The group must belong to the SAME user, or the
   * save fails with `400 "Movie addon group must belong to addon owner"`.
   */
  readonly movie_addon_group_id?: Id | null;
}

/** Arguments for {@link MovieAddonsNamespace.update}. Every field is optional; omitted ones are left alone. */
export interface UpdateMovieAddonInput {
  /** A replacement manifest. Must be a non-empty object. */
  readonly manifest_json?: StremioManifest;
  /** `null` un-groups the addon. Omitting the key leaves the group alone. */
  readonly movie_addon_group_id?: Id | null;
  /**
   * Only if you really are re-pointing the addon. Changing it can collide with
   * the `(user_id, manifest_url)` unique index, which surfaces as
   * `400 "Manifest url has already been taken"`.
   */
  readonly manifest_url?: string;
}

/**
 * Filters for {@link MovieAddonsNamespace.list}.
 *
 * The server's allowlist for this index is exactly `user_id`, `id`,
 * `created_at` and `updated_at`. Any other filter key is
 * `400 "Unknown search filter: ..."` - filters fail closed rather than widening
 * the query - so there is deliberately no way to list by
 * `movie_addon_group_id`. Group client-side off the field on each row.
 */
export interface ListMovieAddonsParams extends ListParams<(typeof MOVIE_ADDON_FILTER_COLUMNS)[number]> {
  /** Exact match. Use it to split your own addons from the shared ones. */
  readonly userId?: Id;
  /** Exact match on the primary key. */
  readonly id?: Id;
}

/** Filter columns of `GET /movie_addons`, on top of {@link BASE_FILTER_COLUMNS}. */
export const MOVIE_ADDON_FILTER_COLUMNS = Object.freeze(["user_id"] as const);

/** Arguments for {@link MovieAddonGroupsNamespace.create}. */
export interface CreateMovieAddonGroupInput {
  /** Required, at most {@link MOVIE_ADDON_GROUP_NAME_MAX_LENGTH} characters. */
  readonly name: string;
}

/**
 * A named folder for addons, owned by one user.
 *
 * A group is also a sharing unit: granting a group shares every addon inside
 * it, including ones added later, which is the whole reason groups exist.
 */
export interface MovieAddonGroup extends BaseRecord {
  readonly user_id: Id;
  readonly name: string;
}

/** Filters for {@link MovieAddonGroupsNamespace.list}. */
export interface ListMovieAddonGroupsParams extends ListParams<never> {
  /** Exact match on the primary key. The only filter this index allows. */
  readonly id?: Id;
}

/** `GET /movie_addon_groups` filters on {@link BASE_FILTER_COLUMNS} only. */
export const MOVIE_ADDON_GROUP_FILTER_COLUMNS = Object.freeze([] as const);

/**
 * A share: one addon, or one whole group, handed to one other user.
 *
 * Exactly one of `movie_addon_id` and `movie_addon_group_id` is set; the other
 * is `null`. A database check constraint enforces it as well as the model, so
 * there is no path to a row with both or neither.
 */
export interface MovieAddonGrant extends BaseRecord {
  /** Set when this grant targets a single addon. */
  readonly movie_addon_id: Id | null;
  /** Set when this grant targets a whole group. */
  readonly movie_addon_group_id: Id | null;
  /** Who shared. Always the caller for a grant you created. */
  readonly grantor_id: Id;
  /** Who received. */
  readonly grantee_id: Id;
  /**
   * The grantee, rendered as a full user.
   *
   * The web frontend types this as `{ id, name, handle }`; that is a subset,
   * not the payload. `MovieAddonGrantBlueprint` does
   * `JSON.parse(grant.grantee.render)`, which is `UserBlueprint`'s DEFAULT view
   * with `Current.user` injected as the viewer - so `bio`, `country_code`, the
   * `library_*` fields and the visibility flags all come along, and `email` /
   * `gender` / `group` appear or not depending on who is asking.
   *
   * There is no matching `grantor` field: you only ever see grants you made or
   * received, so the other side is either you or the grantee.
   */
  readonly grantee: User;
}

/**
 * Arguments for {@link MovieAddonGrantsNamespace.create}.
 *
 * Pass exactly one target. Both or neither is
 * `400 "Grant must target one addon or one group"`.
 */
export interface CreateMovieAddonGrantInput {
  /** Share one addon. Mutually exclusive with {@link movie_addon_group_id}. */
  readonly movie_addon_id?: Id | null;
  /** Share a whole group, present and future contents. */
  readonly movie_addon_group_id?: Id | null;
  /** Who to share with. Must not be yourself. */
  readonly grantee_id: Id;
}

/**
 * Filters for {@link MovieAddonGrantsNamespace.list}.
 *
 * This controller declares no `search_params` at all, so the allowlist is only
 * the framework default: `id`, `created_at`, `updated_at`. You CANNOT ask the
 * server for "grants I made" versus "grants I received", nor for the grants on
 * one addon - those are `400`s. Filter on `grantor_id` / `grantee_id` /
 * `movie_addon_id` client-side after listing.
 */
export interface ListMovieAddonGrantsParams extends ListParams<never> {
  /** Exact match on the primary key. */
  readonly id?: Id;
}

/** `GET /movie_addon_grants` filters on {@link BASE_FILTER_COLUMNS} only. */
export const MOVIE_ADDON_GRANT_FILTER_COLUMNS = Object.freeze([] as const);

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** The manual kind: a collection the user created and may rename or delete. */
export const MOVIE_COLLECTION_MANUAL_KIND = "manual";

/**
 * The one system kind. There is exactly one favourites collection per user,
 * enforced by a partial unique index on `(user_id, kind) WHERE kind <> 'manual'`.
 */
export const MOVIE_COLLECTION_FAVORITES_KIND = "favorites";

/** Every kind `MovieCollection::KINDS` allows. Anything else is a `400`. */
export const MOVIE_COLLECTION_KINDS = [
  MOVIE_COLLECTION_MANUAL_KIND,
  MOVIE_COLLECTION_FAVORITES_KIND,
] as const;

/** One of {@link MOVIE_COLLECTION_KINDS}. */
export type MovieCollectionKind = (typeof MOVIE_COLLECTION_KINDS)[number];

/** Longest name `MovieAddonGroup` accepts. Over it is a `400`. */
export const MOVIE_ADDON_GROUP_NAME_MAX_LENGTH = 80;

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
   * How many items are in it. Counted from the association the controller
   * preloads, so it is exact and costs no extra query - but it is a snapshot,
   * and adding an item does not refresh the collection row you are holding.
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
   * Required. It is the ONLY field create reads: `before_create` overwrites
   * `user`, forces `kind` to `"manual"` and computes `position` as
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

// ---------------------------------------------------------------------------
// Watch progress
// ---------------------------------------------------------------------------

/**
 * Fraction of the runtime that counts as watched when the server derives
 * `finished` itself. Mirrors `MovieWatchProgress::FINISHED_THRESHOLD`.
 */
export const MOVIE_WATCH_FINISHED_THRESHOLD = 0.95;

/**
 * Rows `POST /movie_watch_progresses/bulk` will accept in one call. Mirrors
 * `MovieWatchProgressesController::BULK_LIMIT`.
 *
 * The server does `Array(params[:items]).first(200)`: entries past the limit
 * are dropped in SILENCE and the call still answers `200` with the 200 rows it
 * did save, so a client marking a 300-episode series watched would believe it
 * succeeded. {@link MovieWatchProgressesNamespace.saveMany} raises instead.
 */
export const MOVIE_WATCH_BULK_LIMIT = 200;

/**
 * Rows `GET /movie_watch_progresses` returns, at most. Hard-coded `limit(500)`
 * in the controller, with no paging and no way to reach row 501 - see
 * {@link MovieWatchProgressesNamespace.list}.
 */
export const MOVIE_WATCH_LIST_LIMIT = 500;

/** One title-or-episode the user has started, and how far in they got. */
export interface MovieWatchProgress extends BaseRecord {
  readonly user_id: Id;
  readonly movie_type: MovieType;
  /** The addon's id for the TITLE. A series shares it across every episode. */
  readonly movie_id: string;
  /**
   * The addon's id for the specific playable. For a film this is usually the
   * same string as `movie_id`; for a series it is the episode.
   *
   * `(user_id, movie_id, video_id)` is the row's identity and carries a unique
   * index.
   */
  readonly video_id: string;
  readonly season: number | null;
  readonly episode: number | null;
  readonly name: string | null;
  readonly episode_title: string | null;
  readonly poster: string | null;
  /** Seconds into the playable. A float, `NOT NULL DEFAULT 0.0`. */
  readonly position: number;
  /** Runtime in seconds, as the player measured it. `0` when unknown. */
  readonly duration: number;
  /** See {@link MovieWatchProgressInput.finished} for how this gets its value. */
  readonly finished: boolean;
  /** What "Continuar a ver" sorts on, descending. */
  readonly last_watched_at: Timestamp;
}

/**
 * One row to upsert, through {@link MovieWatchProgressesNamespace.save} or
 * {@link MovieWatchProgressesNamespace.saveMany}.
 *
 * `movie_id`, `video_id` and `movie_type` are checked up front by the
 * controller and a missing one is
 * `400 "movie_id, video_id, movie_type are required"`. Everything else is
 * optional, but read the notes on `finished` and `last_watched_at` before
 * leaving them out: both are cases where omitting the field does something
 * other than "leave it as it was".
 */
export interface MovieWatchProgressInput {
  readonly movie_type: MovieType;
  /** Identity, with `video_id`. Changing `movie_type` does NOT make a new row. */
  readonly movie_id: string;
  /** Identity, with `movie_id`. */
  readonly video_id: string;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly name?: string | null;
  readonly episode_title?: string | null;
  readonly poster?: string | null;
  /** Seconds into the playable. Negative is `400 "Position must be greater than or equal to 0"`. */
  readonly position?: number;
  /** Runtime in seconds. Negative is a `400` the same way. */
  readonly duration?: number;
  /**
   * Three states, not two.
   *
   * - **omitted** - the server derives it:
   *   `finished = position >= duration * 0.95`, and if `duration <= 0` it
   *   leaves the stored flag ALONE. This is what a playback tick should send.
   * - **`true` / `false`** - the user said so. `upsert_for` sets the model's
   *   `finished_given` flag, which makes `set_finished` return before its
   *   `duration <= 0` guard, so the value is written as given.
   * - **`null`** - deleted by `progress_params` before it reaches the model
   *   (`permitted.delete(:finished) if permitted[:finished].nil?`) and
   *   therefore identical to omitting it.
   *
   * That last branch is the bug that was fixed here. "Marcar como nao visto"
   * sends `position: 0, duration: 0`, which used to hit the `duration <= 0`
   * guard and leave `finished` true forever. Sending an explicit `false` is
   * what makes it stick - sending `null`, or leaving the key out, still does
   * nothing at all. {@link MovieWatchProgressesNamespace.setWatched} spells it
   * out so you cannot get this wrong by accident.
   *
   * `finished_given` is a plain `attr_accessor`, not a column, so it only
   * pins the value for THAT save. The next tick that omits `finished` goes
   * back to deriving it from the position.
   */
  readonly finished?: boolean;
  /**
   * When the user last watched, ISO-8601.
   *
   * SEND IT ON EVERY CALL. The model only defaults it with
   * `self.last_watched_at ||= Time.current`, which is a no-op on an existing
   * row - so an upsert that omits it keeps whatever timestamp was there when
   * the row was first created. The Continue Watching list is
   * `order(last_watched_at: :desc)`, so omitting this pins the title where it
   * first appeared and it never moves back to the front. `new Date().toISOString()`
   * at the call site is the whole fix.
   */
  readonly last_watched_at?: Timestamp;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a collection is the server-managed favourites row.
 *
 * Prefer this over `collection.kind === "favorites"`: the server's own test is
 * `kind != "manual"`, so a future system kind reads as system there and would
 * read as manual in a hand-written equality check. The blueprint already
 * computes it; this just keeps the test in one place.
 */
export function isSystemMovieCollection(collection: Pick<MovieCollection, "kind">): boolean {
  return collection.kind !== MOVIE_COLLECTION_MANUAL_KIND;
}

/**
 * The same arithmetic `MovieWatchProgress#set_finished` uses, for a client that
 * wants to render a "watched" tick before the round trip lands.
 *
 * Returns `null` - not `false` - when `duration` is zero or negative, because
 * that is precisely the case where the server declines to decide and leaves the
 * stored flag untouched. Treating that as `false` is how an optimistic UI ends
 * up un-ticking something the server still considers watched.
 */
export function movieWatchFinished(position: number, duration: number): boolean | null {
  if (!(duration > 0)) return null;
  return position >= duration * MOVIE_WATCH_FINISHED_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * The `movies.addons.groups` namespace: named folders of addons, which double
 * as sharing units.
 *
 * There is no `show` route. Read one out of {@link list}.
 */
export class MovieAddonGroupsNamespace extends Resource {
  /**
   * `GET /movie_addon_groups` - the caller's own groups.
   *
   * `viewable_by` is `where(user: user)` with no grant clause, so a group
   * somebody shared with you never appears here even though its addons do.
   * The shared addons arrive from {@link MovieAddonsNamespace.list} carrying a
   * `movie_addon_group_id` you cannot resolve; render them under a single
   * "shared with me" heading rather than trying to look the group up.
   *
   * The relation has NO order of its own, so pass `order` (typically
   * `"name:asc"` or `"created_at:desc"`) - paging an unordered relation can
   * repeat and drop rows.
   *
   * @throws {OmsApiError} 401 for an anonymous caller, 403 for an OAuth token.
   * @throws {OmsApiError} 400 `"Unknown search filter: ..."` for any filter
   *   beyond `id`, `created_at` and `updated_at`.
   */
  async list(
    params: ListMovieAddonGroupsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<MovieAddonGroup>> {
    const base = { exactSearch: { id: params.id } };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<MovieAddonGroup[]>("/movie_addon_groups", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `POST /movie_addon_groups` - creates a group owned by the caller. `201`.
   *
   * `name` is the only writable field; the owner is forced to `Current.user` in
   * a `before_validation`, so there is no way to create one for somebody else.
   *
   * Names are NOT unique: two groups called "Filmes" are allowed and will look
   * identical in a picker. De-duplicate client-side if that matters.
   *
   * @throws {OmsApiError} 400 `"Name can't be blank"` or
   *   `"Name is too long (maximum is 80 characters)"`.
   */
  async create(
    input: CreateMovieAddonGroupInput | string,
    options: RequestOptions = {},
  ): Promise<MovieAddonGroup> {
    const name = typeof input === "string" ? input : input.name;
    assertPresent("name", name);
    if (name.length > MOVIE_ADDON_GROUP_NAME_MAX_LENGTH) {
      throw new OmsError(
        `name is at most ${MOVIE_ADDON_GROUP_NAME_MAX_LENGTH} characters; got ${name.length}.`,
        "invalid_request",
      );
    }
    return this.http.post<MovieAddonGroup>("/movie_addon_groups", { name }, options);
  }

  /**
   * `PATCH /movie_addon_groups/:id` - renames a group. `200`.
   *
   * Unlike its sibling {@link MovieAddonsNamespace.update}, this one is a real
   * partial update: `update_params :name` permits exactly one key and nothing
   * is assigned behind your back.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` for an id that is not
   *   yours - ownership is applied by the lookup scope, so somebody else's
   *   group is indistinguishable from a group that does not exist.
   */
  async update(id: Id, name: string, options: RequestOptions = {}): Promise<MovieAddonGroup> {
    assertPresent("name", name);
    return this.http.patch<MovieAddonGroup>(
      `/movie_addon_groups/${encodeURIComponent(id)}`,
      { name },
      options,
    );
  }

  /**
   * `DELETE /movie_addon_groups/:id` - `204`, empty body.
   *
   * Two different cascades, and only one of them destroys anything:
   *
   * - the addons inside are `dependent: :nullify`, so they SURVIVE and become
   *   ungrouped;
   * - the grants on the group are `dependent: :destroy`, so every share made
   *   through this group is revoked. People who could see those addons stop
   *   seeing them, with no notification. Direct grants on the individual
   *   addons are untouched.
   *
   * @throws {OmsApiError} 404 for an id that is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/movie_addon_groups/${encodeURIComponent(id)}`, options);
  }
}

/**
 * The `movies.addons.grants` namespace: sharing an addon, or a whole group,
 * with one other user.
 *
 * Grants are create-and-delete only; there is no update route and no `show`.
 * To change who can see what, delete the grant and make a new one.
 */
export class MovieAddonGrantsNamespace extends Resource {
  /**
   * `GET /movie_addon_grants` - every grant the caller made OR received.
   *
   * Both directions come back in one undifferentiated list
   * (`where(grantor: user).or(where(grantee: user))`) and the index accepts no
   * filter to separate them, so split on `grantor_id === myUserId` yourself.
   *
   * The relation has no order of its own; pass `order: "created_at:desc"`.
   *
   * @throws {OmsApiError} 400 `"Unknown search filter: ..."` for anything
   *   beyond `id`, `created_at` and `updated_at`. See
   *   {@link ListMovieAddonGrantsParams}.
   */
  async list(
    params: ListMovieAddonGrantsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<MovieAddonGrant>> {
    const base = { exactSearch: { id: params.id } };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<MovieAddonGrant[]>("/movie_addon_grants", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `POST /movie_addon_grants` - shares one addon, or one group, with one user.
   * `201`.
   *
   * The grantor is always the caller: it is forced in a `before_validation` and
   * re-checked on save, so there is no way to make a grant in somebody else's
   * name.
   *
   * ## Failure modes, and which status each one is
   *
   * - **both targets, or neither** - `400 "Grant must target one addon or one
   *   group"`. Caught here before the request goes out.
   * - **a target you do not own, or granting to YOURSELF** - `401 "You are not
   *   authorized to create this resource"`. Not a `400` and not a `403`:
   *   `creatable_by?` runs inside `CrudActions#create`, so a business-rule
   *   violation comes back wearing an authentication status. A generic error
   *   handler that logs the user out on `401` will do exactly that here.
   * - **granting the same target to the same person twice** - this is the one
   *   to be careful with. There is a partial unique index on
   *   `(movie_addon_id, grantee_id)` and another on
   *   `(movie_addon_group_id, grantee_id)`, and there is NO matching
   *   `validates :uniqueness` on the model, so the duplicate is not a tidy
   *   `400`: it raises `ActiveRecord::RecordNotUnique` out of `save`, lands in
   *   the global rescue, answers **500** and fires a Discord error alert. List
   *   the existing grants and check before you create, and do not put this call
   *   behind a blind retry.
   *
   * Retries are off by default for a POST anyway (the transport only replays
   * safe methods unless you opt in); do not opt in here.
   *
   * @throws {OmsError} `invalid_request` when the target count is not exactly
   *   one, or `grantee_id` is blank.
   */
  async create(
    input: CreateMovieAddonGrantInput,
    options: RequestOptions = {},
  ): Promise<MovieAddonGrant> {
    const addon = input.movie_addon_id ?? undefined;
    const group = input.movie_addon_group_id ?? undefined;
    if ((addon === undefined) === (group === undefined)) {
      throw new OmsError(
        "A grant targets exactly one of movie_addon_id or movie_addon_group_id.",
        "invalid_request",
      );
    }
    assertPresent("grantee_id", input.grantee_id);
    return this.http.post<MovieAddonGrant>(
      "/movie_addon_grants",
      { movie_addon_id: addon, movie_addon_group_id: group, grantee_id: input.grantee_id },
      options,
    );
  }

  /**
   * `DELETE /movie_addon_grants/:id` - revokes a share. `204`, empty body.
   *
   * Only the GRANTOR may revoke: `destroyable_by?` is `grantor == user`. The
   * grantee can see the grant in {@link list} but deleting it is
   * `401 "You are not authorized to destroy this resource"` - there is no
   * "leave this share" for the receiving side.
   *
   * @throws {OmsApiError} 404 for a grant that is neither yours nor shared
   *   with you, 401 when you are the grantee rather than the grantor.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/movie_addon_grants/${encodeURIComponent(id)}`, options);
  }
}

/**
 * The `movies.addons` namespace: installed Stremio addons, plus the groups and
 * grants that share them.
 *
 * There is no `show` route on `/movie_addons`; {@link list} is how you read
 * one.
 */
export class MovieAddonsNamespace extends Resource {
  /** Named folders of addons, which are also the unit of sharing. */
  readonly groups: MovieAddonGroupsNamespace;
  /** Shares of an addon or a group with another user. */
  readonly grants: MovieAddonGrantsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.groups = new MovieAddonGroupsNamespace(http);
    this.grants = new MovieAddonGrantsNamespace(http);
  }

  /**
   * `GET /movie_addons` - the caller's addons AND every addon shared with them.
   *
   * `viewable_by` is a three-way `OR`: rows you own, rows granted to you
   * directly, and rows whose group was granted to you. That last arm is why a
   * grant on a group covers addons added to it later. The result is
   * `.distinct`, so an addon shared both ways still appears once.
   *
   * Read {@link MovieAddon.shared} to tell the two kinds apart. Everything is
   * read-only for a shared row.
   *
   * The relation has NO default order. Always pass `order` - `"created_at:desc"`
   * matches the web app's "most recently installed first" - because paging an
   * unordered Postgres relation can repeat and drop rows between pages.
   *
   * **Array filters are silently ignored on this index.** `search_params` here
   * declares only scalars, so `id` given as an array is dropped by `permit`
   * without a `400` and you get the UNFILTERED list back. The SDK only accepts
   * a scalar for that reason. Unknown filter KEYS do fail closed with a `400`.
   *
   * This index emits an `ETag` and can answer `304`. Do not hand-write an
   * `If-None-Match` header: the transport treats a bare `304` as a failure.
   *
   * @throws {OmsApiError} 401 for an anonymous caller, 403 for an OAuth token.
   */
  async list(
    params: ListMovieAddonsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<MovieAddon>> {
    const base = { exactSearch: { id: params.id, user_id: params.userId } };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<MovieAddon[]>("/movie_addons", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `POST /movie_addons` - installs an addon, or re-installs one you already
   * have. **`201` either way.**
   *
   * The controller does `find_or_initialize_by(user: Current.user,
   * manifest_url: ...)` before the generic create runs, so posting a manifest
   * URL you already installed UPDATES that row - refreshing `manifest_json` and
   * reassigning `movie_addon_group_id` - instead of colliding with the
   * `(user_id, manifest_url)` unique index. The status stays `201` and the `id`
   * comes back unchanged, so `201` here does not mean "new row"; compare
   * `created_at` if you need to know.
   *
   * The practical consequence is the good one: reinstalling is idempotent and
   * the app can re-post its whole addon list on boot. The trap is the other
   * side of it - re-posting with `movie_addon_group_id` omitted leaves the
   * group as it was (the key is only assigned when present in `params.permit`),
   * while re-posting it as `null` clears the group.
   *
   * `manifest_json` is stored with `to_unsafe_h`: no key is validated, no key
   * is stripped, and whatever you send is what everyone the addon is shared
   * with will later render. Fetch the manifest yourself and do not forward one
   * a third party handed you unchecked.
   *
   * @throws {OmsApiError} 400 `"Manifest url must be a valid URL"`,
   *   `"Manifest json can't be blank"` (an empty object counts as blank), or
   *   `"Movie addon group must belong to addon owner"`.
   */
  async create(input: CreateMovieAddonInput, options: RequestOptions = {}): Promise<MovieAddon> {
    assertPresent("manifest_url", input.manifest_url);
    assertManifest(input.manifest_json);
    return this.http.post<MovieAddon>(
      "/movie_addons",
      {
        manifest_url: input.manifest_url,
        manifest_json: input.manifest_json,
        ...("movie_addon_group_id" in input
          ? { movie_addon_group_id: input.movie_addon_group_id ?? null }
          : {}),
      },
      options,
    );
  }

  /**
   * `PATCH /movie_addons/:id` - `200`. A partial update: omitted fields are
   * left alone. Only the owner may update; a shared row is `401`.
   *
   * @throws {OmsError} `invalid_request` when `manifest_json` is given but empty.
   * @throws {OmsApiError} 404 for an id you cannot see, 401 for one you can see
   *   but do not own.
   */
  async update(
    id: Id,
    input: UpdateMovieAddonInput,
    options: RequestOptions = {},
  ): Promise<MovieAddon> {
    if (input.manifest_json !== undefined) assertManifest(input.manifest_json);
    return this.http.patch<MovieAddon>(
      `/movie_addons/${encodeURIComponent(id)}`,
      {
        ...(input.manifest_json === undefined ? {} : { manifest_json: input.manifest_json }),
        ...("movie_addon_group_id" in input
          ? { movie_addon_group_id: input.movie_addon_group_id ?? null }
          : {}),
        ...(input.manifest_url === undefined ? {} : { manifest_url: input.manifest_url }),
      },
      options,
    );
  }

  /**
   * Files an addon under a group, or un-groups it with `null`.
   *
   * Refuses a shared addon before the round trip: the server would answer
   * `401`, and the message here says why.
   *
   * @throws {OmsError} `invalid_request` for an addon whose `shared` flag is set.
   */
  async moveToGroup(
    addon: MovieAddon,
    groupId: Id | null,
    options: RequestOptions = {},
  ): Promise<MovieAddon> {
    if (addon.shared) {
      throw new OmsError(
        "This addon was shared with you, not installed by you: only its owner can move it between groups.",
        "invalid_request",
      );
    }
    return this.update(addon.id, { movie_addon_group_id: groupId }, options);
  }

  /**
   * `DELETE /movie_addons/:id` - uninstalls. `204`, empty body.
   *
   * Owner only; uninstalling an addon somebody shared with you is `401`, and
   * the way to lose one of those is for the grantor to revoke the grant.
   *
   * Every grant ON this addon is `dependent: :destroy`, so deleting it revokes
   * the shares along with it. Grants that reached people through its GROUP are
   * untouched - they belong to the group, which still exists.
   *
   * @throws {OmsApiError} 404 for an id you cannot see, 401 for a shared one.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/movie_addons/${encodeURIComponent(id)}`, options);
  }
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
   * `MovieCollectionItem` carries `default_scope { order(position: :asc) }`
   * they come back interleaved by position rather than grouped by collection -
   * position 0 of each list, then position 1 of each, and so on. Grouping that
   * back together client-side works but reads like a bug when you first see it.
   *
   * `collectionId` accepts an array, which becomes `IN (...)`: one request for
   * the three lists a screen shows.
   *
   * The default order is `position:asc` and it is the useful one, so leave
   * `order` alone unless you want something else. Note that passing `order`
   * REPLACES the default (`QueryModifier` uses `reorder`), it does not add to
   * it, so `order: "created_at:desc"` loses the position ordering entirely.
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
   * The controller does `find_or_initialize_by(movie_collection_id, movie_type,
   * movie_id)` first, so adding the same title twice is a no-op-with-an-update
   * rather than a `400` off the unique index. This is deliberate: the heart
   * button and the "add to list" dialog both fire blind, holding only the
   * collection they already loaded. The upshot is that this call is safe to
   * repeat and safe to fire optimistically.
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
   * `creatable_by?` reads `movie_collection&.user == user`, and a missing
   * collection makes that `nil == user`, which is false. Do not read that `401`
   * as "the session expired".
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
   * `listing_scope` runs `MovieCollection.favorites_for(Current.user)` before
   * anything else, which `find_or_create_by!`s the "Favoritos" row (kind
   * `favorites`, position `-1`). The index is the only place that knows the
   * user has opened the movies app, so it is where the row gets minted. Two
   * consequences: a brand new account's first listing WRITES to the database,
   * and there is no other way to make favourites exist - a client that goes
   * straight to the heart button without ever listing has no collection to put
   * the title in. List first.
   *
   * A concurrent second tab racing the same first listing is handled: the
   * partial unique index raises, the model rescues `RecordNotUnique` and reads
   * the winner's row back.
   *
   * `items_count` is exact and free - the controller preloads
   * `:movie_collection_items` so the blueprint counts a loaded array instead of
   * firing a `COUNT` per row. {@link get} does not preload, so it costs one
   * `COUNT` there. Neither is a snapshot you can trust after a write.
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
   * The only `show` route in this whole namespace. It renders the `:extended`
   * view, which for these blueprints is byte-identical to the default view the
   * index returns: `ApplicationBlueprint` declares `view :extended do end`, and
   * a Blueprinter view INHERITS the base fields and adds nothing here. So
   * `show` is not a richer payload, only a single-row one.
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
   * `name` is the only field that survives: `before_create` overwrites `user`,
   * pins `kind` to `"manual"` and sets `position` to `max(position) + 1`.
   * Passing `kind: "favorites"` does not fail, it is just ignored, which is the
   * point - there is exactly one system collection and only the listing may
   * mint it.
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
   * A real partial update: `update_params :name, :position` permits those two
   * and nothing else, and an omitted key is left alone.
   *
   * Refused for the favourites row with
   * `401 "You are not authorized to update this resource"` - the GENERIC
   * message, because `updatable_by?` already returns false for a system
   * collection and the friendlier "The favourites collection cannot be renamed,
   * reordered or deleted" in `before_update` is never reached. Only
   * {@link reorder} produces that sentence. Test with
   * {@link isSystemMovieCollection} and hide the control instead.
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
   * Cascades: `movie_collection_items` is `dependent: :destroy`, so every title
   * in the list goes with it. Nothing is recoverable and nothing is asked.
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
   * Positions are written with `update_column` inside one transaction, which
   * skips validations and callbacks and - the part that catches people -
   * does NOT touch each item's `updated_at`. A client that syncs on
   * `updated_at` will not see a reorder. Refetch by position.
   *
   * The whole rewrite is one transaction, and items already at the right
   * position are skipped, so a reorder that changes nothing costs no writes.
   *
   * Refused for the favourites row with
   * `401 "The favourites collection cannot be renamed, reordered or deleted"` -
   * this is the one action that produces that message rather than the generic
   * one, because `reorder` calls `refuse_if_system!` itself before any
   * authorisation runs.
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

/**
 * The `movies.watchProgress` namespace: how far into each title the user got,
 * and what "Continuar a ver" is built from.
 *
 * This controller is the odd one out. It overrides `index`, `create` and
 * `destroy` instead of inheriting `CrudActions`, so none of the list DSL
 * applies, `create` answers `200`, and there is no `show` and no `update`.
 * Everything is an upsert keyed on `(user, movie_id, video_id)`.
 */
export class MovieWatchProgressesNamespace extends Resource {
  /**
   * `GET /movie_watch_progresses` - the caller's rows, newest first.
   *
   * Not paginated, and not filterable. The controller ignores the query string
   * entirely and runs a fixed
   * `order(last_watched_at: :desc).limit(500)`, so:
   *
   * - there is NO way to reach row 501. A user with more history than that
   *   simply cannot read the tail through this API;
   * - `search[...]` / `exact_search[...]` / `modifiers[...]` are not rejected,
   *   they are silently ignored - this index never touches the code that
   *   raises `400 "Unknown search filter"`. A client that thinks it asked for
   *   one title gets all 500 rows and, if it trusts the filter, the wrong
   *   answer. Filter client-side; that is why this method takes no params;
   * - there is no `ETag` either, because it does not go through
   *   `resources_stale?`.
   *
   * Finished rows are included. Build "Continuar a ver" by dropping
   * `finished === true` yourself, and remember an episode can be finished while
   * its series is not.
   *
   * @throws {OmsApiError} 401 for an anonymous caller, 403 for an OAuth token.
   */
  async list(options: RequestOptions = {}): Promise<MovieWatchProgress[]> {
    return this.http.get<MovieWatchProgress[]>("/movie_watch_progresses", options);
  }

  /**
   * `POST /movie_watch_progresses` - upserts ONE row. **`200`, not `201`.**
   *
   * This is the playback tick: call it while something is playing, throttled
   * by the player to whatever interval you like. `MovieWatchProgress.upsert_for`
   * finds by `(user, movie_id, video_id)` and updates in place, so it is
   * idempotent and safe to repeat - the only create in this file where opting
   * into `options.retry` is a good idea rather than a way to make duplicates.
   * (The transport does not replay non-safe methods unless you ask.)
   *
   * `movie_type` is NOT part of the key. Posting the same `(movie_id,
   * video_id)` with a different type rewrites the existing row's type rather
   * than creating a second one.
   *
   * Read {@link MovieWatchProgressInput.finished} and
   * {@link MovieWatchProgressInput.last_watched_at} before using this: a tick
   * that omits `last_watched_at` does not move the title up the list, and
   * `finished` has three states rather than two. A `finished` of `null` is
   * dropped by this method rather than sent, matching what the server would do
   * with it, so `finished` reaches the wire only as a real boolean.
   *
   * Use {@link saveMany} instead when you have more than a couple of rows -
   * see its docs for why one request is not just faster but differently shaped.
   *
   * @throws {OmsError} `invalid_request` when `movie_id`, `video_id` or
   *   `movie_type` is blank.
   * @throws {OmsApiError} 400 `"movie_id, video_id, movie_type are required"`
   *   from the server's own check, or a validation sentence such as
   *   `"Position must be greater than or equal to 0"`.
   */
  async save(
    input: MovieWatchProgressInput,
    options: RequestOptions = {},
  ): Promise<MovieWatchProgress> {
    return this.http.post<MovieWatchProgress>(
      "/movie_watch_progresses",
      watchProgressBody(input),
      options,
    );
  }

  /**
   * `POST /movie_watch_progresses/bulk` - upserts up to
   * {@link MOVIE_WATCH_BULK_LIMIT} rows in ONE request and ONE transaction.
   * `200`, with the saved rows in the order sent.
   *
   * ## Why this endpoint exists, and when to reach for it
   *
   * "Marcar temporada como vista" is one row per episode. A 24-episode season
   * through {@link save} is 24 POSTs: 24 round trips, 24 Puma threads taken in
   * turn, 24 chances for one to fail and leave the season half-marked, and 24
   * requests against the caller's 600/min ceiling. The comment on
   * `BULK_LIMIT` says it outright - "Marking a whole season watched would
   * otherwise be one POST per episode". This collapses it into one.
   *
   * The transaction is the other half of the point, and it cuts both ways:
   *
   * - **use {@link saveMany}** for a statement about several rows at once that
   *   must be all-or-nothing - mark a season watched or unwatched, restore a
   *   device's offline queue, seed history on first sync. If any entry is
   *   invalid the whole batch rolls back and answers `400`, so you never end up
   *   with episodes 1-9 marked and 10-24 not.
   * - **use {@link save}** for the continuous playback tick. One row, and a
   *   failure costs one tick that the next one will overwrite anyway. Batching
   *   ticks would trade a lost second for a lost minute.
   *
   * ## The silent-truncation trap this method closes
   *
   * The server does `Array(params[:items]).first(200)`: entries past the limit
   * are dropped without a word and the response is a cheerful `200` listing the
   * 200 that were saved. A 300-episode batch would look like it worked. This
   * method raises before sending instead, so split the work yourself - and note
   * that separate batches are separate transactions, so a split is no longer
   * atomic end to end.
   *
   * Retrying the whole batch is safe: every entry is the same upsert
   * {@link save} performs.
   *
   * @throws {OmsError} `invalid_request` for an empty list, for more than
   *   {@link MOVIE_WATCH_BULK_LIMIT} entries, or for an entry missing
   *   `movie_id`, `video_id` or `movie_type`.
   * @throws {OmsApiError} 400 `"items is required"` for an empty list that got
   *   through, or the first failing entry's validation sentence - and in that
   *   case NOTHING was saved.
   */
  async saveMany(
    inputs: readonly MovieWatchProgressInput[],
    options: RequestOptions = {},
  ): Promise<MovieWatchProgress[]> {
    if (inputs.length === 0) {
      throw new OmsError("saveMany needs at least one entry.", "invalid_request");
    }
    if (inputs.length > MOVIE_WATCH_BULK_LIMIT) {
      throw new OmsError(
        `saveMany takes at most ${MOVIE_WATCH_BULK_LIMIT} entries; got ${inputs.length}. The server would silently drop the rest and still answer 200, so split the batch yourself.`,
        "invalid_request",
      );
    }
    return this.http.post<MovieWatchProgress[]>(
      "/movie_watch_progresses/bulk",
      { items: inputs.map(watchProgressBody) },
      options,
    );
  }

  /**
   * Marks one playable watched or unwatched, explicitly.
   *
   * Sugar over {@link save} that exists because this is the exact call the
   * fixed bug was about. Marking something UNWATCHED sends `position: 0,
   * duration: 0`, and with `finished` absent the model's `set_finished` bails
   * on its `duration <= 0` guard and leaves the stored flag as it was - so the
   * tick never came off. Passing the boolean outright sets `finished_given`,
   * which makes the model skip that guard and write what you said.
   *
   * Defaults `position` and `duration` to `0` when you do not supply them,
   * which is right for "mark unwatched" and harmless for "mark watched"
   * precisely because the explicit flag stops the server deriving anything from
   * them. Supply the real numbers when you have them; the progress bar reads
   * them.
   *
   * `last_watched_at` is still yours to send, and still matters: marking an
   * episode watched without one leaves the series where it was in the list.
   */
  async setWatched(
    input: Omit<MovieWatchProgressInput, "finished">,
    watched: boolean,
    options: RequestOptions = {},
  ): Promise<MovieWatchProgress> {
    return this.save(
      { position: 0, duration: 0, ...input, finished: watched },
      options,
    );
  }

  /**
   * `DELETE /movie_watch_progresses/:id` - forgets ONE playable. `204`, empty
   * body.
   *
   * The id is the progress row's primary key, which for a series is one
   * episode. To forget a whole title use {@link forgetMovie}.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` for a row that is not
   *   yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(
      `/movie_watch_progresses/${encodeURIComponent(id)}`,
      options,
    );
  }

  /**
   * `DELETE /movie_watch_progresses/for_movie?movie_id=...` - forgets EVERY row
   * for a title. `204`, empty body.
   *
   * This is the "remover de Continuar a ver" button. For a series it destroys
   * the progress of every episode, not just the one on screen; there is no
   * per-season form and no undo.
   *
   * Note the verb: despite the `?movie_id=` query string this is a **DELETE**,
   * not a read. It is a collection route, so the `movie_id` is the addon's id
   * for the title (an IMDb id, say), never a `movie_watch_progresses` primary
   * key.
   *
   * `204` even when nothing matched, so the answer does not tell you whether
   * anything was there.
   *
   * @throws {OmsError} `invalid_request` for a blank id.
   * @throws {OmsApiError} 400 `"movie_id is required"`.
   */
  async forgetMovie(movieId: string, options: RequestOptions = {}): Promise<void> {
    assertPresent("movie_id", movieId);
    await this.http.delete<void>("/movie_watch_progresses/for_movie", {
      ...options,
      query: { movie_id: movieId },
    });
  }
}

/**
 * The `movies` namespace, reachable as `oms.movies`.
 *
 * Everything under it needs a session or a personal token. An OAuth access
 * token cannot reach any of it: `enforce_oauth_scope!` denies by omission and
 * no movies controller declares an `oauth_scope`, so a third-party client gets
 * `403 {"error":"insufficient_scope", "message": "This endpoint is not
 * reachable with an OAuth access token..."}` - one of the few structured error
 * bodies the API emits. That is a deliberate gate, not an oversight to route
 * around.
 */
export class MoviesNamespace extends Resource {
  /** Installed Stremio addons, plus `.groups` and `.grants` for sharing them. */
  readonly addons: MovieAddonsNamespace;
  /** Favourites and hand-made lists, plus `.items` for their contents. */
  readonly collections: MovieCollectionsNamespace;
  /** Playback position per title or episode; "Continuar a ver". */
  readonly watchProgress: MovieWatchProgressesNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.addons = new MovieAddonsNamespace(http);
    this.collections = new MovieCollectionsNamespace(http);
    this.watchProgress = new MovieWatchProgressesNamespace(http);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Copies the keys that were actually supplied.
 *
 * `undefined` is skipped so an omitted key never reaches the wire, while an
 * explicit `null` is kept: for these endpoints `null` means "clear this
 * column", and the two are not interchangeable. `finished` deliberately does
 * NOT go through here - see {@link watchProgressBody}.
 */
function pickOptional<T extends object>(
  source: T,
  keys: readonly (keyof T & string)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Builds the body for one watch-progress upsert.
 *
 * `finished` is only forwarded when it is a real boolean. A `null` would be
 * deleted by `MovieWatchProgressesController#progress_params` anyway
 * (`permitted.delete(:finished) if permitted[:finished].nil?`), so dropping it
 * here keeps the wire honest about what the server will act on.
 */
function watchProgressBody(input: MovieWatchProgressInput): Record<string, unknown> {
  assertPresent("movie_type", input.movie_type);
  assertPresent("movie_id", input.movie_id);
  assertPresent("video_id", input.video_id);
  const body: Record<string, unknown> = {
    movie_type: input.movie_type,
    movie_id: input.movie_id,
    video_id: input.video_id,
    ...pickOptional(input, [
      "season",
      "episode",
      "name",
      "episode_title",
      "poster",
      "position",
      "duration",
      "last_watched_at",
    ]),
  };
  if (typeof input.finished === "boolean") body.finished = input.finished;
  return body;
}

/** Fails fast on a value the server would answer for with a validation error. */
function assertPresent(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OmsError(`${field} is required and cannot be blank.`, "invalid_request");
  }
}

/**
 * Rejects a manifest the server would refuse.
 *
 * `validates :manifest_json, presence: true` treats an empty hash as blank, so
 * `{}` is a `400` just like `nil`. Worth catching here because the most common
 * way to send `{}` is a manifest fetch that failed and returned a falsy body.
 */
function assertManifest(manifest: StremioManifest): void {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new OmsError("manifest_json must be the fetched manifest object.", "invalid_request");
  }
  if (Object.keys(manifest).length === 0) {
    throw new OmsError(
      "manifest_json cannot be empty: the server treats {} as blank and answers 400.",
      "invalid_request",
    );
  }
}
