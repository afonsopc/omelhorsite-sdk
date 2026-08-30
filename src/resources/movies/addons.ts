/** The `movies.addons` area: installed Stremio addons, the groups that file them and the grants that share them. */

import type { ApiClient } from "../../http";
import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../listing";
import { OmsError } from "../../errors";
import type { BaseRecord, Id, Paginated, RequestOptions } from "../../types";
import { DEFAULT_PAGE_SIZE } from "../../types";
import type { User } from "../account";
import type { StremioManifest } from "./types";
import { assertPresent } from "../../internal/helpers";

/**
 * An installed addon: a manifest URL plus the manifest fetched from it.
 *
 * Rows reach a caller two ways, and {@link MovieAddon.shared} is how you tell
 * them apart: the ones the caller installed, and the ones somebody granted
 * them (directly, or through a group). A shared addon is read-only in
 * practice - every write against one is a `401`.
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
   * Absolute `http`/`https` URL of the manifest. Anything else is
   * `400 "Manifest url must be a valid URL"`.
   */
  readonly manifest_url: string;
  /**
   * The fetched manifest. Required: both a missing value and `{}` are
   * rejected, so an addon whose manifest failed to download cannot be stored
   * as a placeholder.
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
   * It is a full {@link User} as the account endpoints render one for the
   * caller - so `bio`, `country_code`, the `library_*` fields and the
   * visibility flags all come along, and `email` / `gender` / `group` appear
   * or not depending on who is asking.
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
 * The allowlist here is only the default: `id`, `created_at`, `updated_at`.
 * You CANNOT ask the server for "grants I made" versus "grants I received",
 * nor for the grants on one addon - those are `400`s. Filter on `grantor_id`
 * / `grantee_id` / `movie_addon_id` client-side after listing.
 */
export interface ListMovieAddonGrantsParams extends ListParams<never> {
  /** Exact match on the primary key. */
  readonly id?: Id;
}

/** `GET /movie_addon_grants` filters on {@link BASE_FILTER_COLUMNS} only. */
export const MOVIE_ADDON_GRANT_FILTER_COLUMNS = Object.freeze([] as const);

/** Longest name `MovieAddonGroup` accepts. Over it is a `400`. */
export const MOVIE_ADDON_GROUP_NAME_MAX_LENGTH = 80;

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
   * A group somebody shared with you never appears here even though its
   * addons do. The shared addons arrive from {@link MovieAddonsNamespace.list}
   * carrying a `movie_addon_group_id` you cannot resolve; render them under a
   * single "shared with me" heading rather than trying to look the group up.
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
   * `name` is the only writable field; the owner is always the caller, so
   * there is no way to create one for somebody else.
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
   * partial update: `name` is the only key accepted and nothing is assigned
   * behind your back.
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
   * - the addons inside SURVIVE and become ungrouped;
   * - every share made through this group is revoked. People who could see
   *   those addons stop seeing them, with no notification. Direct grants on
   *   the individual addons are untouched.
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
   * Both directions come back in one undifferentiated list and the index
   * accepts no filter to separate them, so split on `grantor_id === myUserId`
   * yourself.
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
   * The grantor is always the caller, so there is no way to make a grant in
   * somebody else's name.
   *
   * ## Failure modes, and which status each one is
   *
   * - **both targets, or neither** - `400 "Grant must target one addon or one
   *   group"`. Caught here before the request goes out.
   * - **a target you do not own, or granting to YOURSELF** - `401 "You are not
   *   authorized to create this resource"`. Not a `400` and not a `403`: the
   *   ownership check runs as an authorisation step, so a business-rule
   *   violation comes back wearing an authentication status. A generic error
   *   handler that logs the user out on `401` will do exactly that here.
   * - **granting the same target to the same person twice** - this is the one
   *   to be careful with. There is a partial unique index on
   *   `(movie_addon_id, grantee_id)` and another on
   *   `(movie_addon_group_id, grantee_id)`, and nothing checks them before the
   *   write, so the duplicate is not a tidy `400`: it answers **500**. List
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
   * Only the GRANTOR may revoke. The grantee can see the grant in
   * {@link list} but deleting it is
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
   * The result is a three-way `OR`: rows you own, rows granted to you
   * directly, and rows whose group was granted to you. That last arm is why a
   * grant on a group covers addons added to it later. An addon shared both
   * ways still appears once.
   *
   * Read {@link MovieAddon.shared} to tell the two kinds apart. Everything is
   * read-only for a shared row.
   *
   * The relation has NO default order. Always pass `order` - `"created_at:desc"`
   * gives "most recently installed first" - because paging an unordered
   * Postgres relation can repeat and drop rows between pages.
   *
   * **Array filters are silently ignored on this index.** `id` given as an
   * array is dropped without a `400` and you get the UNFILTERED list back. The
   * SDK only accepts a scalar for that reason. Unknown filter KEYS do fail
   * closed with a `400`.
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
   * Posting a manifest URL you already installed UPDATES that row - refreshing
   * `manifest_json` and reassigning `movie_addon_group_id` - instead of
   * colliding with the `(user_id, manifest_url)` unique index. The status
   * stays `201` and the `id` comes back unchanged, so `201` here does not mean
   * "new row"; compare `created_at` if you need to know.
   *
   * The practical consequence is the good one: reinstalling is idempotent and
   * the app can re-post its whole addon list on boot. The trap is the other
   * side of it - re-posting with `movie_addon_group_id` omitted leaves the
   * group as it was (the key is only assigned when present), while re-posting
   * it as `null` clears the group.
   *
   * `manifest_json` is stored as sent: no key is validated, no key is
   * stripped, and whatever you send is what everyone the addon is shared with
   * will later render. Fetch the manifest yourself and do not forward one a
   * third party handed you unchecked.
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
   * Deleting it revokes every grant ON this addon along with it. Grants that
   * reached people through its GROUP are untouched - they belong to the group,
   * which still exists.
   *
   * @throws {OmsApiError} 404 for an id you cannot see, 401 for a shared one.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/movie_addons/${encodeURIComponent(id)}`, options);
  }
}

/**
 * Rejects a manifest the server would refuse.
 *
 * The server treats an empty object as blank, so `{}` is a `400` just like a
 * missing one. Worth catching here because the most common way to send `{}`
 * is a manifest fetch that failed and returned a falsy body.
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
