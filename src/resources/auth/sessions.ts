/**
 * The `sessions` namespace: establishing a credential, ending it, and the
 * two-step email flows that create an account, reset a password, move an
 * address or delete the account.
 *
 * This is the module the rest of the SDK stands on. Every other namespace
 * assumes a credential already exists; this one is where it comes from.
 *
 * ## What a credential actually is
 *
 * A `Session` row, and nothing more. `POST /sessions` writes one and hands back
 * its `token`, which is a `SecureRandom.uuid`. That UUID IS the credential.
 *
 * There is no JWT, no signature to verify, no `exp`, no refresh token and no
 * rotation. A session token never expires on its own: it lives until the row is
 * deleted, which happens on sign-out, when an administrator deactivates the
 * account (`User#deactivate!` runs `sessions.delete_all`), or when someone
 * deletes it in the database. Do not build refresh logic against this - there
 * is nothing to refresh, and a client that "renews" by signing in again just
 * accumulates rows in the user's device list and fires a login alert each time.
 *
 * The OAuth 2 / OIDC tokens under `oms.auth` are a DIFFERENT credential with a
 * different lifecycle (they do expire, they do refresh, they carry scopes).
 * Both are accepted by the API. This module is only about the session kind.
 *
 * ## Three ways the server reads it, and the one that bites
 *
 * `Session.candidate_tokens` collects, in this order:
 *
 * 1. the `Authorization` header,
 * 2. the `token` request parameter (query string or body),
 * 3. the `oms_session` cookie.
 *
 * and `Session.resolve_from_request` tries each until one resolves to a LIVE
 * row, so a stale header no longer permanently shadows a good cookie on API
 * requests. (`ApplicationCable::Connection` is the exception: the WebSocket
 * handshake takes the FIRST candidate, not the first live one, so a stale
 * header there really does beat a good `?token=`.)
 *
 * The header is parsed as `header["Bearer:".length..]`, which is a BLIND SLICE
 * OF THE FIRST SEVEN CHARACTERS. Nothing checks that those seven characters
 * spell anything:
 *
 * - `Bearer <token>` works (7 chars: `Bearer` plus the space),
 * - `Bearer:<token>` also works, which is where the constant's name comes from,
 * - a bare token with NO prefix does NOT work. Its first seven characters are
 *   eaten, the remainder matches no row, and the request is answered as
 *   anonymous. The failure is a 401 on an endpoint that needs auth, or - far
 *   worse - a silently empty list on one that does not, with no hint anywhere
 *   that a credential was sent and mangled.
 *
 * The SDK's transport always writes `Bearer ${token}`, so this only matters if
 * you build the header yourself, or if you store a token that already carries a
 * prefix and then let the transport add a second one.
 *
 * ## Cookie mode and token mode
 *
 * Sign-in works in BOTH, and the difference is only in what you do with the
 * answer. See {@link AuthSessionsNamespace.signIn}.
 *
 * The cookie is named `oms_session` ({@link SESSION_COOKIE_NAME}) and is set by
 * every session-minting endpoint with `httpOnly`, `secure` in production,
 * `SameSite=Lax`, `path=/`, a one-year expiry and NO `Domain` attribute, which
 * makes it host-only: it belongs to `backend.omelhorsite.pt` alone and is never
 * sent to a sibling subdomain. `omelhorsite.pt` and `backend.omelhorsite.pt`
 * share a registrable domain, so a call from the web app is cross-ORIGIN but
 * same-SITE, and `SameSite=Lax` still lets the cookie ride along. A page on a
 * genuinely different site (the `pages.dev` staging build, where `pages.dev` is
 * a public suffix) can never receive it, no CORS header can change that, and
 * such a page must use token mode instead.
 *
 * ## No CSRF token exists
 *
 * The backend is an `ActionController::API` and `protect_from_forgery` is never
 * enabled. There is no CSRF token to fetch, no header to echo, and nothing in
 * this SDK that omits one. For browsers the entire cross-site defence is
 * `SameSite=Lax` on the cookie; bearer clients are unaffected because a
 * cross-site page cannot make the browser attach an `Authorization` header.
 *
 * ## What lives elsewhere
 *
 * Deliberately NOT re-implemented here, because `oms.account` already owns it
 * and two implementations of one endpoint drift:
 *
 * - `oms.account.sessions.list()` / `.update()` - the device-management screen,
 *   `GET /sessions` and `PATCH /sessions/:id`;
 * - `oms.account.me()`, `.get()`, `.byHandle()`, `.profile()`, `.search()`,
 *   `.update()`, `.follow()`, `.picture()` - the user read and write surface.
 *
 * `DELETE /users/:id` is also absent, and that one is not a delegation: the
 * route cannot succeed for anybody. `UsersController#destroy` checks for an
 * administrator and then calls `super`, and `CrudActions#destroy` asks
 * `resource.destroyable_by?(Current.user)` - which on `User` is
 * `alias destroyable_by? creatable_by?`, and `creatable_by?` returns `false`
 * unconditionally. Every caller, administrator included, gets
 * `401 "You are not authorized to destroy this resource"`. Use
 * {@link AuthSessionsNamespace.deactivateUser} for the operational need, or
 * {@link AuthSessionsNamespace.deleteAccountStart} for a user deleting
 * themselves, which is a different code path and does work.
 */

import { OmsApiError } from "../../errors";
import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../listing";
import type { AccountSession, User } from "../account";
import type {
  Id,
  PageLoader,
  Paginated,
  PageParams,
  QueryParams,
  RequestOptions,
} from "../../types";
import { DEFAULT_PAGE_SIZE } from "../../types";

