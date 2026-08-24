/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This is how a CLI or an MCP server signs a person in without ever handling
 * their password: the client asks for a code, the person opens a URL in a real
 * browser and approves, and the client polls the token endpoint until the
 * approval lands.
 *
 * The approval page is rendered by RAILS at `backend.omelhorsite.pt`, not by
 * the Next.js frontend - the browser already holds the host-only `oms_session`
 * cookie for that origin, so the person is usually already signed in when they
 * arrive.
 *
 * The core never opens a browser and never prints a URL. It returns the
 * verification URI and lets the host decide what to do with it.
 */

import { OmsApiError, OmsError, OmsNetworkError, OmsQuotaError, OmsTimeoutError } from "../errors";
import { Resource, sleep } from "../http";
import type { RequestOptions } from "../types";
import { oauthErrorFrom, oauthPost, OmsOAuthError, type TokenSet, tokenSetFromResponse } from "./tokens";

/** The RFC 8628 `grant_type` URN. Sent literally; `URLSearchParams` escapes it. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Poll interval to use when the server names none. Matches the backend default. */
export const DEFAULT_DEVICE_INTERVAL_MS = 5_000;

/** Grant lifetime to assume when the caller passes no `expiresAt`. */
export const DEFAULT_DEVICE_EXPIRY_MS = 600_000;

/** How much `slow_down` adds to the interval, per RFC 8628 §3.5. Permanent. */
export const DEVICE_SLOW_DOWN_STEP_MS = 5_000;

/** What the device authorization endpoint answers. */
export interface DeviceAuthorization {
  /** Opaque code the client polls with. Never show it to the person. */
  readonly deviceCode: string;
  /** Short code the person types, e.g. `"WDJB-MJHT"`. */
  readonly userCode: string;
  /** URL the person opens to approve. */
  readonly verificationUri: string;
  /** Same URL with the code pre-filled, when the server provides it. Prefer it. */
  readonly verificationUriComplete?: string;
  /** Absolute epoch milliseconds after which `deviceCode` is dead. */
  readonly expiresAt: number;
  /** Minimum milliseconds between polls, as the server asked. Honour it. */
  readonly intervalMs: number;
}

/** Arguments for starting a device flow. */
export interface StartDeviceFlowInput {
  /** The registered doorkeeper application id. */
  readonly clientId: string;
  /** Space-separated scopes to request. */
  readonly scope?: string;
}

/** Arguments for polling a device flow to completion. */
export interface WaitForDeviceApprovalInput extends RequestOptions {
  readonly clientId: string;
  readonly deviceCode: string;
  /** Starting poll interval. RFC 8628 `slow_down` raises it as the server asks. */
  readonly intervalMs?: number;
  /** Absolute epoch milliseconds to give up at. Defaults to the grant's own expiry. */
  readonly expiresAt?: number;
  /** Called on each poll so a host can keep a spinner honest. Never receives the code. */
  readonly onPoll?: (state: "pending" | "slow_down") => void;
}

/**
 * A device flow that ended for a reason the client cannot argue with.
 *
 * Branch on the subclasses, or on {@link OmsOAuthError.error} for the exact
 * wire code. Never on the message.
 */
export class OmsDeviceFlowError extends OmsOAuthError {
  /** Nothing about a terminal grant outcome improves by being tried again. */
  override get retryable(): boolean {
    return false;
  }
}

/**
 * The `device_code` outlived `expires_in` and the grant row is gone.
 *
 * The person took too long, or never opened the URL. Recover by calling
 * {@link DeviceFlow.start} again for a fresh code.
 */
export class OmsDeviceExpiredError extends OmsDeviceFlowError {}

/**
 * The person refused, or the grant no longer exists.
 *
 * Both `access_denied` and `invalid_grant` land here on purpose. This backend
 * represents a refusal by destroying the grant row, so the next poll finds
 * nothing and answers `invalid_grant`; `access_denied` is handled identically
 * so that emitting it later is not a breaking change. Read
 * {@link OmsOAuthError.error} when the difference matters.
 */
export class OmsDeviceDeniedError extends OmsDeviceFlowError {}

