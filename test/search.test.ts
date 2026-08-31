/**
 * `bun test` coverage for the `search` namespace.
 *
 * The two ways this call can go quietly wrong: a parameter renamed on the way
 * to the wire (`timeRange` travels as `time_range`, and a key that is not
 * renamed is simply ignored server-side with a `200` on it), and an optional
 * parameter sent as the string `"undefined"`, which the server rejects as an
 * out-of-range value. Both are asserted on the query string itself.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsAuthError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  SEARCH_CATEGORIES,
  SEARCH_MAX_PAGE,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_TIME_RANGES,
  SearchNamespace,
  type SearchResponse,
} from "../src/resources/search";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
}

interface Harness {
  readonly search: SearchNamespace;
  readonly calls: Call[];
}

function harness(body: unknown, status = 200): Harness {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.searchParams });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
    retry: { maxAttempts: 1 },
  });
  return { search: new SearchNamespace(http), calls };
}

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: "mesquita lisboa",
    category: "general",
    page: 1,
    results: [
      {
        title: "Comunidade Islâmica de Lisboa",
        url: "https://www.comunidadeislamica.pt/",
        host: "comunidadeislamica.pt",
        snippet: "A Mesquita Central de Lisboa, inaugurada em 1985.",
        engines: ["google", "bing"],
        thumbnail: null,
        image: null,
        resolution: null,
        duration: null,
        published_at: null,
        category: "general",
      },
    ],
    suggestions: ["mesquita central de lisboa"],
    infoboxes: [],
    number_of_results: 0,
    unresponsive_engines: [],
    has_more: true,
    ...overrides,
  };
}

describe("search.query", () => {
  test("sends one GET /search with only the query", async () => {
    const { search, calls } = harness(response());
    await search.query({ q: "mesquita lisboa" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/search");
    expect(calls[0]?.search.get("q")).toBe("mesquita lisboa");
    expect([...(calls[0]?.search.keys() ?? [])]).toEqual(["q"]);
  });

  test("renames timeRange to time_range and sends every other parameter as given", async () => {
    const { search, calls } = harness(response({ page: 3, category: "news" }));
    await search.query({ q: "eleições", page: 3, category: "news", timeRange: "week", language: "pt", safesearch: 0 });

    const sent = calls[0]?.search;
    expect(sent?.get("page")).toBe("3");
    expect(sent?.get("category")).toBe("news");
    expect(sent?.get("time_range")).toBe("week");
    expect(sent?.has("timeRange")).toBe(false);
    expect(sent?.get("language")).toBe("pt");
    expect(sent?.get("safesearch")).toBe("0");
  });

  test("returns the body untouched", async () => {
    const body = response({ has_more: false, unresponsive_engines: ["qwant"] });
    const { search } = harness(body);
    const answer = await search.query({ q: "mesquita lisboa" });

    expect(answer).toEqual(body);
    expect(answer.results[0]?.host).toBe("comunidadeislamica.pt");
    expect(answer.has_more).toBe(false);
  });

  test("401 is an auth error, 502 an API error carrying the status", async () => {
    const anonymous = harness("Session required to access this resource.", 401);
    await expect(anonymous.search.query({ q: "x" })).rejects.toBeInstanceOf(OmsAuthError);

    const down = harness("Search is temporarily unavailable: search backend unreachable", 502);
    const error = await down.search.query({ q: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OmsApiError);
    expect((error as OmsApiError).status).toBe(502);
  });

  test("publishes the server's limits", () => {
    expect(SEARCH_CATEGORIES).toEqual(["general", "images", "news", "videos"]);
    expect(SEARCH_TIME_RANGES).toEqual(["day", "week", "month", "year"]);
    expect(SEARCH_MAX_PAGE).toBe(10);
    expect(SEARCH_MAX_QUERY_LENGTH).toBe(200);
  });
});
