/**
 * `bun test` coverage for the three downloads that follow a `302` from Rails
 * into object storage: `account.picture`, `chests.entries.download` and
 * `tickets.attachment`.
 *
 * The bug these guard against is invisible off-browser, which is exactly why it
 * needs a test. `fetch` in Bun, Node and a Worker enforces no CORS at all, so
 * every one of these calls passes there whatever credential it sends. In a
 * browser the redirect hop reaches MinIO with `Origin: null`, MinIO answers
 * `Access-Control-Allow-Origin: *`, and a wildcard is illegal for a
 * credentialed request - so a client built with `sessionCookie: true`, which is
 * what the production web app uses, has the response rejected before any
 * JavaScript sees it.
 *
 * Nothing here can observe a real CORS check. What it CAN observe, and what
 * actually decides the outcome, is the credential the SDK puts on the request:
 * every test below is an assertion about the `RequestInit` and about the
 * `Authorization` header. `credentials: "omit"` on the two anonymous routes is
 * the fix; a credential creeping back onto either of them is the regression.
 *
 * The asymmetry is the other half of the contract. `tickets.attachment` MUST
 * send its credential - the action resolves the ticket through
 * `Ticket.viewable_by(Current.user)` - so it is asserted to keep sending one,
 * and the burden shifts to `attachmentUrl` plus a legible error.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsError, OmsNetworkError } from "../src/errors";
import { ApiClient } from "../src/http";
import { AccountNamespace } from "../src/resources/account";
import { ChestsNamespace } from "../src/resources/chests";
import { TicketsNamespace } from "../src/resources/tickets";

const BASE_URL = "https://api.test";
const TOKEN = "secret-session-token";

/** One request the SDK made, flattened into what the assertions care about. */
interface Recorded {
  readonly url: string;
  readonly path: string;
  readonly search: string;
  readonly credentials: RequestCredentials | undefined;
  readonly redirect: RequestRedirect | undefined;
  readonly authorization: string | null;
}

interface Harness {
  readonly account: AccountNamespace;
  readonly chests: ChestsNamespace;
  readonly tickets: TicketsNamespace;
  readonly calls: Recorded[];
}

/**
 * Builds a client whose `fetch` records the init it was handed.
 *
 * `mode` is the only axis that matters: a token client sends
 * `credentials: "omit"` and an `Authorization` header, a cookie client sends
 * `credentials: "include"` and no header. Those are the two shapes the
 * production web app and the CLI actually run in.
 *
 * `respond` returns the `Response`, or throws to simulate a `fetch` rejection -
 * which is how a browser reports a blocked CORS response, indistinguishable
 * from a real network fault.
 */
function harness(
  mode: "token" | "cookie",
  respond: (request: Recorded) => Response = () => new Response("bytes", { status: 200 }),
): Harness {
  const calls: Recorded[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init?.headers ?? {});
    const recorded: Recorded = {
      url: input,
      path: url.pathname,
      search: url.search,
      credentials: init?.credentials,
      redirect: init?.redirect,
      authorization: headers.get("authorization"),
    };
    calls.push(recorded);
    return respond(recorded);
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    ...(mode === "token" ? { tokens: { getToken: () => TOKEN } } : { sessionCookie: true }),
  });

  return {
    account: new AccountNamespace(http),
    chests: new ChestsNamespace(http),
    tickets: new TicketsNamespace(http),
    calls,
  };
}

/** The single request the SDK should have made. Fails loudly if it made more. */
function onlyCall(calls: Recorded[]): Recorded {
  expect(calls).toHaveLength(1);
  return calls[0] as Recorded;
}