/**
 * The device grant, exposed as `oms.auth.device`.
 *
 * Typical use:
 * ```ts
 * const grant = await oms.auth.device.start({ clientId });
 * // host shows grant.verificationUriComplete ?? grant.verificationUri
 * const tokens = await oms.auth.device.wait({ clientId, deviceCode: grant.deviceCode });
 * ```
 *
 * Call it through a client with NO credential. Both endpoints authenticate
 * with `client_id` in the body and want no `Authorization` header.
 */
export class DeviceFlow extends Resource {
  /**
   * `POST /oauth/authorize_device` - asks for a device code and a user code.
   *
   * `scope` is omitted from the request when the caller passes none, and the
   * server then grants `openid` alone. An unknown scope is rejected here
   * rather than at first use, so a typo fails fast.
   *
   * @throws {OmsDeviceFlowError} when the server named an OAuth error.
   *   `invalid_client` (HTTP 401) means the `clientId` is wrong: a build bug,
   *   not something the person can fix.
   */
  async start(input: StartDeviceFlowInput, options: RequestOptions = {}): Promise<DeviceAuthorization> {
    let body: unknown;
    try {
      body = await oauthPost(
        this.http,
        "/oauth/authorize_device",
        { client_id: input.clientId, ...(input.scope === undefined ? {} : { scope: input.scope }) },
        options,
      );
    } catch (thrown) {
      throw terminal(thrown);
    }

    // `expires_in` is the grant's full lifetime from server-side creation, so
    // converting it at receipt time is a little conservative. Correct direction.
    return readDeviceAuthorization(body, Date.now());
  }

  /**
   * Polls `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`
   * until the person approves.
   *
   * Timing, in order:
   * 1. sleep the interval BEFORE the first poll - the server would accept an
   *    immediate one, but the person has not opened a browser yet;
   * 2. `authorization_pending` sleeps the interval and goes again;
   * 3. `slow_down` adds {@link DEVICE_SLOW_DOWN_STEP_MS} to the interval
   *    permanently, then goes again;
   * 4. HTTP 429 is rack-attack, not OAuth: wait what `Retry-After` said and go
   *    again, without touching the interval and without counting it against
   *    the flow;
   * 5. a network fault or a 5xx waits one interval and goes again.
   *
   * The flow ends only at `expiresAt`, on a terminal OAuth error, or when the
   * caller's `signal` aborts.
   *
   * @throws {OmsDeviceExpiredError} at `expiresAt`, and on `expired_token`.
   * @throws {OmsDeviceDeniedError} when the person refused.
   * @throws {OmsTimeoutError} with `code === "aborted"` when `signal` fired.
   */
  async wait(input: WaitForDeviceApprovalInput): Promise<TokenSet> {
    const options = requestOptionsOf(input);
    const expiresAt = input.expiresAt ?? Date.now() + DEFAULT_DEVICE_EXPIRY_MS;

    let intervalMs = Math.max(0, input.intervalMs ?? DEFAULT_DEVICE_INTERVAL_MS);
    let delayMs = intervalMs;

    for (;;) {
      if (Date.now() >= expiresAt) throw expiredLocally();
      await sleep(delayMs, input.signal);
      if (Date.now() >= expiresAt) throw expiredLocally();

      try {
        return await this.exchange(input.clientId, input.deviceCode, options);
      } catch (thrown) {
        const oauth = oauthErrorFrom(thrown);
        if (oauth) {
          if (oauth.error === "authorization_pending") {
            input.onPoll?.("pending");
            delayMs = intervalMs;
            continue;
          }
          if (oauth.error === "slow_down") {
            // RFC 8628 §3.5: raise it, and never lower it again for this flow.
            intervalMs += DEVICE_SLOW_DOWN_STEP_MS;
            delayMs = intervalMs;
            input.onPoll?.("slow_down");
            continue;
          }
          throw terminalFromOAuth(oauth);
        }

        if (thrown instanceof OmsQuotaError) {
          // rack-attack, not the authorization server. The flow is still alive.
          delayMs = thrown.retryAfterMs ?? intervalMs;
          continue;
        }
        if (thrown instanceof OmsNetworkError) {
          delayMs = intervalMs;
          continue;
        }
        if (thrown instanceof OmsTimeoutError && thrown.code === "timeout") {
          delayMs = intervalMs;
          continue;
        }
        if (thrown instanceof OmsApiError && thrown.status >= 500) {
          delayMs = intervalMs;
          continue;
        }
        throw thrown;
      }
    }
  }

