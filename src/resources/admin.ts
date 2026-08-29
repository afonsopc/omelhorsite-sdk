/**
 * The `admin` namespace: OAuth client management and the operator surface.
 *
 * ## Three publics live in this one file. Do not confuse them.
 *
 * The routes below arrive as one list from the router and read as one feature,
 * but they answer to three completely different callers. Every sub-namespace
 * here is named so that the caller is legible from the call site alone:
 *
 * | reachable as                       | who may call it            | what it is |
 * | ---------------------------------- | -------------------------- | ---------- |
 * | `oms.admin.myApplications`         | any authenticated user     | the OAuth clients **you registered**, and the only place a `client_secret` is ever handed out |
 * | `oms.admin.authorizedApplications` | any authenticated user     | the applications **you gave access to your account**, and the button that takes it back |
 * | `oms.admin.identities`             | any authenticated user     | the Google/GitHub/Spotify logins **linked to your account** |
 * | `oms.admin.oauthApplications`      | **administrators only**    | the review queue and the registry of every client on the server |
 * | `oms.admin.quotas`                 | **administrators only**    | another person's ceilings |
 * | `oms.admin.jobs`                   | **administrators only**    | every background job on the server |
 * | `oms.admin.shortLinks`             | **administrators only**    | every public short link, and its traffic |
 * | `oms.admin.vocalSeparations`       | **administrators only**    | every separation run on the server |
 * | `oms.admin.chests`                 | **administrators only**    | aggregate chest statistics |
 * | `oms.admin.notepads`               | **administrators only**    | aggregate notepad statistics |
 * | `oms.admin.eventAlerts`            | **administrators only**    | the Discord alert catalogue |
 *
 * The rule to remember: **a sub-namespace whose class name starts with `Admin`
 * is administrator-only**, and everything under it answers `403` to everybody
 * else. The three that are not administrator-only are
 * {@link MyOauthApplicationsNamespace},
 * {@link AuthorizedApplicationsNamespace} and
 * {@link LinkedIdentitiesNamespace}, and they are here because they are the
 * other two thirds of the same OAuth story, not because they need privilege.
 *
 * The naming collision they are here to prevent is real and expensive:
 * `myApplications.destroy(id)` deletes a client **you own**, while
 * `oauthApplications.destroy(id)` deletes **anybody's** client on the whole
 * server, and both take the same integer. One is a tidy-up, the other is an
 * outage for whoever was using it.
 *
 * ## Registration is open; being usable is not
 *
 * This is a product decision of this project and it is not the OAuth default,
 * so it is worth stating plainly before you build anything on top:
 *
 * > **Any authenticated user may register an OAuth client, and nothing they
 * > register works until an administrator approves it.**
 *
 * A freshly registered client is `approval_status: "pending"`. It has a real
 * `client_id`, it shows up in {@link MyOauthApplicationsNamespace.list}, and it
 * **cannot mint a single token**: every grant type funnels through
 * `OauthApplication.by_uid`, which refuses anything that is not `approved`, so
 * a device-flow start against a pending client answers `invalid_client`. There
 * is no partial state, no "works for your own account", no grace period.
 *
 * The reason is anti-phishing. The consent screen renders the client's name
 * right next to the signed-in identity, so an unreviewed client called
 * "omelhorsite Oficial" is a phishing page wearing the owner's brand. That is
 * also why the gate does not stop at registration:
 *
 * - **editing an approved client can un-approve it.** Renaming it, WIDENING its
 *   scopes, or moving its `redirect_uri` sends it straight back to `pending`
 *   and it stops resolving on the very next request. Narrowing scopes does not.
 *   See {@link MyOauthApplicationsNamespace.update}, which is where the whole
 *   rule is written down, and {@link editWouldRequeue}, which predicts it
 *   before you spend the call.
 * - **approving is receipted.** An administrator who rendered a client and then
 *   approves a row that changed underneath gets `409 review_stale` instead of a
 *   rubber stamp. See {@link AdminOauthApplicationsNamespace.approve}.
 *
 * ## `403` on the administrator half, and what it looks like
 *
 * Every `/admin/*` route sits behind one `before_action` that answers
 * `403 Forbidden` with the bare JSON string `"Admin access required"` when
 * `Current.user.admin?` is not true. It is not hidden behind a `404` and it is
 * not silently empty, so the SDK does not hide it either: it arrives as an
 * {@link OmsAuthError} with `status === 403`, `code === "forbidden"`,
 * `authenticationRequired === false` and `message === "Admin access required"`.
 *
 * `authenticationRequired` is the field worth branching on. It is `false` here,
 * which means the credential is perfectly good and the ACT is not allowed -
 * re-authenticating changes nothing, and a client that reflexively runs its
 * login flow on any 4xx will loop forever on this one. Check for admin rights
 * once, up front, and degrade the UI; do not discover them per request.
 *
 * There is no endpoint that answers "am I an admin". `GET /account` carries the
 * user's `group`, which is what the web frontend reads.
 *
 * ## Rate limits
 *
 * No `/admin/*` route has a rule of its own: they are all covered by the
 * general authenticated ceiling of **600 requests per minute**. The one
 * genuinely tight budget in this file is on the owner half -
 * {@link MyOauthApplicationsNamespace.create} is capped at **10 per hour and 20
 * per day per owner** - and it is documented on the method.
 */

import type { Job } from "./jobs";
import type { QuotaPeriod, QuotaResource, QuotaUnit } from "./quotas";
import type { VocalSeparation } from "./tools/vocalSeparation";
import { Resource, pageModifier } from "../http";
import type { OmsScope } from "../auth/tokens";
import {
  createPage,
  type Id,
  type PageParams,
  type Paginated,
  type QueryParams,
  type RequestOptions,
  type Timestamp,
} from "../types";

/* ========================================================================== *
 *  Shapes shared by the owner half and the administrator half
 * ========================================================================== */

/**
 * Where a client sits in the review queue.
 *
 * There is no fourth state and in particular there is no "suspended": pulling
 * an approved client back off the air is `"rejected"`, which is why
 * {@link AdminOauthApplicationsNamespace.reject} accepts a client that was
 * already approved.
 *
 * A database check constraint pins the column to exactly these three, so this
 * union is closed rather than widened to `string`.
 */
export type OauthApprovalStatus = "pending" | "approved" | "rejected";

/** Every value {@link OauthApprovalStatus} can take, for building filters. */
export const OAUTH_APPROVAL_STATUSES: readonly OauthApprovalStatus[] = Object.freeze([
  "pending",
  "approved",
  "rejected",
]);

/**
 * A person attached to a client: its owner, or the administrator who decided.
 *
 * Three keys and no more. This is not the full user record - the controllers
 * build it by hand precisely so that reviewing a client does not leak an email
 * address or a session count into an admin panel.
 */
export interface OauthApplicationParty {
  /** User id. A string, like every user id in this API. */
  readonly id: Id;
  readonly handle: string;
  /** Display name. `null` for an account that never set one. */
  readonly name: string | null;
}

/**
 * The shape both halves render for a registered OAuth client.
 *
 * `OauthApplicationsController#summary` and
 * `Admin::OauthApplicationsController#summary` are two methods that emit the
 * same eleven keys on purpose, so one renderer works on both surfaces. The
 * differences are in the VALUES, not the keys, and there are exactly two:
 *
 * - `approved_by` is hardcoded `null` on the owner routes. Which administrator
 *   decided what is deliberately withheld from the applicant, so read it as
 *   "not disclosed", not as "nobody approved it";
 * - the owner routes only ever show you your own rows, so `owner` there is
 *   always you.
 */
export interface OauthApplicationSummary {
  /**
   * Primary key, and an **integer**. `oauth_applications` is a Doorkeeper
   * table and kept the bigint primary key the gem ships with, so this is one of
   * the handful of ids in this API that is not a string. Do not compare it
   * against an {@link Id}.
   */
  readonly id: number;
  /** The public `client_id`, i.e. the `uid` column. Not a secret. */
  readonly client_id: string;
  /** What the consent screen renders. At most 60 characters. */
  readonly name: string;
  /**
   * Already split. Doorkeeper stores one space-separated string; both
   * controllers call `.to_a` before rendering, so what arrives here is an
   * array and never needs splitting.
   *
   * An EMPTY array would be dangerous rather than harmless - in Doorkeeper a
   * blank scopes column means "every scope the server has", not "none" - which
   * is why both write paths refuse to save one.
   */
  readonly scopes: string[];
  /**
   * `true` for a client that holds a secret. Frozen after registration: see
   * {@link MyOauthApplicationsNamespace.update} for why neither direction is
   * editable.
   */
  readonly confidential: boolean;
  /**
   * Every registered redirect URI, in ONE space-separated string, exactly as
   * Doorkeeper stores it. Use {@link splitRedirectUris} rather than reading it
   * raw.
   *
   * Matching at the authorization endpoint is exact - no wildcards, no prefix
   * match, no fragment - so a URI that looks nearly right matches nothing.
   */
  readonly redirect_uri: string;
  readonly approval_status: OauthApprovalStatus;
  /** When it was approved, `null` while pending or rejected. */
  readonly approved_at: Timestamp | null;
  /** The reason shown to the owner. `null` unless rejected. At most 500 characters. */
  readonly rejection_reason: string | null;
  /**
   * Who registered it. `null` for the clients this project ships itself
   * (`owner_id` is deliberately NULL for those) **and** for a client whose
   * owner deleted their account.
   *
   * Because those two cases are indistinguishable here, `owner === null` is
   * NOT a trust signal. See {@link isShippedClient}.
   */
  readonly owner: OauthApplicationParty | null;
  /**
   * The administrator who approved it, or `null`.
   *
   * Always `null` on {@link MyOauthApplicationsNamespace} regardless of the
   * truth. Populated on {@link AdminOauthApplicationsNamespace}.
   */
  readonly approved_by: OauthApplicationParty | null;
  readonly created_at: Timestamp;
}

/**
 * A client YOU registered, as {@link MyOauthApplicationsNamespace} renders it.
 *
 * A distinct name from {@link AdminOauthApplication} even though the keys are
 * identical, so that a function taking one cannot be handed the other by
 * accident. They come from different endpoints with different blast radii.
 */
export interface OwnedOauthApplication extends OauthApplicationSummary {
  /** Always `null` here. The owner routes never disclose the reviewer. */
  readonly approved_by: null;
}

/**
 * The response of the two calls that MINT a client secret:
 * {@link MyOauthApplicationsNamespace.create} and
 * {@link MyOauthApplicationsNamespace.rotateSecret}.
 *
 * `client_secret` is the only value in this whole API you cannot ask for twice.
 * The server hashes secrets (`hash_application_secrets` is on), so the column
 * holds a SHA256 and there is nothing to read back: losing the string means
 * rotating, and rotating breaks whatever was using the old one. Capture it in
 * the same expression that made the call.
 */
export interface OwnedOauthApplicationWithSecret {
  readonly application: OwnedOauthApplication;
  /**
   * The plaintext secret, ONCE. `null` for a public client, which is most of
   * them: a public client has no secret by design, and `confidential: false`
   * is the normal choice for anything that ships to end users.
   */
  readonly client_secret: string | null;
}