describe("account.picture", () => {
  test("sends no credential even when the client is holding a token", async () => {
    const { account, calls } = harness("token");

    await account.picture("usr_1");

    const call = onlyCall(calls);
    expect(call.path).toBe("/users/usr_1/picture");
    // The whole fix. "include" here is what a browser rejects against MinIO's
    // wildcard, and a bearer header would be a second credential the store
    // never asked for.
    expect(call.credentials).toBe("omit");
    expect(call.authorization).toBeNull();
    expect(call.redirect).toBe("follow");
  });

  test("sends no credential in cookie mode either, which is the mode that breaks", async () => {
    const { account, calls } = harness("cookie");

    await account.picture("usr_1");

    expect(onlyCall(calls).credentials).toBe("omit");
  });

  test("returns the bytes", async () => {
    const { account } = harness("token", () => new Response("png-bytes", { status: 200 }));

    expect(await (await account.picture("usr_1")).text()).toBe("png-bytes");
  });

  test("a user with no avatar is a 404 OmsApiError, not a bare fetch failure", async () => {
    const { account } = harness("token", () => new Response("", { status: 404 }));

    const failure = await account.picture("usr_1").catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
    expect((failure as OmsApiError).code).toBe("not_found");
  });

  test("escapes the id rather than letting it walk out of the path", () => {
    const { account } = harness("token");

    expect(account.pictureUrl("../admin")).toBe(`${BASE_URL}/users/..%2Fadmin/picture`);
  });
});

describe("account.pictureUrl", () => {
  test("is synchronous, so a list of avatars renders in one pass", () => {
    const { account } = harness("token");

    const url: string = account.pictureUrl("usr_1");

    expect(url).toBe(`${BASE_URL}/users/usr_1/picture`);
  });

  test("never carries a credential, in either mode", () => {
    expect(harness("token").account.pictureUrl("usr_1")).toBe(`${BASE_URL}/users/usr_1/picture`);
    expect(harness("cookie").account.pictureUrl("usr_1")).toBe(`${BASE_URL}/users/usr_1/picture`);
  });

  test("is the URL picture() fetches, so the two can never drift apart", async () => {
    const { account, calls } = harness("token");

    await account.picture("usr_1");

    expect(onlyCall(calls).url).toBe(account.pictureUrl("usr_1"));
  });
});

describe("chests.entries.download", () => {
  test("sends no credential: the entry id is the only thing the action checks", async () => {
    const { chests, calls } = harness("cookie");

    await chests.entries.download("ent_1");

    const call = onlyCall(calls);
    expect(call.path).toBe("/chest_entries/ent_1/data");
    expect(call.credentials).toBe("omit");
    expect(call.authorization).toBeNull();
  });

  test("drops the bearer token a token-mode client would otherwise attach", async () => {
    const { chests, calls } = harness("token");

    await chests.entries.download("ent_1");

    expect(onlyCall(calls).authorization).toBeNull();
  });

  test("reads the inline send_data shape too, not just the redirect one", async () => {
    // Against a Disk service presigning raises ArgumentError and the controller
    // falls back to send_data, so the bytes arrive straight from Rails.
    const { chests } = harness("token", () =>
      new Response("file-bytes", {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="notes.txt"' },
      }),
    );

    expect(await (await chests.entries.download("ent_1")).text()).toBe("file-bytes");
  });

  test("an expired chest is a 404 OmsApiError that says so", async () => {
    const { chests } = harness("token", () => new Response("", { status: 404 }));

    const failure = await chests.entries.download("ent_1").catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
    expect((failure as OmsError).message).toContain("two hours");
  });
});

describe("chests.entries.downloadUrl", () => {
  test("is synchronous and credential-free, unlike the helper it replaces", () => {
    const { chests } = harness("token");

    expect(chests.entries.downloadUrl("ent_1")).toBe(`${BASE_URL}/chest_entries/ent_1/data`);
    expect(harness("cookie").chests.entries.downloadUrl("ent_1")).toBe(`${BASE_URL}/chest_entries/ent_1/data`);
  });

  test("is the URL download() fetches", async () => {
    const { chests, calls } = harness("token");

    await chests.entries.download("ent_1");

    expect(onlyCall(calls).url).toBe(chests.entries.downloadUrl("ent_1"));
  });
});

