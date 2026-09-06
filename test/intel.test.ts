/**
 * `bun test` coverage for the intel families in `resources/content.ts`.
 *
 * The shapes that have already cost bugs elsewhere in this API and that intel
 * repeats:
 *
 * - **top-level filters are not `search` filters.** `q`, `min_importance` and
 *   `sort` are read straight off `params` by `IntelArticlesController`, not
 *   through the fail-closed filter allowlist, so they must land at the root of
 *   the query string and not inside a `search[...]` bucket. Put them in the
 *   bucket and every request is a `400 "Unknown search filter"`.
 * - **`cursor: null` is a body null, not the `\b` sentinel.** The sentinel is a
 *   query-string convention; writing it into a JSON body would store a literal
 *   backspace character as the source's cursor and quietly break its next poll.
 * - **camelCase in, snake_case out.** Every create/update input here is
 *   renamed on the way to the wire, and a key that fails to be renamed is
 *   simply dropped by Rails' `permit` with a `200` on it.
 * - **the write routes must not be replayed.** A retried `POST` to
 *   `/intel_sources/:id/run` enqueues a second fetch job on a queue with no
 *   throttle in front of it.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsAuthError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  INTEL_ARTICLE_CATEGORIES,
  INTEL_PROMPT_KEYS,
  INTEL_REPORT_KINDS,
  IntelNamespace,
  intelArticleImageUrl,
  type IntelArticle,
  type IntelConfig,
  type IntelReport,
  type IntelStats,
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
  readonly intel: IntelNamespace;
  readonly calls: Call[];
}

/**
 * A fake transport. `bodies` is consumed one entry per request so a paging
 * test can hand back a full page and then a short one; the last entry repeats
 * once the list runs dry.
 */
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
    // Retrying is OFF for most tests: they assert a request count and must not
    // race a backoff sleep. The tests that check a write is NOT replayed pass
    // `retries` so the client would happily retry if the method let it - which
    // is the only way that assertion proves anything.
    ...(retries ? { retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false } } : { retry: { maxAttempts: 1 } }),
  });
  return { intel: new IntelNamespace(http), calls };
}

