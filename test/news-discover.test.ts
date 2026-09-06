/** `bun test` coverage for the news dry run and feed discovery: paths and bodies. */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { NewsNamespace } from "../src/resources/content/news";

function harness(body: unknown) {
  const calls: { method: string; path: string; search: string; body: unknown }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: decodeURIComponent(url.search), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  };
  const http = new ApiClient({ baseUrl: "https://api.test", fetch: fetchImpl, tokens: { getToken: () => "t" }, retry: { maxAttempts: 1 } });
  return { news: new NewsNamespace(http), calls };
}

describe("news dry run and discovery", () => {
  test("sources.test posts the script id and the config to the collection route", async () => {
    const { news, calls } = harness({ ok: true, items: [], count: 0, dated: 0, logs: [] });
    await news.sources.test({ scriptId: "s1", config: { url: "https://x.pt/rss" } });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/news_sources/test", body: { news_script_id: "s1", config: { url: "https://x.pt/rss" } } });
  });

  test("discover is a GET with the url in the query", async () => {
    const { news, calls } = harness({ url: "https://x.pt/", host: "x.pt", title: "X", feeds: [] });
    const found = await news.discover("https://x.pt/");
    expect(found.host).toBe("x.pt");
    expect(calls[0]?.path).toBe("/news/discover");
    expect(calls[0]?.search).toContain("url=https://x.pt/");
  });
});
