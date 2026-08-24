/**
 * `bun test` coverage for the RFC 8628 device grant client.
 *
 * The intervals are shrunk to a few milliseconds so the polling loop can be
 * exercised in real time. The one place a real constant matters -
 * `slow_down` adding five seconds permanently - is asserted by aborting the
 * flow during that longer sleep and counting the polls that did NOT happen.
 */

import { describe, expect, test } from "bun:test";

import { AuthNamespace } from "../src/auth/index";
import {
  DEVICE_CODE_GRANT_TYPE,
  OmsDeviceDeniedError,
  OmsDeviceExpiredError,
  OmsDeviceFlowError,
} from "../src/auth/device";
import { OmsOAuthError } from "../src/auth/tokens";
import { OmsTimeoutError } from "../src/errors";
import { ApiClient } from "../src/http";

const BASE_URL = "https://api.test";
const CLIENT_ID = "oms-cli-uid";
const DEVICE_CODE = "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly at: number;
}

function fakeFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>): {
  auth: AuthNamespace;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
      at: Date.now(),
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  };
  return { auth: new AuthNamespace(new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl })), calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Every OAuth error the token endpoint can answer with is a 400, bar one. */
function oauthError(error: string, status = 400): Response {
  return json(status, { error, error_description: `translated text for ${error}` });
}

function grantBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_code: DEVICE_CODE,
    user_code: "0A44L90H",
    verification_uri: `${BASE_URL}/oauth/device`,
    verification_uri_complete: `${BASE_URL}/oauth/device?user_code=0A44L90H`,
    expires_in: 600,
    interval: 5,
    ...overrides,
  };
}

