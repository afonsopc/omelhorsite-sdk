/**
 * `bun test` coverage for the `admin` namespace.
 *
 * The namespace's whole reason to exist is that three different publics live
 * behind one word, so the tests are weighted towards the mistakes that mix them
 * up rather than towards happy-path plumbing:
 *
 * - a call on the owner half must never reach an `/admin/*` path, and vice
 *   versa. Two methods called `destroy` sit one property apart and one of them
 *   deletes anybody's OAuth client;
 * - the `403` an administrator route answers must arrive as "your credential is
 *   fine, the act is not" and not as "log in again", because a client that
 *   retries its login flow on that will loop;
 * - the filters the list DSL reads have to land inside `exact_search`. A filter
 *   sent at the top level is dropped in silence and the answer is the whole
 *   table, which is the failure that never shows up in a review;
 * - the two `429`s on registration are different diagnoses, and the request
 *   must not be replayed on either.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsAuthError, OmsQuotaError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  AdminNamespace,
  NATIVE_LOOPBACK_REDIRECT_VALUE,
  OAUTH_APP_MAX_PENDING,
  SHIPPED_CLIENT_IDS,
  editWouldRequeue,
  isShippedClient,
  normalizeRedirectUris,
  registeredRedirectUris,
  splitRedirectUris,
  type OauthApplicationSummary,
} from "../src/resources/admin";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

interface Harness {
  readonly admin: AdminNamespace;
  readonly calls: Call[];
}

/** One canned response for every request, plus a log of what was asked. */
function harness(body: unknown, status = 200, headers: Record<string, string> = {}): Harness {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    let parsed: unknown = undefined;
    if (typeof init?.body === "string") parsed = JSON.parse(init.body);
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      search: decodeURIComponent(url.search),
      body: parsed,
    });
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
    // The transport honours Retry-After literally, and one of the tests below
    // returns a 429 on purpose. Without this the suite would sleep.
    retry: false,
  });
  return { admin: new AdminNamespace(http), calls };
}