/**
 * Name of the httpOnly cookie the backend sets on every session-minting
 * response.
 *
 * Exported for hosts that need to recognise it (a proxy forwarding it, a native
 * client emptying its cookie jar), NOT for reading it: it is `httpOnly`, so
 * `document.cookie` never contains it and no amount of trying will change that.
 * That is the entire point of cookie mode.
 */
export const SESSION_COOKIE_NAME = "oms_session";

/**
 * The seven characters the server slices off the `Authorization` header before
 * looking the token up, spelled the way the Rails source spells them
 * (`"Bearer:".length`).
 *
 * Present so the number 7 appears somewhere other than a comment. The transport
 * writes `"Bearer "` (with a space), which is the same length; both forms work
 * and a token with no prefix at all does not. See the module note.
 */
export const SESSION_BEARER_PREFIX_LENGTH = 7;

/**
 * Digits in an email verification code (`EmailVerification::CODE_LENGTH`).
 *
 * Six, numeric only, zero-padded. This is a deliberate product decision on this
 * project rather than an accident: a code a person can read off a phone and
 * type on a numeric keypad, made safe by a hard attempt budget rather than by
 * length. See {@link VERIFICATION_CODE_MAX_ATTEMPTS}.
 */
export const VERIFICATION_CODE_LENGTH = 6;

/**
 * Wrong guesses an issued code survives (`EmailVerification::MAX_ATTEMPTS`).
 *
 * This is the counterweight to a six-digit code, and it is per CODE, not per IP:
 * rack-attack only throttles by address, so an attacker rotating through a
 * botnet would otherwise walk a million-key space at 10 guesses a minute per
 * address. The budget closes that regardless of where the guesses come from.
 *
 * The exact arithmetic, because off-by-one matters when you are deciding
 * whether to let a user try again: `register_failed_attempt` destroys the code
 * when `attempts + 1 >= MAX_ATTEMPTS`, starting from `attempts = 0`. So four
 * wrong guesses are survivable and the FIFTH burns the code. Burning is
 * permanent - the row is deleted, not locked - and it also fires a
 * `verification_burned` security alert to the owner. The user's only route
 * forward is a fresh `*_start` call, which is throttled at 4 a minute and 20 an
 * hour per IP, so a client that lets someone mash a code field will lock them
 * out of the flow for the rest of the hour.
 *
 * Validate the shape locally with {@link isVerificationCode} before spending an
 * attempt on something that cannot possibly be right.
 */
export const VERIFICATION_CODE_MAX_ATTEMPTS = 5;

/**
 * How long an issued code stays valid (`EmailVerification::EXPIRES_IN`), in
 * milliseconds. Fifteen minutes.
 *
 * Expiry is enforced by an `active` scope plus an opportunistic purge on every
 * issue and every verify, so an expired code behaves exactly like a wrong one:
 * `404 "Invalid Verification"`, indistinguishable from the status alone. Show
 * the user a countdown rather than making them find out.
 */
export const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * How long an OAuth handoff ticket stays valid (`SessionsController::TICKET_TTL`),
 * in milliseconds. Two minutes.
 *
 * The signature window is only half the story - the ticket is also one-time.
 * See {@link AuthSessionsNamespace.adopt}.
 */
export const OAUTH_TICKET_TTL_MS = 2 * 60 * 1000;

/**
 * Every value the `device_type` column accepts, as the server's own enum
 * spells them.
 *
 * The server picks one by parsing the `User-Agent` of the sign-in request, and
 * the user can rename it afterwards through `oms.account.sessions.update()`.
 * The list is mostly a joke, with one entry that is not:
 *
 * **`"teapot"` suppresses alerts.** `Session#alert_login` and
 * `#alert_returning_activity` both bail out for a teapot session, which is how
 * the backend's own background jobs sign in without paging the owner on every
 * run. Do not relabel a real user's device as a teapot to quieten notifications:
 * you are turning off the only signal that a stolen token is being used.
 */
export const SESSION_DEVICE_TYPES = [
  "tablet",
  "console",
  "fridge",
  "teapot",
  "toaster",
  "air_conditioner",
  "car",
  "blender",
  "vacuum_cleaner",
  "washing_machine",
  "lawn_mower",
  "microwave",
  "hair_dryer",
  "electric_toothbrush",
  "desktop",
  "laptop",
  "television",
  "mobile",
  "space_ship",
  "time_machine",
  "hoverboard",
  "teleporter",
  "magic_carpet",
  "unicorn",
  "flying_broom",
  "submarine",
  "hot_air_balloon",
  "keychain",
  "alarm_clock",
  "radio",
  "record_player",
  "other",
] as const;

/** One of {@link SESSION_DEVICE_TYPES}. */
export type SessionDeviceType = (typeof SESSION_DEVICE_TYPES)[number];

/**
 * True when `value` has the shape of an email verification code: exactly
 * {@link VERIFICATION_CODE_LENGTH} ASCII digits.
 *
 * Purely local, and worth calling before every `*Complete` method. A malformed
 * code cannot match anything, but sending it still costs one of the five
 * guesses the live code has ({@link VERIFICATION_CODE_MAX_ATTEMPTS}) and one of
 * the ten requests a minute the IP is allowed. A user who pastes a code with a
 * trailing space should not lose a fifth of their budget to whitespace.
 *
 * The server normalises with `strip`, so surrounding whitespace is forgiven
 * there; this returns `false` for it anyway, so a caller can trim before
 * sending rather than relying on the remote side to be lenient.
 */