function tokenBody(): Record<string, unknown> {
  return {
    access_token: "granted-access",
    token_type: "Bearer",
    expires_in: 7200,
    refresh_token: "granted-refresh",
    scope: "openid storage:read",
    id_token: "eyJ.header.sig",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("device.start", () => {
  test("posts client_id and scope form-encoded, with no Authorization header", async () => {
    const { auth, calls } = fakeFetch(() => json(200, grantBody()));

    const grant = await auth.device.start({ clientId: CLIENT_ID, scope: "openid storage:read" });

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE_URL}/oauth/authorize_device`);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.headers["authorization"]).toBeUndefined();

    const params = new URLSearchParams(call.body);
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("scope")).toBe("openid storage:read");

    expect(grant.deviceCode).toBe(DEVICE_CODE);
    expect(grant.userCode).toBe("0A44L90H");
    expect(grant.verificationUri).toBe(`${BASE_URL}/oauth/device`);
    expect(grant.verificationUriComplete).toBe(`${BASE_URL}/oauth/device?user_code=0A44L90H`);
    expect(grant.intervalMs).toBe(5_000);
    expect(grant.expiresAt).toBeGreaterThan(Date.now() + 590_000);
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  test("omits scope entirely when the caller asked for none", async () => {
    const { auth, calls } = fakeFetch(() => json(200, grantBody()));

    await auth.device.start({ clientId: CLIENT_ID });

    expect(new URLSearchParams(calls[0]!.body).get("scope")).toBeNull();
  });

  test("copes with the optional members being absent", async () => {
    const { auth } = fakeFetch(() =>
      json(200, { device_code: DEVICE_CODE, user_code: "0A44L90H", verification_uri: `${BASE_URL}/oauth/device`, expires_in: 600 }),
    );

    const grant = await auth.device.start({ clientId: CLIENT_ID });

    expect(grant.verificationUriComplete).toBeUndefined();
    expect(grant.intervalMs).toBe(5_000);
  });

  test("a 401 invalid_client is terminal and typed", async () => {
    const { auth } = fakeFetch(() => oauthError("invalid_client", 401));

    let thrown: unknown;
    try {
      await auth.device.start({ clientId: "wrong" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OmsDeviceFlowError);
    expect(thrown).not.toBeInstanceOf(OmsDeviceDeniedError);
    expect((thrown as OmsOAuthError).error).toBe("invalid_client");
    expect((thrown as OmsOAuthError).status).toBe(401);
    expect((thrown as OmsOAuthError).retryable).toBe(false);
  });

  test("refuses a response with no device_code", async () => {
    const { auth } = fakeFetch(() => json(200, { user_code: "0A44L90H" }));
    await expect(auth.device.start({ clientId: CLIENT_ID })).rejects.toThrow(/device_code/);
  });
});

describe("device.wait", () => {
  test("waits one interval before the first poll, then polls until approval", async () => {
    const started = Date.now();
    const { auth, calls } = fakeFetch((_call, index) =>
      index < 2 ? oauthError("authorization_pending") : json(200, tokenBody()),
    );

    const seen: string[] = [];
    const tokens = await auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 10,
      expiresAt: Date.now() + 30_000,
      onPoll: (state) => seen.push(state),
    });

    expect(calls.length).toBe(3);
    expect(seen).toEqual(["pending", "pending"]);
    expect(calls[0]!.at - started).toBeGreaterThanOrEqual(9);

    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(params.get("device_code")).toBe(DEVICE_CODE);
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(calls[0]!.headers["authorization"]).toBeUndefined();

    expect(tokens.accessToken).toBe("granted-access");
    expect(tokens.refreshToken).toBe("granted-refresh");
    expect(tokens.idToken).toBe("eyJ.header.sig");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 7_190_000);
  });

  test("slow_down raises the interval permanently", async () => {
    const { auth, calls } = fakeFetch(() => oauthError("slow_down"));

    const controller = new AbortController();
    const seen: string[] = [];
    const running = auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 5,
      expiresAt: Date.now() + 120_000,
      signal: controller.signal,
      onPoll: (state) => seen.push(state),
    });

    // At 5ms apart the loop would have polled dozens of times by now. One
    // slow_down pushes the next poll out by five seconds, so there is exactly
    // one.
    await delay(200);
    controller.abort();

    await expect(running).rejects.toBeInstanceOf(OmsTimeoutError);
    expect(calls.length).toBe(1);
    expect(seen).toEqual(["slow_down"]);
  });

  test("expired_token ends the flow with its own error type", async () => {
    const { auth } = fakeFetch(() => oauthError("expired_token"));

    const running = auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 1,
      expiresAt: Date.now() + 30_000,
    });

    await expect(running).rejects.toBeInstanceOf(OmsDeviceExpiredError);
  });

  test("invalid_grant is how this backend reports a refusal", async () => {
    const { auth } = fakeFetch(() => oauthError("invalid_grant"));

    let thrown: unknown;
    try {
      await auth.device.wait({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE, intervalMs: 1, expiresAt: Date.now() + 30_000 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OmsDeviceDeniedError);
    expect(thrown).not.toBeInstanceOf(OmsDeviceExpiredError);
    expect((thrown as OmsOAuthError).error).toBe("invalid_grant");
  });

  test("access_denied lands in the same place, for the day it starts being sent", async () => {
    const { auth } = fakeFetch(() => oauthError("access_denied"));

    const running = auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 1,
      expiresAt: Date.now() + 30_000,
    });

    await expect(running).rejects.toBeInstanceOf(OmsDeviceDeniedError);
  });

  test("gives up at expiresAt without asking the server", async () => {
    const { auth, calls } = fakeFetch(() => json(200, tokenBody()));

    const running = auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 1,
      expiresAt: Date.now() - 1,
    });

    await expect(running).rejects.toBeInstanceOf(OmsDeviceExpiredError);
    expect(calls.length).toBe(0);
  });

  test("a 429 from rack-attack is a rate limit, not an OAuth error", async () => {
    const { auth, calls } = fakeFetch((_call, index) =>
      index === 0
        ? json(429, { error: "rate_limited", retry_after: 0 }, { "retry-after": "0" })
        : json(200, tokenBody()),
    );

    const seen: string[] = [];
    const tokens = await auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 5,
      expiresAt: Date.now() + 30_000,
      onPoll: (state) => seen.push(state),
    });

    expect(tokens.accessToken).toBe("granted-access");
    expect(calls.length).toBe(2);
    // It is not an approval state, so the host's spinner is not told about it,
    // and it must not count as a slow_down.
    expect(seen).toEqual([]);
  });

  test("a 5xx keeps the flow alive", async () => {
    const { auth, calls } = fakeFetch((_call, index) =>
      index === 0 ? json(502, "<html>bad gateway</html>") : json(200, tokenBody()),
    );

    const tokens = await auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 5,
      expiresAt: Date.now() + 30_000,
    });

    expect(tokens.accessToken).toBe("granted-access");
    expect(calls.length).toBe(2);
  });

  test("a network fault keeps the flow alive", async () => {
    let attempts = 0;
    const { auth } = fakeFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return json(200, tokenBody());
    });

    const tokens = await auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 5,
      expiresAt: Date.now() + 30_000,
    });

    expect(tokens.accessToken).toBe("granted-access");
    expect(attempts).toBe(2);
  });

  test("an aborted signal ends the wait", async () => {
    const { auth } = fakeFetch(() => oauthError("authorization_pending"));
    const controller = new AbortController();

    const running = auth.device.wait({
      clientId: CLIENT_ID,
      deviceCode: DEVICE_CODE,
      intervalMs: 5,
      expiresAt: Date.now() + 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    let thrown: unknown;
    try {
      await running;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OmsTimeoutError);
    expect((thrown as OmsTimeoutError).code).toBe("aborted");
  });
});

describe("device.poll", () => {
  test("answers null while nobody has approved", async () => {
    const { auth, calls } = fakeFetch(() => oauthError("authorization_pending"));

    expect(await auth.device.poll({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE })).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("answers null on slow_down, because wait() owns the timing", async () => {
    const { auth } = fakeFetch(() => oauthError("slow_down"));

    expect(await auth.device.poll({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE })).toBeNull();
  });

  test("answers the token set once approved", async () => {
    const { auth } = fakeFetch(() => json(200, tokenBody()));

    const tokens = await auth.device.poll({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE });
    expect(tokens?.accessToken).toBe("granted-access");
    expect(tokens?.scope).toBe("openid storage:read");
  });

  test("throws the terminal outcomes", async () => {
    const expired = fakeFetch(() => oauthError("expired_token"));
    await expect(expired.auth.device.poll({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE })).rejects.toBeInstanceOf(
      OmsDeviceExpiredError,
    );

    const denied = fakeFetch(() => oauthError("invalid_grant"));
    await expect(denied.auth.device.poll({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE })).rejects.toBeInstanceOf(
      OmsDeviceDeniedError,
    );
  });

  test("does not retry the token endpoint on its own", async () => {
    const { auth, calls } = fakeFetch(() => json(503, { error: "server_error" }));

    await expect(auth.device.poll({ clientId: CLIENT_ID, deviceCode: DEVICE_CODE })).rejects.toBeDefined();
    expect(calls.length).toBe(1);
  });
});

describe("auth.refresh and auth.revoke", () => {
  test("refresh sends the refresh grant and maps the answer", async () => {
    const { auth, calls } = fakeFetch(() => json(200, tokenBody()));

    const tokens = await auth.refresh("old-refresh", { clientId: CLIENT_ID });

    const params = new URLSearchParams(calls[0]!.body);
    expect(calls[0]!.url).toBe(`${BASE_URL}/oauth/token`);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(tokens.refreshToken).toBe("granted-refresh");
  });

  test("revoke posts the token and swallows the empty answer", async () => {
    const { auth, calls } = fakeFetch(() => json(200, {}));

    await auth.revoke("granted-refresh", { clientId: CLIENT_ID });

    expect(calls[0]!.url).toBe(`${BASE_URL}/oauth/revoke`);
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get("token")).toBe("granted-refresh");
    expect(params.get("client_id")).toBe(CLIENT_ID);
  });
});

describe("auth.whoami", () => {
  test("maps an OAuth-authenticated account payload", async () => {
    const { auth, calls } = fakeFetch(() =>
      json(200, {
        id: "abc123def456",
        handle: "afonso",
        name: "Afonso",
        email: "afonso@omelhorsite.pt",
        oauth: true,
        scopes: ["openid", "storage:read"],
      }),
    );

    const me = await auth.whoami();

    expect(calls[0]!.url).toBe(`${BASE_URL}/account`);
    expect(me).toEqual({
      id: "abc123def456",
      handle: "afonso",
      email: "afonso@omelhorsite.pt",
      scopes: ["openid", "storage:read"],
      oauth: true,
    });
  });

  test("a legacy session token reports no scopes", async () => {
    const { auth } = fakeFetch(() => json(200, { id: "abc123def456", handle: "afonso", name: "Afonso" }));

    const me = await auth.whoami();

    expect(me.oauth).toBe(false);
    expect(me.scopes).toBeUndefined();
  });
});
