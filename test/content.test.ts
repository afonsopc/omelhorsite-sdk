/**
 * `bun test` coverage for the `content` namespace.
 *
 * This namespace is a bag of ten small domains, so the tests are not "one per
 * method". They pin the handful of behaviours that are easy to get wrong and
 * expensive to notice:
 *
 * - the two ENVELOPED responses (`GET /blogs`, `GET /blog_posts`) really are
 *   unwrapped, because a caller that gets `{posts: [...]}` back instead of an
 *   array fails at the render, far from the cause;
 * - `setPublished` sends `publish` ALONE. The controller returns early on that
 *   key and throws away every other field in the body, so a future
 *   "convenience" merge of update+publish would silently lose edits;
 * - the SDK does not grow a `markRead(id)`. `PATCH /notifications/:id` is
 *   routed and always 401s, and the temptation to wrap it is exactly what this
 *   assertion exists to block;
 * - Space Invaders scores arrive as STRINGS. The test decodes a realistic
 *   payload and asserts the types, so nobody "fixes" the interface to
 *   `number` without a server change;
 * - the intel proxy builds paths without inventing a schema, and forwards the
 *   query string.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { OmsApiError, OmsQuotaError } from "../src/errors";
import { collect } from "../src/types";
import {
  ContentNamespace,
  FEEDBACK_STATUSES,
  SERVICE_USAGE_IDS,
  type Blog,
  type BlogPostSummary,
  type Feedback,
  type Joke,
  type Notification,
  type SpaceInvadersGame,
  type UptimeReport,
} from "../src/resources/content";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

interface Reply {
  readonly body?: unknown;
  readonly status?: number;
  readonly contentType?: string;
  /** Raw text instead of JSON, for the "the sidecar sent HTML" case. */
  readonly text?: string;
}

interface Harness {
  readonly content: ContentNamespace;
  readonly calls: Call[];
}

/** Mounts a fake fetch that answers each request from a queue of replies. */
function harness(replies: Reply | Reply[]): Harness {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: Call[] = [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.search,
      body,
    });

    const reply = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] ?? {});
    const status = reply.status ?? 200;
    if (status === 204) return new Response(null, { status: 204 });
    if (reply.text !== undefined) {
      return new Response(reply.text, {
        status,
        headers: { "content-type": reply.contentType ?? "text/html; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify(reply.body ?? null), {
      status,
      headers: { "content-type": reply.contentType ?? "application/json; charset=utf-8" },
    });
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
    // One attempt: a retry would double the recorded calls and hide which
    // request the assertion is actually about.
    retry: { maxAttempts: 1 },
  });
  return { content: new ContentNamespace(http), calls };
}

function postSummary(overrides: Partial<BlogPostSummary> = {}): BlogPostSummary {
  return {
    id: 12,
    slug: "primeiro-post",
    title: "Primeiro post",
    excerpt: "Um resumo.",
    published_at: "2026-08-01T10:00:00Z",
    reading_minutes: 3,
    tags: ["oms"],
    blog: { id: 4, slug: "afonso", name: "Blog do Afonso" },
    ...overrides,
  };
}

function blog(overrides: Partial<Blog> = {}): Blog {
  return {
    id: 4,
    slug: "afonso",
    name: "Blog do Afonso",
    description: null,
    user: { id: "usr_1", handle: "afonso_coutinho", name: "Afonso" },
    followers_count: 2,
    published_posts_count: 1,
    created_at: "2026-01-01T00:00:00Z",
    is_following: false,
    ...overrides,
  };
}

describe("blogs", () => {
  test("discover unwraps the { posts } envelope", async () => {
    const { content, calls } = harness({ body: { posts: [postSummary(), postSummary({ id: 13 })] } });

    const posts = await content.blogs.discover();

    expect(Array.isArray(posts)).toBe(true);
    expect(posts.map((p) => p.id)).toEqual([12, 13]);
    expect(calls[0]?.path).toBe("/blogs");
    // A front page, not a listing: the SDK must not invent page modifiers the
    // action would ignore anyway.
    expect(calls[0]?.search).toBe("");
  });

  test("show addresses the blog by slug and returns its posts", async () => {
    const { content, calls } = harness({ body: { ...blog(), posts: [postSummary()] } });

    const found = await content.blogs.show("Afonso");

    expect(found.slug).toBe("afonso");
    expect(found.posts).toHaveLength(1);
    expect(calls[0]?.path).toBe("/blogs/Afonso");
  });

  test("updateMine patches /blogs/mine and gets a blog with no posts key", async () => {
    const { content, calls } = harness({ body: blog({ name: "Novo nome" }) });

    const updated = await content.blogs.updateMine({ name: "Novo nome" });

    expect(updated.name).toBe("Novo nome");
    expect("posts" in updated).toBe(false);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/blogs/mine");
    expect(calls[0]?.body).toEqual({ name: "Novo nome" });
  });

  test("subscribe sends an empty body when signed in and the email when not", async () => {
    const { content, calls } = harness({ body: { ok: true, confirmed: true } });

    await content.blogs.subscribe("afonso");
    await content.blogs.subscribe("afonso", { email: "alguem@exemplo.pt" });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/blogs/afonso/subscribe");
    expect(calls[0]?.body).toEqual({});
    expect(calls[1]?.body).toEqual({ email: "alguem@exemplo.pt" });
  });

  test("unsubscribe deletes the same path", async () => {
    const { content, calls } = harness({ body: { ok: true } });

    const result = await content.blogs.unsubscribe(4);

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/blogs/4/subscribe");
  });
});

