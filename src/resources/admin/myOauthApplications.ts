/** `oms.admin.myApplications` - the OAuth clients you registered. */

import type { OmsScope } from "../../auth/tokens";
import { Resource } from "../../http";
import type { RequestOptions } from "../../types";
import type { OauthApplicationSummary } from "./types";
import { scopeList } from "../../internal/helpers";

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
 * The server stores only a hash of it, so there is nothing to read back: losing
 * the string means rotating, and rotating breaks whatever was using the old
 * one. Capture it in the same expression that made the call.
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
 * ({@link AdminOauthApplicationDeletion}). Two routes, two spellings of one
 * value, and nothing normalises them - a shared renderer reading `client_id`
 * shows `undefined` for half the app.
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
 * The server branches on whether the key is present, so sending a field at all
 * is asking for it to be written, and writing the same value it already had
 * still counts as a write for the purposes of the requeue rule below.
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

/**
 * `oms.admin.myApplications` - the OAuth clients **you registered**.
 *
 * Needs an ordinary authenticated session and nothing more. Every action starts
 * from a relation already narrowed to the caller, so another person's id and an
 * id that was never issued produce the identical `404` and there is no way to
 * probe whether a client exists.
 *
 * **This is not `/oauth/*`.** There is no client management under `/oauth/*`
 * at all (`/oauth/applications` is a hard 404); `/oauth_applications` is this
 * API's own and is authenticated the same way every other endpoint here is.
 * Authentication is by SESSION, deliberately: you do not manage the keys to the
 * house with a key to the house, and an OAuth token cannot reach these routes.
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
   * A `client_secret` never appears here.
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
   * - the server allows **10 registrations per hour and 20 per day, keyed by
   *   the OWNER** (not the session, so logging in again does not buy a fresh
   *   budget). It answers `{"error":"rate_limited","retry_after":N}` WITH a
   *   `Retry-After` header, so the {@link OmsQuotaError} carries
   *   `retryAfterMs`. Waiting fixes it.
   * - the server refuses a sixth PENDING client with
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
   *   an already-approved client: the server authenticates a public client on
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
   * administrator reviewed has changed, so the anti-phishing rule correctly
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
