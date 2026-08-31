/**
 * The `search` namespace: web search through the site's own metasearch engine.
 *
 * One request, one answer: results from several upstream engines merged and
 * scored server-side, plus the query suggestions and knowledge-panel style
 * infoboxes the engines offered. Nothing is paged in the background - a page
 * is what you asked for, and {@link SearchResponse.has_more} says whether it
 * is worth asking for the next one.
 *
 * Requires a credential. The server answers the same query from a short-lived
 * cache, so repeating a search (or paging back) is cheap.
 */

import { Resource } from "../http";
import type { QueryParams, RequestOptions } from "../types";

/** The four result families. Each one changes what a {@link SearchResult} carries. */
export const SEARCH_CATEGORIES = Object.freeze(["general", "images", "news", "videos"] as const);
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

/** Restricts results to things published inside the window. */
export const SEARCH_TIME_RANGES = Object.freeze(["day", "week", "month", "year"] as const);
export type SearchTimeRange = (typeof SEARCH_TIME_RANGES)[number];

/** `0` off, `1` moderate (the default), `2` strict. */
export type SearchSafeSearch = 0 | 1 | 2;

/** Pages beyond this answer `400`. */
export const SEARCH_MAX_PAGE = 10;
/** Longer queries answer `400`. */
export const SEARCH_MAX_QUERY_LENGTH = 200;

export interface SearchQueryInput {
  /** What to search for. Trimmed server-side; blank is a `400`. */
  readonly q: string;
  /** 1-based, at most {@link SEARCH_MAX_PAGE}. Defaults to 1. */
  readonly page?: number;
  /** Defaults to `"general"`. */
  readonly category?: SearchCategory;
  readonly timeRange?: SearchTimeRange;
  /**
   * A language code such as `"pt"`, `"pt-PT"` or `"en"`, or `"all"` to search
   * without a language filter. When omitted the server reads the request's
   * `Accept-Language`, and falls back to Portuguese.
   */
  readonly language?: string;
  /** Defaults to `1`. */
  readonly safesearch?: SearchSafeSearch;
}

/**
 * One hit.
 *
 * `image`, `resolution` and `duration` are filled only by the category that
 * has them (images for the first two, videos for the last) and are `null`
 * otherwise; `thumbnail` may appear in any category. `published_at` is the
 * upstream engine's own timestamp string and is not normalised to one format.
 */
export interface SearchResult {
  /** Never empty: a hit without a title carries its host instead. */
  readonly title: string;
  /** Always absolute `http(s)`. */
  readonly url: string;
  /** The hostname of `url` without a leading `www.`. */
  readonly host: string;
  /** Plain text, at most 600 characters. Empty when the engine gave none. */
  readonly snippet: string;
  /** Upstream engines that returned this hit, deduplicated. */
  readonly engines: string[];
  readonly thumbnail: string | null;
  /** The full-size image, images only. */
  readonly image: string | null;
  /** `"1200x800"` style, images only. */
  readonly resolution: string | null;
  /** As the engine spells it (`"12:34"`), videos only. */
  readonly duration: string | null;
  readonly published_at: string | null;
  readonly category: SearchCategory | string;
}

export interface SearchInfoboxLink {
  readonly title: string;
  readonly url: string;
}

/** A knowledge-panel style card an engine attached to the query. */
export interface SearchInfobox {
  readonly title: string;
  /** Plain text, at most 1200 characters. */
  readonly content: string;
  readonly image: string | null;
  /** At most six. */
  readonly urls: SearchInfoboxLink[];
}

export interface SearchResponse {
  /** The query as the engine understood it. */
  readonly query: string;
  readonly category: SearchCategory | string;
  readonly page: number;
  /** At most 40, in the server's ranking order. */
  readonly results: SearchResult[];
  /** At most eight related queries. */
  readonly suggestions: string[];
  readonly infoboxes: SearchInfobox[];
  /**
   * The engines' own estimate of the total. Often `0`: many engines do not
   * report one, and it is never the length of anything you can page through.
   */
  readonly number_of_results: number;
  /** Engines that failed to answer in time. The results are complete without them. */
  readonly unresponsive_engines: string[];
  /** Whether asking for `page + 1` is likely to return anything. */
  readonly has_more: boolean;
}

/** The `search` namespace, reachable as `oms.search`. */
export class SearchNamespace extends Resource {
  /**
   * `GET /search` - runs one search and returns one page of merged results.
   *
   * @throws {OmsApiError} 400 when the query is blank or too long, or a
   *   parameter is out of range; 401 without a credential; 429 above 60
   *   searches a minute; 502 while the engine behind the service is down.
   */
  async query(input: SearchQueryInput, options: RequestOptions = {}): Promise<SearchResponse> {
    const query: QueryParams = { q: input.q };
    if (input.page !== undefined) query["page"] = input.page;
    if (input.category !== undefined) query["category"] = input.category;
    if (input.timeRange !== undefined) query["time_range"] = input.timeRange;
    if (input.language !== undefined) query["language"] = input.language;
    if (input.safesearch !== undefined) query["safesearch"] = input.safesearch;
    return this.http.get<SearchResponse>("/search", { ...options, query });
  }
}
