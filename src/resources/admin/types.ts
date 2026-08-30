/** Shapes, constants and helpers shared by more than one `admin` module. */

import type { Id, Timestamp } from "../../types";

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
 * Three keys and no more. This is not the full user record, precisely so that
 * reviewing a client does not leak an email address or a session count into an
 * admin panel.
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
 * The owner routes and the administrator routes emit the same eleven keys on
 * purpose, so one renderer works on both surfaces. The differences are in the
 * VALUES, not the keys, and there are exactly two:
 *
 * - `approved_by` is hardcoded `null` on the owner routes. Which administrator
 *   decided what is deliberately withheld from the applicant, so read it as
 *   "not disclosed", not as "nobody approved it";
 * - the owner routes only ever show you your own rows, so `owner` there is
 *   always you.
 */
export interface OauthApplicationSummary {
  /**
   * Primary key, and an **integer**: one of the handful of ids in this API that
   * is not a string. Do not compare it against an {@link Id}.
   */
  readonly id: number;
  /** The public `client_id`, i.e. the `uid` column. Not a secret. */
  readonly client_id: string;
  /** What the consent screen renders. At most 60 characters. */
  readonly name: string;
  /**
   * Already split: what arrives here is an array and never needs splitting.
   *
   * An EMPTY array would be dangerous rather than harmless - on the server a
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
   * the server stores it. Use {@link splitRedirectUris} rather than reading it
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

/** The longest name the server accepts, measured after normalisation. */
export const OAUTH_APP_NAME_MAX_LENGTH = 60;

/**
 * How many of ONE person's clients may sit in the review queue at once. The
 * sixth answers `429 too_many_pending`, and so does an edit that would send a
 * sixth approved client back into the queue. Deleting a pending client frees
 * its slot immediately.
 */
export const OAUTH_APP_MAX_PENDING = 5;

/** The most redirect URIs one client may register. More than this is `400 redirect_uri_excessive`. */
export const OAUTH_REDIRECT_URI_MAX_COUNT = 8;

/** The longest `redirect_uri` value the server accepts, counted across the whole space-separated string. */
export const OAUTH_REDIRECT_URI_MAX_LENGTH = 1024;

/**
 * What a blank `redirect_uri` registers.
 *
 * RFC 8252 section 7.3. No port, because the client listens on an ephemeral one
 * and the server drops the port from both sides before comparing, so
 * `http://127.0.0.1:49731/callback` matches the first entry.
 *
 * Both literals, because `127.0.0.1` and `[::1]` are two different hosts to
 * that comparison and an IPv6-only machine can only bind the second.
 * `localhost` is deliberately absent and registering it is a mistake: the
 * server does not treat a name as loopback and would then demand an exact port
 * match, which is the one thing an ephemeral port cannot promise.
 */
export const NATIVE_LOOPBACK_REDIRECT_URIS: readonly string[] = Object.freeze([
  "http://127.0.0.1/callback",
  "http://[::1]/callback",
]);

/** {@link NATIVE_LOOPBACK_REDIRECT_URIS} as the single column value the server stores. */
export const NATIVE_LOOPBACK_REDIRECT_VALUE = "http://127.0.0.1/callback http://[::1]/callback";

/**
 * The `client_id`s this project ships itself.
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
 * review gate exists to prevent. The server draws the same distinction, and the
 * consent screen uses the pinned list too.
 */
export function isShippedClient(application: { readonly client_id: string }): boolean {
  return SHIPPED_CLIENT_IDS.includes(application.client_id);
}

/**
 * Splits the one space-separated `redirect_uri` column into the URIs it holds.
 *
 * The server keeps every registered redirect URI in a single column. Splitting
 * on whitespace is exactly what the server does on the way in, so what comes
 * back out is what was registered, character for character.
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
 * The rule reproduced here is:
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