export function isVerificationCode(value: string): boolean {
  return new RegExp(`^[0-9]{${VERIFICATION_CODE_LENGTH}}$`).test(value);
}

/** Credentials for {@link AuthSessionsNamespace.signIn}. */
export interface SignInInput {
  /** Normalised server-side with `strip.downcase`; send it as the user typed it. */
  readonly email: string;
  /**
   * Compared with `User.authenticate_by`, which is timing-safe: a wrong
   * password and an unknown address take the same time and give the same
   * message, so this endpoint cannot be used to test whether an account exists.
   */
  readonly password: string;
}

/**
 * What `POST /sessions` answers with: the session record plus, ONCE, the token.
 *
 * This is `SessionBlueprint`'s `:token` view, which is the base view plus one
 * field - Blueprinter views inherit, they do not replace - so everything an
 * ordinary {@link AccountSession} carries is here too, including the inlined
 * `user`. That inline user saves a round trip: there is no need to call
 * `oms.account.me()` straight after signing in.
 *
 * `token` appears in this response and in NO other. Nothing else in the API
 * ever renders it again: `GET /sessions` and `GET /sessions/mine` return the
 * base view, which has no `token` field. Lose it and the only way back is to
 * sign in again, minting another row.
 */
export interface SignedInSession extends AccountSession {
  /**
   * The credential. A bare UUID, no prefix.
   *
   * Store it where the platform stores secrets (Keychain / Keystore via
   * SecureStore on React Native, the OS keyring for the CLI). Do NOT store it
   * when you are in cookie mode - see {@link AuthSessionsNamespace.signIn}.
   */
  readonly token: string;
  /** The signed-in user, rendered inline. Always present on this view. */
  readonly user: User;
}

/**
 * What `POST /sessions/adopt` answers with. Two fields short of a session: the
 * endpoint returns only the token, not the record.
 */
export interface AdoptedSession {
  /** The credential, same kind of value as {@link SignedInSession.token}. */
  readonly token: string;
}

/** What `GET /sessions/oauth_ticket` answers with. */
export interface SessionOAuthTicket {
  /**
   * A signed id for the current session, scoped to the `oauth` purpose and good
   * for {@link OAUTH_TICKET_TTL_MS}. It is NOT a session token and cannot
   * authenticate an API call; the only thing that accepts it is the OAuth link
   * flow, which trades it back for a session through
   * {@link AuthSessionsNamespace.adopt}.
   */
  readonly ticket: string;
}

/** Arguments for {@link AuthSessionsNamespace.signUpComplete}. */
export interface SignUpInput {
  /** The address the code was sent to. Must match `signUpStart` exactly. */
  readonly email: string;
  /** The six digits from the email. */
  readonly code: string;
  /**
   * Display name, 1 to 50 characters. The `handle` is NOT settable here: the
   * server generates one from this name in a `before_create` hook. Change it
   * afterwards with `oms.account.update({ handle })`.
   */
  readonly name: string;
  /** The password. The backend enforces no minimum beyond presence. */
  readonly password: string;
}

/** Arguments for {@link AuthSessionsNamespace.resetPasswordComplete}. */
export interface ResetPasswordInput {
  /** The address the code was sent to. */
  readonly email: string;
  /** The six digits from the email. */
  readonly code: string;
  /** The new password. This is the only field the call changes. */
  readonly password: string;
}

/** Arguments for {@link AuthSessionsNamespace.changeEmailComplete}. */
export interface ChangeEmailInput {
  /** The NEW address, identical to the one passed to `changeEmailStart`. */
  readonly email: string;
  /** The six digits sent to the address currently on the account. */
  readonly prevEmailCode: string;
  /** The six digits sent to the new address. */
  readonly newEmailCode: string;
}

/** Filter columns of `GET /users`, on top of {@link BASE_FILTER_COLUMNS}. */
export const USER_FILTER_COLUMNS = Object.freeze(["name", "handle"] as const);

/** Filters for {@link AuthSessionsNamespace.listUsers}. */
export interface ListUsersParams extends ListParams<(typeof USER_FILTER_COLUMNS)[number]> {
  /** Substring match on the display name, accent-folded and case-insensitive. */
  readonly name?: string;
  /** Substring match on the handle, accent-folded and case-insensitive. */
  readonly handle?: string;
  /** Exact handle. Cheaper and less surprising than `handle` for a lookup. */
  readonly exactHandle?: string;
}

/**
 * The `sessions` namespace, reachable as `oms.sessions`.
 *
 * Named `AuthSessionsNamespace` rather than `SessionsNamespace` because the
 * SDK already has an `AuthNamespace` for OAuth and the RFC 8628 device grant,
 * and the two are genuinely different credentials rather than two spellings of
 * one. Nothing here touches OAuth except {@link adopt} and {@link oauthTicket},
 * which are the two places the browser OAuth flow hands control back to a
 * session.
 */
export class AuthSessionsNamespace extends Resource {
  // ---------------------------------------------------------------- sign-in