  /**
   * One poll of the token endpoint. Returns the tokens once approved, or
   * `null` while the person has not answered yet.
   *
   * Does not sleep and does not respect the interval: {@link wait} owns the
   * timing. `slow_down` reads as `null` here, so a caller driving its own loop
   * must raise its interval on its own - or use {@link wait}.
   *
   * @throws {OmsDeviceExpiredError} / {@link OmsDeviceDeniedError} / any other
   *   terminal OAuth failure.
   */
  async poll(input: { clientId: string; deviceCode: string }, options: RequestOptions = {}): Promise<TokenSet | null> {
    try {
      return await this.exchange(input.clientId, input.deviceCode, options);
    } catch (thrown) {
      const oauth = oauthErrorFrom(thrown);
      if (oauth && (oauth.error === "authorization_pending" || oauth.error === "slow_down")) return null;
      if (oauth) throw terminalFromOAuth(oauth);
      throw thrown;
    }
  }

  /** The bare token request. Every caller above adds the policy around it. */
  private async exchange(clientId: string, deviceCode: string, options: RequestOptions): Promise<TokenSet> {
    const body = await oauthPost(
      this.http,
      "/oauth/token",
      { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: deviceCode, client_id: clientId },
      options,
    );
    return tokenSetFromResponse(body, Date.now());
  }
}

/** Maps the device authorization response onto {@link DeviceAuthorization}. */
function readDeviceAuthorization(body: unknown, now: number): DeviceAuthorization {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OmsError("The device authorization endpoint did not answer with a JSON object.", "api_error");
  }
  const record = body as Record<string, unknown>;

  const deviceCode = stringField(record, "device_code");
  const userCode = stringField(record, "user_code");
  const verificationUri = stringField(record, "verification_uri");

  // The server builds the body with `compact_blank`, so anything blank is
  // ABSENT rather than null. Both of these are documented as optional.
  const complete = record["verification_uri_complete"];
  const expiresIn = positiveNumber(record["expires_in"]);
  const interval = positiveNumber(record["interval"]);

  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof complete === "string" && complete.length > 0 ? { verificationUriComplete: complete } : {}),
    expiresAt: now + (expiresIn ?? DEFAULT_DEVICE_EXPIRY_MS / 1000) * 1000,
    intervalMs: (interval ?? DEFAULT_DEVICE_INTERVAL_MS / 1000) * 1000,
  };
}

/** Picks the {@link RequestOptions} out of the wider wait input. */
function requestOptionsOf(input: WaitForDeviceApprovalInput): RequestOptions {
  return {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  };
}

/** Turns whatever the transport threw into the right terminal device error. */
function terminal(thrown: unknown): unknown {
  const oauth = oauthErrorFrom(thrown);
  return oauth ? terminalFromOAuth(oauth) : thrown;
}

function terminalFromOAuth(oauth: OmsOAuthError): OmsDeviceFlowError {
  const input = {
    error: oauth.error,
    ...(oauth.description === undefined ? {} : { description: oauth.description }),
    ...(oauth.errorUri === undefined ? {} : { errorUri: oauth.errorUri }),
    status: oauth.status,
    ...(oauth.method === undefined ? {} : { method: oauth.method }),
    ...(oauth.url === undefined ? {} : { url: oauth.url }),
    cause: oauth,
  };

  if (oauth.error === "expired_token") return new OmsDeviceExpiredError(input);
  if (oauth.error === "access_denied" || oauth.error === "invalid_grant") return new OmsDeviceDeniedError(input);
  return new OmsDeviceFlowError(input);
}

/** The deadline passed on this side, before the server had to say so. */
function expiredLocally(): OmsDeviceExpiredError {
  return new OmsDeviceExpiredError({
    error: "expired_token",
    description: "The device code expired before it was approved. Start a new sign-in.",
    status: 400,
  });
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OmsError(`The device authorization endpoint answered without \`${key}\`.`, "api_error");
  }
  return value;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}
