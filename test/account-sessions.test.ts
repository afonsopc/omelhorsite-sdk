import { describe, expect, test } from "bun:test";

import { OmsApiError } from "../src/errors";
import { ApiClient } from "../src/http";
import { AccountNamespace, AccountSessionsNamespace } from "../src/resources/account";

describe("account.update", () => {
  test("null reaches the wire, so a column can be cleared", async () => {
    const bodies: unknown[] = [];
    const http = new ApiClient({
      baseUrl: BASE_URL,
      tokens: { getToken: () => "t" },
      fetch: async (input, init) => {
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "u1", handle: "afonso" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await new AccountNamespace(http).update({ libraryName: null, libraryDescription: "x", bio: null });

    expect(bodies).toEqual([{ library_name: null, library_description: "x", bio: null }]);
  });
});

const BASE_URL = "https://api.test";

function harness(status = 204, body: unknown = null) {
  const calls: Array<{ method: string; path: string }> = [];
  const http = new ApiClient({
    baseUrl: BASE_URL,
    tokens: { getToken: () => "t" },
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(input).pathname });
      return new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { sessions: new AccountSessionsNamespace(http), calls };
}

describe("account.sessions.revoke", () => {
  test("deletes the session by id", async () => {
    const { sessions, calls } = harness();

    await sessions.revoke("abc/def");

    expect(calls).toEqual([{ method: "DELETE", path: "/sessions/abc%2Fdef" }]);
  });

  test("a session that is not yours is a 404", async () => {
    const { sessions } = harness(404, "Session not found.");

    const failure = await sessions.revoke("theirs").catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
  });
});