  /**
   * `POST /sessions` - trades an email and a password for a session token.
   *
   * Answers `201` with {@link SignedInSession}: the session row, the signed-in
   * user inline, and the token, which appears here and nowhere else ever again.
   *
   * ## What to do with the answer, per mode
   *
   * **Token mode** (React Native, the CLI, anything not served from
   * `omelhorsite.pt`): store `token` in the platform's secret store and build a
   * client with it. The client you called this on has no credential, and adding
   * one to an existing client is not possible - `Oms` takes its token at
   * construction.
   *
   * ```ts
   * const anon = new Oms({ baseUrl });
   * const session = await anon.sessions.signIn({ email, password });
   * await secureStore.set("oms_token", session.token);
   * const oms = new Oms({ baseUrl, token: session.token });
   * ```
   *
   * **Cookie mode** (`new Oms({ sessionCookie: true })`, a first-party page on
   * `omelhorsite.pt` or `music.omelhorsite.pt`): the response carries
   * `Set-Cookie: oms_session=...` and, because the transport sends
   * `credentials: "include"`, the browser stores it. The SAME client is
   * authenticated from the next call onwards; there is nothing to construct and
   * nothing to store.
   *
   * ```ts
   * const oms = new Oms({ sessionCookie: true });
   * await oms.sessions.signIn({ email, password });
   * const me = await oms.account.me(); // already authenticated
   * ```
   *
   * **In cookie mode, throw the token away.** It is still in the response body,
   * in plain JSON, readable by any script on the page - the httpOnly cookie
   * cannot hide what the body already said. Persisting it to `localStorage`
   * re-creates precisely the XSS-exfiltratable copy the cookie mode exists to
   * eliminate, and it also gives you a second credential that outlives the
   * first: sign out, and the cookie dies while the stored token keeps working.
   * The web app is explicit about this - `persistSessionToken` writes only a
   * non-sensitive `authed` flag when `isCookieAuth()`, and actively purges any
   * legacy token it finds.
   *
   * Note that an `Oms` cannot be both: passing `sessionCookie: true` together
   * with a token throws a `TypeError` at construction, deliberately, so that no
   * request ever carries two credentials and leaves the server to choose.
   *
   * ## Cost and failure
   *
   * Throttled to **10 POSTs per minute per IP** (`login/ip`), which is a
   * password-guessing bound and is keyed by address, so several users behind
   * one NAT share it. The throttle matches a normalised path, so `/sessions/`,
   * `//sessions` and `/sessions.json` all count against the same bucket - that
   * gap was closed.
   *
   * Every successful sign-in creates a row AND fires a Discord alert to the
   * owner. Signing in once per process invocation is how a device list fills up
   * with a hundred identical entries; persist the token instead.
   *
   * Retries: an ambiguous network failure is NOT replayed, because this is a
   * `POST` and the transport only replays safe methods by default. That is the
   * right default here - a replay after a lost response mints a second session.
   * A `429` IS still waited out and retried, which on a login screen can mean a
   * silent minute-long pause; pass `retry: false` if you would rather show the
   * user the rate-limit error immediately.
   *
   * Send a meaningful `clientName` on the `Oms` (it becomes `X-Oms-Client`) and,
   * where the platform lets you set it, a real `User-Agent`: the server derives
   * the session's `name`, `description` and `device_type` from the User-Agent of
   * THIS request, and a blank one produces an unhelpful row in the user's own
   * device list that they cannot fix except by renaming it.
   *
   * @throws {OmsAuthError} 401 `"Invalid email address or password."` for a
   *   wrong password, an unknown address, and a deactivated account alike. The
   *   three are not distinguishable, on purpose. (Deactivation is enforced as a
   *   validation on `Session` create, so it fails at the same place.)
   * @throws {OmsQuotaError} 429 once the per-IP login budget is spent.
   */
  async signIn(input: SignInInput, options: RequestOptions = {}): Promise<SignedInSession> {
    return this.http.post<SignedInSession>(
      "/sessions",
      { email: input.email, password: input.password },
      options,
    );
  }

  /**
   * `DELETE /sessions/:id` - ends the session THIS credential is using.
   *
   * ## THE `:id` IS IGNORED. THIS ALWAYS DESTROYS THE CALLING SESSION.
   *
   * `SessionsController#destroy` does not look the path segment up. It does not
   * call `resource`. It reads `Current.session`, destroys that, clears the
   * cookie and answers `204`. So `DELETE /sessions/<any string at all>` means
   * "log ME out", and there is no way through this API to revoke a different
   * device. The web app's own "sign out this other device" button has always
   * signed the user out of the browser they clicked it in.
   *
   * That is why this method takes no id. A signature that accepted one would be
   * describing behaviour the server does not have, and the mistake it invites -
   * passing a row from the device list - logs the user out of the wrong device
   * with a `204` that looks like success.
   *
   * To actually end someone else's sessions there is exactly one lever, and it
   * is administrative: {@link deactivateUser} runs `sessions.delete_all` on the
   * target.
   *
   * ## What it does on the wire
   *
   * One request, to the literal path `/sessions/current`. The segment is a
   * placeholder and it is spelled to read as one. `oms.account.sessions.revokeCurrent()`
   * does the same thing in two requests, resolving the real id first so the call
   * stays correct if the backend is ever fixed to honour the id; this one
   * spends a single round trip and covers that case with a fallback instead,
   * re-resolving through `GET /sessions/mine` and retrying if the placeholder
   * ever starts answering 404.
   *
   * ## It does not throw when there was nothing to sign out of
   *
   * A dead, missing or already-revoked credential answers `404 "Session not
   * found."` or `401`, and both are resolved rather than raised: you asked for
   * the session to be gone and it is gone. Sign-out is idempotent, it usually
   * runs while an app is tearing down, and a throw there strands clients with a
   * credential they have decided to stop using. Everything else - a network
   * failure, a 500, a 429 - is raised normally.
   *
   * Clear your own stored credential regardless of what this resolves to. The
   * server side is best-effort; the client side is the part you control.
   *
   * In cookie mode the response also carries a cookie deletion, so the browser
   * forgets it and the same client is anonymous from the next call onwards.
   */
  async signOut(options: RequestOptions = {}): Promise<void> {
    try {
      await this.http.delete<void>("/sessions/current", options);
      return;
    } catch (thrown) {
      if (!(thrown instanceof OmsApiError)) throw thrown;
      if (thrown.status === 401) return;
      if (thrown.status !== 404) throw thrown;
    }

    // Only reachable if the backend starts honouring the `:id`, at which point
    // the placeholder segment is a genuine 404 and the real id is needed.
    let sessionId: Id;
    try {
      sessionId = (await this.http.get<AccountSession>("/sessions/mine", options)).id;
    } catch (thrown) {
      // No live session to resolve. The desired end state already holds.
      if (thrown instanceof OmsApiError && (thrown.status === 401 || thrown.status === 404)) return;
      throw thrown;
    }

    try {
      await this.http.delete<void>(`/sessions/${encodeURIComponent(sessionId)}`, options);
    } catch (thrown) {
      if (thrown instanceof OmsApiError && (thrown.status === 401 || thrown.status === 404)) return;
      throw thrown;
    }
  }

