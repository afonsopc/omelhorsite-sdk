/**
 * Token providers: where the transport gets a bearer token from.
 *
 * The core has no storage. A provider is either a constant, or a thing the
 * host wired to its own store (the CLI's config file, a Worker KV namespace, a
 * browser's memory). Nothing here reads a file or an environment variable.
 *
 * Two credential shapes exist today and both are just bearer tokens on the
 * wire:
 * - a legacy opaque session token (a UUID minted by `Session`), which never
 *   expires and carries no scopes;
 * - an OAuth 2 / OIDC access token from doorkeeper, which does expire and does
 *   carry scopes, and which comes with a refresh token.
 *
 * {@link TokenSet} models the second. The first is just a string.
 *
 * This module also owns the OAuth *wire* layer - the form encoding every
 * `/oauth/*` endpoint wants, and the error shape they all answer with - because
 * that is the same layer that turns a token response into a {@link TokenSet}.
 * `device.ts` and `index.ts` are built on top of it.
 */

import { OmsApiError, OmsError, type OmsErrorCode, toOmsError } from "../errors";
import { type ApiClient, readJson, type TokenProvider } from "../http";
import type { RequestOptions } from "../types";

/**
 * An OAuth 2 token response, as doorkeeper returns it.
 *
 * `expiresAt` is absolute epoch milliseconds, not the `expires_in` seconds the
 * server sends, so a stored set stays correct across a restart.
 */
export interface TokenSet {
  /** Bearer token sent as `Authorization: Bearer <accessToken>`. */
  readonly accessToken: string;
  /** Refresh token, when the grant issued one. */
  readonly refreshToken?: string;
  /** OIDC identity token, when `openid` was among the scopes. */
  readonly idToken?: string;
  /** Always `"Bearer"` for this API. */
  readonly tokenType: string;
  /** Absolute expiry, epoch milliseconds. `undefined` means it does not expire. */
  readonly expiresAt?: number;
  /** Granted scopes, space-separated as the server sent them. */
  readonly scope?: string;
}

/** Claims the SDK reads out of an OIDC id token. */
export interface IdentityClaims {
  /**
   * Stable user identifier: `users.id`. Never the handle and never the email,
   * both of which the user can change.
   */
  readonly sub: string;
  readonly iss?: string;
  readonly aud?: string | string[];
  readonly exp?: number;
  readonly iat?: number;
  /** Present only when the `profile` scope was granted. Mutable, display only. */
  readonly preferred_username?: string;
  /** Present only when the `email` scope was granted. Mutable, display only. */
  readonly email?: string;
  readonly [claim: string]: unknown;
}

/**
 * Persistence hook the host supplies so a refreshed token survives the
 * process. Both methods may be async. The core never calls anything else.
 */
export interface TokenStore {
  /** Loads the stored set, or `null` when the caller has never signed in. */
  load(): TokenSet | null | Promise<TokenSet | null>;
  /** Persists a set after a login or a refresh. */
  save(tokens: TokenSet): void | Promise<void>;
  /** Removes the stored set on logout or on an unrecoverable refresh failure. */
  clear(): void | Promise<void>;
}

/**
 * Every scope this authorization server knows about.
 *
 * An unknown scope is rejected at the device authorization request, so a typo
 * fails fast at `start()` rather than silently at first use. Ask for the
 * narrowest set the product actually uses: every extra scope makes the
 * approval page scarier for no benefit.
 */
export const OMS_SCOPES = [
  "openid",
  "profile",
  "email",
  "tools:read",
  "tools:write",
  "storage:read",
  "storage:write",
  "tickets:write",
] as const;

/** One of {@link OMS_SCOPES}. */
export type OmsScope = (typeof OMS_SCOPES)[number];

/** Refresh this long before the real expiry unless the host says otherwise. */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * A refresh that finished this recently already fixed whatever a 401 was
 * complaining about, so {@link OAuthTokenProvider.onUnauthorized} lets the
 * transport retry instead of burning another refresh-token rotation.
 */
const REFRESH_REUSE_WINDOW_MS = 5_000;

