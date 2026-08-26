import { describe, expect, test } from "bun:test";

import { ApiClient, Oms } from "../src/index";

// The cookie mode is the one credential the SDK cannot see. Everything else is
// a token this code was handed; this one is the browser attaching something no
// script is allowed to read. So the tests are about the SHAPE of the request,
// which is all the SDK actually controls.
const capture = () => {
  const seen: RequestInit[] = [];
  const fetchLike = (async (_url: string, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { seen, fetchLike };
};

describe("session cookie mode", () => {
  test("omits credentials and sends no cookie by default", async () => {
    const { seen, fetchLike } = capture();
    await new ApiClient({ fetch: fetchLike, baseUrl: "https://example.invalid" }).get("/x");

    expect(seen[0]!.credentials).toBe("omit");
  });

  test("includes credentials when asked for by name", async () => {
    const { seen, fetchLike } = capture();
    await new ApiClient({ fetch: fetchLike, baseUrl: "https://example.invalid", sessionCookie: true }).get("/x");

    expect(seen[0]!.credentials).toBe("include");
  });

  // The whole point: in cookie mode the SDK must not also assert an identity of
  // its own. Two credentials on one request means the server picks, and the
  // caller cannot tell which one it got.
  test("sends no Authorization header in cookie mode", async () => {
    const { seen, fetchLike } = capture();
    await new Oms({ sessionCookie: true, baseUrl: "https://example.invalid", fetch: fetchLike }).account.usage();

    const headers = seen[0]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(seen[0]!.credentials).toBe("include");
  });

  test("refuses a cookie and a token together, in both spellings", () => {
    expect(() => new Oms({ sessionCookie: true, token: "t" })).toThrow(TypeError);
    expect(() => new ApiClient({ sessionCookie: true, tokens: { getToken: async () => "t" } })).toThrow(TypeError);
  });

  // A token client must not quietly become a cookie client. withToken() exists
  // so a caller can act as somebody else; inheriting `include` would keep the
  // signed-in browser identity riding along underneath.
  test("a token client still omits credentials", async () => {
    const { seen, fetchLike } = capture();
    await new Oms({ token: "t", baseUrl: "https://example.invalid", fetch: fetchLike }).account.usage();

    expect(seen[0]!.credentials).toBe("omit");
    expect((seen[0]!.headers as Record<string, string>)["Authorization"]).toBe("Bearer t");
  });
});