  /**
   * `GET /sessions/mine` - the session the current credential resolves to.
   *
   * The cheapest liveness check there is, and the one the web app and the
   * native app both boot with: a `200` means the stored credential still names
   * a row, a `401` means it does not and the user must sign in again. Identical
   * to `oms.account.sessions.current()`; both are here because "am I still
   * signed in" belongs to the sign-in lifecycle and "which devices are signed
   * in" belongs to the account screen.
   *
   * Returns the base `SessionBlueprint` view, with the owner inlined under
   * `user` and WITHOUT `token`. There is no route that hands a token back.
   *
   * `/sessions/mine` is the whole spelling. There is NO `GET /sessions/current`:
   * `resources :sessions` is declared `only: [:index, :create, :update,
   * :destroy]`, so `show` is not routed and a GET to `/sessions/current` is a
   * 404. (It IS a live path on DELETE, where it is the placeholder id
   * {@link signOut} uses, which is exactly the sort of coincidence that makes
   * the wrong spelling look plausible.)
   *
   * Note that reaching this endpoint at all rewrites `last_used_at` and can
   * fire the "user is active again" alert, so it is not free of side effects
   * and is not a good thing to poll.
   *
   * Counts against the general authenticated ceiling, 600 a minute. Careful
   * with the failure case: a request whose token does not resolve is billed to
   * the ANONYMOUS per-IP bucket of 120 a minute instead, so a client that
   * retries a dead credential in a loop can rate-limit every user sharing that
   * address.
   *
   * @throws {OmsAuthError} 401 when the credential is absent or dead.
   * @throws {OmsApiError} 404 `"Session not found."` when the credential
   *   resolved to nothing but the request still reached the action.
   */
  async current(options: RequestOptions = {}): Promise<AccountSession> {
    return this.http.get<AccountSession>("/sessions/mine", options);
  }

  /**
   * `POST /sessions/adopt` - trades a one-time OAuth ticket for a session.
   *
   * The last step of the browser OAuth flow. The provider round trip happens on
   * the API host; its callback redirects the browser back to
   * `https://omelhorsite.pt/account/oauth/callback?ticket=...` (hardcoded to
   * `Rails.configuration.frontend_url`, not configurable per client), and the
   * page hands that ticket here. The ticket exists so the session token itself
   * never travels in a URL, a browser history entry or a `Referer`.
   *
   * Unauthenticated by design: this IS the sign-in step. Call it on a client
   * with no credential. Answers `201 {"token": "..."}` and sets the cookie,
   * exactly like {@link signIn}, so the same "which mode am I in" reasoning
   * applies to the token it returns.
   *
   * ## MUST NOT BE RETRIED, and this method enforces that
   *
   * The ticket is one-time on the server. Redemption is claimed atomically with
   * `Rails.cache.write(..., unless_exist: true)` before the session is adopted,
   * and a second presentation of the same ticket gets the same `401 "Invalid or
   * expired ticket."` as a forged one. So a retry after an ambiguous failure -
   * a torn connection, a lost response - burns the ticket and reports a login
   * failure for a login that actually SUCCEEDED. The user is left staring at an
   * error page while the browser quietly holds a valid session cookie.
   *
   * This method therefore passes `retry: false` and a caller cannot override it
   * back on. If the call fails ambiguously, the honest recovery is to check
   * {@link current} before deciding anything: if it answers, you are signed in.
   *
   * The app-side documentation (`oms-music/docs/auth-account.md`, section 6)
   * says the ticket is "not single-use server-side" and that the web enforces
   * single use client-side with a sessionStorage nonce. THAT IS OUT OF DATE.
   * The Rails code enforces it, and it is the enforcement that makes a retry
   * destructive. When the doc and the Rails disagree, the Rails wins.
   *
   * Tickets are also short-lived, {@link OAUTH_TICKET_TTL_MS} (two minutes), so
   * do not stash one to redeem later.
   *
   * @throws {OmsAuthError} 401 `"Invalid or expired ticket."` for a forged
   *   ticket, an expired one, and an already-redeemed one alike.
   */
  async adopt(ticket: string, options: RequestOptions = {}): Promise<AdoptedSession> {
    return this.http.post<AdoptedSession>("/sessions/adopt", { ticket }, { ...options, retry: false });
  }