/**
 * Wraps a constant token. This is what `new Oms({ token })` builds.
 *
 * Accepts both credential kinds: an opaque session UUID and a doorkeeper
 * access token look identical on the wire.
 */
export function staticToken(token: string | null): TokenProvider {
  return {
    getToken(): string | null {
      return token;
    },
  };
}

/**
 * Wraps a plain function as a provider, for a host that already has its own
 * lookup and does not want to build an object.
 */
export function tokenFromFunction(fn: () => string | null | Promise<string | null>): TokenProvider {
  return {
    getToken: fn,
  };
}

/** Options for {@link OAuthTokenProvider} and {@link refreshingTokenProvider}. */
export interface RefreshingTokenOptions {
  /**
   * Where the set is read from and written back to. Omit it to keep the set in
   * memory only, seeded from {@link RefreshingTokenOptions.tokens}.
   */
  readonly store?: TokenStore;
  /**
   * Initial set, when there is no {@link TokenStore}. Mutually exclusive with
   * `store`; passing both throws.
   */
  readonly tokens?: TokenSet | null;
  /**
   * Exchanges a refresh token for a new set. Usually `auth.refresh` - but see
   * the warning on {@link OAuthTokenProvider}: it must come from a client that
   * does NOT carry this provider.
   */
  readonly refresh: (refreshToken: string) => Promise<TokenSet>;
  /**
   * Refresh this many milliseconds before the real expiry, so a token does not
   * die mid-flight. Defaults to {@link DEFAULT_REFRESH_SKEW_MS}.
   */
  readonly skewMs?: number;
}

/**
 * A {@link TokenProvider} that holds an OAuth {@link TokenSet} and renews it on
 * its own, shortly before it expires.
 *
 * Concurrency is the whole point. Ten in-flight requests that all notice the
 * same expiry share ONE refresh call: every caller awaits a single in-flight
 * promise. Without that, nine of them burn a rotated refresh token and the
 * user is signed out.
 *
 * ## Wire the `refresh` callback to a client WITHOUT this provider
 *
 * `POST /oauth/token` authenticates with `client_id` in the body and must not
 * carry an `Authorization` header at all. More importantly, a refresh callback
 * that talks through the same client this provider feeds is a deadlock: the
 * refresh request asks the provider for a token, the provider is mid-refresh,
 * and the two wait for each other forever.
 *
 * Build two clients - one anonymous for the OAuth endpoints, one credentialed
 * for everything else:
 *
 * ```ts
 * const anon = new Oms({ baseUrl, fetch });
 * const tokens = new OAuthTokenProvider({
 *   store,
 *   refresh: (refreshToken) => anon.auth.refresh(refreshToken, { clientId }),
 * });
 * const oms = new Oms({ baseUrl, fetch, tokens });
 * ```
 *
 * Wiring it the other way is caught: the provider notices the re-entrant call
 * and throws an {@link OmsError} explaining this, rather than hanging.
 */
export class OAuthTokenProvider implements TokenProvider {
  private readonly store: TokenStore;
  private readonly refreshFn: (refreshToken: string) => Promise<TokenSet>;
  private readonly skewMs: number;

  /** Last set we know about. `undefined` means "never read the store yet". */
  private cached: TokenSet | null | undefined;
  /** The one refresh every concurrent caller waits on. */
  private inFlight: Promise<TokenSet> | null = null;
  /** When the last successful refresh landed, epoch milliseconds. */
  private lastRefreshAt: number | undefined;
  /**
   * True only for the synchronous instant in which the refresh callback is
   * being invoked. A `getToken` that arrives inside that instant can only be
   * the refresh request asking for a credential, which is the deadlock this
   * class refuses to enter. Nothing else can observe it: no `await` runs
   * between setting and clearing it.
   */
  private invokingRefresh = false;