/**
 * What {@link MyOauthApplicationsNamespace.destroy} answers with.
 *
 * Note the key: **`client_id`**. The administrator's delete answers the same
 * three values under the key `uid` instead
 * ({@link AdminOauthApplicationDeletion}). Two controllers, two spellings of
 * one column, and nothing normalises them - a shared renderer reading
 * `client_id` shows `undefined` for half the app.
 */
export interface OwnedOauthApplicationDeletion {
  readonly id: number;
  readonly client_id: string;
  /** Access tokens that were alive and are not any more. `0` is normal. */
  readonly revoked_tokens: number;
}

/** Arguments for {@link MyOauthApplicationsNamespace.create}. */
export interface CreateOauthApplicationInput {
  /**
   * At most 60 characters AFTER normalisation, and normalisation is not a
   * `trim`: the server strips zero-width and bidi characters first, so 60
   * characters of padding is not a 60 character name and a name made only of
   * bidi overrides is refused as blank (`name_required`).
   */
  readonly name: string;
  /**
   * At least one scope the server knows. An unknown scope is **dropped, not
   * refused**, so a typo quietly narrows the client instead of registering
   * something nobody asked for - but if EVERY scope you sent was unknown the
   * result is `400 unknown_scope`.
   *
   * A string is accepted too and is split on whitespace or commas, but pass the
   * array: it is the shape that cannot be misread.
   */
  readonly scopes: readonly (OmsScope | string)[] | string;
  /**
   * `true` to mint a client secret. Defaults to `false`.
   *
   * **This is the only chance you get.** The flag is frozen after registration
   * (see {@link MyOauthApplicationsNamespace.update}), so a client that changes
   * its mind has to be registered again from scratch. Choose `false` for
   * anything that ships to end users - a secret inside a distributed binary is
   * not a secret - and `true` only for something running on a server you
   * control.
   */
  readonly confidential?: boolean;
  /**
   * Every redirect URI, space separated, or omitted.
   *
   * **Omitting it is the right answer for a CLI or a native app**: blank
   * registers the RFC 8252 loopback pair
   * ({@link NATIVE_LOOPBACK_REDIRECT_VALUE}), which is the only shape whose
   * authorization code cannot land anywhere but the requester's own machine.
   *
   * It is otherwise the most dangerous field on the form. Matching is exact,
   * and a redirect URI pointing at something an attacker controls IS account
   * takeover - PKCE does not help, it binds the code to the client that started
   * the flow, not to where the code is delivered. The server refuses anything
   * that is not `https`, not loopback `http`, carries userinfo, carries a
   * wildcard host or has no host at all, and it does so with a `422`
   * (`validation_failed`) rather than by quietly rewriting your value.
   */
  readonly redirect_uri?: string;
}

/**
 * Arguments for {@link MyOauthApplicationsNamespace.update}.
 *
 * **An absent key means "leave it alone"; a present key means "write this".**
 * The controller branches on `params.key?`, so sending a field at all is asking
 * for it to be written, and writing the same value it already had still counts
 * as a write for the purposes of the requeue rule below.
 *
 * Never send `null`. The transport encodes `null` in a query as the backend's
 * null sentinel, and in a JSON body it reaches the column as a blanking of a
 * `NOT NULL` field: a `422`, at best.
 */
export interface UpdateOauthApplicationInput {
  readonly name?: string;
  readonly scopes?: readonly (OmsScope | string)[] | string;
  readonly redirect_uri?: string;
}

/* ========================================================================== *
 *  Server constants, mirrored so a client can warn before a round trip
 * ========================================================================== */

/** `OauthApplicationsController::NAME_MAX_LENGTH`, measured after normalisation. */
export const OAUTH_APP_NAME_MAX_LENGTH = 60;

/**
 * `OauthApplication::MAX_PENDING_PER_OWNER`.
 *
 * How many of ONE person's clients may sit in the review queue at once. The
 * sixth answers `429 too_many_pending`, and so does an edit that would send a
 * sixth approved client back into the queue. Deleting a pending client frees
 * its slot immediately.
 */
export const OAUTH_APP_MAX_PENDING = 5;

/** `Oauth::RedirectUri::MAX_URIS`. More than this is `400 redirect_uri_excessive`. */
export const OAUTH_REDIRECT_URI_MAX_COUNT = 8;

/** `Oauth::RedirectUri::MAX_LENGTH`, counted across the whole space-separated string. */
export const OAUTH_REDIRECT_URI_MAX_LENGTH = 1024;

/**
 * `Oauth::RedirectUri::NATIVE_LOOPBACK` - what a blank `redirect_uri` registers.
 *
 * RFC 8252 section 7.3. No port, because the client listens on an ephemeral one
 * and Doorkeeper's `URIChecker` drops the port from both sides before
 * comparing, so `http://127.0.0.1:49731/callback` matches the first entry.
 *
 * Both literals, because `127.0.0.1` and `[::1]` are two different hosts to
 * that comparison and an IPv6-only machine can only bind the second.
 * `localhost` is deliberately absent and registering it is a mistake: `IPAddr`
 * cannot parse a name, so the gem does not treat it as loopback and would then
 * demand an exact port match, which is the one thing an ephemeral port cannot
 * promise.
 */
export const NATIVE_LOOPBACK_REDIRECT_URIS: readonly string[] = Object.freeze([
  "http://127.0.0.1/callback",
  "http://[::1]/callback",
]);

/** {@link NATIVE_LOOPBACK_REDIRECT_URIS} as the single column value the server stores. */
export const NATIVE_LOOPBACK_REDIRECT_VALUE = "http://127.0.0.1/callback http://[::1]/callback";

/**
 * The `client_id`s this project ships itself, pinned in
 * `Oauth::FirstPartyClients` (`CLI_CLIENT_ID`, `MCP_CLIENT_ID`).
 *
 * Pinned constants rather than values generated per environment, so matching on
 * them is stable across dev, CI and production.
 */
export const SHIPPED_CLIENT_IDS: readonly string[] = Object.freeze(["oms-cli", "oms-mcp"]);

/**
 * True for a client this project ships, by `client_id`.
 *
 * **Use this, not `owner === null`.** A NULL owner means two very different
 * things - "registered by the operator" and "orphaned when its owner deleted
 * their account" - and calling an orphan official is exactly the lie the whole
 * review gate exists to prevent. The backend draws the same distinction
 * (`shipped_by_the_house?` vs `first_party?`) and the consent screen uses the
 * pinned list too.
 */
export function isShippedClient(application: { readonly client_id: string }): boolean {
  return SHIPPED_CLIENT_IDS.includes(application.client_id);
}

/**
 * Splits the one space-separated `redirect_uri` column into the URIs it holds.
 *
 * Doorkeeper keeps every registered redirect URI in a single column. Splitting
 * on whitespace is exactly what `Oauth::RedirectUri.normalize` does on the way
 * in, so what comes back out is what was registered, character for character.
 */
export function splitRedirectUris(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\s+/)
    .map((uri) => uri.trim())
    .filter((uri) => uri.length > 0);
}

/**
 * Normalises a redirect URI list the way the server will store it.
 *
 * Split, trim, de-duplicate, join with single spaces. **Nothing else.** No
 * trailing slash is added or removed, no scheme is upgraded, no case is folded:
 * redirect matching is exact, so quietly "fixing" a URI would register
 * something the client can never match and the failure would only appear at the
 * end of a login attempt.
 *
 * A blank result means the server will register
 * {@link NATIVE_LOOPBACK_REDIRECT_VALUE}, which is what
 * {@link registeredRedirectUris} makes explicit.
 */
export function normalizeRedirectUris(raw: string | null | undefined): string {
  return splitRedirectUris(raw)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(" ");
}

/**
 * What the server will actually store for this input, blank included.
 *
 * Use it to compare a form against a record: an empty field and a field holding
 * the loopback pair register the same value, so comparing the raw strings would
 * report a change that is not one.
 */
export function registeredRedirectUris(raw: string | null | undefined): string {
  const normalized = normalizeRedirectUris(raw);
  return normalized.length > 0 ? normalized : NATIVE_LOOPBACK_REDIRECT_VALUE;
}

/**
 * Predicts whether an edit will send an APPROVED client back to the review
 * queue, before the call is made.
 *
 * Losing an approval without being told is the difference between "I did that"
 * and "this is broken": the client keeps its `client_id`, keeps working for
 * about as long as its live tokens last, and then starts answering
 * `invalid_client` with nothing in the request to explain it. Warn first.
 *
 * The rule reproduced here is spread across two places in the backend - a
 * `before_save` on the model covers the name and the scopes, and
 * `OauthApplicationsController#update` covers the redirect URI - and it is:
 *
 * - a client that is not `approved` cannot be sent back to a queue it is
 *   already in, so this is always `false` for `pending` and `rejected`;
 * - **any** change of name requeues. The name is what the consent screen shows;
 * - **widening** scopes requeues. Narrowing does not: asking for less than what
 *   was already reviewed has nothing left to review;
 * - **any** move of the redirect URI requeues, in either direction. There is no
 *   "narrower" destination - a different destination is a different
 *   destination, and it is where the authorization code gets delivered.
 *
 * This is a prediction, not the enforcement. The server decides, and the
 * `approval_status` on the response is the answer.
 */
export function editWouldRequeue(
  application: OauthApplicationSummary,
  next: { readonly name: string; readonly scopes: readonly string[]; readonly redirectUris: string },
): boolean {
  if (application.approval_status !== "approved") return false;
  if (next.name.trim() !== application.name) return true;
  if (next.scopes.some((scope) => !application.scopes.includes(scope))) return true;
  return registeredRedirectUris(next.redirectUris) !== registeredRedirectUris(application.redirect_uri);
}

/** Normalises {@link CreateOauthApplicationInput.scopes} into the array the API reads. */
function scopeList(scopes: readonly string[] | string): string[] {
  const parts = Array.isArray(scopes) ? scopes : String(scopes).split(/[\s,]+/);
  return parts.map((scope) => String(scope).trim()).filter((scope) => scope.length > 0);
}

/* ========================================================================== *
 *  YOUR OWN clients - any authenticated user
 * ========================================================================== */

/**
 * `oms.admin.myApplications` - the OAuth clients **you registered**.
 *
 * Needs an ordinary authenticated session and nothing more. Every action starts
 * from a relation already narrowed to the caller, so another person's id and an
 * id that was never issued produce the identical `404` and there is no way to
 * probe whether a client exists.
 *
 * **This is not `/oauth/*`.** Doorkeeper's own client CRUD is not mounted at
 * all (`/oauth/applications` is a hard 404); `/oauth_applications` is this
 * application's own JSON API and is authenticated the same way every other
 * endpoint here is. Authentication is by SESSION, deliberately: you do not
 * manage the keys to the house with a key to the house, and an OAuth token
 * cannot reach these routes.
 *
 * Remember the product rule: what you register here does not work until an
 * administrator approves it. See the namespace documentation.
 *
 * Every error on this surface carries a STRUCTURED body -
 * `{ "error": "<code>", "message": "<PT-PT sentence>" }`, plus an `errors`
 * array of model messages on a `422`. That is unusual in this API, where an
 * error is normally a bare JSON string, and it is worth using: read
 * `OmsApiError.body.error` for the code and branch on that. The `message` is
 * written in one language.
 */
