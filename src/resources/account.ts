/**
 * The `account` namespace: the signed-in user, other users' public profiles,
 * the usage report behind the quota bars, and the sessions a credential can
 * see.
 *
 * `GET /account` is the canonical "who am I" call and the cheapest way to check
 * that a stored credential is still alive.
 */

import { OmsApiError } from "../errors";
import { type ApiClient, Resource, buildFormData, readJson } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../listing";
import { objectStoreFetch } from "./storage/upload";
import type {
  BaseRecord,
  FileInput,
  Id,
  PageLoader,
  Paginated,
  PageParams,
  QueryParams,
  RequestOptions,
  Timestamp,
} from "../types";
import { DEFAULT_PAGE_SIZE } from "../types";

/**
 * A user as the API renders them.
 *
 * Most fields are conditional: the blueprint hides `email` and `gender` unless
 * they are public or you are the owner or an administrator, and hides
 * `group`, `last_seen_at`, `sessions_count` and `deactivated_at` from everyone
 * but an administrator. An absent key therefore means "not visible to you",
 * never "empty".
 */
export interface User extends BaseRecord {
  /** Stable identifier. This is the OIDC `sub` claim. Never key on the handle. */
  readonly id: Id;
  /** Login name. Mutable: display it, do not store it as a foreign key. */
  readonly handle: string;
  readonly name?: string | null;
  readonly bio?: string | null;
  /** ISO 3166-1 alpha-2, as the user set it. */
  readonly country_code?: string | null;
  readonly email_is_public?: boolean;
  readonly gender_is_public?: boolean;
  readonly library_public?: boolean;
  readonly library_name?: string | null;
  readonly library_description?: string | null;
  /** Visible when public, or to the owner and administrators. */
  readonly email?: string | null;
  /** Visible when public, or to the owner and administrators. */
  readonly gender?: string | null;
  /** Privilege group, e.g. `"admin"`. Owner and administrators only. */
  readonly group?: string | null;
  /** Owner and administrators only. */
  readonly allowed_to_use_spotify?: boolean;
  /** Owner and administrators only: whether friends see this user's playback. */
  readonly share_listening?: boolean;
  /** Administrators only. */
  readonly last_seen_at?: Timestamp | null;
  /** Administrators only. */
  readonly sessions_count?: number;
  /** Administrators only. Non-null once the account is deactivated. */
  readonly deactivated_at?: Timestamp | null;
}

/**
 * The `:profile` view: everything in {@link User} plus the social counters.
 * Returned by `profile`, `byHandle`, `follow` and `unfollow`.
 */
export interface UserProfile extends User {
  readonly followers_count: number;
  readonly following_count: number;
  /** Whether the CALLER follows this user. `false` for an anonymous caller. */
  readonly is_following: boolean;
  /** `created_at` again, as an explicit ISO-8601 string. */
  readonly member_since: Timestamp;
}

/** One hit from {@link AccountNamespace.search}. Deliberately three fields. */
export interface UserSearchResult {
  readonly id: Id;
  readonly handle: string;
  readonly name?: string | null;
}

/**
 * Fields a user may change on their own account.
 *
 * Anything not listed here is dropped in silence and the call still answers
 * 200, so compare the returned {@link User} rather than trusting the status.
 * The avatar is not here: it is multipart, through
 * {@link AccountNamespace.updatePicture}.
 */
export interface UpdateAccountInput {
  readonly handle?: string;
  readonly name?: string;
  readonly bio?: string;
  readonly countryCode?: string;
  readonly emailIsPublic?: boolean;
  readonly genderIsPublic?: boolean;
  readonly gender?: string;
  readonly libraryPublic?: boolean;
  readonly libraryName?: string;
  readonly libraryDescription?: string;
  /** Whether friends may see what you are listening to. */
  readonly shareListening?: boolean;
}

/** One extension bucket of {@link AccountStorageUsage.top_extensions}. */
export interface AccountExtensionUsage {
  /** Lowercased extension with no dot, or `""` for a file that has none. */
  readonly ext: string;
  readonly count: number;
  readonly bytes: number;
}

/** One row of {@link AccountStorageUsage.biggest_files}. */
export interface AccountBiggestFile {
  readonly id: Id;
  readonly name: string;
  readonly size: number;
  readonly parent_id: Id | null;
}

/** One row of {@link AccountStorageUsage.biggest_folders}. */
export interface AccountBiggestFolder {
  readonly id: Id;
  readonly name: string;
  /** Sum of the file descendants, computed live. */
  readonly size: number;
}