describe("blog posts", () => {
  test("list unwraps the envelope and forwards blog_slug", async () => {
    const { content, calls } = harness({ body: { posts: [postSummary()] } });

    const posts = await content.blogs.posts.list({ blogSlug: "afonso" });

    expect(posts).toHaveLength(1);
    expect(calls[0]?.path).toBe("/blog_posts");
    expect(calls[0]?.search).toBe("?blog_slug=afonso");
  });

  test("getBySlugs builds the permalink path", async () => {
    const { content, calls } = harness({
      body: { ...postSummary(), content_md: "# olá", created_at: "x", updated_at: "x", is_owner: true },
    });

    await content.blogs.posts.getBySlugs("afonso", "primeiro-post");

    expect(calls[0]?.path).toBe("/blogs/afonso/posts/primeiro-post");
  });

  test("setPublished sends publish ALONE", async () => {
    // The controller returns early on `publish`, discarding every other field
    // in the same body. If this method ever learns to merge content into the
    // same request, the content is silently lost - so pin the body exactly.
    const { content, calls } = harness({
      body: { ...postSummary(), content_md: null, created_at: "x", updated_at: "x", is_owner: true },
    });

    await content.blogs.posts.setPublished(12, true);

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/blog_posts/12");
    expect(calls[0]?.body).toEqual({ publish: true });
  });

  test("update passes the caller's fields through untouched, tags included", async () => {
    const { content, calls } = harness({
      body: { ...postSummary(), content_md: "novo", created_at: "x", updated_at: "x", is_owner: true },
    });

    await content.blogs.posts.update(12, { title: "Outro", tags: ["oms", "sdk"] });

    expect(calls[0]?.body).toEqual({ title: "Outro", tags: ["oms", "sdk"] });
  });

  test("destroy tolerates the 204 with no body", async () => {
    const { content, calls } = harness({ status: 204 });

    await expect(content.blogs.posts.destroy(12)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
  });
});

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 901,
    kind: "friendship_request",
    context: { handle: "biraj" },
    read: false,
    user_id: "usr_1",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
    ...overrides,
  };
}

describe("notifications", () => {
  test("list sends the page modifier and pages through", async () => {
    const first = Array.from({ length: 2 }, (_, i) => notification({ id: 900 + i }));
    const { content, calls } = harness([{ body: first }, { body: [notification({ id: 910 })] }]);

    const page = await content.notifications.list({ pageSize: 2, order: "created_at:desc" });

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(calls[0]?.search).toContain("modifiers%5Bpage%5D=1%3A2");
    expect(calls[0]?.search).toContain("modifiers%5Border%5D=created_at%3Adesc");

    const all = await collect(page);
    expect(all).toHaveLength(3);
    expect(calls[1]?.search).toContain("modifiers%5Bpage%5D=2%3A2");
  });

  test("unreadCount and markAllRead unwrap the { count } bodies", async () => {
    const { content, calls } = harness([{ body: { count: 7 } }, { body: { count: 7 } }]);

    expect(await content.notifications.unreadCount()).toBe(7);
    expect(await content.notifications.markAllRead()).toBe(7);

    expect(calls[0]?.path).toBe("/notifications/unread_count");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.path).toBe("/notifications/read_all");
  });

  test("there is no markRead: PATCH /notifications/:id can never succeed", async () => {
    // `Notification` never overrides `updatable_by?`, so Authorizable's
    // default `false` stands and the route 401s for everybody, owner
    // included. Wrapping it would be shipping a method that cannot work.
    const { content } = harness({ body: null });
    const surface = content.notifications as unknown as Record<string, unknown>;

    expect(surface.markRead).toBeUndefined();
    expect(surface.update).toBeUndefined();
    expect(typeof content.notifications.dismiss).toBe("function");
  });

  test("dismiss deletes by id", async () => {
    const { content, calls } = harness({ status: 204 });

    await content.notifications.dismiss(901);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/notifications/901");
  });
});