function article(overrides: Partial<IntelArticle> = {}): IntelArticle {
  return {
    id: "art_1",
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:00:00Z",
    title: "Something happened",
    summary: "A short summary.",
    importance: 8,
    category: "incidente",
    tags: ["lisboa"],
    image_url: "https://news.example/og.jpg",
    enriched: true,
    first_seen_at: "2026-08-29T08:00:00Z",
    last_seen_at: "2026-08-29T09:30:00Z",
    n_sources: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("paths", () => {
  test("articles list under /intel_articles", async () => {
    const { intel, calls } = harness([[]]);

    await intel.articles.list();

    expect(calls[0]?.path).toBe("/intel_articles");
  });
});

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

describe("intel.articles.list", () => {
  test("pages with a modest default and no ordering of its own", async () => {
    const { intel, calls } = harness([[article()]]);

    const page = await intel.articles.list();

    expect(calls[0]?.path).toBe("/intel_articles");
    // 50, not 500: every row costs a COUNT for `n_sources`.
    expect(calls[0]?.search.get("modifiers[page]")).toBe("1:50");
    // The controller supplies `importance DESC, last_seen_at DESC` itself, and
    // sending an order of our own would PROMOTE it above the controller's.
    expect(calls[0]?.search.get("modifiers[order]")).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.pageSize).toBe(50);
  });

  test("q, minImportance and sort are TOP-LEVEL, never search keys", async () => {
    const { intel, calls } = harness([[]]);

    await intel.articles.list({ q: "mesquita", minImportance: 7, sort: "recent" });

    const search = calls[0]?.search;
    expect(search?.get("q")).toBe("mesquita");
    expect(search?.get("min_importance")).toBe("7");
    expect(search?.get("sort")).toBe("recent");
    // Inside a bucket these three would be a 400: the filter allowlist fails
    // closed and none of them is on it.
    expect(search?.get("search[q]")).toBeNull();
    expect(search?.get("search[min_importance]")).toBeNull();
    expect(search?.get("search[sort]")).toBeNull();
  });

  test("declared filters still go through the search buckets", async () => {
    const { intel, calls } = harness([[]]);

    await intel.articles.list({
      search: { title: "incendio" },
      exactSearch: { category: "incidente", enriched: false },
    });

    const search = calls[0]?.search;
    expect(search?.get("search[title]")).toBe("incendio");
    expect(search?.get("exact_search[category]")).toBe("incidente");
    expect(search?.get("exact_search[enriched]")).toBe("false");
  });

  test("next() walks pages and stops on a short one", async () => {
    const full = Array.from({ length: 2 }, (_, i) => article({ id: `art_${i}` }));
    const { intel, calls } = harness([full, [article({ id: "art_2" })]]);

    const first = await intel.articles.list({ pageSize: 2, q: "x" });
    expect(first.hasMore).toBe(true);

    const second = await first.next();
    expect(second?.items).toHaveLength(1);
    expect(second?.hasMore).toBe(false);
    expect(calls[1]?.search.get("modifiers[page]")).toBe("2:2");
    // Filters have to survive the page turn or page 2 answers about a
    // different query than page 1.
    expect(calls[1]?.search.get("q")).toBe("x");
  });

  test("get() reads the extended view by id", async () => {
    const detail = { ...article(), details: "Long body", sources: [], related: [], reports: [] };
    const { intel, calls } = harness([detail]);

    const got = await intel.articles.get("art_1");

    expect(calls[0]?.path).toBe("/intel_articles/art_1");
    expect(got.details).toBe("Long body");
    // The extended view INHERITS the base fields; it is never a subset.
    expect(got.n_sources).toBe(3);
  });

  test("delete() is a 204 with an empty body", async () => {
    const { intel, calls } = harness([undefined], 204);

    await expect(intel.articles.delete("art_1")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/intel_articles/art_1");
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe("intel.reports", () => {
  test("kind is an exact match, not a partial one", async () => {
    const { intel, calls } = harness([[]]);

    await intel.reports.list({ kind: "day" });

    expect(calls[0]?.path).toBe("/intel_reports");
    expect(calls[0]?.search.get("exact_search[kind]")).toBe("day");
    expect(calls[0]?.search.get("search[kind]")).toBeNull();
  });

  test("no order is sent: the controller already orders by period_end", async () => {
    const { intel, calls } = harness([[]]);
    await intel.reports.list();
    expect(calls[0]?.search.get("modifiers[order]")).toBeNull();
  });

  test("get() returns the extended view", async () => {
    const report: IntelReport = {
      id: "rep_1",
      created_at: "2026-08-29T00:00:00Z",
      updated_at: "2026-08-29T00:00:00Z",
      kind: "week",
      title: "Weekly",
      period_start: "2026-08-22T00:00:00Z",
      period_end: "2026-08-29T00:00:00Z",
      model: "some-model",
    };
    const { intel, calls } = harness([{ ...report, content: "# Weekly", stats: {}, articles: [] }]);

    const got = await intel.reports.get("rep_1");

    expect(calls[0]?.path).toBe("/intel_reports/rep_1");
    expect(got.content).toBe("# Weekly");
    expect(got.kind).toBe("week");
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config and stats
// ---------------------------------------------------------------------------

describe("intel.config", () => {
  const config: IntelConfig = {
    id: "cfg_1",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    rubric: "What matters to me",
    prompts: {},
    build_model: null,
    report_model: null,
    report_min_importance: 4,
    enrich_min_importance: 6,
    web_search: true,
    max_sources: 50,
  };

  test("get() hits the singular path, with no id segment", async () => {
    const { intel, calls } = harness([config]);

    const got = await intel.config.get();

    expect(calls[0]?.path).toBe("/intel_config");
    expect(got.max_sources).toBe(50);
  });

  test("update() renames the thresholds onto their snake_case columns", async () => {
    const { intel, calls } = harness([config]);

    await intel.config.update({
      reportMinImportance: 5,
      enrichMinImportance: 7,
      webSearch: false,
      maxSources: 100,
      buildModel: "m1",
      reportModel: "m2",
    });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      build_model: "m1",
      report_model: "m2",
      report_min_importance: 5,
      enrich_min_importance: 7,
      web_search: false,
      max_sources: 100,
    });
  });

  test("prompts go over whole, because the column is replaced not merged", async () => {
    const { intel, calls } = harness([config]);

    await intel.config.update({ prompts: { build: "b", report: "r" } });

    expect(calls[0]?.body).toEqual({ prompts: { build: "b", report: "r" } });
  });

  test("a rubric explicitly set to null is sent, not dropped", async () => {
    const { intel, calls } = harness([config]);

    await intel.config.update({ rubric: null });

    // `undefined` means "leave it alone"; `null` means "clear it". Collapsing
    // the two would make a reset impossible.
    expect(calls[0]?.body).toEqual({ rubric: null });
  });
});

describe("intel.stats", () => {
  test("one request to a singular path, despite the plural spelling", async () => {
    const stats: IntelStats = {
      totals: { articles: 120, sources: 400, reports: 9, items: 900, pending_items: 12, pending_media: 3 },
      by_category: [{ category: "incidente", c: 40 }],
      by_day: [{ day: "2026-08-29", c: 5 }],
      by_importance: { critico: 2, alta: 10, media: 30, baixa: 50, ruido: 28 },
      last24h: 5,
    };
    const { intel, calls } = harness([stats]);

    const got = await intel.stats.get();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/intel_stats");
    // `totals.sources` counts article-to-item citations, NOT configured feeds.
    // Asserted so that a future rename in the backend breaks here rather than
    // in a dashboard label.
    expect(got.totals.sources).toBe(400);
    expect(got.by_day[0]?.day).toBe("2026-08-29");
  });

  test("a caller outside the handle allowlist gets a 403 with the backend's sentence", async () => {
    const { intel } = harness(['"Intel access is restricted."'], 403);

    const thrown = await intel.stats.get().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(OmsAuthError);
    expect((thrown as OmsAuthError).status).toBe(403);
    expect((thrown as OmsAuthError).authenticationRequired).toBe(false);
    expect((thrown as OmsAuthError).message).toBe("Intel access is restricted.");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("intelArticleImageUrl", () => {
  test("returns an empty string for a story with no image", () => {
    expect(intelArticleImageUrl(null)).toBe("");
    expect(intelArticleImageUrl(undefined)).toBe("");
    expect(intelArticleImageUrl("")).toBe("");
  });

  test("encodes the origin URL and applies the web app's defaults", () => {
    const url = intelArticleImageUrl("https://news.example/a b.jpg?x=1&y=2");

    expect(url.startsWith("https://wsrv.nl/?url=")).toBe(true);
    // The origin URL must be fully escaped or its own query string would merge
    // into the proxy's and change the resize parameters.
    expect(url).toContain(encodeURIComponent("https://news.example/a b.jpg?x=1&y=2"));
    expect(url).toContain("&w=480");
    expect(url).toContain("&q=45");
    expect(url).toContain("&output=webp");
    expect(url.endsWith("&we")).toBe(true);
  });

  test("width and quality are overridable", () => {
    const url = intelArticleImageUrl("https://news.example/a.jpg", { width: 1200, quality: 80 });
    expect(url).toContain("&w=1200");
    expect(url).toContain("&q=80");
  });
});

describe("the vocabulary constants match the Ruby ones", () => {
  test("categories, kinds, healths and prompt keys", () => {
    expect([...INTEL_ARTICLE_CATEGORIES]).toEqual([
      "incidente",
      "politica",
      "comunidade",
      "sociedade",
      "internacional",
      "economia",
      "outro",
    ]);
    expect([...INTEL_REPORT_KINDS]).toEqual(["6h", "day", "week", "month"]);
    expect([...INTEL_PROMPT_KEYS]).toEqual(["build", "media", "enrich_plan", "enrich_actors", "enrich_synth", "report"]);
  });
});