/** The storage section of {@link AccountUsage}. */
export interface AccountStorageUsage {
  readonly used_bytes: number;
  /** The account's own ceiling, not the global default. */
  readonly max_bytes: number;
  readonly file_count: number;
  readonly directory_count: number;
  /** Up to six, biggest first. */
  readonly top_extensions: AccountExtensionUsage[];
  /** Up to five, biggest first. */
  readonly biggest_files: AccountBiggestFile[];
  /** Up to five direct children of the home folder, biggest first. */
  readonly biggest_folders: AccountBiggestFolder[];
}

/**
 * `GET /account/usage`: what the account has spent, per area.
 *
 * This is a bespoke report, not a quota answer: it carries breakdowns nothing
 * else has (the biggest files, the extension histogram) and it does NOT carry
 * every ceiling - the row ceiling on the file tree and the music byte ceiling
 * are absent from it. For ceilings, ask `oms.quotas.list()`, which answers all
 * of them in one call; each metered tool also still reports its own through
 * its `quota()`.
 */
export interface AccountUsage {
  readonly user: { readonly id: Id; readonly handle: string; readonly name: string | null };
  readonly storage: AccountStorageUsage;
  readonly music: {
    readonly songs: number;
    readonly playlists: number;
    readonly play_events_total: number;
    readonly play_events_30d: number;
  };
  readonly tickets: { readonly open: number; readonly closed: number };
  readonly messages: {
    readonly sent_30d: number;
    readonly received_30d: number;
    readonly unread: number;
  };
  readonly short_links: { readonly total: number; readonly total_clicks: number };
}

/**
 * One sign-in. The token itself is never rendered here: it is handed out once,
 * at `POST /sessions`, and never again.
 */
export interface AccountSession extends BaseRecord {
  readonly user_id: Id;
  readonly ip_address?: string | null;
  readonly user_agent?: string | null;
  /** Caller-set label, e.g. `"laptop"`. */
  readonly name?: string | null;
  /** Caller-set kind, e.g. `"cli"`. `"teapot"` suppresses login alerts. */
  readonly device_type?: string | null;
  readonly description?: string | null;
  /** Rewritten on every authenticated request this session makes. */
  readonly last_used_at?: Timestamp | null;
  /** The owner, rendered inline. */
  readonly user?: User;
}

/** Filter columns of `GET /sessions`, on top of {@link BASE_FILTER_COLUMNS}. */
export const ACCOUNT_SESSION_FILTER_COLUMNS = Object.freeze(["user_id"] as const);

/** Filters for {@link AccountSessionsNamespace.list}. */
export interface ListAccountSessionsParams extends ListParams<(typeof ACCOUNT_SESSION_FILTER_COLUMNS)[number]> {
  /** Administrators only: someone else's sessions. */
  readonly userId?: Id;
}

/** Fields that can change on a session after it exists. */
export interface UpdateAccountSessionInput {
  readonly name?: string;
  /** `"teapot"` silences the login and activity alerts for this session. */
  readonly deviceType?: string;
  readonly description?: string;
}

/**
 * Sessions of the current credential, reachable as `oms.account.sessions`.
 *
 * A session is the legacy credential: an opaque UUID with no scopes and no
 * expiry. Every login mints a new row, so a client that signs in on each
 * invocation fills this list up; persist the token instead.
 */