  /**
   * `GET /sessions/oauth_ticket` - mints a short-lived ticket for the current
   * session, so the session token itself never crosses a subdomain boundary.
   *
   * Only the web app needs this, and only for one thing: linking an OAuth
   * provider to an account that is already signed in. That flow is a full-page
   * navigation to `backend.omelhorsite.pt/auth/link/<provider>`, and a
   * navigation cannot carry an `Authorization` header. The cookie is host-only
   * on the API host, so it does not help either. The alternative would be
   * `?token=<the session token>` in a URL that lands in browser history and in
   * a `Referer`, which is exactly what this endpoint exists to avoid.
   *
   * Native and CLI clients have no such constraint and do not need this: they
   * hold the token already.
   *
   * The result is scoped to the `oauth` purpose and expires after
   * {@link OAUTH_TICKET_TTL_MS}. It authenticates nothing else - an API call
   * carrying it as a bearer token is anonymous - and it is spent by the first
   * {@link adopt} that redeems it. Mint one per navigation, never cache it.
   *
   * Requires a live session. Counts against the general authenticated ceiling.
   *
   * @throws {OmsApiError} 404 `"Session not found."` when there is no live
   *   session behind the credential.
   */
  async oauthTicket(options: RequestOptions = {}): Promise<SessionOAuthTicket> {
    return this.http.get<SessionOAuthTicket>("/sessions/oauth_ticket", options);
  }

  // ------------------------------------------------- account creation (OTP)

  /**
   * `POST /users/create_start` - emails a six-digit code to an address that
   * does not have an account yet.
   *
   * Step one of two. Nothing is created here: the row appears only when
   * {@link signUpComplete} presents the code back. Anonymous, and it must be -
   * the caller has no account yet.
   *
   * Answers `200` with a BARE JSON STRING, not an object:
   * `"Verification code sent to your email."`. Several endpoints in this
   * namespace do that; the transport parses it into a `string`, so read it as
   * one and do not reach for a `.message` that is not there.
   *
   * This is the one `*_start` in the family that leaks whether an address is
   * registered: it answers `409 "Email already registered."` when it is. That
   * is a deliberate trade for a usable signup form, and it is why
   * {@link resetPasswordStart} does the opposite.
   *
   * Issuing a code DELETES any live code for the same address and reason
   * (`where(reason:, email:).delete_all` before insert). One code per flow per
   * address, always. A user who asks for a second code and then types the first
   * one gets `404 "Invalid Verification"` and, worse, spends one of the five
   * guesses belonging to the code they cannot see. Tell them the old code is
   * dead when they request a new one.
   *
   * Throttled hard, and shared across all four `*_start` endpoints of the
   * family: **4 per minute AND 20 per hour, per IP**. Both windows apply. This
   * is anti-email-bombing, and the hourly one is what a "resend code" button
   * with no cooldown will hit. Put a client-side cooldown on that button.
   *
   * @throws {OmsApiError} 409 when the address already has an account.
   * @throws {OmsApiError} 422 with an array of validation messages when the
   *   address is not a valid email.
   * @throws {OmsQuotaError} 429 on either the per-minute or the hourly bucket.
   */
  async signUpStart(email: string, options: RequestOptions = {}): Promise<string> {
    return this.http.post<string>("/users/create_start", { email }, options);
  }

  /**
   * `POST /users/create_end` - presents the code and creates the account.
   *
   * Answers `201` with the new {@link User}. Anonymous.
   *
   * ## IT DOES NOT SIGN YOU IN
   *
   * No session is created and no token is returned. The account exists and the
   * caller is still anonymous. Follow it immediately with {@link signIn} using
   * the same email and password - that is what both the web app and the native
   * app do, and forgetting it is the classic "signup worked but the app is
   * still on the login screen" bug.
   *
   * ```ts
   * await oms.sessions.signUpStart(email);
   * // user reads the email, types six digits
   * await oms.sessions.signUpComplete({ email, code, name, password });
   * const session = await oms.sessions.signIn({ email, password });
   * ```
   *
   * `handle` cannot be chosen here even though the column exists: the parameter
   * is not permitted on this action, and a `before_create` hook generates one
   * from `name`. Let the user change it afterwards with
   * `oms.account.update({ handle })`, where 15 characters is the ceiling.
   *
   * Consuming the code also stamps `email_verified_at`, inside the same create.
   * The address is proven, so a freshly signed-up account is never in the
   * "verify your email" limbo.
   *
   * Throttled to **10 a minute per IP**, shared with the other three `*_end`
   * endpoints. Remember the per-code budget is separate and much smaller:
   * {@link VERIFICATION_CODE_MAX_ATTEMPTS} wrong guesses destroy the code
   * outright.
   *
   * @throws {OmsApiError} 404 `"Invalid Verification"` for a wrong code, an
   *   expired code, a code issued for a different address, and a code that has
   *   already been burned. All four look identical.
   * @throws {OmsApiError} 422 with validation messages when the code was right
   *   but the account could not be created - a name that is too long, an
   *   address taken in the meantime. The code is CONSUMED by then, so the user
   *   has to restart at {@link signUpStart}.
   */
  async signUpComplete(input: SignUpInput, options: RequestOptions = {}): Promise<User> {
    return this.http.post<User>(
      "/users/create_end",
      { email: input.email, code: input.code, name: input.name, password: input.password },
      options,
    );
  }

  // -------------------------------------------------- password reset (OTP)