function feedback(overrides: Partial<Feedback> = {}): Feedback {
  return {
    id: "fb_abc",
    content: "O botão não faz nada.",
    status: "new",
    context: { path: "/tools" },
    user_id: null,
    email: "alguem@exemplo.pt",
    country: null,
    device_name: null,
    user: null,
    attachments: [],
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
    ...overrides,
  };
}

describe("feedbacks", () => {
  test("create unwraps the id and forwards the captcha token", async () => {
    const { content, calls } = harness({ body: { id: "fb_abc" }, status: 201 });

    const id = await content.feedbacks.create({
      content: "O botão não faz nada.",
      email: "alguem@exemplo.pt",
      cf_turnstile_token: "cf-token",
    });

    expect(id).toBe("fb_abc");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ cf_turnstile_token: "cf-token" });
  });

  test("the per-IP hourly cap surfaces as an OmsQuotaError", async () => {
    const { content } = harness({ body: { error: "rate_limited" }, status: 429 });

    const thrown = await content.feedbacks.create({ content: "spam" }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(OmsQuotaError);
    expect((thrown as OmsQuotaError).status).toBe(429);
  });

  test("an admin listing pages, and setStatus sends only the status", async () => {
    const { content, calls } = harness([{ body: [feedback()] }, { body: feedback({ status: "read" }) }]);

    const page = await content.feedbacks.list({ exactSearch: { status: "new" }, pageSize: 1 });
    expect(page.items[0]?.id).toBe("fb_abc");
    expect(calls[0]?.search).toContain("exact_search%5Bstatus%5D=new");

    const updated = await content.feedbacks.setStatus("fb_abc", "read");
    expect(updated.status).toBe("read");
    expect(calls[1]?.body).toEqual({ status: "read" });
    expect(FEEDBACK_STATUSES).toContain(updated.status);
  });

  test("attachmentUrl is a plain absolute URL and costs no request", () => {
    const { content, calls } = harness({ body: null });

    expect(content.feedbacks.attachmentUrl("fb_abc", 55)).toBe(`${BASE_URL}/feedbacks/fb_abc/attachment/55`);
    expect(calls).toHaveLength(0);
  });
});

describe("jokes and config", () => {
  const joke: Joke = {
    id: 1,
    lang: "pt",
    content: "Está um gajo...",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  test("random: true reaches the wire as a modifier", async () => {
    const { content, calls } = harness({ body: [joke] });

    const page = await content.jokes.list({ random: true, pageSize: 1 });

    expect(page.items[0]?.lang).toBe("pt");
    expect(calls[0]?.search).toContain("modifiers%5Brandom%5D=true");
    expect(calls[0]?.search).toContain("modifiers%5Bpage%5D=1%3A1");
  });

  test("a page size above the server ceiling is clamped before the request", async () => {
    const { content, calls } = harness({ body: [] });

    const page = await content.jokes.list({ pageSize: 5_000 });

    // The server clamps to 500 in silence; reporting the requested size would
    // make a full page look short and drop the rest of the table.
    expect(page.pageSize).toBe(500);
    expect(calls[0]?.search).toContain("modifiers%5Bpage%5D=1%3A500");
  });

  test("an unknown search key fails closed with a 400 from the server", async () => {
    const { content } = harness({ body: "Unknown search filter: lang", status: 400 });

    const thrown = await content.jokes.list({ search: { lang: "pt" } }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(OmsApiError);
    expect((thrown as OmsApiError).status).toBe(400);
  });

  test("config carries a null site key when Turnstile is unconfigured", async () => {
    const { content, calls } = harness({ body: { turnstile_site_key: null } });

    const config = await content.config.get();

    expect(config.turnstile_site_key).toBeNull();
    expect(calls[0]?.path).toBe("/config");
  });
});

describe("services status", () => {
  test("current returns a map whose status is a STRING, not an HTTP code", async () => {
    const { content, calls } = harness({
      body: {
        vocal_separator: { ok: true, status: "OK" },
        ai: { ok: false, status: "Errno::ECONNREFUSED" },
        yt_dlp: { ok: false, status: "HTTP503" },
      },
    });

    const map = await content.status.current();

    expect(calls[0]?.path).toBe("/services_status");
    expect(typeof map.ai?.status).toBe("string");
    expect(map.ai?.ok).toBe(false);
    // The web frontend types this as `number` and adds an `error` key. Neither
    // is what the controller sends.
    expect(map.yt_dlp?.status).toBe("HTTP503");
  });

  test("uptime keeps a null percentage as null rather than zero", async () => {
    const report: UptimeReport = {
      from: "2026-06-01",
      to: "2026-08-29",
      services: [
        { slug: "ai", days: [{ date: "2026-08-29", status: "up", up: 900, down: 0 }], uptime_pct: 99.93 },
        { slug: "jokes", days: [{ date: "2026-08-29", status: "unknown", up: 0, down: 0 }], uptime_pct: null },
      ],
      incidents: [],
    };
    const { content, calls } = harness({ body: report });

    const got = await content.status.uptime();

    expect(calls[0]?.path).toBe("/services_status/uptime");
    expect(got.services[1]?.uptime_pct).toBeNull();
    expect(got.services[1]?.uptime_pct ?? "no data").toBe("no data");
  });
});

describe("service usages and analysis", () => {
  test("record posts the service_id and answers 200, not 201", async () => {
    const { content, calls } = harness({ body: { service_id: "music", count: 12 }, status: 200 });

    const usage = await content.serviceUsages.record("music");

    expect(usage.count).toBe(12);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ service_id: "music" });
    expect(SERVICE_USAGE_IDS).toContain(usage.service_id);
  });

  test("top forwards the limit and omits it when unset", async () => {
    const { content, calls } = harness({ body: [{ service_id: "music", count: 12 }] });

    await content.serviceUsages.top();
    await content.serviceUsages.top({ limit: 10 });

    expect(calls[0]?.search).toBe("");
    expect(calls[1]?.search).toBe("?limit=10");
  });

  test("filesDaily unwraps creations_daily", async () => {
    const { content, calls } = harness({
      body: { creations_daily: [{ date: "2026-08-28", count: 4 }, { date: "2026-08-29", count: 0 }] },
    });

    const series = await content.analysis.filesDaily();

    expect(series).toHaveLength(2);
    expect(series[1]?.count).toBe(0);
    expect(calls[0]?.path).toBe("/analysis/files_daily");
  });
});