  constructor(options: RefreshingTokenOptions) {
    if (options.store && options.tokens !== undefined) {
      throw new TypeError("Pass either `store` or `tokens` to OAuthTokenProvider, not both.");
    }
    this.store = options.store ?? memoryTokenStore(options.tokens ?? null);
    this.refreshFn = options.refresh;
    this.skewMs = options.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /**
   * The token the transport should send, refreshing first when the stored one
   * is expired or about to be.
   *
   * Returns `null` when nobody is signed in. Returns the stored access token
   * unchanged when there is no refresh token to renew it with: letting the API
   * answer 401 says more than sending nothing at all.
   */
  async getToken(): Promise<string | null> {
    if (this.invokingRefresh) throw reentrantRefreshError();

    const current = await this.read();
    if (!current) return null;
    if (!isExpired(current, this.skewMs)) return current.accessToken;
    if (!current.refreshToken) return current.accessToken;

    const refreshed = await this.renew();
    return refreshed.accessToken;
  }

  /**
   * The API rejected the token we just handed out. Renew once and tell the
   * transport whether the retry is worth making.
   *
   * Never throws: a failed renewal returns `false` so the original
   * `OmsAuthError` reaches the caller, which is the error that says "sign in
   * again". The store is cleared on the way out.
   */
  async onUnauthorized(): Promise<boolean> {
    if (this.invokingRefresh) throw reentrantRefreshError();

    try {
      // Somebody is already fixing it. Wait for them rather than rotating twice.
      if (this.inFlight) {
        await this.inFlight;
        return true;
      }
      if (this.lastRefreshAt !== undefined && Date.now() - this.lastRefreshAt < REFRESH_REUSE_WINDOW_MS) {
        return true;
      }

      // Another process (another CLI invocation) may have refreshed underneath
      // us. `undefined` means we have never read the store, so there is no
      // token of ours to have been superseded and the shortcut does not apply.
      const known = this.cached;
      const stored = await this.read(true);
      if (known !== undefined && stored && stored.accessToken !== known?.accessToken) return true;

      if (!stored?.refreshToken) {
        await this.forget();
        return false;
      }
      // Forced: the set still looks alive, but the server just rejected it -
      // the grant was revoked, or an admin killed it. Rotate regardless.
      await this.renew(true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The set as last seen, without touching the store or the network.
   *
   * `null` before the first {@link getToken} and after a {@link clear}. Read it
   * for display (the granted scopes, the expiry); never to decide whether a
   * request may go out.
   */
  peek(): TokenSet | null {
    return this.cached ?? null;
  }

  /** Adopts a set - after a device flow completes - and persists it. */
  async set(tokens: TokenSet): Promise<void> {
    this.cached = tokens;
    this.lastRefreshAt = Date.now();
    await this.store.save(tokens);
  }

  /** Forgets the set here and in the store. Sign-out, or a dead grant. */
  async clear(): Promise<void> {
    await this.forget();
  }

  /**
   * Reads the store, using the cached set while it is still good.
   *
   * Re-reading whenever the cached set is expired is what lets a second
   * process pick up a refresh the first one already performed.
   */
  private async read(force = false): Promise<TokenSet | null> {
    if (!force && this.cached !== undefined && this.cached !== null && !isExpired(this.cached, this.skewMs)) {
      return this.cached;
    }
    const loaded = (await this.store.load()) ?? null;
    this.cached = loaded;
    return loaded;
  }

  /**
   * The single in-flight refresh every concurrent caller shares.
   *
   * `force` skips the "somebody already refreshed" shortcut, for the one case
   * where a live-looking set is known to be dead: the API answered 401 with it.
   */
  private renew(force = false): Promise<TokenSet> {
    if (this.inFlight) return this.inFlight;
    const running = this.performRefresh(force).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  private async performRefresh(force: boolean): Promise<TokenSet> {
    const current = await this.read(true);
    // Another writer got there first while we were queueing.
    if (!force && current && !isExpired(current, this.skewMs)) return current;

    const refreshToken = current?.refreshToken;
    if (!refreshToken) {
      await this.forget();
      throw new OmsError(
        "No refresh token available. Sign in again to get a new one.",
        "unauthorized",
      );
    }

    let call: Promise<TokenSet>;
    this.invokingRefresh = true;
    try {
      call = this.refreshFn(refreshToken);
    } finally {
      this.invokingRefresh = false;
    }

    let next: TokenSet;
    try {
      next = await call;
    } catch (thrown) {
      // A 4xx means the grant is gone: revoked, rotated past, or 180 days idle.
      // Nothing to retry, and the stored set is now worthless.
      if (isTerminalRefreshFailure(thrown)) await this.forget();
      throw toOmsError(thrown);
    }

    this.cached = next;
    this.lastRefreshAt = Date.now();
    await this.store.save(next);
    return next;
  }

  private async forget(): Promise<void> {
    this.cached = null;
    this.lastRefreshAt = undefined;
    await this.store.clear();
  }
}

/**
 * Builds a provider that refreshes an expiring {@link TokenSet} on its own.
 *
 * Sugar over `new OAuthTokenProvider(options)`; read that class's notes before
 * wiring the `refresh` callback.
 */
export function refreshingTokenProvider(options: RefreshingTokenOptions): OAuthTokenProvider {
  return new OAuthTokenProvider(options);
}

/**
 * Decodes an OIDC id token's claims WITHOUT verifying its signature.
 *
 * Only safe for reading `sub` out of a token this client just received over
 * TLS from the issuer. Never use it to authorise anything.
 *
 * The device grant's id token carries no `nonce` - there is nowhere to put one
 * in RFC 8628 - and it expires 120 seconds after issue. Read `sub` on arrival
 * and never send it anywhere.
 *
 * @throws {OmsError} when the token is not three base64url segments, when the
 *   payload is not JSON, or when `sub` is missing. A token with no `sub` is
 *   useless: it is the only identifier that is safe to key anything on.
 */
export function decodeIdToken(idToken: string): IdentityClaims {
  const segments = idToken.split(".");
  if (segments.length !== 3 || !segments[1]) {
    throw new OmsError("Malformed id token: expected three base64url segments.", "invalid_request");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(segments[1]));
  } catch (thrown) {
    throw new OmsError("Malformed id token: the payload is not JSON.", "invalid_request", { cause: thrown });
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new OmsError("Malformed id token: the payload is not a JSON object.", "invalid_request");
  }
  const claims = payload as Record<string, unknown>;
  if (typeof claims["sub"] !== "string" || claims["sub"].length === 0) {
    throw new OmsError("Malformed id token: no `sub` claim.", "invalid_request");
  }

  return claims as unknown as IdentityClaims;
}

/**
 * Whether a set is expired, or will be within `skewMs`.
 *
 * A set with no `expiresAt` never expires - that is how a legacy opaque
 * session token behaves when it is carried in this shape.
 */
export function isExpired(tokens: TokenSet, skewMs = DEFAULT_REFRESH_SKEW_MS, now = Date.now()): boolean {
  if (tokens.expiresAt === undefined) return false;
  return now + Math.max(0, skewMs) >= tokens.expiresAt;
}

/**
 * Builds a {@link TokenSet} from a raw OAuth token endpoint response,
 * converting `expires_in` seconds into an absolute `expiresAt`.
 *
 * This is the ONLY place that touches `expires_in`. `now` defaults to the
 * moment of the call, which makes `expiresAt` slightly conservative - the
 * server measured the lifetime from issue, and that is the right direction to
 * be wrong in.
 *
 * @throws {OmsError} when the body carries no `access_token`.
 */
export function tokenSetFromResponse(body: unknown, now = Date.now()): TokenSet {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OmsError("The token endpoint did not answer with a JSON object.", "api_error");
  }
  const record = body as Record<string, unknown>;

  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OmsError("The token endpoint answered without an access_token.", "api_error");
  }

  const expiresIn = numberFrom(record["expires_in"]);
  const tokenType = typeof record["token_type"] === "string" ? record["token_type"] : "Bearer";

  return {
    accessToken,
    tokenType,
    ...(expiresIn === undefined ? {} : { expiresAt: now + expiresIn * 1000 }),
    ...(typeof record["refresh_token"] === "string" ? { refreshToken: record["refresh_token"] } : {}),
    ...(typeof record["id_token"] === "string" ? { idToken: record["id_token"] } : {}),
    ...(typeof record["scope"] === "string" ? { scope: record["scope"] } : {}),
  };
}

/** The scopes a {@link TokenSet} carries, split out of its space-separated `scope`. */
export function scopesOf(tokens: TokenSet): string[] {
  return parseScopes(tokens.scope);
}

/** Splits a scope value the server sent, in either shape, into a list. */
export function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string") return [];
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}

/**
 * An in-memory {@link TokenStore}. Useful for tests and for a Worker that
 * holds a token for the length of one request.
 */
export function memoryTokenStore(initial: TokenSet | null = null): TokenStore {
  let held: TokenSet | null = initial;
  return {
    load(): TokenSet | null {
      return held;
    },
    save(tokens: TokenSet): void {
      held = tokens;
    },
    clear(): void {
      held = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The OAuth wire layer
// ---------------------------------------------------------------------------

/**
 * An error the authorization server named itself, in the RFC 6749 §5.2 shape:
 * `{ "error": "...", "error_description": "...", "error_uri": "..." }`.
 *
 * Branch on {@link OmsOAuthError.error}. NEVER on the message: the
 * descriptions are I18n strings and they change.
 */
export class OmsOAuthError extends OmsError {
  /** The OAuth error code, e.g. `"invalid_grant"`. The only field to branch on. */
  readonly error: string;
  /** The server's human sentence, when it sent one. Display only. */
  readonly description: string | undefined;
  /** `error_uri`, when the server sent one. */
  readonly errorUri: string | undefined;
  /** HTTP status it arrived with. `invalid_client` is 401; everything else 400. */
  readonly status: number;

  constructor(
    input: {
      error: string;
      description?: string;
      errorUri?: string;
      status: number;
      method?: string;
      url?: string;
      cause?: unknown;
    },
  ) {
    super(input.description && input.description.length > 0 ? input.description : input.error, codeForOAuthError(input.error, input.status), {
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
    this.error = input.error;
    this.description = input.description;
    this.errorUri = input.errorUri;
    this.status = input.status;
  }

  /**
   * OAuth errors are decisions, not faults. Only the two the spec reserves for
   * a struggling server are worth trying again.
   */
  override get retryable(): boolean {
    return this.error === "server_error" || this.error === "temporarily_unavailable";
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), error: this.error, description: this.description, status: this.status };
  }
}

/**
 * Recognises an OAuth error inside whatever the transport threw.
 *
 * Deliberately narrow: only 400 and 401 bodies are read as OAuth errors. A 429
 * comes from rack-attack with the body `{"error":"rate_limited"}`, and that
 * `error` key is NOT an OAuth code - reading it as one abandons a perfectly
 * live device flow. It stays an {@link OmsQuotaError} and the caller handles
 * it as a rate limit.
 *
 * @returns The typed error, or `undefined` when this was not an OAuth failure.
 */
export function oauthErrorFrom(thrown: unknown): OmsOAuthError | undefined {
  if (thrown instanceof OmsOAuthError) return thrown;
  if (!(thrown instanceof OmsApiError)) return undefined;
  if (thrown.status !== 400 && thrown.status !== 401) return undefined;

  const body = thrown.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;

  const error = record["error"];
  if (typeof error !== "string" || error.length === 0) return undefined;

  const description = record["error_description"];
  const errorUri = record["error_uri"];

  return new OmsOAuthError({
    error,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof errorUri === "string" ? { errorUri } : {}),
    status: thrown.status,
    ...(thrown.method === undefined ? {} : { method: thrown.method }),
    ...(thrown.url === undefined ? {} : { url: thrown.url }),
    cause: thrown,
  });
}

/** What a 403 `insufficient_scope` challenge said was missing. */
export interface InsufficientScope {
  /**
   * The scopes the endpoint needed. EMPTY when the server named none, which
   * means the endpoint has not been opened to OAuth clients at all - a backend
   * gap, not a client bug. The two cases must read differently to the user.
   */
  readonly required: string[];
  /** The `realm` parameter, when present. */
  readonly realm: string | undefined;
}

/**
 * Reads the `WWW-Authenticate` challenge of a 403 that rejected an OAuth token
 * for want of a scope.
 *
 * The fix for this error is a fresh authorization with a wider scope set, not
 * a change to the account's permissions, and the message shown to the user
 * should say so.
 *
 * Note for browser hosts: `WWW-Authenticate` is not a CORS-safelisted response
 * header, so a cross-origin `fetch` will not expose it unless the server lists
 * it in `Access-Control-Expose-Headers`. This returns `undefined` then.
 */
export function readInsufficientScope(error: unknown): InsufficientScope | undefined {
  if (!(error instanceof OmsApiError) || error.status !== 403) return undefined;

  const header = error.headers["www-authenticate"];
  if (!header || !/error\s*=\s*"?insufficient_scope"?/i.test(header)) return undefined;

  const scope = /(?:^|[\s,])scope\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? "";
  const realm = /(?:^|[\s,])realm\s*=\s*"([^"]*)"/i.exec(header)?.[1];

  return { required: parseScopes(scope), realm };
}

/**
 * `POST`s an `application/x-www-form-urlencoded` body to an `/oauth/*` endpoint
 * and returns the parsed JSON.
 *
 * The OAuth endpoints do not take JSON, which is why this exists next to
 * `ApiClient.post` rather than using it. Blank values are dropped rather than
 * sent empty, because doorkeeper reads `""` as a present-but-invalid parameter.
 *
 * Retries are OFF and stay off. Replaying `POST /oauth/token` after a lost
 * response is not safe: the server may have rotated the refresh token already,
 * and the replay would spend the old one and sign the user out. Callers that
 * want to try again own the timing - `DeviceFlow.wait` does exactly that.
 *
 * These endpoints authenticate with `client_id` in the body and want no
 * `Authorization` header. Call them through a client with no credential; see
 * the note on {@link OAuthTokenProvider}.
 */
export async function oauthPost(
  http: ApiClient,
  path: string,
  params: Record<string, string | undefined>,
  options: RequestOptions = {},
): Promise<unknown> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value.length === 0) continue;
    body.set(key, value);
  }

  const response = await http.raw("POST", path, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(options.headers ?? {}) },
    retry: false,
    body: body.toString(),
  });

  return readJson(response);
}