  /**
   * `POST /users/reset_password_start` - emails a reset code, if the address is
   * registered.
   *
   * Anonymous. **Always answers `200` with the same bare string**, whether or
   * not the address exists: `"If that email is registered, password reset
   * instructions have been sent."`. That is anti-enumeration, and it is the
   * deliberate opposite of {@link signUpStart}, which does tell you. Do not
   * present this result to the user as confirmation that mail is on its way to
   * a real account, because it is not evidence of that.
   *
   * A real send also fires a `password_reset_started` security alert to the
   * owner.
   *
   * Same throttle family as every other `*_start`: **4 a minute and 20 an hour
   * per IP**, shared.
   */
  async resetPasswordStart(email: string, options: RequestOptions = {}): Promise<string> {
    return this.http.post<string>("/users/reset_password_start", { email }, options);
  }

  /**
   * `POST /users/reset_password_end` - presents the code and sets a new
   * password.
   *
   * Anonymous, and answers `200` with the updated {@link User}. `password` is
   * the ONLY field it writes; anything else in the body is dropped.
   *
   * It does NOT sign you in and it does NOT revoke other sessions. Resetting a
   * password because it may have leaked leaves every existing session token
   * alive, since a session is a row and not a signature over the password. If
   * you are building a "my account was compromised" flow, changing the password
   * is not enough on its own, and this API gives a user no way to end their own
   * other sessions ({@link signOut} only ends the caller's). Escalating to an
   * administrator and {@link deactivateUser} is the only lever that clears them.
   *
   * Consuming the code stamps `email_verified_at`: proving control of the
   * mailbox verifies the address even if it never was verified before.
   *
   * Throttled to **10 a minute per IP**, shared with the other `*_end`
   * endpoints, on top of the per-code budget of
   * {@link VERIFICATION_CODE_MAX_ATTEMPTS}.
   *
   * @throws {OmsApiError} 404 `"Invalid Verification"` for a wrong, expired,
   *   burned or mismatched code; also `"User not found."` in the narrow race
   *   where the account is deleted between the code being verified and the row
   *   being loaded.
   * @throws {OmsApiError} 422 with validation messages when the new password is
   *   rejected. The code is already consumed at that point.
   */
  async resetPasswordComplete(input: ResetPasswordInput, options: RequestOptions = {}): Promise<User> {
    return this.http.post<User>(
      "/users/reset_password_end",
      { email: input.email, code: input.code, password: input.password },
      options,
    );
  }

  // --------------------------------------------------- email change (OTP x2)

  /**
   * `POST /users/update_email_start` - emails TWO codes: one to the address
   * currently on the account, one to the address it is moving to.
   *
   * Requires a live session. One HTTP request, two `EmailVerification` rows,
   * two different reasons (`email_update_prev` and `email_update_new`), and
   * {@link changeEmailComplete} needs both codes back. Proving control of the
   * new mailbox alone is not enough: an attacker sitting on a hijacked session
   * would otherwise move the account to an address they own and lock the real
   * owner out permanently.
   *
   * The old address is read from the session, never from the arguments, so
   * there is nothing to spoof: `email` here is the NEW address only.
   *
   * The two issues are not atomic. The previous-address code is issued first,
   * and if the new address fails validation the call answers `422` with the old
   * code already sent and live. Harmless, but expect users to report a code
   * arriving for a change that "failed".
   *
   * Answers `200` with the bare string `"Email update instructions sent."`.
   *
   * Same shared `*_start` throttle: **4 a minute and 20 an hour per IP**. Note
   * that this is one request even though it sends two emails, so it costs one
   * unit of the budget, not two.
   *
   * @throws {OmsAuthError} 401 without a live session.
   * @throws {OmsApiError} 422 with validation messages when either address is
   *   not a valid email.
   */
  async changeEmailStart(newEmail: string, options: RequestOptions = {}): Promise<string> {
    return this.http.post<string>("/users/update_email_start", { email: newEmail }, options);
  }

  /**
   * `POST /users/update_email_end` - presents both codes and moves the address.
   *
   * Requires a live session; answers `200` with the updated {@link User}.
   *
   * Both codes are checked BEFORE either is consumed (the controller verifies
   * twice with `destroy: false`, then verifies again to consume), so getting
   * one right and one wrong burns neither. What it does still cost is an
   * attempt against BOTH live codes: a wrong guess charges
   * `register_failed_attempt` on the code for that reason, so a user typing the
   * two codes into the wrong boxes spends one of the five guesses on each. With
   * two codes in play the per-code budget is easier to exhaust than anywhere
   * else in this family - validate with {@link isVerificationCode} first, and
   * label the two inputs unmistakably.
   *
   * Consuming both stamps `email_verified_at`, since both mailboxes are proven.
   *
   * Throttled to **10 a minute per IP**, shared with the other `*_end`
   * endpoints.
   *
   * @throws {OmsAuthError} 401 without a live session.
   * @throws {OmsApiError} 404 `"Invalid Verification"` when either code is
   *   wrong, expired or burned. The message does not say which one.
   * @throws {OmsApiError} 422 with validation messages when the new address is
   *   rejected at write time - already taken, malformed. Both codes are
   *   consumed by then and the flow restarts at {@link changeEmailStart}.
   */
  async changeEmailComplete(input: ChangeEmailInput, options: RequestOptions = {}): Promise<User> {
    return this.http.post<User>(
      "/users/update_email_end",
      {
        email: input.email,
        prev_email_code: input.prevEmailCode,
        new_email_code: input.newEmailCode,
      },
      options,
    );
  }

  // ----------------------------------------------- account deletion (OTP)