function application(overrides: Partial<OauthApplicationSummary> = {}): OauthApplicationSummary {
  return {
    id: 12,
    client_id: "abc123",
    name: "A Minha Appzinha",
    scopes: ["openid", "profile"],
    confidential: false,
    redirect_uri: NATIVE_LOOPBACK_REDIRECT_VALUE,
    approval_status: "approved",
    approved_at: "2026-08-01T10:00:00.000Z",
    rejection_reason: null,
    owner: { id: "u_1", handle: "afonso", name: "Afonso" },
    approved_by: null,
    created_at: "2026-07-30T09:00:00.000Z",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- *
 *  The three publics do not share a path
 * -------------------------------------------------------------------------- */

describe("the three publics are separated by the call site", () => {
  test("the owner half never touches an /admin path", async () => {
    const { admin, calls } = harness({ applications: [] });

    await admin.myApplications.list();
    await admin.authorizedApplications.list();
    await admin.identities.list();

    expect(calls.map((call) => call.path)).toEqual([
      "/oauth_applications",
      "/authorized_applications",
      "/identities",
    ]);
    expect(calls.some((call) => call.path.startsWith("/admin"))).toBe(false);
  });

  test("every administrator sub-namespace is under /admin", async () => {
    const { admin, calls } = harness({});

    await admin.oauthApplications.list();
    await admin.quotas.get("afonso");
    await admin.jobs.list();
    await admin.shortLinks.stats();
    await admin.vocalSeparations.list();
    await admin.chests.stats();
    await admin.notepads.stats();
    await admin.eventAlerts.list();

    expect(calls.every((call) => call.path.startsWith("/admin/"))).toBe(true);
  });

  test("the two destroys with the same name hit different resources", async () => {
    const owner = harness({ id: 12, client_id: "abc123", revoked_tokens: 0 });
    const server = harness({ id: 12, uid: "abc123", revoked_tokens: 4 });

    const mine = await owner.admin.myApplications.destroy(12);
    const anybodys = await server.admin.oauthApplications.destroy(12);

    expect(owner.calls[0]?.path).toBe("/oauth_applications/12");
    expect(server.calls[0]?.path).toBe("/admin/oauth_applications/12");
    // The same column under two names. A shared renderer reading one of them
    // shows `undefined` for half the app, which is the point of asserting it.
    expect(mine.client_id).toBe("abc123");
    expect(anybodys.uid).toBe("abc123");
  });
});

/* -------------------------------------------------------------------------- *
 *  403 is not "log in again"
 * -------------------------------------------------------------------------- */

describe("403 on the administrator half", () => {
  test("arrives as an auth error that does NOT ask for re-authentication", async () => {
    const { admin } = harness("Admin access required", 403);

    const thrown = await admin.jobs.list().then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(OmsAuthError);
    const error = thrown as OmsAuthError;
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
    // The credential is good and the ACT is not. A client that runs its login
    // flow on this loops forever.
    expect(error.authenticationRequired).toBe(false);
    expect(error.message).toBe("Admin access required");
    // Not retryable: replaying it changes nothing.
    expect(error.retryable).toBe(false);
  });

  test("the bare string body survives on the error, not just the message", async () => {
    const { admin } = harness("Admin access required", 403);

    const error = (await admin.chests.stats().catch((thrown: unknown) => thrown)) as OmsApiError;

    expect(error.body).toBe("Admin access required");
  });
});

/* -------------------------------------------------------------------------- *
 *  Registration: two different 429s, and never replayed
 * -------------------------------------------------------------------------- */

describe("myApplications.create", () => {
  test("sends the scopes as an array and does not invent the optional fields", async () => {
    const { admin, calls } = harness({ application: application(), client_secret: null });

    await admin.myApplications.create({ name: "A Minha Appzinha", scopes: ["openid", "profile"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/oauth_applications");
    expect(calls[0]?.body).toEqual({ name: "A Minha Appzinha", scopes: ["openid", "profile"] });
  });

  test("a scope string is split rather than sent as one scope", async () => {
    const { admin, calls } = harness({ application: application(), client_secret: null });

    await admin.myApplications.create({ name: "x", scopes: "openid, profile  tools:read" });

    expect(calls[0]?.body).toEqual({ name: "x", scopes: ["openid", "profile", "tools:read"] });
  });

  test("the rack-attack 429 carries a wait, and the queue 429 does not", async () => {
    const throttled = harness({ error: "rate_limited", retry_after: 37 }, 429, { "retry-after": "37" });
    const queueFull = harness(
      { error: "too_many_pending", message: "Já tens 5 aplicações à espera de revisão." },
      429,
    );

    const first = (await throttled.admin.myApplications
      .create({ name: "x", scopes: ["openid"] })
      .catch((error: unknown) => error)) as OmsQuotaError;
    const second = (await queueFull.admin.myApplications
      .create({ name: "x", scopes: ["openid"] })
      .catch((error: unknown) => error)) as OmsQuotaError;

    expect(first).toBeInstanceOf(OmsQuotaError);
    expect(first.retryAfterMs).toBe(37_000);

    expect(second).toBeInstanceOf(OmsQuotaError);
    // Waiting does not fix this one: a human has to decide, or a pending
    // client has to be deleted. There is nothing to read off the response.
    expect(second.retryAfterMs).toBeUndefined();
    expect((second.body as { error: string }).error).toBe("too_many_pending");
  });

  test("is never replayed, so one lost answer cannot mint two clients", async () => {
    // A client with retrying switched ON, to prove the method turns it off
    // rather than merely inheriting a harness default.
    const calls: Call[] = [];
    const http = new ApiClient({
      baseUrl: BASE_URL,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
      tokens: { getToken: () => "t" },
      fetch: async (input: string, init?: RequestInit): Promise<Response> => {
        calls.push({
          method: (init?.method ?? "GET").toUpperCase(),
          path: new URL(input).pathname,
          search: "",
          body: undefined,
        });
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await new AdminNamespace(http).myApplications
      .create({ name: "x", scopes: ["openid"] })
      .catch(() => undefined);

    expect(calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- *
 *  Owner CRUD
 * -------------------------------------------------------------------------- */

describe("myApplications", () => {
  test("list unwraps the envelope and answers [] for a body with nothing in it", async () => {
    const empty = harness({});
    const full = harness({ applications: [application(), application({ id: 13 })] });

    expect(await empty.admin.myApplications.list()).toEqual([]);
    expect((await full.admin.myApplications.list()).map((app) => app.id)).toEqual([12, 13]);
  });

  test("update sends only the keys it was given, because a key present is a write", async () => {
    const { admin, calls } = harness({ application: application({ approval_status: "pending" }) });

    const updated = await admin.myApplications.update(12, { name: "Outro Nome" });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ name: "Outro Nome" });
    // The server's answer is the authoritative word on whether the edit cost
    // the approval.
    expect(updated.approval_status).toBe("pending");
  });

  test("rotateSecret posts with no body and returns the one-time secret", async () => {
    const { admin, calls } = harness({
      application: application({ confidential: true }),
      client_secret: "s3cr3t-once",
    });

    const rotated = await admin.myApplications.rotateSecret(12);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/oauth_applications/12/rotate_secret");
    expect(rotated.client_secret).toBe("s3cr3t-once");
  });

  test("a 409 on a shipped client keeps its code readable on the body", async () => {
    const { admin } = harness(
      { error: "first_party_immutable", message: "Esta aplicação é um cliente do sistema." },
      409,
    );

    const error = (await admin.myApplications
      .update(1, { name: "x" })
      .catch((thrown: unknown) => thrown)) as OmsApiError;

    expect(error.status).toBe(409);
    expect((error.body as { error: string }).error).toBe("first_party_immutable");
  });
});

/* -------------------------------------------------------------------------- *
 *  Authorized applications
 * -------------------------------------------------------------------------- */

describe("authorizedApplications", () => {
  test("revoke is a DELETE on the application id and reports what it killed", async () => {
    const { admin, calls } = harness({ id: 7, revoked_tokens: 3 });

    const result = await admin.authorizedApplications.revoke(7);

    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/authorized_applications/7" });
    expect(result.revoked_tokens).toBe(3);
  });

  test("revoking access that was already gone is a success, not a 404", async () => {
    const { admin } = harness({ id: 999, revoked_tokens: 0 });

    // The server answers 200 for an id that is not an application at all, on
    // purpose: a 404 would be an existence oracle. So a 200 here proves
    // nothing about the client, only about the intent.
    expect((await admin.authorizedApplications.revoke(999)).revoked_tokens).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 *  Identities
 * -------------------------------------------------------------------------- */

describe("identities", () => {
  test("list pages through the list DSL rather than sending a bare request", async () => {
    const { admin, calls } = harness([
      { id: "id_1", provider: "github", email: null, name: null, avatar_url: null, created_at: "", updated_at: "" },
    ]);

    const page = await admin.identities.list({ pageSize: 25 });

    expect(calls[0]?.search).toContain("modifiers[page]=1:25");
    expect(calls[0]?.search).toContain("modifiers[order]=created_at:desc");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.provider).toBe("github");
  });

  test("destroy is a 204 and resolves to nothing", async () => {
    const { admin, calls } = harness(null, 204);

    expect(await admin.identities.destroy("id_1")).toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/identities/id_1" });
  });
});

/* -------------------------------------------------------------------------- *
 *  Administrator: OAuth review
 * -------------------------------------------------------------------------- */

describe("oauthApplications review", () => {
  test("pending fills in a missing count instead of returning undefined", async () => {
    const empty = harness({});
    const queue = harness({ applications: [application({ approval_status: "pending" })], count: 1 });

    expect(await empty.admin.oauthApplications.pending()).toEqual({ applications: [], count: 0 });
    expect((await queue.admin.oauthApplications.pending()).count).toBe(1);
  });

  test("get accepts a client_id as well as a numeric id", async () => {
    const { admin, calls } = harness({ application: application({ client_id: "oms-cli" }) });

    await admin.oauthApplications.get("oms-cli");

    expect(calls[0]?.path).toBe("/admin/oauth_applications/oms-cli");
  });

  test("reject requires the reason on the body and passes the opt-in flag through", async () => {
    const { admin, calls } = harness({
      application: application({ approval_status: "rejected" }),
      revoked_tokens: 2,
    });

    const result = await admin.oauthApplications.reject(12, {
      reason: "Nome enganador.",
      revoke_tokens: true,
    });

    expect(calls[0]?.body).toEqual({ reason: "Nome enganador.", revoke_tokens: true });
    expect(result.revoked_tokens).toBe(2);
  });

  test("reject omits revoke_tokens entirely when it was not asked for", async () => {
    const { admin, calls } = harness({ application: application(), revoked_tokens: 0 });

    await admin.oauthApplications.reject(12, { reason: "Sem motivo suficiente." });

    expect(calls[0]?.body).toEqual({ reason: "Sem motivo suficiente." });
  });

  test("a stale review comes back as a 409 carrying the row it turned into", async () => {
    const current = application({ name: "omelhorsite Oficial" });
    const { admin } = harness(
      { error: "review_stale", message: "Esta aplicação mudou.", application: current },
      409,
    );

    const error = (await admin.oauthApplications
      .approve(12)
      .catch((thrown: unknown) => thrown)) as OmsApiError;

    expect(error.status).toBe(409);
    const body = error.body as { error: string; application: OauthApplicationSummary };
    expect(body.error).toBe("review_stale");
    // Retrying the same call gets the same 409. The body is there so the
    // screen can show what changed instead of sending someone to look.
    expect(body.application.name).toBe("omelhorsite Oficial");
  });

  test("register posts to the admin route and is not replayed", async () => {
    const { admin, calls } = harness({
      application: { ...application({ owner: null }), live_token_count: 0 },
      client_secret: null,
    });

    await admin.oauthApplications.register({ name: "Operador", scopes: ["openid"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/admin/oauth_applications" });
  });
});

/* -------------------------------------------------------------------------- *
 *  Administrator: quotas
 * -------------------------------------------------------------------------- */

describe("quotas", () => {
  test("get accepts a handle in the same slot as a user id", async () => {
    const { admin, calls } = harness({ user_id: "u_1", handle: "afonso", quotas: [] });

    await admin.quotas.get("afonso");

    expect(calls[0]?.path).toBe("/admin/users/afonso/quotas");
  });

  test("update is a PUT and drops the value key for the modes that ignore it", async () => {
    const { admin, calls } = harness({ user_id: "u_1", handle: "afonso", quotas: [] });

    await admin.quotas.update("u_1", [
      { resource: "storage_nodes", mode: "unlimited" },
      { resource: "caption_seconds", mode: "limit", value: 7200 },
      { resource: "jumpstyle_edits", mode: "default" },
    ]);

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toEqual({
      overrides: [
        { resource: "storage_nodes", mode: "unlimited" },
        { resource: "caption_seconds", mode: "limit", value: 7200 },
        { resource: "jumpstyle_edits", mode: "default" },
      ],
    });
  });

  test("a rejected batch is one request, so the caller knows the write was partial", async () => {
    const { admin, calls } = harness("Unknown resource: nope", 400);

    await admin.quotas
      .update("u_1", [
        { resource: "storage_nodes", mode: "unlimited" },
        { resource: "nope", mode: "default" },
      ])
      .catch(() => undefined);

    // The server has no transaction around the loop: the first override is
    // already written when the second one 400s. Retrying would write it twice.
    expect(calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- *
 *  Administrator: jobs, short links, separations
 * -------------------------------------------------------------------------- */

describe("jobs", () => {
  test("filters land inside exact_search, never at the top level", async () => {
    const { admin, calls } = harness([]);

    await admin.jobs.list({ status: ["pending", "processing"], jobType: "song_import" });

    const search = calls[0]?.search ?? "";
    expect(search).toContain("exact_search[status][]=pending");
    expect(search).toContain("exact_search[status][]=processing");
    expect(search).toContain("exact_search[job_type]=song_import");
    // A top-level `status=` is read by nothing and would come back unfiltered
    // with no error at all, which is the failure this asserts against.
    expect(search).not.toContain("&status=");
    expect(search.startsWith("?status=")).toBe(false);
  });

  test("no filters means no empty exact_search bucket", async () => {
    const { admin, calls } = harness([]);

    await admin.jobs.list();

    expect(calls[0]?.search).not.toContain("exact_search");
    expect(calls[0]?.search).toContain("modifiers[page]=1:100");
  });

  test("cancel on a terminal job is a 400 the caller has to expect", async () => {
    const { admin } = harness("Already terminal", 400);

    const error = (await admin.jobs.cancel("j_1").catch((thrown: unknown) => thrown)) as OmsApiError;

    expect(error.status).toBe(400);
    expect(error.message).toBe("Already terminal");
  });

  test("cleanupStuck is a single unretried sweep", async () => {
    const { admin, calls } = harness({ canceled_job_ids: ["j_1", "j_2"], count: 2 });

    const result = await admin.jobs.cleanupStuck();

    expect(calls).toEqual([
      { method: "POST", path: "/admin/jobs/cleanup_stuck", search: "", body: undefined },
    ]);
    expect(result.count).toBe(2);
  });
});

describe("shortLinks", () => {
  test("search goes out as a flat parameter, not as the search bucket", async () => {
    const { admin, calls } = harness({ items: [], total: 0, limit: 100 });

    await admin.shortLinks.list({ owner: "anon", search: "talk" });

    const search = calls[0]?.search ?? "";
    expect(search).toContain("owner=anon");
    expect(search).toContain("search=talk");
    // This controller reads params[:search] as a string. A bucket would be a
    // hash and would match nothing.
    expect(search).not.toContain("search[");
  });

  test("no filters means no query string at all", async () => {
    const { admin, calls } = harness({ items: [], total: 0, limit: 100 });

    await admin.shortLinks.list();

    expect(calls[0]?.search).toBe("");
  });

  test("the hard cap is reported even when the body forgets it", async () => {
    const { admin } = harness({ items: [], total: 4210 });

    const page = await admin.shortLinks.list();

    // total far above limit is normal and there is NO way to reach the rest.
    expect(page.limit).toBe(100);
    expect(page.total).toBe(4210);
  });

  test("namespaces unwraps its envelope", async () => {
    const { admin } = harness({ namespaces: [{ namespace: null, count: 40 }, { namespace: "n", count: 9 }] });

    const rows = await admin.shortLinks.namespaces();

    expect(rows.map((row) => row.namespace)).toEqual([null, "n"]);
  });
});

describe("vocalSeparations", () => {
  test("source rides at the top level while status goes in the bucket", async () => {
    const { admin, calls } = harness([]);

    await admin.vocalSeparations.list({ status: "processing", source: "song" });

    const search = calls[0]?.search ?? "";
    expect(search).toContain("exact_search[status]=processing");
    expect(search).toContain("source=song");
    expect(search).not.toContain("exact_search[source]");
  });

  test("cancel lands on the failed status, because there is no cancelled one", async () => {
    const { admin, calls } = harness({
      id: "vs_1",
      status: "failed",
      error: "Canceled by admin",
    });

    const run = await admin.vocalSeparations.cancel("vs_1");

    expect(calls[0]?.path).toBe("/admin/vocal_separations/vs_1/cancel");
    expect(run.status).toBe("failed");
    // The message is the ONLY way to tell an administrative stop from a real
    // failure, which anything counting failures needs to know.
    expect(run.error).toBe("Canceled by admin");
  });
});

/* -------------------------------------------------------------------------- *
 *  Statistics and the alert catalogue
 * -------------------------------------------------------------------------- */

describe("stats and event alerts", () => {
  test("chests and notepads each have exactly one route", async () => {
    const { admin, calls } = harness({});

    await admin.chests.stats();
    await admin.notepads.stats();

    expect(calls.map((call) => call.path)).toEqual([
      "/admin/chests/stats",
      "/admin/notepads/stats",
    ]);
  });

  test("the alert catalogue separates 'not configured' from 'configured and off'", async () => {
    const off = harness({ delivering: false, webhook_configured: true, events: [] });
    const missing = harness({});

    expect(await off.admin.eventAlerts.list()).toEqual({
      delivering: false,
      webhook_configured: true,
      events: [],
    });
    expect((await missing.admin.eventAlerts.list()).webhook_configured).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 *  The pure helpers
 * -------------------------------------------------------------------------- */

describe("redirect URI helpers", () => {
  test("splitting is the inverse of what the server stored", () => {
    expect(splitRedirectUris(NATIVE_LOOPBACK_REDIRECT_VALUE)).toEqual([
      "http://127.0.0.1/callback",
      "http://[::1]/callback",
    ]);
    expect(splitRedirectUris(null)).toEqual([]);
    expect(splitRedirectUris("")).toEqual([]);
  });

  test("normalising de-duplicates and does NOTHING else", () => {
    expect(normalizeRedirectUris("  https://a.example/cb\n https://a.example/cb  ")).toBe(
      "https://a.example/cb",
    );
    // No trailing slash added or removed, no case folded, no scheme upgraded:
    // matching is exact, and a helpfully "fixed" URI matches nothing.
    expect(normalizeRedirectUris("https://A.example/CB/")).toBe("https://A.example/CB/");
  });

  test("a blank field registers the loopback pair, so blank and loopback compare equal", () => {
    expect(registeredRedirectUris("")).toBe(NATIVE_LOOPBACK_REDIRECT_VALUE);
    expect(registeredRedirectUris("   ")).toBe(NATIVE_LOOPBACK_REDIRECT_VALUE);
    expect(registeredRedirectUris(NATIVE_LOOPBACK_REDIRECT_VALUE)).toBe(
      NATIVE_LOOPBACK_REDIRECT_VALUE,
    );
  });
});

describe("editWouldRequeue", () => {
  const approved = application({ scopes: ["openid", "profile"] });
  const asIs = {
    name: approved.name,
    scopes: approved.scopes,
    redirectUris: approved.redirect_uri,
  };

  test("a client that is not approved has no approval to lose", () => {
    for (const status of ["pending", "rejected"] as const) {
      expect(
        editWouldRequeue(application({ approval_status: status }), {
          name: "Completely Different",
          scopes: ["openid", "storage:write"],
          redirectUris: "https://evil.example/cb",
        }),
      ).toBe(false);
    }
  });

  test("an edit that changes nothing changes nothing", () => {
    expect(editWouldRequeue(approved, asIs)).toBe(false);
  });

  test("renaming requeues, and so does widening the scopes", () => {
    expect(editWouldRequeue(approved, { ...asIs, name: "omelhorsite Oficial" })).toBe(true);
    expect(
      editWouldRequeue(approved, { ...asIs, scopes: ["openid", "profile", "storage:write"] }),
    ).toBe(true);
  });

  test("narrowing the scopes does not: there is nothing new to review", () => {
    expect(editWouldRequeue(approved, { ...asIs, scopes: ["openid"] })).toBe(false);
  });

  test("any move of the redirect URI requeues, in either direction", () => {
    expect(editWouldRequeue(approved, { ...asIs, redirectUris: "https://app.example/cb" })).toBe(
      true,
    );
    const remote = application({ redirect_uri: "https://app.example/cb" });
    expect(
      editWouldRequeue(remote, {
        name: remote.name,
        scopes: remote.scopes,
        redirectUris: "",
      }),
    ).toBe(true);
  });

  test("an empty field and the loopback pair are the same registration", () => {
    expect(editWouldRequeue(approved, { ...asIs, redirectUris: "" })).toBe(false);
  });
});

describe("isShippedClient", () => {
  test("reads the pinned client_id list, never a null owner", () => {
    for (const uid of SHIPPED_CLIENT_IDS) {
      expect(isShippedClient({ client_id: uid })).toBe(true);
    }
    // A NULL owner also means "orphaned when its owner deleted their account",
    // so an orphan must not be dressed up as official.
    expect(isShippedClient(application({ client_id: "abc123", owner: null }))).toBe(false);
  });
});

describe("mirrored server constants", () => {
  test("the pending ceiling matches the server's", () => {
    expect(OAUTH_APP_MAX_PENDING).toBe(5);
  });
});
