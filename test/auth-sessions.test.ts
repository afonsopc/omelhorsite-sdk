/**
 * `bun test` coverage for the `auth-sessions` namespace.
 *
 * This is the namespace that decides whether anybody is signed in at all, so
 * the tests are about the four things that would be unrecoverable if they were
 * wrong, rather than about round-tripping JSON:
 *
 * 1. sign-in works in BOTH credential modes, and cookie mode sends the cookie
 *    and no `Authorization` header (two credentials on one request means the
 *    server picks and the caller cannot tell which one it got);
 * 2. sign-out costs ONE request, hits the placeholder path, and is idempotent -
 *    a dead credential resolves instead of throwing, because "make this session
 *    be gone" has already succeeded when the session is gone;
 * 3. `adopt` is never retried. The ticket is one-time on the server, so a
 *    replay after a lost response burns it and reports failure for a login that
 *    succeeded;
 * 4. the two-step email flows put the codes in the fields the controller
 *    permits, since a misnamed key is dropped in silence and answers 404
 *    "Invalid Verification" as if the user had typed the code wrong.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { OmsApiError, OmsAuthError, OmsQuotaError } from "../src/errors";
import {
  AuthSessionsNamespace,
  SESSION_COOKIE_NAME,
  SESSION_DEVICE_TYPES,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_MAX_ATTEMPTS,
  VERIFICATION_CODE_TTL_MS,
  isVerificationCode,
} from "../src/resources/auth/sessions";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly credentials: string | undefined;
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

interface Harness {
  readonly sessions: AuthSessionsNamespace;
  readonly calls: Call[];
}

/**
 * Queues one reply per call, in order. The last reply repeats, so a test that
 * only cares about the first request does not have to enumerate the rest.
 */
function harness(replies: Reply[], clientOptions: Record<string, unknown> = {}): Harness {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const raw = init?.body;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      search: decodeURIComponent(url.search),
      body: typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      credentials: init?.credentials,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
    const status = reply.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(reply.body ?? null), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl, ...clientOptions });
  return { sessions: new AuthSessionsNamespace(http), calls };
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess-1",
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:00:00Z",
    ip_address: "203.0.113.7",
    user_agent: "oms-cli/0.3.0",
    name: "laptop",
    device_type: "laptop",
    description: "macOS",
    last_used_at: "2026-08-29T10:00:00Z",
    user_id: "user-1",
    user: { id: "user-1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", handle: "afonso" },
    ...overrides,
  };
}