  /**
   * `POST /users/destroy_start` - emails a deletion code to the address on the
   * account.
   *
   * Requires a live session. The address is taken from the session, so a user
   * can only ever start deleting themselves; there is no argument and nothing
   * to point at somebody else.
   *
   * Not in the same league as the other flows: {@link deleteAccountComplete}
   * destroys the row and everything hanging off it. Make the confirmation
   * unmistakable, and note that the code is the only thing standing between a
   * hijacked session and a deleted account.
   *
   * Answers `200` with the bare string `"User deletion instructions sent."`.
   * Shared `*_start` throttle: **4 a minute and 20 an hour per IP**.
   *
   * Included here even though it is the one pair of routes the sibling
   * documentation does not list, because nothing else in the SDK covers it and
   * a user who cannot delete their account has no exit.
   *
   * @throws {OmsAuthError} 401 without a live session.
   */
  async deleteAccountStart(options: RequestOptions = {}): Promise<string> {
    return this.http.post<string>("/users/destroy_start", undefined, options);
  }

  /**
   * `POST /users/destroy_end` - presents the code and DESTROYS THE ACCOUNT.
   *
   * Requires a live session. Irreversible: `user.destroy` runs, taking the
   * user's sessions, files, music library and everything else that cascades
   * from the row. There is no soft-delete on this path and no undo.
   * {@link deactivateUser} is the reversible operation, and it is
   * administrators only.
   *
   * Answers `200` with an empty body. The credential is dead the moment this
   * resolves - the sessions went with the user - so discard the client and
   * every stored token; do not try to {@link signOut} afterwards.
   *
   * Throttled to **10 a minute per IP**, shared with the other `*_end`
   * endpoints, plus the per-code budget.
   *
   * @throws {OmsAuthError} 401 without a live session.
   * @throws {OmsApiError} 404 `"Invalid Verification"` for a wrong, expired or
   *   burned code.
   * @throws {OmsApiError} 500 with the model's error messages when the record
   *   could not be destroyed - a foreign key that refused to cascade. The
   *   account survives; the code does not.
   */
  async deleteAccountComplete(code: string, options: RequestOptions = {}): Promise<void> {
    await this.http.post<unknown>("/users/destroy_end", { code }, options);
  }

  // ------------------------------------------------------ user administration

  /**
   * `GET /users` - the user roster.
   *
   * Requires a credential, and any authenticated account can enumerate the
   * whole table: `User.viewable_by` is `->(user) { all }`. What an ordinary
   * caller does NOT get is the privileged columns - `group`, `email`, `gender`,
   * `last_seen_at`, `sessions_count`, `deactivated_at` and
   * `allowed_to_use_spotify` are all rendered conditionally, so an absent key
   * means "not visible to you", never "empty".
   *
   * This used to be anonymous and is not any more, precisely so that the roster
   * could not be harvested. For a picker, prefer `oms.account.search()`: it is
   * anonymous, capped at eight rows, and returns only id, handle and name.
   *
   * Only `name` and `handle` are filterable. Any other key is a `400 "Unknown
   * search filter"` - this DSL fails closed rather than ignoring what it does
   * not recognise.
   *
   * Deactivated accounts are NOT filtered out of this listing (the `active`
   * scope is applied by `users#search`, not by the index), so a roster shows
   * them; an administrator can tell by `deactivated_at`, and nobody else can.
   *
   * Index responses carry an `ETag`, so a repeat can answer `304` with no body.
   * Counts against the general authenticated ceiling, 600 a minute.
   */
  async listUsers(params: ListUsersParams = {}, options: RequestOptions = {}): Promise<Paginated<User>> {
    const base = {
      search: { name: params.name, handle: params.handle },
      exactSearch: { handle: params.exactHandle },
    };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<User[]>("/users", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `POST /users/:id/deactivate` - administrators only. Suspends an account.
   *
   * ## This is also the only way to revoke somebody's sessions
   *
   * `User#deactivate!` stamps `deactivated_at` and runs `sessions.delete_all`
   * in the same transaction, so every device the target is signed in on is
   * logged out at once, and `Session`'s create validation then refuses to mint
   * a new one. It is the single lever in this API that ends a session other
   * than the caller's own - {@link signOut} cannot, and neither can anything in
   * `oms.account.sessions`. If a token has leaked, this is the response.
   *
   * Reversible with {@link reactivateUser}, which clears the stamp. The old
   * sessions do not come back; the user signs in again.
   *
   * Answers `200` with the target {@link User}.
   *
   * @throws {OmsAuthError} 401 `"Admins only."` for a non-administrator, and
   *   also for an anonymous caller.
   * @throws {OmsApiError} 400 `"Cannot deactivate yourself."` - the guard that
   *   stops an administrator locking themselves out.
   * @throws {OmsApiError} 404 `"User not found."`
   */
  async deactivateUser(id: Id, options: RequestOptions = {}): Promise<User> {
    return this.http.post<User>(`/users/${encodeURIComponent(id)}/deactivate`, undefined, options);
  }

  /**
   * `POST /users/:id/reactivate` - administrators only. Clears
   * `deactivated_at`.
   *
   * The account can sign in again from the next request. It does NOT restore
   * the sessions {@link deactivateUser} deleted, so every device has to sign in
   * fresh. Answers `200` with the target {@link User}.
   *
   * Unlike deactivation there is no self-guard, because reactivating yourself
   * is not reachable: a deactivated administrator has no session to call with.
   *
   * @throws {OmsAuthError} 401 `"Admins only."`
   * @throws {OmsApiError} 404 `"User not found."`
   */
  async reactivateUser(id: Id, options: RequestOptions = {}): Promise<User> {
    return this.http.post<User>(`/users/${encodeURIComponent(id)}/reactivate`, undefined, options);
  }
}

