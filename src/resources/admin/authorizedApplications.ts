/** `oms.admin.authorizedApplications` - the applications you gave access to your account. */

import { Resource } from "../../http";
import type { RequestOptions, Timestamp } from "../../types";
import type { OauthApprovalStatus } from "./types";

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
   * person thinks "stop that application", not "kill token 4712".
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