describe("space invaders", () => {
  const game: SpaceInvadersGame = {
    id: 77,
    user_id: "usr_1",
    money: "1200.0",
    time: "310.5",
    kills: 128,
    played_at: "2026-08-29T09:00:00Z",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
  };

  test("money and time arrive as strings, kills as a number", async () => {
    const { content } = harness({ body: [game] });

    const board = await content.spaceInvaders.leaderboard();
    const top = board[0]!;

    // Decimal columns are encoded as JSON strings by Rails so no precision is
    // lost. Sorting these without Number() puts "9.0" above "10.0".
    expect(typeof top.money).toBe("string");
    expect(typeof top.time).toBe("string");
    expect(typeof top.kills).toBe("number");
    expect(Number(top.money)).toBe(1200);
  });

  test("submit sends the three fields and never played_at", async () => {
    const { content, calls } = harness({ body: game, status: 201 });

    await content.spaceInvaders.submit({ money: 1200, time: 310.5, kills: 128 });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/space_invaders_games");
    expect(calls[0]?.body).toEqual({ money: 1200, time: 310.5, kills: 128 });
  });

  test("an implausible score is a 400 from the model, not a client-side throw", async () => {
    const { content } = harness({ body: "Kills are impossibly high for a 10s game", status: 400 });

    const thrown = await content.spaceInvaders
      .submit({ money: 0, time: 10, kills: 5_000 })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(OmsApiError);
    expect((thrown as OmsApiError).status).toBe(400);
  });
});

describe("intel proxy", () => {
  test("builds the path, keeps the separators, and forwards the query", async () => {
    const { content, calls } = harness({ body: { anything: true } });

    const answer = await content.intel.get("api/articles/abc def", { min_importance: 3 });

    expect(answer).toEqual({ anything: true });
    expect(calls[0]?.path).toBe("/intel/api/articles/abc%20def");
    expect(calls[0]?.search).toBe("?min_importance=3");
  });

  test("a leading slash is stripped so the glob route still matches", async () => {
    const { content, calls } = harness({ body: {} });

    await content.intel.get("/api/stats");

    expect(calls[0]?.path).toBe("/intel/api/stats");
  });

  test("a non-JSON upstream body comes back as text rather than throwing", async () => {
    const { content } = harness({ text: "<html>nope</html>" });

    const answer = await content.intel.get<string>("api/whatever");

    expect(answer).toBe("<html>nope</html>");
  });

  test("the upstream status is forwarded, body and all", async () => {
    const { content } = harness({ body: { detail: "not found upstream" }, status: 404 });

    const thrown = await content.intel.get("api/missing").catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(OmsApiError);
    expect((thrown as OmsApiError).status).toBe(404);
    // Not this API's usual bare JSON string: whatever the sidecar sent.
    expect((thrown as OmsApiError).body).toEqual({ detail: "not found upstream" });
  });

  test("url() is a pure string builder", () => {
    const { content, calls } = harness({ body: null });

    expect(content.intel.url("img/cover.png")).toBe(`${BASE_URL}/intel/img/cover.png`);
    expect(calls).toHaveLength(0);
  });
});