export class MyOauthApplicationsNamespace extends Resource {
  /**
   * `GET /oauth_applications` - every client you registered, newest first.
   *
   * Whatever their approval state, on purpose: a pending client has to stay
   * visible to the person waiting on it. There is no pagination, no state
   * filter and no ETag on this route - one person's list has units in it, not
   * pages, and {@link OAUTH_APP_MAX_PENDING} plus the registration throttle
   * keep it that way.
   *
   * The response is enveloped (`{ applications: [...] }`); this method unwraps
   * it. An empty list is `[]`, never `null`.
   *
   * A `client_secret` never appears here. There is exactly one serializer
   * behind this route and it has no branch that could emit one.
   */
  async list(options: RequestOptions = {}): Promise<OwnedOauthApplication[]> {
    const body = await this.http.get<{ applications?: OwnedOauthApplication[] }>("/oauth_applications", options);
    return body?.applications ?? [];
  }

  /**
   * `GET /oauth_applications/:id` - one of your clients.
   *
   * @throws {OmsApiError} 404 `not_found` for an id that is not yours, which is
   *   byte for byte the answer for an id that never existed. The primary key is
   *   a walkable integer sequence, so the absence of a `403` here is the point:
   *   there is no existence oracle to walk.
   */
  async get(id: number | string, options: RequestOptions = {}): Promise<OwnedOauthApplication> {
    const body = await this.http.get<{ application: OwnedOauthApplication }>(
      `/oauth_applications/${encodeURIComponent(String(id))}`,
      options,
    );
    return body.application;
  }

