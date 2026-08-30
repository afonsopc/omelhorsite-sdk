/** `oms.admin.identities` - the social logins linked to your account. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../listing";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../types";

/** The identity providers this server accepts. */
export const IDENTITY_PROVIDERS = ["google_oauth2", "github", "spotify"] as const;

/**
 * One of {@link IDENTITY_PROVIDERS}. Note `"google_oauth2"`, not `"google"`:
 * it is the exact value the server stores and matches on.
 */
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

/**
 * A social login linked to your account.
 *
 * This is OAuth coming IN - signing in with Google, GitHub or Spotify - and it
 * is the opposite direction from {@link AuthorizedApplication}.
 *
 * Seven fields and NOTHING else, which is the interesting part: the server also
 * holds `uid`, `oauth_token`, `oauth_refresh_token`, `oauth_expires_at` and the
 * entire `raw_info` payload from the provider, and none of them cross the wire.
 * There is no endpoint that will hand you a provider token.
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

/** Filter columns of `GET /identities`, on top of {@link BASE_FILTER_COLUMNS}. */
export const LINKED_IDENTITY_FILTER_COLUMNS = Object.freeze(["user_id"] as const);

/** Filters for {@link LinkedIdentitiesNamespace.list}. */
export interface ListLinkedIdentitiesParams extends ListParams<(typeof LINKED_IDENTITY_FILTER_COLUMNS)[number]> {
  /** Defaults to `"created_at:desc"`. */
  readonly order?: string;
}

/**
 * `oms.admin.identities` - the Google, GitHub and Spotify logins linked to
 * YOUR account.
 *
 * Any authenticated user, and strictly their own rows: the listing is narrowed
 * to the caller and being an administrator buys nothing extra here. There is no
 * admin view of other people's identities anywhere in this API.
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
    const base = { order: "created_at:desc" };
    return paginate(params, 100, (at) =>
      this.http.get<LinkedIdentity[] | undefined>("/identities", { ...options, query: listQuery(params, at, base) }),
    );
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
