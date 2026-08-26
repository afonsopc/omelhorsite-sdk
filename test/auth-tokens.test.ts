/**
 * `bun test` coverage for the token providers.
 *
 * Everything goes through a fake `fetch` injected into a real {@link ApiClient},
 * so the tests exercise the actual form encoding and the actual error mapping
 * rather than a mock of them.
 *
 * Lives outside `src/` on purpose: `tsconfig.json` only includes
 * `src/**`, because the core is compiled under the isolate guard and a test
 * file is host code.
 */

import { describe, expect, test } from "bun:test";

import { AuthNamespace } from "../src/auth/index";
import {
  decodeIdToken,
  isExpired,
  memoryTokenStore,
  OAuthTokenProvider,
  OmsOAuthError,
  readInsufficientScope,
  refreshingTokenProvider,
  scopesOf,
  type TokenSet,
  tokenSetFromResponse,
} from "../src/auth/tokens";
import { OmsApiError } from "../src/errors";
import { ApiClient, type TokenProvider } from "../src/http";

const BASE_URL = "https://api.test";
const CLIENT_ID = "oms-cli-uid";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** An injected fetch that records what it was asked and answers from `handler`. */
function fakeFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
      const call: RecordedCall = {
        url: input,
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : "",
      };
      const index = calls.length;
      calls.push(call);
      return handler(call, index);
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An anonymous auth namespace: no credential, which is how OAuth calls must be made. */
function anonymousAuth(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): AuthNamespace {
  return new AuthNamespace(new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl }));
}

function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "new-access",
    token_type: "Bearer",
    expires_in: 7200,
    refresh_token: "new-refresh",
    scope: "openid storage:read",
    created_at: 1593096829,
    ...overrides,
  };
}

function expiredSet(): TokenSet {
  return { accessToken: "old-access", tokenType: "Bearer", refreshToken: "old-refresh", expiresAt: Date.now() - 1_000 };
}

describe("tokenSetFromResponse", () => {
  test("turns expires_in seconds into an absolute expiry", () => {
    const now = 1_700_000_000_000;
    const set = tokenSetFromResponse(tokenResponse(), now);

    expect(set.accessToken).toBe("new-access");
    expect(set.refreshToken).toBe("new-refresh");
    expect(set.tokenType).toBe("Bearer");
    expect(set.expiresAt).toBe(now + 7_200_000);
    expect(scopesOf(set)).toEqual(["openid", "storage:read"]);
  });

  test("leaves expiresAt undefined when the server sent no expires_in", () => {
    const set = tokenSetFromResponse({ access_token: "a", token_type: "Bearer" });
    expect(set.expiresAt).toBeUndefined();
    expect(isExpired(set)).toBe(false);
  });

  test("refuses a body with no access_token", () => {
    expect(() => tokenSetFromResponse({ token_type: "Bearer" })).toThrow(/access_token/);
  });
});

describe("isExpired", () => {
  const at = (expiresAt: number): TokenSet => ({ accessToken: "a", tokenType: "Bearer", expiresAt });

  test("is false while the token is comfortably alive", () => {
    expect(isExpired(at(1_000_000 + 120_000), 60_000, 1_000_000)).toBe(false);
  });

  test("is true inside the skew window, before the real expiry", () => {
    expect(isExpired(at(1_000_000 + 30_000), 60_000, 1_000_000)).toBe(true);
  });

  test("is true once the expiry has passed", () => {
    expect(isExpired(at(1_000_000 - 1), 0, 1_000_000)).toBe(true);
  });

  test("a set with no expiry never expires", () => {
    expect(isExpired({ accessToken: "opaque-session-uuid", tokenType: "Bearer" })).toBe(false);
  });
});

describe("decodeIdToken", () => {
  function jwt(claims: Record<string, unknown>): string {
    const segment = (value: unknown): string => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    return `${segment({ alg: "RS256", kid: "k1" })}.${segment(claims)}.not-a-real-signature`;
  }

  test("reads sub and the UTF-8 claims without verifying anything", () => {
    const claims = decodeIdToken(jwt({ sub: "abc123def456", preferred_username: "josé", iss: BASE_URL }));
    expect(claims.sub).toBe("abc123def456");
    expect(claims.preferred_username).toBe("josé");
  });

  test("refuses a token with no sub", () => {
    expect(() => decodeIdToken(jwt({ preferred_username: "afonso" }))).toThrow(/sub/);
  });

  test("refuses a token that is not three segments", () => {
    expect(() => decodeIdToken("not.a-jwt")).toThrow(/three base64url segments/);
  });
});