  /**
   * `POST /oauth_applications` - registers a client. Answers `201`.
   *
   * The client lands as `pending` and **cannot mint a single token until an
   * administrator approves it**. It does get a real `client_id` immediately,
   * and it appears in {@link list} straight away, so "I have a client_id" is
   * not the same as "I have a working client". Registering also rings a Discord
   * alert on the review queue, because a review gate nobody is told about is a
   * feature that quietly does not work.
   *
   * **The response is the only place `client_secret` will ever exist.** Capture
   * it now; see {@link OwnedOauthApplicationWithSecret}. It is `null` for a
   * public client.
   *
   * **Two different `429`s guard this endpoint and they need opposite
   * reactions:**
   *
   * - rack-attack allows **10 registrations per hour and 20 per day, keyed by
   *   the OWNER** (not the session, so logging in again does not buy a fresh
   *   budget). It answers `{"error":"rate_limited","retry_after":N}` WITH a
   *   `Retry-After` header, so the {@link OmsQuotaError} carries
   *   `retryAfterMs`. Waiting fixes it.
   * - the controller refuses a sixth PENDING client with
   *   `{"error":"too_many_pending", ...}` and **no** `Retry-After`, so
   *   `retryAfterMs` is `undefined`. Waiting does NOT fix that one: a human has
   *   to decide on one of the five, or you have to delete one. Read
   *   `OmsApiError.body.error` to tell them apart, not the status.
   *
   * Retries are disabled. Both reasons matter: a replay after a lost response
   * mints a SECOND client with a different `client_id`, leaving an orphan in a
   * queue a person has to work through; and the transport retries `429` for
   * every method, which on the `too_many_pending` branch would burn three of
   * the ten hourly registrations on an answer that cannot change.
   *
   * @throws {OmsQuotaError} 429, from either producer above.
   * @throws {OmsApiError} 400 `name_required`, `name_too_long`,
   *   `scopes_required`, `unknown_scope` or `redirect_uri_excessive`; 422
   *   `validation_failed` with an `errors` array when the redirect URI is a
   *   shape this server will not register.
   */
  async create(
    input: CreateOauthApplicationInput,
    options: RequestOptions = {},
  ): Promise<OwnedOauthApplicationWithSecret> {
    return this.http.post<OwnedOauthApplicationWithSecret>(
      "/oauth_applications",
      {
        name: input.name,
        scopes: scopeList(input.scopes),
        ...(input.confidential === undefined ? {} : { confidential: input.confidential }),
        ...(input.redirect_uri === undefined ? {} : { redirect_uri: input.redirect_uri }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /oauth_applications/:id` - edits name, scopes or redirect URIs.
   *
   * **Read {@link editWouldRequeue} before calling this on an approved
   * client.** Renaming it, widening its scopes or moving its redirect URI
   * returns it to `pending`, clears the approval stamps, and stops it resolving
   * on the very next request. That is the anti-phishing rule working, not a
   * bug: without it you could get "A Minha Appzinha" approved and rename it to
   * "omelhorsite Oficial" a minute later, or get a loopback client approved and
   * repoint it at your own server, which since `authorization_code` is enabled
   * means the authorization code itself is delivered to you. The
   * `approval_status` on the response is the authoritative answer.
   *
   * **What is NOT editable, and why the omissions are deliberate:**
   *
   * - `confidential`. Flipping it `true -> false` downgrades authentication for
   *   an already-approved client: Doorkeeper authenticates a public client on
   *   its `client_id` alone, and a `client_id` is not a secret - it travels in
   *   the clear in every device authorization request. The reverse direction is
   *   merely broken: secrets are minted on create only, so `false -> true`
   *   would 422 on a missing secret. One direction is a security downgrade and
   *   the other is a dead end, so the field is frozen; a client that changes its
   *   mind registers a new one.
   * - `client_id`. It is the identity the approval was granted to. Editable, it
   *   would move an approval onto a different client.
   * - anything approval-shaped. The owner never writes their own verdict.
   *
   * An edit that requeues an approved client SPENDS a slot against
   * {@link OAUTH_APP_MAX_PENDING} and can therefore answer `429
   * too_many_pending`. Editing a client that is already pending, or narrowing
   * an approved client's scopes, costs nothing and keeps working with a full
   * queue - otherwise the ceiling would trap you into being unable to fix the
   * very clients that are waiting.
   *
   * @throws {OmsApiError} 409 `first_party_immutable` for `oms-cli` or
   *   `oms-mcp`; 404 `not_found`; 400 for the name and scope codes; 422
   *   `validation_failed` for a refused redirect URI.
   * @throws {OmsQuotaError} 429 `too_many_pending`, with no `Retry-After`.
   */
  async update(
    id: number | string,
    input: UpdateOauthApplicationInput,
    options: RequestOptions = {},
  ): Promise<OwnedOauthApplication> {
    const body = await this.http.patch<{ application: OwnedOauthApplication }>(
      `/oauth_applications/${encodeURIComponent(String(id))}`,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.scopes === undefined ? {} : { scopes: scopeList(input.scopes) }),
        ...(input.redirect_uri === undefined ? {} : { redirect_uri: input.redirect_uri }),
      },
      options,
    );
    return body.application;
  }

  /**
   * `DELETE /oauth_applications/:id` - deletes one of your clients.
   *
   * Answers **`200` with a body**, not the `204` most destroys in this API
   * answer, because the count of tokens it just killed is worth reporting. Live
   * tokens, access grants and pending device grants are revoked first and the
   * row goes afterwards.
   *
   * Deleting a pending client frees its queue slot immediately, which is the
   * cure for `too_many_pending`.
   *
   * The body's key is **`client_id`**. The administrator's delete spells the
   * same value `uid`. See {@link OwnedOauthApplicationDeletion}.
   *
   * @throws {OmsApiError} 409 `first_party_immutable` for a shipped client; 404
   *   `not_found` otherwise.
   */
  async destroy(id: number | string, options: RequestOptions = {}): Promise<OwnedOauthApplicationDeletion> {
    return this.http.delete<OwnedOauthApplicationDeletion>(
      `/oauth_applications/${encodeURIComponent(String(id))}`,
      options,
    );
  }

  /**
   * `POST /oauth_applications/:id/rotate_secret` - mints a new client secret.
   *
   * `POST` rather than `PATCH` because it MINTS a value: the response is the
   * only place the new secret ever appears, and the old one stops working the
   * instant this returns.
   *
   * Confidential clients only. It does NOT touch approval (nothing an
   * administrator reviewed has changed, so the anti-phishing callback correctly
   * does not fire) and it does NOT touch live tokens - killing those is a
   * louder, separate decision and it belongs to an administrator
   * ({@link AdminOauthApplicationsNamespace.revokeTokens}).
   *
   * @throws {OmsApiError} 400 `not_confidential` for a public client, which has
   *   no secret to rotate; 409 `first_party_immutable` for a shipped client;
   *   404 `not_found`.
   */
  async rotateSecret(
    id: number | string,
    options: RequestOptions = {},
  ): Promise<OwnedOauthApplicationWithSecret> {
    return this.http.post<OwnedOauthApplicationWithSecret>(
      `/oauth_applications/${encodeURIComponent(String(id))}/rotate_secret`,
      undefined,
      options,
    );
  }
}

/* ========================================================================== *
 *  Applications YOU gave access to - any authenticated user
 * ========================================================================== */

/**
 * An application holding a live token for YOUR account.
 *
 * This is OAuth going OUT (a third party acting in your account), which is the
 * opposite direction from {@link LinkedIdentity} - logging IN with Google or
 * Spotify. Two things with similar names that live in the same settings tab.
 */
export interface AuthorizedApplication {
  /**
   * The **application** id, not a token id, and an integer like every
   * `oauth_applications` primary key. Revocation is per client on purpose: a
   * person thinks "stop the CLI", not "kill token 4712".
   */
  readonly id: number;
  readonly client_id: string;
  readonly name: string;
  /**
   * The scopes of **your tokens**, not of the client's registration.
   *
   * The question this list answers is "what can that application do in MY
   * account", and a client registered for eight scopes may hold a token for
   * two. The union across your tokens, ordered by the server's own scope list
   * so the same set always renders in the same order whatever order the client
   * asked in.
   */
  readonly scopes: string[];
  /**
   * The client's CURRENT review state, which is not the same question as
   * whether it has access.
   *
   * A client that was approved and later rejected still holds live tokens until
   * they expire, and this listing shows them: it queries the token table
   * directly and never goes through the approval gate, because the person whose
   * account it is has more right to see the access than anyone.
   */
  readonly approval_status: OauthApprovalStatus;
  /**
   * True for a client this project SHIPS, read off the pinned `client_id` list
   * (`oms-cli`, `oms-mcp`) rather than off `owner_id IS NULL`.
   *
   * The backend deliberately uses the pinned list here, because NULL owner also
   * means "orphaned when its owner deleted their account", and this is the
   * screen where a person decides what to cut off. {@link isShippedClient}
   * computes the same answer from `client_id` alone.
   */
  readonly first_party: boolean;
  /**
   * How many unrevoked tokens this client holds for you.
   *
   * "Unrevoked", NOT "unexpired", and the difference matters: refresh tokens
   * are on, and a row whose two-hour access token expired an hour ago still
   * buys a fresh one on demand. Counting only unexpired rows would hide exactly
   * the access that most needs revoking.
   */
  readonly token_count: number;
  /**
   * `created_at` of the most recent of those tokens, `null` if there are none.
   *
   * Read it as "last time this renewed its access", NOT as "authorised since":
   * every refresh writes a new token row, so this moves forward on its own
   * while the client keeps working. The list is sorted by this, newest first.
   */
  readonly last_authorized_at: Timestamp | null;
}

/** What {@link AuthorizedApplicationsNamespace.revoke} answers with. */
export interface AuthorizedApplicationRevocation {
  /** The application id you asked about, echoed back. */
  readonly id: number;
  /** How many live tokens were killed. `0` when there was nothing to kill. */
  readonly revoked_tokens: number;
}

/**
 * `oms.admin.authorizedApplications` - "which applications have access to my
 * account", and the button that takes it away.
 *
 * Any authenticated user, about their own account only. Nothing here can touch
 * another person's grants: every write is filtered by BOTH the application id
 * and the caller, so an id belonging to somebody else's client can only ever
 * revoke rows the caller owns, which is none.
 *
 * Without this pair of calls, consent would be a one-way door: the device
 * approval page hands out a credential that outlives the browser session, and
 * every consent screen in this product promises the access can be withdrawn
 * later from account settings. These two calls are that promise.
 */
export class AuthorizedApplicationsNamespace extends Resource {
  /**
   * `GET /authorized_applications` - every application holding a live token for
   * you, most recently renewed first.
   *
   * Always `200`, `[]` included. No pagination: this list has units, not pages.
   * The response is enveloped and this method unwraps it.
   *
   * The listing does NOT filter by approval state. See
   * {@link AuthorizedApplication.approval_status}.
   */
  async list(options: RequestOptions = {}): Promise<AuthorizedApplication[]> {
    const body = await this.http.get<{ applications?: AuthorizedApplication[] }>(
      "/authorized_applications",
      options,
    );
    return body?.applications ?? [];
  }

  /**
   * `DELETE /authorized_applications/:id` - cuts one application off your
   * account.
   *
   * **Idempotent by construction, and it never answers `404`.** Revoking access
   * that is already gone is a `200` with `revoked_tokens: 0`: your intent
   * ("this must not have access") is satisfied either way, and a `404` for an
   * unknown id would answer "does this client exist?" to anyone willing to
   * count upwards. So a `200` here does not prove the client existed.
   *
   * **What actually dies**, which is more than it looks:
   *
   * - every unrevoked access token of yours for that client. A refresh token is
   *   not a row of its own in this system, it is a column ON the access token
   *   row, so revoking the row kills the refresh token with it. That is the
   *   whole point: a half-done revoke leaves the client walking back in on its
   *   next refresh;
   * - every access grant of yours for it;
   * - every device grant you already approved but whose client has not polled
   *   the token endpoint yet. Those are tokens waiting to be minted and are
   *   easy to forget, so they are deleted outright - a missing device code is
   *   the terminal `invalid_grant` a polling client needs to see.
   *
   * Strictly your own rows. Killing every grant a client holds across all users
   * is an administrator's action
   * ({@link AdminOauthApplicationsNamespace.revokeTokens}).
   *
   * The tokens are counted BEFORE the writes, because afterwards there is
   * nothing left to count.
   */
  async revoke(
    id: number | string,
    options: RequestOptions = {},
  ): Promise<AuthorizedApplicationRevocation> {
    return this.http.delete<AuthorizedApplicationRevocation>(
      `/authorized_applications/${encodeURIComponent(String(id))}`,
      options,
    );
  }
}

/* ========================================================================== *
 *  Social logins linked to YOUR account - any authenticated user
 * ========================================================================== */

/** The identity providers this server accepts. `Identity::PROVIDERS`. */
export const IDENTITY_PROVIDERS = ["google_oauth2", "github", "spotify"] as const;

/**
 * One of {@link IDENTITY_PROVIDERS}. Note `"google_oauth2"`, not `"google"`:
 * it is the OmniAuth strategy name and it is what the column stores.
 */
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/**
 * A social login linked to your account.
 *
 * This is OAuth coming IN - signing in with Google, GitHub or Spotify - and it
 * is the opposite direction from {@link AuthorizedApplication}.
 *
 * The blueprint renders seven fields and NOTHING else, which is the interesting
 * part: the row also holds `uid`, `oauth_token`, `oauth_refresh_token`,
 * `oauth_expires_at` and the entire `raw_info` payload from the provider, and
 * none of them cross the wire. There is no endpoint that will hand you a
 * provider token.
 */
export interface LinkedIdentity {
  /** A **string** id, 12 characters. `identities` is not one of the integer tables. */
  readonly id: Id;
  readonly provider: IdentityProvider;
  /**
   * The address the provider asserted, or `null` when it asserted none.
   *
   * Not necessarily the account's own email, and never proof of it: linking a
   * provider to an existing account does not touch `email_verified_at`.
   */
  readonly email: string | null;
  /** Display name from the provider, or `null`. */
  readonly name: string | null;
  /** Provider avatar URL, or `null`. A remote URL, not something this API serves. */
  readonly avatar_url: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** Filters for {@link LinkedIdentitiesNamespace.list}. */
export interface ListLinkedIdentitiesParams extends PageParams {
  /**
   * `modifiers[order]`, e.g. `"created_at:desc"`. Defaults to
   * `"created_at:desc"`.
   */
  readonly order?: string;
}

/**
 * `oms.admin.identities` - the Google, GitHub and Spotify logins linked to
 * YOUR account.
 *
 * Any authenticated user, and strictly their own rows: the listing scope is
 * `where(user: Current.user)` and being an administrator buys nothing extra
 * here. There is no admin view of other people's identities anywhere in this
 * API.
 *
 * **Linking a new provider is not in this SDK and cannot be.** It is a browser
 * redirect flow (`GET /auth/link/:provider` into the provider and back through
 * `/auth/:provider/callback`), it depends on a single-use nonce held in a
 * server-side session, and it ends by redirecting to an allowlisted origin or
 * to the `omsmusic://` scheme. A host that needs it opens a browser; there is
 * nothing here to call. UNLINKING, which is the destructive half, is
 * {@link destroy}.
 */
export class LinkedIdentitiesNamespace extends Resource {
  /**
   * `GET /identities` - your linked providers.
   *
   * A bare JSON array, not an envelope, unlike the two OAuth application
   * listings above. This one goes through the generic list DSL, so it paginates
   * (default page size applies even when you do not ask) and it answers ETag
   * and `304`.
   *
   * In practice this returns at most three rows, one per provider, since
   * `(provider, uid)` is unique and a person has one account per provider. The
   * pagination is the framework's, not a hint that the list is long.
   */
  async list(
    params: ListLinkedIdentitiesParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<LinkedIdentity>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const order = params.order ?? "created_at:desc";

    const load = async (at: { page: number; pageSize: number }): Promise<LinkedIdentity[]> => {
      const query: QueryParams = {
        modifiers: { page: pageModifier(at.page, at.pageSize), order },
      };
      const items = await this.http.get<LinkedIdentity[] | undefined>("/identities", { ...options, query });
      return items ?? [];
    };

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `DELETE /identities/:id` - unlinks a provider. Answers `204`, empty.
   *
   * Only your own: the row is looked up inside your own scope, so somebody
   * else's identity id is a `404` and never a `403`.
   *
   * **This is the last-credential footgun.** Nothing here checks that you still
   * have another way in. An account created through a provider gets a random
   * UUID as its password, which nobody knows, so unlinking the only identity on
   * such an account can lock it out until a password reset is done through
   * email. Check what else the account has - a password, a passkey, another
   * provider - before calling this.
   *
   * It does not revoke anything at the provider, and it does not touch the
   * sessions that identity was used to create. Those keep working; this only
   * removes the link.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` (a bare JSON string, not
   *   the structured body the `/oauth_applications` routes use).
   */
  async destroy(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/identities/${encodeURIComponent(id)}`, options);
  }
}

/* ========================================================================== *
 *  ADMINISTRATORS ONLY from here down. Everything answers 403 otherwise.
 * ========================================================================== */

/**
 * A registered client as an ADMINISTRATOR sees it: same eleven keys as
 * {@link OwnedOauthApplication}, but `approved_by` is real and the row can
 * belong to anybody on the server.
 */
export interface AdminOauthApplication extends OauthApplicationSummary {}

/**
 * {@link AdminOauthApplication} plus the counters that answer "is this client
 * live right now".
 *
 * Returned by every administrator action EXCEPT `index` and `pending`, which
 * send the summary: the counters cost five aggregate queries per row and a
 * listing does not pay for them.
 */
export interface AdminOauthApplicationDetail extends AdminOauthApplication {
  /**
   * Unrevoked AND unexpired access tokens. Note the difference from
   * {@link AuthorizedApplication.token_count}, which counts unrevoked only: an
   * expired-but-refreshable token counts there and not here, so this number can
   * read `0` for a client that will be talking to the server again in a second.
   */
  readonly live_token_count: number;
  /** Distinct people behind those live tokens. The blast radius of a revocation. */
  readonly live_token_users: number;
  /** Every token ever minted for this client, revoked and expired included. */
  readonly total_token_count: number;
  /** When the most recent token was minted, `null` if never. */
  readonly last_token_at: Timestamp | null;
  /**
   * Device grants nobody has approved yet (`resource_owner_id IS NULL`), i.e.
   * device flows in progress. Approved-but-uncollected grants are NOT counted
   * here, though a revocation kills those too.
   */
  readonly pending_device_grants: number;
}

/** What {@link AdminOauthApplicationsNamespace.pending} answers with. */
export interface AdminOauthPendingQueue {
  /** Oldest first: it is a queue, not a feed. A newest-first queue starves its own bottom. */
  readonly applications: AdminOauthApplication[];
  /** `applications.length`. Sent so a badge does not have to load the array. */
  readonly count: number;
}

/** Arguments for {@link AdminOauthApplicationsNamespace.register}. */
export interface RegisterOauthApplicationInput {
  /** Normalised then required. See {@link OAUTH_APP_NAME_MAX_LENGTH}. */
  readonly name: string;
  /** Unknown scopes are dropped; an empty result after filtering is a `400`. */
  readonly scopes: readonly (OmsScope | string)[] | string;
  /** Defaults to `false`. Every client this project ships is public. */
  readonly confidential?: boolean;
  /** Blank registers {@link NATIVE_LOOPBACK_REDIRECT_VALUE}. */
  readonly redirect_uri?: string;
}

/** What {@link AdminOauthApplicationsNamespace.register} answers with. */
export interface AdminOauthApplicationWithSecret {
  readonly application: AdminOauthApplicationDetail;
  /** Once, and `null` for a public client. See {@link OwnedOauthApplicationWithSecret}. */
  readonly client_secret: string | null;
}

/** Arguments for {@link AdminOauthApplicationsNamespace.reject}. */
export interface RejectOauthApplicationInput {
  /**
   * Required, non-blank, at most 500 characters. **The owner is shown this
   * text**, so write it for them.
   */
  readonly reason: string;
  /**
   * Kill the client's live tokens as well.
   *
   * Opt-in, and it only decides anything for a client that was NOT approved -
   * rejecting an APPROVED client always revokes, whatever this says, because an
   * administrator withdrawing trust has decided the client should stop acting,
   * not that it should stop acting eventually.
   */
  readonly revoke_tokens?: boolean;
}

/** What {@link AdminOauthApplicationsNamespace.approve} and `.reject()` answer with. */
export interface OauthApplicationReview {
  readonly application: AdminOauthApplicationDetail;
  /** Present on `reject`. Absent on `approve`, which never revokes anything. */
  readonly revoked_tokens?: number;
}

/** What {@link AdminOauthApplicationsNamespace.revokeTokens} answers with. */
export interface OauthTokenRevocation {
  readonly application: AdminOauthApplicationDetail;
  readonly revoked_tokens: number;
}

/**
 * What {@link AdminOauthApplicationsNamespace.destroy} answers with.
 *
 * The `client_id` is spelled **`uid`** here and `client_id` on the owner route
 * ({@link OwnedOauthApplicationDeletion}). One column, two controllers, two
 * names, and nothing reconciles them.
 */
export interface AdminOauthApplicationDeletion {
  readonly id: number;
  /** The `client_id`. Named after the column, not after the protocol. */
  readonly uid: string;
  readonly revoked_tokens: number;
}

/**
 * `oms.admin.oauthApplications` - **administrators only**. The review queue and
 * the registry of every OAuth client on the server.
 *
 * Every method here answers `403 "Admin access required"` to a non-admin. See
 * the namespace documentation for the exact error shape and why
 * re-authenticating will not help.
 *
 * This is the other end of {@link MyOauthApplicationsNamespace}: the same
 * table, without the ownership filter. `destroy` here deletes anybody's client
 * and cuts off everyone using it.
 *
 * Together with the self-service surface, this is the ONLY write path into the
 * table: dynamic client registration is off, and Doorkeeper's own application
 * CRUD is not mounted.
 *
 * ## Review receipts, and why a read here is not a pure read
 *
 * {@link list}, {@link pending} and {@link get} each record, in a server-side
 * cache and keyed to the calling administrator, a digest of what they were just
 * shown. {@link approve} then refuses with `409 review_stale` if the row no
 * longer matches.
 *
 * That exists because approving by id approves whatever the row holds when the
 * request lands, not what the queue rendered - and the window between a
 * reviewer's eyes and their click belongs to the applicant, who may edit a
 * pending client freely (they have to be able to: that is how a refused
 * registration gets fixed). Register something innocent, wait to be read,
 * rename it to "omelhorsite Oficial" with a redirect URI you control, and the
 * approval lands on a client nobody reviewed.
 *
 * Two consequences for a client of this SDK:
 *
 * - **calling `approve` without having read the client first is allowed** and
 *   behaves exactly as it would with no receipt. No receipt means no
 *   contradiction. This layer tightens the reviewed path; the authorisation
 *   check is the `403` above, not this;
 * - the digest covers name, scopes, redirect URIs, `confidential` and owner. It
 *   deliberately excludes `approval_status`, so approving twice stays
 *   idempotent, and the receipt lasts 7 days.
 *
 * {@link reject} and {@link revokeTokens} are NOT gated this way on purpose:
 * refusing or shutting down a client that changed under you is the safe
 * direction, and a shut-down button that can refuse is how a client stays live.
 */
export class AdminOauthApplicationsNamespace extends Resource {
  /**
   * `GET /admin/oauth_applications` - every client on the server, newest first.
   *
   * No pagination and no filter. Records a review receipt for every row
   * returned; see the class documentation.
   *
   * Summaries, not details: no token counters. Use {@link get} for those.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(options: RequestOptions = {}): Promise<AdminOauthApplication[]> {
    const body = await this.http.get<{ applications?: AdminOauthApplication[] }>(
      "/admin/oauth_applications",
      options,
    );
    return body?.applications ?? [];
  }

  /**
   * `GET /admin/oauth_applications/pending` - the review queue, oldest first.
   *
   * A separate collection route and NOT a filter on {@link list}, so an admin
   * panel can poll one cheap indexed query without carrying the other
   * listing's joins. Ordered by `created_at` then `id`, which makes the order
   * total: two rows can share a timestamp, and an unstable order makes a
   * polling panel jitter.
   *
   * Records a review receipt for every row returned.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async pending(options: RequestOptions = {}): Promise<AdminOauthPendingQueue> {
    const body = await this.http.get<Partial<AdminOauthPendingQueue>>(
      "/admin/oauth_applications/pending",
      options,
    );
    return { applications: body?.applications ?? [], count: body?.count ?? 0 };
  }

  /**
   * `GET /admin/oauth_applications/:id` - one client, with its token counters.
   *
   * **`id` may be either the numeric primary key or the `client_id`.** The
   * lookup tries the id first and falls back to the `uid`, which is what makes
   * `oms.admin.oauthApplications.get("oms-cli")` work. The owner route has no
   * such fallback.
   *
   * Records a review receipt.
   *
   * @throws {OmsApiError} 404 `{ "error": "not_found" }`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async get(id: number | string, options: RequestOptions = {}): Promise<AdminOauthApplicationDetail> {
    const body = await this.http.get<{ application: AdminOauthApplicationDetail }>(
      `/admin/oauth_applications/${encodeURIComponent(String(id))}`,
      options,
    );
    return body.application;
  }

  /**
   * `POST /admin/oauth_applications` - registers a client by hand, already
   * approved.
   *
   * Named `register` and not `create` because it is not the counterpart of
   * {@link MyOauthApplicationsNamespace.create}: what lands here is **born
   * `approved`**, with `owner_id` NULL and `approved_by` set to the calling
   * administrator. An admin registering a client IS the approval; routing them
   * through their own queue would be theatre. It never appears in
   * {@link pending}.
   *
   * **Answers `200`, not `201`**, unlike the self-service registration. The
   * controller uses the plain OK helper. Do not branch on the status.
   *
   * The response is the ONLY place `client_secret` ever exists. See
   * {@link OwnedOauthApplicationWithSecret} for why there is nothing to read
   * back later.
   *
   * `confidential` defaults to `false`, which is right for the clients this
   * surface exists to register: anything that ships to end users cannot keep a
   * secret.
   *
   * Retries are disabled: a replay after a lost response mints a second client
   * with a second `client_id` and a second secret you never saw.
   *
   * @throws {OmsApiError} 400 (bare string) for a blank name, no known scope,
   *   or too many redirect URIs; 422 `validation_failed` with an `errors` array
   *   for a redirect URI this server will not register.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async register(
    input: RegisterOauthApplicationInput,
    options: RequestOptions = {},
  ): Promise<AdminOauthApplicationWithSecret> {
    return this.http.post<AdminOauthApplicationWithSecret>(
      "/admin/oauth_applications",
      {
        name: input.name,
        scopes: scopeList(input.scopes),
        ...(input.confidential === undefined ? {} : { confidential: input.confidential }),
        ...(input.redirect_uri === undefined ? {} : { redirect_uri: input.redirect_uri }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `POST /admin/oauth_applications/:id/approve` - lets the client start
   * minting tokens.
   *
   * Idempotent, and it works from `rejected` as well as from `pending`: there
   * is no separate rehabilitation action. Approving an already-approved client
   * answers `200` and deliberately does NOT notify the owner a second time - a
   * double click is not two decisions.
   *
   * **Read the class documentation on review receipts before wiring a retry
   * around this.** If this administrator rendered the client and it changed
   * afterwards, the answer is `409 review_stale`, and the body carries the
   * CURRENT row under `application` so the screen can show what it turned into
   * rather than sending someone to go and find out. Retrying that verbatim just
   * gets the same `409`; the fix is to re-read and review again.
   *
   * @throws {OmsApiError} 409 `review_stale`; 404 `not_found`; 422
   *   `validation_failed`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async approve(id: number | string, options: RequestOptions = {}): Promise<OauthApplicationReview> {
    return this.http.post<OauthApplicationReview>(
      `/admin/oauth_applications/${encodeURIComponent(String(id))}/approve`,
      undefined,
      options,
    );
  }

  /**
   * `POST /admin/oauth_applications/:id/reject` - refuses a registration, or
   * pulls an approved client off the air.
   *
   * One action, two buttons. `pending -> rejected` is a refusal at review;
   * `approved -> rejected` is a suspension, and there is no fourth state to put
   * a client in.
   *
   * **Rejecting shuts the gate but does not by itself kill issued tokens.** A
   * rejected client can no longer mint, refresh or exchange anything, yet
   * access tokens already in the wild keep working until they expire - a blast
   * radius of the two-hour token lifetime. Which is why:
   *
   * - `revoke_tokens: true` kills them in the same breath. Opt-in, so refusing
   *   a never-approved registration stays the cheap, quiet operation it should
   *   be;
   * - a client that WAS approved has its tokens revoked regardless of the flag.
   *
   * `reason` is required and the OWNER sees it. Re-rejecting with the same
   * reason is a no-op notification-wise; changing the wording notifies again.
   *
   * Not gated by a review receipt: shutting a client down is always the safe
   * direction.
   *
   * @throws {OmsApiError} 400 `reason_required` for a blank reason; 422
   *   `validation_failed` past 500 characters; 404 `not_found`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async reject(
    id: number | string,
    input: RejectOauthApplicationInput,
    options: RequestOptions = {},
  ): Promise<OauthApplicationReview> {
    return this.http.post<OauthApplicationReview>(
      `/admin/oauth_applications/${encodeURIComponent(String(id))}/reject`,
      {
        reason: input.reason,
        ...(input.revoke_tokens === undefined ? {} : { revoke_tokens: input.revoke_tokens }),
      },
      options,
    );
  }

  /**
   * `POST /admin/oauth_applications/:id/revoke_tokens` - kills everything the
   * client holds, and leaves the client standing.
   *
   * The 3am action: the `client_id` is fine, what it is doing is not. Every
   * live access token dies, every access grant dies, every device grant is
   * deleted, and the client can be used for a fresh login the second
   * afterwards. Approval is untouched.
   *
   * This is the whole-server version of
   * {@link AuthorizedApplicationsNamespace.revoke}, which only ever touches the
   * caller's own tokens. Read `live_token_users` on the detail first to know
   * how many people you are about to sign out.
   *
   * @throws {OmsApiError} 404 `not_found`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async revokeTokens(id: number | string, options: RequestOptions = {}): Promise<OauthTokenRevocation> {
    return this.http.post<OauthTokenRevocation>(
      `/admin/oauth_applications/${encodeURIComponent(String(id))}/revoke_tokens`,
      undefined,
      options,
    );
  }

  /**
   * `DELETE /admin/oauth_applications/:id` - deletes anybody's client.
   *
   * Revokes first, then destroys, so the revocation stamps exist for the moment
   * in between and the device grants (which hold a restricting foreign key) are
   * cleared by hand rather than by a cascade.
   *
   * This is not the tidy-up that {@link MyOauthApplicationsNamespace.destroy}
   * is. Deleting a client somebody else registered signs out everyone using it
   * and there is no undo: the `client_id` is gone and a new registration gets a
   * new one. {@link revokeTokens} is the reversible version.
   *
   * Answers `200` with a body; note the key is `uid`, not `client_id`.
   *
   * @throws {OmsApiError} 404 `not_found`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async destroy(id: number | string, options: RequestOptions = {}): Promise<AdminOauthApplicationDeletion> {
    return this.http.delete<AdminOauthApplicationDeletion>(
      `/admin/oauth_applications/${encodeURIComponent(String(id))}`,
      options,
    );
  }
}

/* -------------------------------------------------------------------------- *
 *  Another person's quotas
 * -------------------------------------------------------------------------- */

/**
 * How an override behaves.
 *
 * - `"default"` DELETES the override row, so the person falls back to the
 *   catalogue default. It does not write a number equal to the default, which
 *   matters the day a default changes;
 * - `"unlimited"` writes an override with a NULL value, which the server reads
 *   as no ceiling at all;
 * - `"limit"` writes the number in `value`.
 */
export type AdminQuotaOverrideMode = "default" | "unlimited" | "limit";

/** One change to apply. See {@link AdminQuotasNamespace.update}. */
export interface AdminQuotaOverride {
  readonly resource: QuotaResource | string;
  readonly mode: AdminQuotaOverrideMode;
  /** Required for `"limit"`, ignored otherwise. Must be `>= 0` and fit in a signed 64-bit integer. */
  readonly value?: number;
}

/** The stored override behind a {@link AdminUserQuotaEntry}, if there is one. */
export interface AdminQuotaOverrideState {
  /** The number, or `null` when the override means unlimited. */
  readonly value: number | null;
  /** `true` exactly when `value` is `null`. */
  readonly unlimited: boolean;
}

/**
 * One resource, for one person, as an administrator sees it.
 *
 * This is the ordinary quota entry that `oms.quotas.list()` returns, plus the
 * two keys that only make sense while editing: what the default WOULD be, and
 * what is currently overriding it.
 */
export interface AdminUserQuotaEntry {
  readonly resource: QuotaResource | string;
  readonly unit: QuotaUnit | string;
  readonly period: QuotaPeriod | string;
  /** Consumption right now, in `unit`. */
  readonly used: number;
  /** The effective ceiling, or `null` when unlimited. */
  readonly limit: number | null;
  /** `limit - used`, floored at zero. `null` when unlimited. */
  readonly remaining: number | null;
  readonly unlimited: boolean;
  /** The catalogue default for a signed-in user. What `"default"` mode restores. */
  readonly user_default: number;
  /** The stored override, or `null` when there is none and the default applies. */
  readonly override: AdminQuotaOverrideState | null;
}

/** What {@link AdminQuotasNamespace} returns. */
export interface AdminUserQuotas {
  readonly user_id: Id;
  readonly handle: string;
  /**
   * **Every** resource in the catalogue, including the storage and music
   * ceilings. Unlike the anonymous answer from `oms.quotas.list()`, nothing is
   * left out here. Look entries up by `resource`, never by position.
   */
  readonly quotas: AdminUserQuotaEntry[];
  /**
   * Legacy twin of the `music_storage_bytes` entry's `limit`, `null` when
   * unlimited. Kept for an older admin bundle that reads it. Prefer the
   * catalogue entry; this key is on its way out.
   */
  readonly music_storage_limit_bytes: number | null;
}

/**
 * `oms.admin.quotas` - **administrators only**. Another person's ceilings.
 *
 * The person's own view of the same numbers is `oms.quotas.list()`, which needs
 * no privilege and cannot change anything.
 */
export class AdminQuotasNamespace extends Resource {
  /**
   * `GET /admin/users/:user/quotas` - the full catalogue for one person.
   *
   * **`user` may be a user id OR a handle.** The lookup tries the id first and
   * then the handle, downcased, which is why an admin tool can take whatever
   * was typed into a search box.
   *
   * @throws {OmsApiError} 404 `"User not found"` (a bare JSON string).
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async get(user: Id | string, options: RequestOptions = {}): Promise<AdminUserQuotas> {
    return this.http.get<AdminUserQuotas>(
      `/admin/users/${encodeURIComponent(user)}/quotas`,
      options,
    );
  }

  /**
   * `PUT /admin/users/:user/quotas` - applies a batch of overrides.
   *
   * **`PUT`, not `PATCH`.** The route declares only `show` and `update` on a
   * singular resource, and Rails maps `update` to both verbs, but this SDK
   * sends the one the frontend has always sent.
   *
   * **The batch is NOT atomic, and this is the thing to design around.** The
   * server loops over `overrides` and writes each one as it goes, with no
   * transaction around the loop: a bad entry in the middle answers `400` with
   * everything BEFORE it already written and everything after it untouched. So
   * a failed call leaves a partial state, and the only reliable way to know
   * what landed is the answer to a fresh {@link get}. Validate the batch
   * yourself before sending it, or send one override per call.
   *
   * Passing an empty `overrides` array is a legal no-op and a cheap way to read
   * the quotas back, though {@link get} is the honest way to do that.
   *
   * The response is the full, reloaded catalogue, so there is no need to follow
   * this with a read on the success path.
   *
   * @throws {OmsApiError} 400 `"Unknown resource: x"`, `"Invalid mode: x"`, or
   *   `"Invalid value for x"` for a negative number or one past the signed
   *   64-bit ceiling. All three are bare JSON strings. 404 `"User not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async update(
    user: Id | string,
    overrides: readonly AdminQuotaOverride[],
    options: RequestOptions = {},
  ): Promise<AdminUserQuotas> {
    return this.http.put<AdminUserQuotas>(
      `/admin/users/${encodeURIComponent(user)}/quotas`,
      {
        overrides: overrides.map((override) => ({
          resource: override.resource,
          mode: override.mode,
          ...(override.value === undefined ? {} : { value: override.value }),
        })),
      },
      options,
    );
  }
}

/* -------------------------------------------------------------------------- *
 *  Every background job on the server
 * -------------------------------------------------------------------------- */

/**
 * A job row, as `/admin/jobs` renders it.
 *
 * Identical to the {@link Job} an ordinary caller reads through `oms.jobs`,
 * because it is the same blueprint: the only difference is the SCOPE, since
 * `Job.viewable_by` returns every row for an administrator and only your own
 * for everybody else.
 */
export type AdminJob = Job;

/** Filters for {@link AdminJobsNamespace.list}. */
export interface ListAdminJobsParams extends PageParams {
  /** `exact_search[status]`. An array becomes an `IN`. */
  readonly status?: string | readonly string[];
  /** `exact_search[job_type]`. An array becomes an `IN`. */
  readonly jobType?: string | readonly string[];
  /** `modifiers[order]`. Defaults to `"created_at:desc"`. */
  readonly order?: string;
}

/** What {@link AdminJobsNamespace.cleanupStuck} answers with. */
export interface AdminStuckJobCleanup {
  /** Ids of the jobs that were canceled. String ids: `jobs` is one of the string-keyed tables. */
  readonly canceled_job_ids: Id[];
  /** `canceled_job_ids.length`. `0` when there was nothing stuck. */
  readonly count: number;
}

/**
 * `oms.admin.jobs` - **administrators only**. Every background job on the
 * server.
 *
 * The unprivileged half of this is `oms.jobs`, which is the same endpoints
 * narrowed to the caller's own jobs. What an administrator gains is the scope,
 * plus {@link cancel} and {@link cleanupStuck}, which need `admin?` on the
 * model itself and not merely on the route.
 */
export class AdminJobsNamespace extends Resource {
  /**
   * `GET /admin/jobs` - every job, newest first.
   *
   * A bare JSON array through the generic list DSL: it paginates (a default
   * page size is forced even when you do not ask, so this can never enumerate
   * the whole table) and it answers ETag and `304`.
   *
   * **The filters have to go inside the filter buckets, and the failure mode if
   * they do not is silent.** `status` and `job_type` are declared as search
   * columns, which means `exact_search[status]`; a plain top-level
   * `?status=pending` is read by nothing and you get the unfiltered first page
   * back, with no error to tell you the narrowing was dropped. The web
   * frontend's admin service does exactly that today - see the note in the
   * report accompanying this namespace. This method builds the buckets for you.
   *
   * Unknown filter keys inside a bucket DO fail, with a `400`, on purpose: a
   * dropped filter is a wider result nobody notices.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(
    params: ListAdminJobsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<AdminJob>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const order = params.order ?? "created_at:desc";

    const exact: Record<string, string | string[]> = {};
    if (params.status !== undefined) {
      exact["status"] = Array.isArray(params.status) ? [...params.status] : String(params.status);
    }
    if (params.jobType !== undefined) {
      exact["job_type"] = Array.isArray(params.jobType) ? [...params.jobType] : String(params.jobType);
    }

    const load = async (at: { page: number; pageSize: number }): Promise<AdminJob[]> => {
      const query: QueryParams = {
        modifiers: { page: pageModifier(at.page, at.pageSize), order },
        ...(Object.keys(exact).length === 0 ? {} : { exact_search: exact }),
      };
      const items = await this.http.get<AdminJob[] | undefined>("/admin/jobs", { ...options, query });
      return items ?? [];
    };

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `POST /admin/jobs/:id/cancel` - stops a job.
   *
   * The row lands on `status: "canceled"` with `error: "Canceled by admin"` and
   * a `finished_at`, and the change is broadcast over the job channel, so
   * anything watching that job sees it immediately.
   *
   * **This marks the row, it does not reach into the worker.** A job that is
   * already executing keeps executing until it next looks at its own status;
   * cancelling is a request, not a kill signal.
   *
   * @throws {OmsApiError} 400 `"Already terminal"` for a job that is complete,
   *   failed or already canceled. Idempotency has to be your side: check
   *   `isJobTerminal(job.status)` first rather than swallowing the 400. 404
   *   `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async cancel(id: Id, options: RequestOptions = {}): Promise<AdminJob> {
    return this.http.post<AdminJob>(
      `/admin/jobs/${encodeURIComponent(id)}/cancel`,
      undefined,
      options,
    );
  }

  /**
   * `POST /admin/jobs/cleanup_stuck` - cancels every job the server considers
   * stuck.
   *
   * A sweep with NO arguments and no dry run: it decides what is stuck and acts
   * on all of it in one request. There is no preview and no undo. Read
   * {@link list} filtered to `"processing"` first if you want to know what you
   * are about to hit.
   *
   * Answers `{ canceled_job_ids, count }`. `count: 0` is the normal, healthy
   * answer and is not an error.
   *
   * Retries are disabled: the sweep is not free, and a replay after a lost
   * response reports a second, smaller set as if it were the whole answer.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async cleanupStuck(options: RequestOptions = {}): Promise<AdminStuckJobCleanup> {
    return this.http.post<AdminStuckJobCleanup>(
      "/admin/jobs/cleanup_stuck",
      undefined,
      { retry: false, ...options },
    );
  }
}

/* -------------------------------------------------------------------------- *
 *  Short links, server-wide
 * -------------------------------------------------------------------------- */

/**
 * One day of a 30 day series.
 *
 * Every daily series on the administrator surface has **exactly 30 entries,
 * oldest first, ending today**, with `count: 0` filled in for days that had
 * nothing. The series is safe to plot without gap filling, and the window is
 * fixed server-side: there is no parameter to widen it.
 *
 * Structurally identical to `ShortLinkDailyClicks` from the `shortLinks`
 * namespace, and kept separate because half the series here count creations
 * rather than clicks.
 */
export interface AdminDailyCount {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly count: number;
}

/** Compact owner object on an admin short link row. `null` for an anonymous link. */
export interface AdminShortLinkOwner {
  readonly id: Id;
  readonly name: string;
  readonly handle: string;
}

/**
 * A short link as the admin tool sees it.
 *
 * This is the blueprint's `:admin` view, which is NOT the shape the ordinary
 * `shortLinks` namespace returns. The differences are load-bearing:
 *
 * - there is **no `updated_at`**, uniquely on this surface;
 * - there is **no `short_link_clicks` array**. The default view inlines EVERY
 *   click ever recorded, which is a payload hazard on a busy link; here it is
 *   replaced by the two aggregates below;
 * - the full user record is replaced by the compact {@link AdminShortLinkOwner}.
 */
export interface AdminShortLink {
  /**
   * Primary key, and an **integer**: `short_links` kept a bigint primary key
   * while the `user_id` next to it is a string.
   */
  readonly id: number;
  readonly url: string;
  readonly endpoint: string;
  /**
   * Always `null` or `""` on this surface: the listing, the drilldown and the
   * delete are all scoped to non-namespaced links so that private chest,
   * notepad and storage-share URLs never surface here.
   * {@link AdminShortLinksNamespace.namespaces} is the one exception and it
   * only returns counts.
   */
  readonly namespace: string | null;
  /** Owner id, or `null` for a link created anonymously. */
  readonly user_id: Id | null;
  readonly owner: AdminShortLinkOwner | null;
  readonly created_at: Timestamp;
  /** Total clicks. Computed per page in one grouped query, not per row. */
  readonly click_count: number;
  readonly last_click_at: Timestamp | null;
}

/** Filters for {@link AdminShortLinksNamespace.list}. */
export interface ListAdminShortLinksParams {
  /**
   * `"auth"` for links with an owner, `"anon"` for links without one. Any other
   * value, including omitting it, means both.
   */
  readonly owner?: "auth" | "anon" | "all";
  /**
   * Case-insensitive substring matched against the endpoint OR the destination
   * URL.
   *
   * **A plain top-level string, not the `search[column]` bucket the rest of
   * this API uses.** This controller reads `params[:search]` directly, so
   * sending a bucket here would be read as a hash and match nothing.
   */
  readonly search?: string;
}

/**
 * A page of {@link AdminShortLinksNamespace.list}.
 *
 * Not a {@link Paginated}, because there is nothing to page through: see
 * {@link AdminShortLinkPage.limit}.
 */
export interface AdminShortLinkPage {
  /** At most {@link AdminShortLinkPage.limit} rows, newest first. */
  readonly items: AdminShortLink[];
  /** How many links match the filter in total. Frequently larger than `items.length`. */
  readonly total: number;
  /**
   * The hard server-side cap, currently 100.
   *
   * **There is no pagination on this endpoint and no way to reach row 101.**
   * When `total > limit` the rest is simply unreachable through this route; the
   * only way to find a specific link beyond the cap is to narrow
   * {@link ListAdminShortLinksParams.search} until it fits.
   */
  readonly limit: number;
}

/** What {@link AdminShortLinksNamespace.stats} answers with. */
export interface AdminShortLinkStats {
  /** Non-namespaced links only, like everything else on this surface. */
  readonly total_links: number;
  readonly total_clicks: number;
  readonly clicks_last_24h: number;
  readonly clicks_last_7d: number;
  readonly zero_click_count: number;
  /** Already a percentage, `0` to `100`, one decimal. Not a fraction. */
  readonly zero_click_percent: number;
  /** Rounded to two decimals. `0` when there are no links. */
  readonly avg_clicks_per_link: number;
  readonly creations_daily: AdminDailyCount[];
  readonly clicks_daily: AdminDailyCount[];
}

/** One row of {@link AdminShortLinksNamespace.namespaces}. */
export interface AdminShortLinkNamespaceCount {
  /**
   * `null` for user links, or one of the reserved tool namespaces: `"n"`
   * notepads, `"c"` chests, `"ss"` storage shares, `"qr"` dynamic QR, `"f"`
   * forms, `"t"` link trees.
   */
  readonly namespace: string | null;
  readonly count: number;
}

/** Clicks grouped by country, on the admin drilldown. */
export interface AdminShortLinkCountryCount {
  /** ISO 3166-1 alpha-2 as stored at click time. */
  readonly country: string;
  readonly count: number;
}

/** Clicks grouped by browser or app, on the admin drilldown. */
export interface AdminShortLinkDeviceCount {
  readonly device_name: string;
  readonly count: number;
}

/**
 * What {@link AdminShortLinksNamespace.get} answers with.
 *
 * Note what is NOT here: no `total_clicks` and no `last_click_at` at the top
 * level. The controller renders this drilldown with totals suppressed because
 * the same two numbers are already on `link`. Read them from there.
 */
export interface AdminShortLinkDetail {
  readonly link: AdminShortLink;
  readonly clicks_daily: AdminDailyCount[];
  /** Top 10 countries by clicks, descending. Rows with no country are excluded. */
  readonly top_countries: AdminShortLinkCountryCount[];
  /** Top 5 devices by clicks, descending. Rows with no device are excluded. */
  readonly top_devices: AdminShortLinkDeviceCount[];
}

/**
 * `oms.admin.shortLinks` - **administrators only**. Every public short link and
 * its traffic.
 *
 * The unprivileged half is `oms.shortLinks`, which only ever shows the caller's
 * own links. This one shows everybody's, anonymous ones included, which is the
 * point: an anonymous short link has no owner to report it.
 *
 * **Scoped to non-namespaced links throughout.** Links minted by the internal
 * tools (notepads, chests, storage shares, dynamic QR, forms, link trees) carry
 * a namespace and are excluded from {@link list}, {@link get}, {@link stats}
 * and {@link destroy}, so an admin panel cannot accidentally surface a private
 * chest URL. {@link namespaces} is the deliberate exception and returns nothing
 * but counts.
 */
export class AdminShortLinksNamespace extends Resource {
  /**
   * `GET /admin/short_links` - the newest 100 matching links.
   *
   * Read {@link AdminShortLinkPage.limit} before building a table on this: the
   * cap is hard and there is no page parameter.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(
    params: ListAdminShortLinksParams = {},
    options: RequestOptions = {},
  ): Promise<AdminShortLinkPage> {
    const query: QueryParams = {
      ...(params.owner === undefined ? {} : { owner: params.owner }),
      ...(params.search === undefined ? {} : { search: params.search }),
    };
    const body = await this.http.get<Partial<AdminShortLinkPage>>("/admin/short_links", {
      ...options,
      ...(Object.keys(query).length === 0 ? {} : { query }),
    });
    return { items: body?.items ?? [], total: body?.total ?? 0, limit: body?.limit ?? 100 };
  }

  /**
   * `GET /admin/short_links/stats` - server-wide totals and two 30 day series.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async stats(options: RequestOptions = {}): Promise<AdminShortLinkStats> {
    return this.http.get<AdminShortLinkStats>("/admin/short_links/stats", options);
  }

  /**
   * `GET /admin/short_links/namespaces` - how many links each namespace holds.
   *
   * The ONE call on this surface that looks past the non-namespaced scope, and
   * even so it only ever returns counts, never a row. User links come first
   * (`namespace: null`), then the reserved namespaces alphabetically.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async namespaces(options: RequestOptions = {}): Promise<AdminShortLinkNamespaceCount[]> {
    const body = await this.http.get<{ namespaces?: AdminShortLinkNamespaceCount[] }>(
      "/admin/short_links/namespaces",
      options,
    );
    return body?.namespaces ?? [];
  }

  /**
   * `GET /admin/short_links/:id` - one link with its traffic breakdown.
   *
   * @throws {OmsApiError} 404 `{ "error": "not_found" }` - which is also the
   *   answer for a link that exists but carries a namespace, since those are
   *   out of scope here.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async get(id: number | string, options: RequestOptions = {}): Promise<AdminShortLinkDetail> {
    return this.http.get<AdminShortLinkDetail>(
      `/admin/short_links/${encodeURIComponent(String(id))}`,
      options,
    );
  }

  /**
   * `DELETE /admin/short_links/:id` - deletes anybody's short link.
   *
   * Answers `200` with `{ id }`, not `204`. The clicks go with it.
   *
   * The link stops resolving immediately and there is no undo: the endpoint
   * becomes free again and somebody else can claim it, which is worth
   * remembering before deleting something that was printed or posted.
   *
   * @throws {OmsApiError} 404 `not_found`, namespaced links included.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async destroy(id: number | string, options: RequestOptions = {}): Promise<{ readonly id: number }> {
    return this.http.delete<{ readonly id: number }>(
      `/admin/short_links/${encodeURIComponent(String(id))}`,
      options,
    );
  }
}

/* -------------------------------------------------------------------------- *
 *  Vocal separations, server-wide
 * -------------------------------------------------------------------------- */

/**
 * A separation run as the admin surface renders it.
 *
 * The same `:extended` view the tool namespace reads, so the type is the same:
 * every key of {@link VocalSeparation}, `user_id` and `ip_address` included.
 * What changes is the SCOPE - an administrator sees every run on the server
 * rather than their own.
 */
export type AdminVocalSeparation = VocalSeparation;

/** Filters for {@link AdminVocalSeparationsNamespace.list}. */
export interface ListAdminVocalSeparationsParams extends PageParams {
  /** `exact_search[status]`. An array becomes an `IN`. */
  readonly status?: string | readonly string[];
  /** `exact_search[model_id]`. An array becomes an `IN`. */
  readonly modelId?: string | readonly string[];
  /**
   * `"song"` for runs started from the music library, `"tool"` for uploads.
   *
   * A top-level parameter, not a search bucket: the controller reads it by hand
   * and turns it into a `song_id IS NOT NULL` test. Omitting it means both.
   */
  readonly source?: "song" | "tool";
  /** `exact_search[user_id]`. */
  readonly userId?: Id;
  /** `modifiers[order]`. Defaults to `"created_at:desc"`. */
  readonly order?: string;
}

/**
 * `oms.admin.vocalSeparations` - **administrators only**. Every separation run
 * on the server.
 *
 * The unprivileged half is `oms.tools.vocalSeparation`, which is scoped to the
 * caller's own runs and the songs they own.
 */
export class AdminVocalSeparationsNamespace extends Resource {
  /**
   * `GET /admin/vocal_separations` - every run, newest first.
   *
   * A bare JSON array through the generic list DSL, rendered in the extended
   * view, with ETag and `304`.
   *
   * **This listing is not cheap and the cost is not in the database.** The
   * extended view computes `progress_percent` by calling the separator sidecar,
   * synchronously, ONCE PER ROW THAT IS `"processing"`. A page with twenty live
   * runs is twenty sidecar round trips inside one request, and if the sidecar
   * is slow or down the whole listing is slow with it. Filter to terminal
   * statuses when you only want history, and keep the page size modest when you
   * are polling a dashboard.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(
    params: ListAdminVocalSeparationsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<AdminVocalSeparation>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const order = params.order ?? "created_at:desc";

    const exact: Record<string, string | string[]> = {};
    if (params.status !== undefined) {
      exact["status"] = Array.isArray(params.status) ? [...params.status] : String(params.status);
    }
    if (params.modelId !== undefined) {
      exact["model_id"] = Array.isArray(params.modelId) ? [...params.modelId] : String(params.modelId);
    }
    if (params.userId !== undefined) exact["user_id"] = params.userId;

    const load = async (at: { page: number; pageSize: number }): Promise<AdminVocalSeparation[]> => {
      const query: QueryParams = {
        modifiers: { page: pageModifier(at.page, at.pageSize), order },
        ...(Object.keys(exact).length === 0 ? {} : { exact_search: exact }),
        ...(params.source === undefined ? {} : { source: params.source }),
      };
      const items = await this.http.get<AdminVocalSeparation[] | undefined>("/admin/vocal_separations", {
        ...options,
        query,
      });
      return items ?? [];
    };

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `GET /admin/vocal_separations/:id` - one run, anybody's.
   *
   * @throws {OmsApiError} 404 `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<AdminVocalSeparation> {
    return this.http.get<AdminVocalSeparation>(
      `/admin/vocal_separations/${encodeURIComponent(id)}`,
      options,
    );
  }

  /**
   * `POST /admin/vocal_separations/:id/cancel` - stops a run.
   *
   * **The row lands on `"failed"`, not on a cancelled status, and there is no
   * cancelled status for a separation.** The `error` field is set to
   * `"Canceled by admin"` and that string is the only way to tell an
   * administrative stop from a genuine failure. Anything counting failures will
   * count this, so match on the message if that matters.
   *
   * A run attached to a song also clears that song's
   * `vocal_separation_started_at`, which is what lets the owner start a new
   * separation instead of being told one is already running.
   *
   * Like every cancel in this API, it marks the row rather than reaching into
   * the worker.
   *
   * @throws {OmsApiError} 400 `"Already terminal"`; 404 `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async cancel(id: Id, options: RequestOptions = {}): Promise<AdminVocalSeparation> {
    return this.http.post<AdminVocalSeparation>(
      `/admin/vocal_separations/${encodeURIComponent(id)}/cancel`,
      undefined,
      options,
    );
  }

  /**
   * `DELETE /admin/vocal_separations/:id` - deletes a run. Answers `204`, empty.
   *
   * The stems go with it: the attached audio is destroyed with the row, and a
   * complete run's download URLs stop working immediately. Deleting a run that
   * is still processing does not stop the worker, it removes the row the worker
   * is going to write to.
   *
   * @throws {OmsApiError} 404 `"Resource not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async destroy(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/admin/vocal_separations/${encodeURIComponent(id)}`, options);
  }
}

/* -------------------------------------------------------------------------- *
 *  Aggregate statistics: chests and notepads
 * -------------------------------------------------------------------------- */

/** What {@link AdminChestsNamespace.stats} answers with. Counts only, never a chest. */
export interface AdminChestStats {
  /** Chests that have not expired. */
  readonly active_count: number;
  /** `Chest::GLOBAL_ACTIVE_LIMIT`. Creation is refused server-wide once `active_count` reaches it. */
  readonly active_limit: number;
  /** Entries in active chests, split by kind. */
  readonly entries_file: number;
  readonly entries_note: number;
  /** Sum of `current_size` across active chests. */
  readonly active_size_bytes: number;
  readonly created_last_1h: number;
  readonly created_last_24h: number;
  readonly created_last_7d: number;
  /** Rounded to two decimals; `0` when there are no active chests. */
  readonly avg_entries_per_chest: number;
  /** Rounded to whole bytes; `0` when there are no active chests. */
  readonly avg_chest_size_bytes: number;
  /** Active chests with an owner, and without one. */
  readonly active_auth_count: number;
  readonly active_anon_count: number;
  /** Active chests expiring within the next 15 minutes. */
  readonly expiring_soon: number;
  /**
   * Creations per day. Counted over ALL chests, expired ones included, unlike
   * every other number here.
   */
  readonly creations_daily: AdminDailyCount[];
}

/** Content length distribution, in characters. */
export interface AdminNotepadContentSize {
  /** Rounded to a whole number. `0` when there are no pads. */
  readonly avg: number;
  /** Median. Nearest-rank, not interpolated. */
  readonly p50: number;
  readonly p95: number;
}

/** What {@link AdminNotepadsNamespace.stats} answers with. Counts only, never content. */
export interface AdminNotepadStats {
  readonly total: number;
  /** Pads whose content starts with the client-side encryption marker. */
  readonly encrypted_count: number;
  /** Already a percentage, `0` to `100`, one decimal. */
  readonly encrypted_percent: number;
  /** Pads longer than 256 characters, i.e. probably not a stray keystroke. */
  readonly meaningful_count: number;
  readonly meaningful_percent: number;
  readonly created_last_24h: number;
  readonly created_last_7d: number;
  readonly created_last_30d: number;
  readonly content_size: AdminNotepadContentSize;
  /** Clicks on every `n/` short link, i.e. how often pads were opened through their link. */
  readonly short_link_clicks_total: number;
  readonly creations_daily: AdminDailyCount[];
}

/**
 * `oms.admin.chests` - **administrators only**. Aggregate chest statistics.
 *
 * `stats` is the ONLY route: there is no admin listing of chests and no way to
 * read one from here. A chest is opened by knowing its code, and the admin
 * surface deliberately does not become a second way in.
 */
export class AdminChestsNamespace extends Resource {
  /**
   * `GET /admin/chests/stats`.
   *
   * Several full-table aggregates in one request. Cheap enough for a dashboard,
   * not cheap enough for a tight poll.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async stats(options: RequestOptions = {}): Promise<AdminChestStats> {
    return this.http.get<AdminChestStats>("/admin/chests/stats", options);
  }
}

/**
 * `oms.admin.notepads` - **administrators only**. Aggregate notepad statistics.
 *
 * `stats` is the ONLY route, for the same reason as
 * {@link AdminChestsNamespace}: a pad's slug IS its authorisation, so there is
 * no admin listing that would hand out slugs, and no content crosses the wire
 * here. Only lengths are measured.
 */
export class AdminNotepadsNamespace extends Resource {
  /**
   * `GET /admin/notepads/stats`.
   *
   * The length distribution is computed by pulling `LENGTH(content)` for every
   * pad and sorting in Ruby, so this request grows linearly with the number of
   * pads. It is a dashboard call, not a poll.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async stats(options: RequestOptions = {}): Promise<AdminNotepadStats> {
    return this.http.get<AdminNotepadStats>("/admin/notepads/stats", options);
  }
}

/* -------------------------------------------------------------------------- *
 *  The Discord alert catalogue
 * -------------------------------------------------------------------------- */

/** One event in the alert catalogue. */
export interface AdminEventAlert {
  /** Stable identifier, e.g. `"oauth_client_created"`. A Ruby symbol on the server, a string here. */
  readonly event: string;
  /** Short human label. */
  readonly label: string;
  /** What the event means and when it fires. */
  readonly description: string;
  /**
   * The fields the Discord message carries, in order. Always starts with
   * `"Actor"`, and when {@link AdminEventAlert.includes_geo} is true the next
   * three are `"IP"`, `"Country"` and `"Network"`.
   */
  readonly fields: string[];
  /** Whether the message carries the actor's IP and its geo enrichment. */
  readonly includes_geo: boolean;
  /** Whether this particular event is currently switched on. */
  readonly enabled: boolean;
}

/**
 * What {@link AdminEventAlertsNamespace.list} answers with.
 *
 * Self-describing on purpose: the catalogue is built from the server's own
 * constant, so adding or removing an event needs no client change. Render the
 * array, do not hardcode the events.
 */
export interface AdminEventAlertsCatalog {
  /** Whether alerts are actually being sent right now. */
  readonly delivering: boolean;
  /**
   * Whether a webhook URL is configured at all.
   *
   * The two booleans are not the same question, and the pair is the diagnosis:
   * `webhook_configured: false` means nothing was ever set up, while
   * `webhook_configured: true` with `delivering: false` means it is configured
   * and switched off (a non-production environment, typically).
   */
  readonly webhook_configured: boolean;
  readonly events: AdminEventAlert[];
}

/**
 * `oms.admin.eventAlerts` - **administrators only**. The catalogue of activity
 * alerts sent to Discord.
 *
 * Read-only, and there is exactly one route. Nothing here switches an event on
 * or off: `enabled` is decided by the server's configuration, and the only way
 * to change it is to change that. This answers "what would be reported, and is
 * anything being reported at all".
 */
export class AdminEventAlertsNamespace extends Resource {
  /**
   * `GET /admin/event_alerts`.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(options: RequestOptions = {}): Promise<AdminEventAlertsCatalog> {
    const body = await this.http.get<Partial<AdminEventAlertsCatalog>>("/admin/event_alerts", options);
    return {
      delivering: body?.delivering ?? false,
      webhook_configured: body?.webhook_configured ?? false,
      events: body?.events ?? [],
    };
  }
}

/* ========================================================================== *
 *  The namespace itself
 * ========================================================================== */

/**
 * The `admin` namespace, reachable as `oms.admin`.
 *
 * A container and nothing else: it has no methods of its own, because the
 * eleven routes underneath it answer to three different publics and putting a
 * bare `list()` here would hide which one a caller had reached. Read the module
 * documentation at the top of this file for the table.
 *
 * The short version, and the rule to check a call site against:
 *
 * ```ts
 * // Any authenticated user, about themselves:
 * await oms.admin.myApplications.list();          // clients I registered
 * await oms.admin.authorizedApplications.list();  // apps I gave access to
 * await oms.admin.identities.list();              // logins linked to my account
 *
 * // Administrators only. Everything below answers 403 to everybody else.
 * await oms.admin.oauthApplications.pending();    // the review queue
 * await oms.admin.quotas.get("someone");          // somebody else's ceilings
 * await oms.admin.jobs.list();                    // every job on the server
 * ```
 *
 * A client that is not sure whether the signed-in person is an administrator
 * should read `group` off `oms.account` once and branch on it, rather than
 * calling an `/admin/*` route to find out: the `403` is real, cheap to trigger
 * and easy to mistake for a broken credential.
 */
export class AdminNamespace extends Resource {
  /** Your own registered OAuth clients. Any authenticated user. */
  readonly myApplications: MyOauthApplicationsNamespace;
  /** Applications holding a token for your account. Any authenticated user. */
  readonly authorizedApplications: AuthorizedApplicationsNamespace;
  /** Social logins linked to your account. Any authenticated user. */
  readonly identities: LinkedIdentitiesNamespace;

  /** The OAuth client registry and review queue. **Administrators only.** */
  readonly oauthApplications: AdminOauthApplicationsNamespace;
  /** Another person's quota ceilings. **Administrators only.** */
  readonly quotas: AdminQuotasNamespace;
  /** Every background job on the server. **Administrators only.** */
  readonly jobs: AdminJobsNamespace;
  /** Every public short link and its traffic. **Administrators only.** */
  readonly shortLinks: AdminShortLinksNamespace;
  /** Every vocal separation run on the server. **Administrators only.** */
  readonly vocalSeparations: AdminVocalSeparationsNamespace;
  /** Aggregate chest statistics. **Administrators only.** */
  readonly chests: AdminChestsNamespace;
  /** Aggregate notepad statistics. **Administrators only.** */
  readonly notepads: AdminNotepadsNamespace;
  /** The Discord alert catalogue. **Administrators only.** */
  readonly eventAlerts: AdminEventAlertsNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.myApplications = new MyOauthApplicationsNamespace(http);
    this.authorizedApplications = new AuthorizedApplicationsNamespace(http);
    this.identities = new LinkedIdentitiesNamespace(http);
    this.oauthApplications = new AdminOauthApplicationsNamespace(http);
    this.quotas = new AdminQuotasNamespace(http);
    this.jobs = new AdminJobsNamespace(http);
    this.shortLinks = new AdminShortLinksNamespace(http);
    this.vocalSeparations = new AdminVocalSeparationsNamespace(http);
    this.chests = new AdminChestsNamespace(http);
    this.notepads = new AdminNotepadsNamespace(http);
    this.eventAlerts = new AdminEventAlertsNamespace(http);
  }
}
