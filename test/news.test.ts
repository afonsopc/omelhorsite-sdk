/**
 * `bun test` coverage for `oms.content.news`: feeds, sources, scripts and
 * items. The paths, the camelCase-to-wire renames and the listing defaults.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsAuthError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  NEWS_SOURCE_DISABLE_AFTER_FAILURES,
  NEWS_SOURCE_HEALTHS,
  NewsNamespace,
  type NewsItem,
  type NewsScript,
  type NewsSource,
} from "../src/resources/content";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly body: unknown;
  readonly raw: string | undefined;
}

interface Harness {
  readonly news: NewsNamespace;
  readonly calls: Call[];
}

function harness(bodies: unknown[], status = 200, retries = false): Harness {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.searchParams,
      body: raw === undefined ? undefined : JSON.parse(raw),
      raw,
    });
    const body = bodies[Math.min(index++, bodies.length - 1)];
    if (status === 204 || body === undefined) return new Response(null, { status });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "session-token" },
    ...(retries ? { retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false } } : { retry: { maxAttempts: 1 } }),
  });
  return { news: new NewsNamespace(http), calls };
}

function source(overrides: Partial<NewsSource> = {}): NewsSource {
  return {
    id: "src_1",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-29T00:00:00Z",
    name: "Publico RSS",
    config: { url: "https://publico.pt/rss" },
    news_feed_id: "feed_1",
    news_script_id: "scr_rss",
    cron_job_id: null,
    cron_schedule_id: null,
    cron: null,
    runtime: null,
    poll_interval_minutes: 15,
    enabled: true,
    cursor: "2026-08-29T00:00:00Z",
    health: "ok",
    last_error: null,
    last_run_at: "2026-08-29T00:00:00Z",
    last_success_at: "2026-08-29T00:00:00Z",
    consecutive_failures: 0,
    ...overrides,
  };
}

describe("news.feeds", () => {
  test("lists oldest first, creates with wire names and reads counters", async () => {
    const feed = { id: "feed_1", created_at: "x", updated_at: "x", name: "Principal", description: null, retention_days: 90, enabled: true };
    const { news, calls } = harness([[feed], feed, { ...feed, sources_count: 2, items_count: 40 }]);
    await news.feeds.list();
    await news.feeds.create({ name: "Tecnologia", retentionDays: 30 });
    const detail = await news.feeds.get("feed_1");
    expect(calls[0]?.path).toBe("/news_feeds");
    expect(calls[0]?.search.get("modifiers[order]")).toBe("created_at:asc");
    expect(calls[1]?.body).toEqual({ name: "Tecnologia", retention_days: 30 });
    expect(detail.items_count).toBe(40);
  });
});

describe("news.items filters", () => {
  test("query, since and until travel at the top level, the feed as exact_search", async () => {
    const { news, calls } = harness([[]]);
    await news.items.list({ feedId: "feed_1", query: "mesquita lisboa", since: "2026-09-01T00:00:00Z", order: "created_at:asc" });
    const search = calls[0]?.search;
    expect(search?.get("exact_search[news_feed_id]")).toBe("feed_1");
    expect(search?.get("query")).toBe("mesquita lisboa");
    expect(search?.get("since")).toBe("2026-09-01T00:00:00Z");
    expect(search?.has("until")).toBe(false);
    expect(search?.get("modifiers[order]")).toBe("created_at:asc");
  });
});

describe("the vocabulary constants match the server's", () => {
  test("healths and the auto-disable threshold", () => {
    expect([...NEWS_SOURCE_HEALTHS]).toEqual(["unknown", "ok", "error"]);
    expect(NEWS_SOURCE_DISABLE_AFTER_FAILURES).toBe(20);
  });
});

describe("news.sources.list", () => {
  test("sends a deterministic order because the controller sets none", async () => {
    const { news, calls } = harness([[source()]]);

    await news.sources.list();

    expect(calls[0]?.path).toBe("/news_sources");
    // Without this, page 2 can repeat or skip rows from page 1.
    expect(calls[0]?.search.get("modifiers[order]")).toBe("created_at:desc");
  });

  test("health, enabled and scriptId become exact_search keys", async () => {
    const { news, calls } = harness([[]]);

    await news.sources.list({ health: "error", enabled: false, scriptId: "scr_rss" });

    const search = calls[0]?.search;
    expect(search?.get("exact_search[health]")).toBe("error");
    expect(search?.get("exact_search[enabled]")).toBe("false");
    expect(search?.get("exact_search[news_script_id]")).toBe("scr_rss");
  });

  test("a caller-supplied order wins over the SDK default", async () => {
    const { news, calls } = harness([[]]);
    await news.sources.list({ order: "name:asc" });
    expect(calls[0]?.search.get("modifiers[order]")).toBe("name:asc");
  });
});

describe("news.sources writes", () => {
  test("create() renames every camelCase key onto the wire", async () => {
    const { news, calls } = harness([source()]);

    await news.sources.create({
      name: "Publico RSS",
      scriptId: "scr_rss",
      config: { url: "https://publico.pt/rss" },
      pollIntervalMinutes: 30,
      enabled: false,
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      name: "Publico RSS",
      news_script_id: "scr_rss",
      config: { url: "https://publico.pt/rss" },
      poll_interval_minutes: 30,
      enabled: false,
    });
  });

  test("create() omits absent optionals so server defaults apply", async () => {
    const { news, calls } = harness([source()]);

    await news.sources.create({ name: "Feed", scriptId: "scr_rss" });

    // `enabled: undefined` on the wire would be dropped by JSON anyway, but a
    // literal `null` would NOT: Rails would try to write NULL into a NOT NULL
    // column and answer 400.
    expect(calls[0]?.body).toEqual({ name: "Feed", news_script_id: "scr_rss" });
  });

  test("update() sends cursor: null as a JSON null, not the \\b sentinel", async () => {
    const { news, calls } = harness([source({ cursor: null })]);

    await news.sources.update("src_1", { cursor: null });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/news_sources/src_1");
    expect(calls[0]?.body).toEqual({ cursor: null });
    // The sentinel is a QUERY-STRING convention. In a body it would be stored
    // verbatim as a one-character cursor and the next poll would resume from
    // a backspace.
    expect(calls[0]?.raw).not.toContain("\b");
  });

  test("update() sends only the keys given", async () => {
    const { news, calls } = harness([source({ enabled: true })]);

    await news.sources.update("src_1", { enabled: true });

    expect(calls[0]?.body).toEqual({ enabled: true });
  });

  test("run() posts, does not retry, and answers the queued stub", async () => {
    const { news, calls } = harness([{ queued: true }], 202);

    const answer = await news.sources.run("src_1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/news_sources/src_1/run");
    expect(answer.queued).toBe(true);
  });

  test("run() does not replay a 500: a second fetch job is not free", async () => {
    // The client here WOULD retry three times. `run()` passes `retry: false`,
    // and that is the only thing standing between one user gesture and three
    // FetchSourceJobs on an unthrottled queue.
    const { news, calls } = harness(['"boom"'], 500, true);

    await expect(news.sources.run("src_1")).rejects.toBeInstanceOf(OmsApiError);
    expect(calls).toHaveLength(1);
  });

  test("create() does not replay a 500 either", async () => {
    const { news, calls } = harness(['"boom"'], 500, true);

    await expect(
      news.sources.create({ name: "Feed", scriptId: "scr_rss" }),
    ).rejects.toBeInstanceOf(OmsApiError);
    expect(calls).toHaveLength(1);
  });

  test("a caller who explicitly opts in CAN retry run()", async () => {
    const { news, calls } = harness(['"boom"'], 500, true);

    await expect(
      news.sources.run("src_1", { retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false } }),
    ).rejects.toBeInstanceOf(OmsApiError);
    // The default is a default, not a lock: `options` is spread after it.
    expect(calls).toHaveLength(2);
  });

  test("delete() targets the source, not its items", async () => {
    const { news, calls } = harness([undefined], 204);
    await news.sources.delete("src_1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/news_sources/src_1");
  });
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

describe("news.scripts", () => {
  test("list() carries no code, get() does", async () => {
    const row: NewsScript = {
      id: "scr_rss",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      name: "RSS",
      slug: "rss",
      description: "Generic RSS reader",
      builtin: true,
      user_id: null,
    };
    const { news, calls } = harness([[row], { ...row, code: "export default () => []" }]);

    const page = await news.scripts.list();
    // `code` lives on the :extended view only, so an index row genuinely has
    // none - the optional key on NewsScript is the API's, not caution.
    expect(page.items[0]?.code).toBeUndefined();

    const one = await news.scripts.get("scr_rss");
    expect(one.code).toBe("export default () => []");
    expect(calls[1]?.path).toBe("/news_scripts/scr_rss");
  });

  test("builtin narrows through exact_search", async () => {
    const { news, calls } = harness([[]]);
    await news.scripts.list({ builtin: false });
    expect(calls[0]?.search.get("exact_search[builtin]")).toBe("false");
  });

  test("create() is not replayed after a 500", async () => {
    const { news, calls } = harness(['"boom"'], 500, true);

    await expect(news.scripts.create({ name: "Mine", code: "x" })).rejects.toBeInstanceOf(OmsApiError);
    expect(calls).toHaveLength(1);
  });

  test("create() sends name/code/description and nothing else", async () => {
    const { news, calls } = harness([{}]);

    await news.scripts.create({ name: "Mine", code: "x" });

    expect(calls[0]?.body).toEqual({ name: "Mine", code: "x" });
    // `builtin` is not on create_params; a client cannot mint a platform script.
    expect(calls[0]?.raw).not.toContain("builtin");
  });

  test("editing a built-in surfaces the API's 401-for-authorisation quirk", async () => {
    const { news } = harness(['"You are not authorized to update this resource"'], 401);

    const thrown = await news.scripts.update("scr_rss", { code: "x" }).catch((e: unknown) => e);

    // A 401 here does NOT mean the session is dead. A generic handler that
    // logs the user out on any 401 would sign them out for clicking edit on a
    // read-only platform script.
    expect(thrown).toBeInstanceOf(OmsAuthError);
    expect((thrown as OmsAuthError).status).toBe(401);
    expect((thrown as OmsAuthError).message).toBe("You are not authorized to update this resource");
  });
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

describe("news.items", () => {
  test("defaults to a small page because every row carries a full body", async () => {
    const item: NewsItem = {
      id: "itm_1",
      created_at: "2026-08-29T00:00:00Z",
      updated_at: "2026-08-29T00:00:00Z",
      news_feed_id: "feed_1",
      news_source_id: "src_1",
      external_id: "guid-1",
      title: "A headline",
      content: "The whole article text.",
      url: "https://news.example/1",
      author: null,
      published_at: "2026-08-28T23:00:00Z",
      fetched_at: "2026-08-29T00:00:00Z",
      media_url: null,
      media_status: null,
      media_error: null,
      parent_id: null,
      media_offset_s: null,
    };
    const { news, calls } = harness([[item]]);

    const page = await news.items.list();

    expect(calls[0]?.path).toBe("/news_items");
    expect(calls[0]?.search.get("modifiers[page]")).toBe("1:25");
    expect(page.items[0]?.content).toBe("The whole article text.");
  });

  test("sourceId narrows to one feed", async () => {
    const { news, calls } = harness([[]]);
    await news.items.list({ sourceId: "src_1" });
    expect(calls[0]?.search.get("exact_search[news_source_id]")).toBe("src_1");
  });
});

describe("news.items.similar", () => {
  const hit: NewsItem & { distance: number } = {
    id: "itm_2",
    created_at: "2026-09-06T00:00:00Z",
    updated_at: "2026-09-06T00:00:00Z",
    news_feed_id: "feed_1",
    news_source_id: "src_1",
    external_id: "guid-2",
    title: "Mesquita",
    content: "Sobre a mesquita.",
    url: null,
    author: null,
    published_at: null,
    fetched_at: "2026-09-06T00:00:00Z",
    media_url: null,
    media_status: null,
    media_error: null,
    parent_id: null,
    media_offset_s: null,
    distance: 0.12,
  };

  test("by text: every parameter has its wire name, absent ones stay off the query", async () => {
    const { news, calls } = harness([[hit]]);

    const hits = await news.items.similar({
      text: "mesquita de Lisboa",
      feedId: "feed_1",
      limit: 5,
      since: "2026-09-01T00:00:00Z",
      maxDistance: 0.5,
    });

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/news_items/similar");
    expect(calls[0]?.search.get("text")).toBe("mesquita de Lisboa");
    expect(calls[0]?.search.get("news_feed_id")).toBe("feed_1");
    expect(calls[0]?.search.get("limit")).toBe("5");
    expect(calls[0]?.search.get("since")).toBe("2026-09-01T00:00:00Z");
    expect(calls[0]?.search.get("max_distance")).toBe("0.5");
    expect(calls[0]?.search.has("item_id")).toBe(false);
    expect(hits[0]?.distance).toBe(0.12);
    expect(hits[0]?.title).toBe("Mesquita");
  });

  test("by itemId: only item_id goes on the wire", async () => {
    const { news, calls } = harness([[]]);
    await news.items.similar({ itemId: "itm_1" });
    expect(calls[0]?.search.get("item_id")).toBe("itm_1");
    expect([...(calls[0]?.search.keys() ?? [])]).toEqual(["item_id"]);
  });

  test("a 422 for an item without a vector yet surfaces as OmsApiError", async () => {
    const { news } = harness(["Item has no embedding yet"], 422);
    await expect(news.items.similar({ itemId: "itm_1" })).rejects.toBeInstanceOf(OmsApiError);
  });
});