export class AccountSessionsNamespace extends Resource {
  /**
   * `GET /sessions` - your sessions, one row per sign-in. An administrator
   * sees everyone's and can narrow with `userId`.
   */
  async list(params: ListAccountSessionsParams = {}, options: RequestOptions = {}): Promise<Paginated<AccountSession>> {
    const base = { exactSearch: { user_id: params.userId } };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<AccountSession[]>("/sessions", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /** `GET /sessions/mine` - the session the current credential resolves to. */
  async current(options: RequestOptions = {}): Promise<AccountSession> {
    return this.http.get<AccountSession>("/sessions/mine", options);
  }

  /**
   * `PATCH /sessions/:id` - renames a session, or relabels its device.
   *
   * This is the only session call that honours the `:id` in the path.
   */
  async update(id: Id, input: UpdateAccountSessionInput, options: RequestOptions = {}): Promise<AccountSession> {
    return this.http.patch<AccountSession>(
      `/sessions/${encodeURIComponent(id)}`,
      { name: input.name, device_type: input.deviceType, description: input.description },
      options,
    );
  }

  /**
   * `DELETE /sessions/:id` - ends the session THIS credential is using.
   *
   * There is no argument on purpose. The endpoint never reads the `:id` in the
   * path: it destroys `Current.session`, whatever id you send. Revoking
   * another device's session is not possible through the API today, and a
   * method that appeared to do it would silently log the caller out instead.
   *
   * After this resolves the credential is dead; build a new client with a new
   * token rather than reusing this one.
   *
   * Costs a `GET /sessions/mine` first. The real id is sent even though the
   * endpoint ignores it, so the call stays correct if that is ever fixed.
   */
  async revokeCurrent(options: RequestOptions = {}): Promise<void> {
    const session = await this.current(options);
    await this.http.delete<void>(`/sessions/${encodeURIComponent(session.id)}`, options);
  }
}

/** The `account` namespace, reachable as `oms.account`. */
export class AccountNamespace extends Resource {
  /** Sessions: listing, relabelling, and ending the current one. */
  readonly sessions: AccountSessionsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.sessions = new AccountSessionsNamespace(http);
  }

  /**
   * `GET /account` - the user the current credential belongs to.
   *
   * @throws {OmsAuthError} 401 when the credential is missing or dead.
   */
  async me(options: RequestOptions = {}): Promise<User> {
    return this.http.get<User>("/account", options);
  }

  /**
   * `PATCH /users/:id` against your own id. Pass only the fields you are
   * changing; the API leaves the rest alone.
   *
   * Costs an extra `GET /account` first, because the endpoint is addressed by
   * id and the SDK holds no identity of its own. Unknown fields are dropped in
   * silence, so read the returned {@link User} to see what actually changed.
   */
  async update(input: UpdateAccountInput, options: RequestOptions = {}): Promise<User> {
    const me = await this.me(options);
    return this.http.patch<User>(`/users/${encodeURIComponent(me.id)}`, updateBody(input), options);
  }

  /**
   * `PATCH /users/:id` with a multipart body - replaces the avatar.
   *
   * The image is re-encoded server-side and capped at 1024px, so send the
   * original rather than a thumbnail. Costs an extra `GET /account`, same as
   * {@link update}.
   */
  async updatePicture(picture: FileInput, options: RequestOptions = {}): Promise<User> {
    const me = await this.me(options);
    const form = await buildFormData({ picture });
    const response = await this.http.raw("PATCH", `/users/${encodeURIComponent(me.id)}`, {
      ...options,
      body: form,
    });
    return (await readJson(response)) as User;
  }

  /**
   * `GET /account/usage` - consumption per area, for the bars the CLI prints
   * before starting an expensive job.
   */
  async usage(options: RequestOptions = {}): Promise<AccountUsage> {
    return this.http.get<AccountUsage>("/account/usage", options);
  }

  /** `GET /users/:id` - another user, by stable id. Requires a credential. */
  async get(id: Id, options: RequestOptions = {}): Promise<User> {
    return this.http.get<User>(`/users/${encodeURIComponent(id)}`, options);
  }

  /**
   * `GET /users/by_handle/:handle` - the public profile of a handle. Works
   * anonymously. Handles are mutable, so resolve once and keep the id.
   */
  async byHandle(handle: string, options: RequestOptions = {}): Promise<UserProfile> {
    return this.http.get<UserProfile>(`/users/by_handle/${encodeURIComponent(handle)}`, options);
  }

  /**
   * `GET /users/:id/profile` - the public profile with follow counters. Works
   * anonymously, and accepts a handle in place of an id.
   */
  async profile(id: Id, options: RequestOptions = {}): Promise<UserProfile> {
    return this.http.get<UserProfile>(`/users/${encodeURIComponent(id)}/profile`, options);
  }

  /**
   * `GET /users/search` - handle and name substring search, for a picker.
   *
   * Answers an empty list for a query under two characters, and never more
   * than eight hits: it is a lookup, not an enumeration, and there is no
   * paging. Throttled to 30 a minute per IP even when authenticated.
   */
  async search(query: string, options: RequestOptions = {}): Promise<UserSearchResult[]> {
    return this.http.get<UserSearchResult[]>("/users/search", { ...options, query: { q: query } });
  }

  /**
   * `GET /users/:id/picture` - the avatar bytes.
   *
   * SENT WITH NO CREDENTIAL AT ALL, and that is the point of this method rather
   * than an oversight.
   *
   * The endpoint is anonymous by design: `UsersController` lists `picture` in
   * `allow_unauthenticated_access`, and `User.viewable_by` is `->(user) { all }`,
   * so a signed-in caller and a stranger resolve the same row and get the same
   * bytes. Sending a credential buys nothing, and it is what breaks the call.
   *
   * Why it breaks. The action answers `302` to `minio.omelhorsite.pt` with a
   * presigned URL, and `fetch` follows that hop. Per the Fetch standard, when a
   * CORS request is redirected cross-origin and the request's origin already
   * differs from the current URL's origin, the origin is replaced by an opaque
   * one - so the second hop reaches the store with `Origin: null`. MinIO
   * answers a null origin with `Access-Control-Allow-Origin: *`. A wildcard is
   * illegal for a credentialed request no matter what
   * `Access-Control-Allow-Credentials` says, so a client built with
   * `sessionCookie: true` - the production web app - would have the browser
   * reject the response before any JavaScript saw it. Every avatar on the page
   * would fail, and fail as an opaque "Failed to fetch".
   *
   * Dropping the credential removes the wildcard problem entirely: an
   * uncredentialed request accepts `*`, so this behaves identically in a
   * browser, in Bun and in a Worker, in cookie mode and in token mode.
   *
   * Going around the transport costs the usual thing, the same trade
   * `storage.download` makes: no retry, no per-call deadline, and only the
   * caller's `signal` is honoured.
   *
   * Prefer {@link pictureUrl} when the avatar is going into an `<img>`. This
   * method is for when the bytes themselves are wanted - a re-upload, a cache,
   * a file written to disk.
   *
   * @throws {OmsApiError} 404 when the user does not exist OR has no avatar
   *   attached. The two are not distinguishable from the status alone.
   */
  async picture(id: Id, options: RequestOptions = {}): Promise<Blob> {
    const url = this.pictureUrl(id);
    const response = await objectStoreFetch(this.http)(url, {
      method: "GET",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // Not "include", and not a bearer header either. See the note above.
      credentials: "omit",
      redirect: "follow",
    });
    if (!response.ok) {
      throw new OmsApiError(
        response.status === 404
          ? "No avatar for that user: either the id is unknown or nothing is attached."
          : `Could not read the avatar (${response.status}).`,
        { status: response.status, method: "GET", url, attempts: 1 },
      );
    }
    return response.blob();
  }

  /**
   * Absolute URL of a user's avatar, for an `<img>`, a CSS `background-image`,
   * or anywhere else the platform fetches the bytes for you.
   *
   * Synchronous, and it has to stay that way. This gets called once per row
   * while rendering a friends list, a member picker or a message thread; an
   * async URL would turn every avatar into a state update and a second paint.
   *
   * It can be synchronous because the route carries no credential: `picture` is
   * in `allow_unauthenticated_access` and `User.viewable_by` is `all`, so there
   * is nothing to resolve and nothing to leak. The URL is safe to put in
   * markup, to log, and to hand to someone else.
   *
   * ```tsx
   * <img src={oms.account.pictureUrl(user.id)} alt={user.handle} />
   * ```
   *
   * Do NOT add a `crossorigin` attribute. Without one the element makes a
   * no-cors request and the `302` to the object store is followed with no CORS
   * check at all, which is why this path has always worked in the web app.
   * `crossorigin="use-credentials"` re-creates exactly the failure
   * {@link picture} documents, and `crossorigin="anonymous"` only buys the
   * ability to read the pixels back out of a canvas.
   *
   * A user with no avatar answers 404, so give the element an `onError` that
   * falls back to initials rather than assuming every id has an image.
   *
   * The `302` itself carries `Cache-Control: private, max-age=300` while the
   * presigned target is good for six hours, so a re-render inside five minutes
   * costs nothing and a cached redirect can never outlive its signature.
   */
  pictureUrl(id: Id): string {
    return this.http.url(`/users/${encodeURIComponent(id)}/picture`);
  }

  /** `POST /users/:id/follow` - returns the followed user's updated profile. */
  async follow(id: Id, options: RequestOptions = {}): Promise<UserProfile> {
    return this.http.post<UserProfile>(`/users/${encodeURIComponent(id)}/follow`, undefined, options);
  }

  /**
   * `DELETE /users/:id/follow` - returns the unfollowed user's updated
   * profile. Idempotent: unfollowing someone you do not follow still answers
   * 200.
   */
  async unfollow(id: Id, options: RequestOptions = {}): Promise<UserProfile> {
    return this.http.delete<UserProfile>(`/users/${encodeURIComponent(id)}/follow`, options);
  }
}

/** Maps the camelCase input onto the snake_case names the endpoint permits. */
function updateBody(input: UpdateAccountInput): Record<string, unknown> {
  return {
    handle: input.handle,
    name: input.name,
    bio: input.bio,
    country_code: input.countryCode,
    email_is_public: input.emailIsPublic,
    gender_is_public: input.genderIsPublic,
    gender: input.gender,
    library_public: input.libraryPublic,
    library_name: input.libraryName,
    library_description: input.libraryDescription,
    share_listening: input.shareListening,
  };
}