/** Maps an OAuth error code onto the SDK's coarse machine code. */
function codeForOAuthError(error: string, status: number): OmsErrorCode {
  switch (error) {
    case "invalid_client":
      return "unauthorized";
    case "access_denied":
    case "invalid_grant":
      return "forbidden";
    case "unsupported_grant_type":
    case "unsupported_response_type":
      return "unsupported";
    case "invalid_request":
    case "invalid_scope":
      return "invalid_request";
    case "expired_token":
      return "timeout";
    case "server_error":
    case "temporarily_unavailable":
      return "server_error";
    default:
      return status === 401 ? "unauthorized" : "api_error";
  }
}

/** A 4xx from the token endpoint means the grant is gone for good. */
function isTerminalRefreshFailure(thrown: unknown): boolean {
  if (thrown instanceof OmsOAuthError) return thrown.status >= 400 && thrown.status < 500;
  if (thrown instanceof OmsApiError) return thrown.status >= 400 && thrown.status < 500;
  return false;
}

function reentrantRefreshError(): OmsError {
  return new OmsError(
    "The refresh callback asked this same provider for a token, which would deadlock. " +
      "Give it a client with no credential: new Oms({ baseUrl, fetch }) for auth.refresh, " +
      "and a second Oms carrying this provider for everything else.",
    "invalid_request",
  );
}

/** Reads a number the server may have sent as a JSON number or as a string. */
function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

/**
 * base64url -> UTF-8 string, with only platform APIs (`atob`, `TextDecoder`),
 * both of which a Worker isolate provides.
 */
function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
