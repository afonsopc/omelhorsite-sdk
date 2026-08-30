/**
 * The `auth` namespace: signing in, refreshing, signing out, and knowing who
 * the current credential belongs to.
 *
 * Re-exports every sibling module so nobody has to touch this file again.
 *
 * Two of these methods want a credential and the rest want none, which is the
 * one thing to get right when wiring a host:
 *
 * - `device.start`, `device.wait`, `device.poll`, `refresh` and `revoke` carry
 *   `client_id` in a form body and must NOT send `Authorization`. Call them on
 *   an `Oms` built with no token.
 * - `whoami` and `userinfo` are ordinary bearer-authenticated calls. Call them
 *   on the credentialed `Oms`.
 *
 * ```ts
 * const anon = new Oms({ baseUrl, fetch });
 * const grant = await anon.auth.device.start({ clientId, scope: "openid storage:read" });
 * // host shows grant.verificationUriComplete ?? grant.verificationUri
 * const set = await anon.auth.device.wait({ clientId, deviceCode: grant.deviceCode, ...grant });
 *
 * const tokens = new OAuthTokenProvider({
 *   store,
 *   refresh: (refreshToken) => anon.auth.refresh(refreshToken, { clientId }),
 * });
 * await tokens.set(set);
 * const oms = new Oms({ baseUrl, fetch, tokens });
 * const me = await oms.auth.whoami();
 * ```
 */

import { ApiClient, Resource } from "../http";
import type { RequestOptions } from "../types";
import { DeviceFlow } from "./device";
import type { IdentityClaims, TokenSet } from "./tokens";
import { oauthErrorFrom, oauthPost, parseScopes, tokenSetFromResponse } from "./tokens";

export * from "./device";
export * from "./tokens";

/** Who the current credential belongs to. */
export interface WhoAmI {
  /** The stable user identifier; matches the OIDC `sub` claim. */
  readonly id: string;
  /** Current handle. Mutable - never key anything on it. */
  readonly handle: string;
  /** Current email. Mutable. */
  readonly email?: string;
  /** Scopes the credential carries, or `undefined` for a legacy session token. */
  readonly scopes?: string[];
  /** Whether the credential is an OAuth token rather than a legacy session token. */
  readonly oauth: boolean;
}

/**
 * The subset of the OIDC discovery document worth naming. Everything else the
 * server publishes is still there under the index signature.
 */
export interface DiscoveryDocument {
  readonly issuer: string;
  readonly token_endpoint: string;
  readonly device_authorization_endpoint?: string;
  readonly userinfo_endpoint?: string;
  readonly jwks_uri?: string;
  readonly scopes_supported?: string[];
  readonly grant_types_supported?: string[];
  readonly [member: string]: unknown;
}

/** The `auth` namespace, reachable as `oms.auth`. */
export class AuthNamespace extends Resource {
  /** RFC 8628 device grant, for CLIs and headless clients. */
  readonly device: DeviceFlow;

  constructor(http: ApiClient) {
    super(http);
    this.device = new DeviceFlow(http);
  }

  /**
   * `GET /account` with the current credential: resolves who is signed in.
   *
   * The cheapest way to check that a stored token is still alive. Needs the
   * credential, so call it on the credentialed client.
   *
   * `email` comes back only when the `email` scope was granted, and `scopes` is
   * `undefined` for a legacy opaque session token - which has no scopes because
   * it carries full account authority.
   */
  async whoami(options: RequestOptions = {}): Promise<WhoAmI> {
    const body = await this.http.get<unknown>("/account", options);
    return readWhoAmI(body);
  }

  /**
   * Exchanges a refresh token for a fresh {@link TokenSet}.
   *
   * The answer carries a NEW refresh token and a freshly built id token;
   * discard the old refresh token the moment this resolves. Not retried: a
   * replay after a lost response would spend a refresh token the server has
   * already rotated and sign the user out.
   *
   * A 4xx here is a normal end state, not a fault - the grant was revoked, or
   * it sat unused past the server's absolute lifetime. Clear the stored set
   * and ask the person to sign in again. {@link OAuthTokenProvider} does that
   * on its own.
   */
  async refresh(refreshToken: string, input: { clientId: string }, options: RequestOptions = {}): Promise<TokenSet> {
    let body: unknown;
    try {
      body = await oauthPost(
        this.http,
        "/oauth/token",
        { grant_type: "refresh_token", refresh_token: refreshToken, client_id: input.clientId },
        options,
      );
    } catch (thrown) {
      throw oauthErrorFrom(thrown) ?? thrown;
    }
    return tokenSetFromResponse(body, Date.now());
  }

  /**
   * Revokes a token at `POST /oauth/revoke` (RFC 7009). Revoking a refresh
   * token kills the whole grant.
   *
   * Answers `200` both for a real revocation and for a token the server has
   * never seen, which is what RFC 7009 asks for: a client signing out must not
   * be able to tell the two apart. A `403` means the token belongs to another
   * application - a bug in the caller, not a state to recover from.
   */
  async revoke(token: string, input: { clientId: string }, options: RequestOptions = {}): Promise<void> {
    try {
      await oauthPost(this.http, "/oauth/revoke", { token, client_id: input.clientId }, options);
    } catch (thrown) {
      throw oauthErrorFrom(thrown) ?? thrown;
    }
  }

  /**
   * Reads the OIDC claims of the current credential from
   * `GET /oauth/userinfo`. `sub` is the user's stable `id`.
   *
   * Needs the `openid` scope; without it the answer is 403. Members whose
   * value is null or empty are omitted from the response, so read defensively.
   *
   * `email_verified: false` means the server holds no proof for that address -
   * NOT that the address is wrong. Do not present it as an invalid email.
   */
  async userinfo(options: RequestOptions = {}): Promise<IdentityClaims> {
    return this.http.get<IdentityClaims>("/oauth/userinfo", options);
  }

  /**
   * `GET /.well-known/openid-configuration`, for diagnostics only.
   *
   * Never call this on the hot path. Every path this SDK uses is stable and
   * same-origin with `baseUrl`; spending a round trip to rediscover them - in
   * an isolate that may only ever handle one request - is pure waste.
   */
  async discover(options: RequestOptions = {}): Promise<DiscoveryDocument> {
    return this.http.get<DiscoveryDocument>("/.well-known/openid-configuration", options);
  }
}

/** Maps the `/account` payload onto {@link WhoAmI}, tolerating either credential. */
function readWhoAmI(body: unknown): WhoAmI {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("GET /account did not answer with a JSON object.");
  }
  const record = body as Record<string, unknown>;

  const id = record["id"];
  const handle = record["handle"];
  if (typeof id !== "string" || typeof handle !== "string") {
    throw new TypeError("GET /account answered without an id or a handle.");
  }

  const scopes = record["scopes"] === undefined ? undefined : parseScopes(record["scopes"]);

  return {
    id,
    handle,
    ...(typeof record["email"] === "string" ? { email: record["email"] } : {}),
    ...(scopes === undefined ? {} : { scopes }),
    oauth: record["oauth"] === true,
  };
}