describe("OAuthTokenProvider", () => {
  test("hands out the stored token untouched while it is alive", async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error("the provider must not call the network for a live token");
    });
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      tokens: { accessToken: "live", tokenType: "Bearer", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    expect(await provider.getToken()).toBe("live");
    expect(calls.length).toBe(0);
  });

  test("returns null when nobody is signed in", async () => {
    const { fetch } = fakeFetch(() => json(200, {}));
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    expect(await provider.getToken()).toBeNull();
  });

  test("refreshes an expired set, form-encoded, with no Authorization header", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, tokenResponse()));
    const auth = anonymousAuth(fetch);
    const store = memoryTokenStore(expiredSet());
    const provider = refreshingTokenProvider({
      store,
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    expect(await provider.getToken()).toBe("new-access");
    expect(calls.length).toBe(1);

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE_URL}/oauth/token`);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.headers["authorization"]).toBeUndefined();

    const params = new URLSearchParams(call.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBeNull();

    // The rotated set was written through to the store, not just cached.
    const stored = await store.load();
    expect(stored?.accessToken).toBe("new-access");
    expect(stored?.refreshToken).toBe("new-refresh");
  });

  test("refreshes early, inside the skew window, before the token actually dies", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, tokenResponse()));
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      tokens: { accessToken: "nearly", tokenType: "Bearer", refreshToken: "r", expiresAt: Date.now() + 30_000 },
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
      skewMs: 60_000,
    });

    expect(await provider.getToken()).toBe("new-access");
    expect(calls.length).toBe(1);
  });

  test("collapses concurrent refreshes into exactly one call", async () => {
    const { fetch, calls } = fakeFetch(async () => {
      await delay(25);
      return json(200, tokenResponse());
    });
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      tokens: expiredSet(),
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    const results = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    expect(calls.length).toBe(1);
    expect(results).toEqual(["new-access", "new-access", "new-access", "new-access", "new-access"]);
  });

  test("a second wave after the refresh landed uses the cached token", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, tokenResponse()));
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      tokens: expiredSet(),
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    await provider.getToken();
    await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);

    expect(calls.length).toBe(1);
    expect(provider.peek()?.accessToken).toBe("new-access");
  });

  test("a 4xx on refresh clears the store and surfaces the OAuth error", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(400, { error: "invalid_grant", error_description: "The provided grant is invalid." }),
    );
    const auth = anonymousAuth(fetch);
    const store = memoryTokenStore(expiredSet());
    const provider = new OAuthTokenProvider({
      store,
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    let thrown: unknown;
    try {
      await provider.getToken();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OmsOAuthError);
    expect((thrown as OmsOAuthError).error).toBe("invalid_grant");
    expect((thrown as OmsOAuthError).retryable).toBe(false);
    expect(calls.length).toBe(1);
    expect(await store.load()).toBeNull();
    expect(provider.peek()).toBeNull();
  });

  test("a refresh that fails does not wedge the provider", async () => {
    let attempt = 0;
    const { fetch, calls } = fakeFetch(() => {
      attempt += 1;
      return attempt === 1 ? json(503, { error: "server_error" }) : json(200, tokenResponse());
    });
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      tokens: expiredSet(),
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    await expect(provider.getToken()).rejects.toBeDefined();
    // A 5xx is not terminal, so the set survives and a later call tries again.
    expect(provider.peek()?.refreshToken).toBe("old-refresh");
    expect(await provider.getToken()).toBe("new-access");
    expect(calls.length).toBe(2);
  });

  test("onUnauthorized renews once and lets the transport retry", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, tokenResponse()));
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      tokens: { accessToken: "live", tokenType: "Bearer", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    expect(await provider.getToken()).toBe("live");
    expect(await provider.onUnauthorized()).toBe(true);
    expect(calls.length).toBe(1);
    expect(await provider.getToken()).toBe("new-access");

    // A second 401 moments later is the tail of the same wave: no extra rotation.
    expect(await provider.onUnauthorized()).toBe(true);
    expect(calls.length).toBe(1);
  });

  test("onUnauthorized never throws, and gives up when there is nothing to renew", async () => {
    const { fetch, calls } = fakeFetch(() => json(400, { error: "invalid_grant" }));
    const auth = anonymousAuth(fetch);
    const store = memoryTokenStore({ accessToken: "orphan", tokenType: "Bearer" });
    const provider = new OAuthTokenProvider({
      store,
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    await provider.getToken();
    expect(await provider.onUnauthorized()).toBe(false);
    expect(calls.length).toBe(0);
    expect(await store.load()).toBeNull();
  });

  test("concurrent 401s share one renewal", async () => {
    const { fetch, calls } = fakeFetch(async () => {
      await delay(25);
      return json(200, tokenResponse());
    });
    const auth = anonymousAuth(fetch);
    const provider = new OAuthTokenProvider({
      tokens: { accessToken: "live", tokenType: "Bearer", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    await provider.getToken();
    const answers = await Promise.all([
      provider.onUnauthorized(),
      provider.onUnauthorized(),
      provider.onUnauthorized(),
    ]);

    expect(answers).toEqual([true, true, true]);
    expect(calls.length).toBe(1);
  });

  test("set() and clear() write through to the store", async () => {
    const { fetch } = fakeFetch(() => json(200, tokenResponse()));
    const auth = anonymousAuth(fetch);
    const store = memoryTokenStore(null);
    const provider = new OAuthTokenProvider({
      store,
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    await provider.set({ accessToken: "fresh", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000 });
    expect((await store.load())?.accessToken).toBe("fresh");
    expect(await provider.getToken()).toBe("fresh");

    await provider.clear();
    expect(await store.load()).toBeNull();
    expect(await provider.getToken()).toBeNull();
  });

  test("picks up a refresh another process already wrote to the store", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, tokenResponse()));
    const auth = anonymousAuth(fetch);

    let held: TokenSet | null = expiredSet();
    const store = {
      load: (): TokenSet | null => held,
      save: (tokens: TokenSet): void => {
        held = tokens;
      },
      clear: (): void => {
        held = null;
      },
    };
    const provider = new OAuthTokenProvider({
      store,
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });

    held = { accessToken: "written-elsewhere", tokenType: "Bearer", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
    expect(await provider.getToken()).toBe("written-elsewhere");
    expect(calls.length).toBe(0);
  });

  test("refuses to deadlock when the refresh callback is wired to its own client", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, tokenResponse()));

    let auth!: AuthNamespace;
    const provider: TokenProvider = new OAuthTokenProvider({
      tokens: expiredSet(),
      refresh: (refreshToken) => auth.refresh(refreshToken, { clientId: CLIENT_ID }),
    });
    // The wrong wiring: the client the refresh goes through carries the very
    // provider that is mid-refresh.
    auth = new AuthNamespace(new ApiClient({ baseUrl: BASE_URL, fetch, tokens: provider }));

    await expect(provider.getToken()).rejects.toThrow(/deadlock/);
    expect(calls.length).toBe(0);
  });

  test("rejects being given both a store and an initial set", () => {
    expect(
      () =>
        new OAuthTokenProvider({
          store: memoryTokenStore(null),
          tokens: null,
          refresh: async () => expiredSet(),
        }),
    ).toThrow(TypeError);
  });
});

describe("readInsufficientScope", () => {
  const challenge = (header: string): OmsApiError =>
    new OmsApiError("Forbidden", { status: 403, headers: { "www-authenticate": header } });

  test("names the scopes the endpoint wanted", () => {
    const found = readInsufficientScope(
      challenge('Bearer realm="omelhorsite", error="insufficient_scope", scope="storage:write"'),
    );
    expect(found).toEqual({ required: ["storage:write"], realm: "omelhorsite" });
  });

  test("reports an empty list when the server named no scope", () => {
    const found = readInsufficientScope(challenge('Bearer realm="omelhorsite", error="insufficient_scope"'));
    expect(found?.required).toEqual([]);
  });

  test("ignores anything that is not an insufficient_scope challenge", () => {
    expect(readInsufficientScope(challenge('Bearer realm="omelhorsite", error="invalid_token'))).toBeUndefined();
    expect(readInsufficientScope(new OmsApiError("Nope", { status: 403 }))).toBeUndefined();
    expect(readInsufficientScope(new Error("unrelated"))).toBeUndefined();
  });
});