describe("tickets.attachment", () => {
  test("KEEPS its credential: this route is scoped to the caller", async () => {
    const { tickets, calls } = harness("token");

    await tickets.attachment(7, 42);

    const call = onlyCall(calls);
    expect(call.path).toBe("/tickets/7/attachment/42");
    // The opposite assertion to the other two, and deliberately so. Ticket.viewable_by
    // scopes the lookup, so an anonymous request is a 404 rather than a download.
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("rides the cookie in cookie mode rather than inventing a header", async () => {
    const { tickets, calls } = harness("cookie");

    await tickets.attachment(7, 42);

    const call = onlyCall(calls);
    expect(call.credentials).toBe("include");
    expect(call.authorization).toBeNull();
  });

  test("returns the bytes", async () => {
    const { tickets } = harness("token", () => new Response("screenshot", { status: 200 }));

    expect(await (await tickets.attachment(7, 42)).text()).toBe("screenshot");
  });

  test("a blocked redirect in cookie mode explains itself and names the way out", async () => {
    const { tickets } = harness("cookie", () => {
      // What a browser throws when the redirect hop fails its CORS check.
      throw new TypeError("Failed to fetch");
    });

    const failure = await tickets.attachment(7, 42, { retry: false }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsError);
    expect(failure).not.toBeInstanceOf(OmsNetworkError);
    expect((failure as OmsError).code).toBe("unsupported");
    expect((failure as OmsError).message).toContain("attachmentUrl");
    // The original fault is kept, so a genuine network problem is still diagnosable.
    expect((failure as OmsError).cause).toBeInstanceOf(OmsNetworkError);
  });

  test("a token-mode network failure is left alone: nothing about CORS applies there", async () => {
    const { tickets } = harness("token", () => {
      throw new TypeError("connection reset");
    });

    const failure = await tickets.attachment(7, 42, { retry: false }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsNetworkError);
    expect((failure as OmsError).message).toContain("connection reset");
  });

  test("an API error is not disguised as a CORS problem", async () => {
    const { tickets } = harness("cookie", () => new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }));

    const failure = await tickets.attachment(7, 42, { retry: false }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
  });
});

describe("tickets.attachmentUrl", () => {
  test("carries the token in the query in token mode, because an <img> cannot send a header", async () => {
    const { tickets } = harness("token");

    const url = await tickets.attachmentUrl(7, 42);

    expect(url).toBe(`${BASE_URL}/tickets/7/attachment/42?token=${TOKEN}`);
  });

  test("carries nothing in cookie mode: the browser attaches oms_session itself", async () => {
    const { tickets } = harness("cookie");

    expect(await tickets.attachmentUrl(7, 42)).toBe(`${BASE_URL}/tickets/7/attachment/42`);
  });

  test("builds the URL without making a request", async () => {
    const { tickets, calls } = harness("token");

    await tickets.attachmentUrl(7, 42);

    expect(calls).toHaveLength(0);
  });

  test("awaits a provider that refreshes before answering", async () => {
    const http = new ApiClient({
      baseUrl: BASE_URL,
      fetch: async () => new Response("", { status: 200 }),
      tokens: { getToken: async () => "refreshed-token" },
    });

    expect(await new TicketsNamespace(http).attachmentUrl(7, 42)).toBe(
      `${BASE_URL}/tickets/7/attachment/42?token=refreshed-token`,
    );
  });

  test("a provider that throws yields a URL with no credential, not a rejection", async () => {
    const http = new ApiClient({
      baseUrl: BASE_URL,
      fetch: async () => new Response("", { status: 200 }),
      tokens: {
        getToken: () => {
          throw new Error("keychain locked");
        },
      },
    });

    expect(await new TicketsNamespace(http).attachmentUrl(7, 42)).toBe(`${BASE_URL}/tickets/7/attachment/42`);
  });
});
