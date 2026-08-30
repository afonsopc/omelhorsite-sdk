/** `oms.admin.oauthApplications` - the review queue and the registry of every OAuth client. Administrators only. */

import type { OmsScope } from "../../auth/tokens";
import { Resource } from "../../http";
import type { RequestOptions, Timestamp } from "../../types";
import type { OauthApplicationSummary } from "./types";
import { scopeList } from "../../internal/helpers";

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
 * ({@link OwnedOauthApplicationDeletion}). One value, two routes, two names,
 * and nothing reconciles them.
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
 * Together with the self-service surface, this is the ONLY way a client gets
 * registered: dynamic client registration is off, and there is no client
 * management under `/oauth/*`.
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
   * **Answers `200`, not `201`**, unlike the self-service registration. Do not
   * branch on the status.
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