describe("signIn", () => {
  test("posts the credentials and hands back the token with the user inlined", async () => {
    const { sessions, calls } = harness([{ status: 201, body: sessionRow({ token: "the-uuid" }) }]);

    const session = await sessions.signIn({ email: "A@Example.com", password: "hunter2" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/sessions");
    expect(calls[0]!.body).toEqual({ email: "A@Example.com", password: "hunter2" });
    expect(session.token).toBe("the-uuid");
    // The :token view INHERITS the base view, so the inline user is there and a
    // GET /account straight after sign-in is a wasted round trip.
    expect(session.user.handle).toBe("afonso");
  });

  // The email is normalised server-side. Normalising it here too would make the
  // SDK and the server disagree about what the user typed for no gain.
  test("sends the address exactly as given, without lowercasing it", async () => {
    const { sessions, calls } = harness([{ status: 201, body: sessionRow({ token: "t" }) }]);

    await sessions.signIn({ email: "  Mixed@Case.PT  ", password: "p" });

    expect((calls[0]!.body as { email: string }).email).toBe("  Mixed@Case.PT  ");
  });

  test("carries no credential of its own in token mode: sign-in is anonymous", async () => {
    const { sessions, calls } = harness([{ status: 201, body: sessionRow({ token: "t" }) }]);

    await sessions.signIn({ email: "a@b.pt", password: "p" });

    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
    expect(calls[0]!.credentials).toBe("omit");
  });

  // Cookie mode is the web app's mode, and it is the one where the SDK cannot
  // read the credential it just established: the Set-Cookie is httpOnly. All
  // the SDK controls is that the browser is ASKED to keep it.
  test("asks the browser to keep the cookie in cookie mode, and still sends no header", async () => {
    const { sessions, calls } = harness([{ status: 201, body: sessionRow({ token: "t" }) }], {
      sessionCookie: true,
    });

    const session = await sessions.signIn({ email: "a@b.pt", password: "p" });

    expect(calls[0]!.credentials).toBe("include");
    expect(calls[0]!.headers["Authorization"]).toBeUndefined();
    // The token is in the body even in cookie mode. The SDK returns it; the
    // documented rule is that a cookie-mode host must not persist it.
    expect(session.token).toBe("t");
  });

  test("a wrong password is an auth error, not a generic one", async () => {
    const { sessions } = harness([{ status: 401, body: "Invalid email address or password." }]);

    await expect(sessions.signIn({ email: "a@b.pt", password: "no" })).rejects.toBeInstanceOf(OmsAuthError);
  });
});

describe("signOut", () => {
  test("costs one request, to the placeholder path, and never names a real id", async () => {
    const { sessions, calls } = harness([{ status: 204 }]);

    await sessions.signOut();

    // Two requests would mean it resolved GET /sessions/mine first; a real id
    // in the path would mean the signature was pretending the id is honoured.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe("/sessions/current");
  });

  test("a dead credential resolves instead of throwing", async () => {
    const dead = harness([{ status: 401, body: "Session required to access this resource." }]);
    await expect(dead.sessions.signOut()).resolves.toBeUndefined();
    expect(dead.calls).toHaveLength(1);
  });

  // The forward-compatibility path: if the backend ever starts honouring the
  // :id, the placeholder 404s and the real id has to be resolved. Nobody should
  // have to notice.
  test("falls back to the real id when the placeholder is refused", async () => {
    const { sessions, calls } = harness([
      { status: 404, body: "Resource not found" },
      { status: 200, body: sessionRow({ id: "sess-real" }) },
      { status: 204 },
    ]);

    await sessions.signOut();

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /sessions/current",
      "GET /sessions/mine",
      "DELETE /sessions/sess-real",
    ]);
  });

  test("gives up quietly when the fallback finds no session either", async () => {
    const { sessions, calls } = harness([
      { status: 404, body: "Resource not found" },
      { status: 401, body: "Session required to access this resource." },
    ]);

    await expect(sessions.signOut()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  // Idempotence is not the same as swallowing everything: a 500 or a 429 means
  // the server did not do what was asked, and hiding that would leave a client
  // believing a revocation happened.
  test("still raises a server failure", async () => {
    const { sessions } = harness([{ status: 500, body: "boom" }]);

    await expect(sessions.signOut()).rejects.toBeInstanceOf(OmsApiError);
  });
});

describe("adopt", () => {
  test("posts the ticket unauthenticated and returns the token", async () => {
    const { sessions, calls } = harness([{ status: 201, body: { token: "adopted-uuid" } }]);

    const adopted = await sessions.adopt("tkt-123");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/sessions/adopt");
    expect(calls[0]!.body).toEqual({ ticket: "tkt-123" });
    expect(adopted.token).toBe("adopted-uuid");
  });

  // THE test of this method. The ticket is claimed atomically on the server and
  // dies on first redemption, so a retry cannot succeed and can only destroy a
  // login that already worked. A 429 is the one status the transport retries on
  // any method, which is why it is the status used here.
  test("is never replayed, not even on a 429", async () => {
    const { sessions, calls } = harness([{ status: 429, body: { error: "rate_limited", retry_after: 1 } }]);

    await expect(sessions.adopt("tkt-123")).rejects.toBeInstanceOf(OmsQuotaError);
    expect(calls).toHaveLength(1);
  });

  test("a caller cannot turn retrying back on", async () => {
    const { sessions, calls } = harness([{ status: 429, body: { error: "rate_limited" } }]);

    await expect(sessions.adopt("tkt-123", { retry: { maxAttempts: 5 } })).rejects.toBeInstanceOf(OmsQuotaError);
    expect(calls).toHaveLength(1);
  });
});

describe("current and oauthTicket", () => {
  test("current reads /sessions/mine and gets no token back", async () => {
    const { sessions, calls } = harness([{ status: 200, body: sessionRow() }]);

    const session = await sessions.current();

    expect(calls[0]!.path).toBe("/sessions/mine");
    expect((session as unknown as { token?: string }).token).toBeUndefined();
  });

  test("oauthTicket mints a ticket, not a token", async () => {
    const { sessions, calls } = harness([{ status: 200, body: { ticket: "signed-id" } }]);

    const minted = await sessions.oauthTicket();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe("/sessions/oauth_ticket");
    expect(minted.ticket).toBe("signed-id");
  });
});

describe("the two-step email flows", () => {
  test("signUpStart sends only the address and returns the bare string body", async () => {
    const { sessions, calls } = harness([{ status: 200, body: "Verification code sent to your email." }]);

    const message = await sessions.signUpStart("new@user.pt");

    expect(calls[0]!.path).toBe("/users/create_start");
    expect(calls[0]!.body).toEqual({ email: "new@user.pt" });
    // Bare JSON strings, not objects. A caller reaching for .message finds
    // undefined.
    expect(message).toBe("Verification code sent to your email.");
  });

  test("signUpComplete sends the four permitted fields and no handle", async () => {
    const { sessions, calls } = harness([{ status: 201, body: { id: "user-2", handle: "novo" } }]);

    await sessions.signUpComplete({ email: "new@user.pt", code: "012345", name: "Novo", password: "p" });

    expect(calls[0]!.path).toBe("/users/create_end");
    expect(calls[0]!.body).toEqual({ email: "new@user.pt", code: "012345", name: "Novo", password: "p" });
    // handle is generated server-side from the name; sending one would be
    // dropped in silence and would read like it had been honoured.
    expect(Object.keys(calls[0]!.body as object)).not.toContain("handle");
  });

  test("signUpComplete does not sign anyone in", async () => {
    const { sessions, calls } = harness([{ status: 201, body: { id: "user-2" } }]);

    await sessions.signUpComplete({ email: "a@b.pt", code: "111111", name: "N", password: "p" });

    // One request. A namespace that quietly chained POST /sessions would hide
    // the fact that the caller has to do it, and would sign the user in on a
    // client that cannot hold the token.
    expect(calls).toHaveLength(1);
  });

  test("resetPasswordComplete sends only email, code and the new password", async () => {
    const { sessions, calls } = harness([{ status: 200, body: { id: "user-1" } }]);

    await sessions.resetPasswordComplete({ email: "a@b.pt", code: "222222", password: "novo" });

    expect(calls[0]!.path).toBe("/users/reset_password_end");
    expect(calls[0]!.body).toEqual({ email: "a@b.pt", code: "222222", password: "novo" });
  });

  test("verifyEmailStart sends no body and verifyEmailComplete carries the code", async () => {
    const { sessions, calls } = harness([
      { status: 200, body: "Verification code sent to your email." },
      { status: 200, body: { id: "user-1", email_verified: true } },
    ]);
    await sessions.verifyEmailStart();
    const user = await sessions.verifyEmailComplete("123456");
    expect(calls[0]!.path).toBe("/users/verify_email_start");
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[1]!.path).toBe("/users/verify_email_end");
    expect(calls[1]!.body).toEqual({ code: "123456" });
    expect(user.email_verified).toBe(true);
  });

  test("changeEmailStart names the NEW address, and nothing identifies the old one", async () => {
    const { sessions, calls } = harness([{ status: 200, body: "Email update instructions sent." }]);

    await sessions.changeEmailStart("moved@user.pt");

    expect(calls[0]!.path).toBe("/users/update_email_start");
    // The old address is read from the session server-side, so there is nothing
    // here to spoof.
    expect(calls[0]!.body).toEqual({ email: "moved@user.pt" });
  });

  // The one place a camelCase input has to become two differently-named
  // snake_case keys. Get either wrong and the controller sees a nil code,
  // answers 404 "Invalid Verification", and burns an attempt against BOTH live
  // codes while looking exactly like a user typo.
  test("changeEmailComplete maps both codes onto the permitted parameter names", async () => {
    const { sessions, calls } = harness([{ status: 200, body: { id: "user-1" } }]);

    await sessions.changeEmailComplete({
      email: "moved@user.pt",
      prevEmailCode: "333333",
      newEmailCode: "444444",
    });

    expect(calls[0]!.path).toBe("/users/update_email_end");
    expect(calls[0]!.body).toEqual({
      email: "moved@user.pt",
      prev_email_code: "333333",
      new_email_code: "444444",
    });
  });

  test("deleteAccountStart takes no argument and sends no body", async () => {
    const { sessions, calls } = harness([{ status: 200, body: "User deletion instructions sent." }]);

    await sessions.deleteAccountStart();

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/users/destroy_start");
    expect(calls[0]!.body).toBeUndefined();
  });

  test("deleteAccountComplete sends the code and returns nothing readable", async () => {
    const { sessions, calls } = harness([{ status: 200, body: null }]);

    await expect(sessions.deleteAccountComplete("555555")).resolves.toBeUndefined();
    expect(calls[0]!.path).toBe("/users/destroy_end");
    expect(calls[0]!.body).toEqual({ code: "555555" });
  });

  test("a wrong code is a 404, indistinguishable from an expired or burned one", async () => {
    const { sessions } = harness([{ status: 404, body: "Invalid Verification" }]);

    const failure = sessions.signUpComplete({ email: "a@b.pt", code: "000000", name: "N", password: "p" });

    await expect(failure).rejects.toMatchObject({ status: 404 });
  });
});

describe("verification code constants", () => {
  // These mirror EmailVerification and are the numbers a UI builds a countdown
  // and an attempt counter from. Pinned so a drift on the Rails side shows up
  // here rather than as a user locked out of a flow.
  test("match the backend's own", () => {
    expect(VERIFICATION_CODE_LENGTH).toBe(6);
    expect(VERIFICATION_CODE_MAX_ATTEMPTS).toBe(5);
    expect(VERIFICATION_CODE_TTL_MS).toBe(900_000);
    expect(SESSION_COOKIE_NAME).toBe("oms_session");
  });

  test("isVerificationCode accepts six digits and nothing else", () => {
    expect(isVerificationCode("012345")).toBe(true);
    expect(isVerificationCode("000000")).toBe(true);
    // A pasted code with whitespace: the server strips it, but spending one of
    // five guesses on a paste artefact is what the guard is for.
    expect(isVerificationCode(" 012345")).toBe(false);
    expect(isVerificationCode("12345")).toBe(false);
    expect(isVerificationCode("1234567")).toBe(false);
    expect(isVerificationCode("12345a")).toBe(false);
    expect(isVerificationCode("")).toBe(false);
  });

  test("teapot is a real device type, because it is the one that silences alerts", () => {
    expect(SESSION_DEVICE_TYPES).toContain("teapot");
    expect(SESSION_DEVICE_TYPES).toContain("mobile");
  });
});

describe("listUsers", () => {
  test("puts substring filters under search and the exact one under exact_search", async () => {
    const { sessions, calls } = harness([{ status: 200, body: [] }]);

    await sessions.listUsers({ name: "afo", exactHandle: "afonso", pageSize: 25, order: "handle:asc" });

    expect(calls[0]!.path).toBe("/users");
    expect(calls[0]!.search).toContain("search[name]=afo");
    expect(calls[0]!.search).toContain("exact_search[handle]=afonso");
    expect(calls[0]!.search).toContain("modifiers[page]=1:25");
    expect(calls[0]!.search).toContain("modifiers[order]=handle:asc");
  });

  test("sends no filter key for a filter that was not asked for", async () => {
    const { sessions, calls } = harness([{ status: 200, body: [] }]);

    await sessions.listUsers();

    // Unknown and empty keys are not the same thing to this backend, and the
    // list DSL rejects what it does not recognise with a 400 rather than
    // ignoring it. Sending nothing is the only safe shape.
    expect(calls[0]!.search).not.toContain("search[name]");
    expect(calls[0]!.search).not.toContain("exact_search[handle]");
    expect(calls[0]!.search).toContain("modifiers[page]=1:100");
  });

  test("pages through the roster", async () => {
    const full = Array.from({ length: 2 }, (_, index) => ({ id: `u${index}`, handle: `h${index}` }));
    const { sessions, calls } = harness([
      { status: 200, body: full },
      { status: 200, body: [{ id: "u2", handle: "h2" }] },
    ]);

    const first = await sessions.listUsers({ pageSize: 2 });
    expect(first.hasMore).toBe(true);

    const second = await first.next();
    expect(second?.items).toHaveLength(1);
    expect(calls[1]!.search).toContain("modifiers[page]=2:2");
    expect(await second!.next()).toBeNull();
  });
});

describe("administrative lifecycle", () => {
  test("deactivateUser posts to the member route with the id encoded", async () => {
    const { sessions, calls } = harness([{ status: 200, body: { id: "user 2/x" } }]);

    await sessions.deactivateUser("user 2/x");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/users/user%202%2Fx/deactivate");
    expect(calls[0]!.body).toBeUndefined();
  });

  test("reactivateUser is its own route, not a PATCH of deactivated_at", async () => {
    const { sessions, calls } = harness([{ status: 200, body: { id: "user-2" } }]);

    await sessions.reactivateUser("user-2");

    expect(calls[0]!.path).toBe("/users/user-2/reactivate");
  });

  test("a non-administrator is refused", async () => {
    const { sessions } = harness([{ status: 401, body: "Admins only." }]);

    await expect(sessions.deactivateUser("user-2")).rejects.toBeInstanceOf(OmsAuthError);
  });

  test("an administrator cannot deactivate themselves", async () => {
    const { sessions } = harness([{ status: 400, body: "Cannot deactivate yourself." }]);

    await expect(sessions.deactivateUser("me")).rejects.toMatchObject({ status: 400 });
  });
});
