/**
 * `bun test` coverage for the transport's WIRE FORMAT: what actually leaves the
 * process, and what is allowed to leave it twice.
 *
 * Every case here is one the SDK used to get wrong in the same direction - by
 * answering successfully with the wrong data instead of failing. A dropped null
 * filter comes back as an unfiltered page, a dropped date filter comes back as
 * an unfiltered page, a replayed POST comes back as a second record, and a page
 * size above the server's ceiling comes back as `hasMore: false` with rows left
 * behind. None of them throws, so only a test that reads the wire notices.
 *
 * The reference points are the Rails source, not the old frontend:
 * `CrudActions#define_option_param_getter` for the null sentinel,
 * `QuerySearcher#date_search` for dates, `Rack::Attack` plus the controllers'
 * `too_many_requests!` guards for the 429 rule, and
 * `QueryModifier#apply_pagination` for the page ceiling.
 */

import { describe, expect, test } from "bun:test";

import {
  ApiClient,
  NULL_SENTINEL,
  buildFormData,
  encodeQuery,
  isSafeMethod,
  pageModifier,
} from "../src/http";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, createPage, resolvePageSize } from "../src/types";

const BASE_URL = "https://api.test";

/** One request the transport actually made. */
interface Attempt {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

/**
 * A fetch double that answers from a script.
 *
 * The script is consumed one entry per attempt and running off the end is a
 * failure rather than a repeat: a retry the policy should have suppressed has
 * to be visible as an error, not absorbed by a lenient double.
 */
function harness(
  script: Array<() => Response | Promise<Response>>,
  clientOptions: ConstructorParameters<typeof ApiClient>[0] = {},
): { http: ApiClient; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    attempts.push({
      method: init?.method ?? "GET",
      url: input,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const step = script[attempts.length - 1];
    if (step === undefined) {
      throw new Error(`Unscripted attempt #${attempts.length} - the transport retried more than expected`);
    }
    return step();
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    // Zero delay and no jitter: this suite asserts WHETHER a retry happened,
    // never how long it waited, and the real 400ms base would make it crawl.
    retry: { maxAttempts: 3, baseDelayMs: 0, jitter: false },
    ...clientOptions,
  });
  return { http, attempts };
}

const json =
  (body: unknown, status = 200) =>
  (): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A 5xx: ambiguous, because the server may have committed before it died. */
const boom = json({ error: "upstream exploded" }, 502);

/** A 429: unambiguous, because this API refuses before it writes. */
const throttled = json({ error: "rate_limited" }, 429);

/** A connection that dies with no response at all. */
const dropped = (): Response => {
  throw new TypeError("fetch failed");
};

const queryOf = (url: string): string => new URL(url).search.slice(1);

// ---------------------------------------------------------------------------
// (A) the null sentinel
// ---------------------------------------------------------------------------

describe("null in a query string", () => {
  test("is the backend's sentinel, because a URL has no way to say null", () => {
    // U+0008. CrudActions turns it back into nil, and exact_search's
    // `where(params)` turns THAT into `IS NULL`.
    expect(NULL_SENTINEL).toBe("\b");
    expect(NULL_SENTINEL.charCodeAt(0)).toBe(8);
    expect(encodeQuery({ exact_search: { parent_id: null } })).toBe("exact_search%5Bparent_id%5D=%08");
  });

  test("is not the same as undefined, which is the absent filter", () => {
    // The distinction is the whole point: drop the key and Searchable's
    // `return self unless params.present?` answers with the UNFILTERED set,
    // so "list the root of my drive" becomes "list my entire drive".
    expect(encodeQuery({ exact_search: { parent_id: undefined } })).toBe("");
    expect(encodeQuery({ a: null, b: undefined, c: "x" })).toBe("a=%08&c=x");
  });

  test("is written at every depth, so being wrong is an empty page and never a wide one", () => {
    // The server only decodes one level inside a filter bucket. Deeper, the
    // sentinel stays a literal character and matches no row - which is the
    // safe way to be wrong, unlike a vanished filter.
    expect(encodeQuery({ ids: ["a", null] })).toBe("ids%5B%5D=a&ids%5B%5D=%08");
    expect(encodeQuery({ search: { nested: { k: null } } })).toBe("search%5Bnested%5D%5Bk%5D=%08");
  });

  test("rides through the client's own URL builder, not just the encoder", async () => {
    const { http, attempts } = harness([json([])]);

    await http.get("/fs_nodes", { query: { exact_search: { parent_id: null } } });

    expect(queryOf(attempts[0]!.url)).toBe("exact_search%5Bparent_id%5D=%08");
  });
});

describe("null in a JSON body", () => {
  test("stays a real null - the sentinel is a query-string workaround only", async () => {
    // NilClass is in ActionController's PERMITTED_SCALAR_TYPES, so a JSON null
    // survives `permit` and arrives as nil with no encoding at all. Every site
    // that decodes the sentinel by hand (GroupChatsController#clean_string,
    // GroupChatMessagesController#clean_string, BookServices::Creator#clean)
    // opens with a nil check, so both spellings land on the same value.
    const { http, attempts } = harness([json({ ok: true })]);

    await http.patch("/songs/abc", { vocal_separation_started_at: null, title: "x" });

    expect(JSON.parse(attempts[0]!.body!)).toEqual({ vocal_separation_started_at: null, title: "x" });
    expect(attempts[0]!.body).not.toContain("\b");
  });

  test("is not corrupted inside an array, which is where the sentinel could not be undone", async () => {
    // Nothing on the backend decodes a sentinel out of an array element, so
    // encoding one there would turn a null into a literal backspace string.
    const { http, attempts } = harness([json({ ok: true })]);

    await http.post("/whatever", { values: [1, null, 3] });

    expect(JSON.parse(attempts[0]!.body!)).toEqual({ values: [1, null, 3] });
  });
});

describe("null in a multipart field", () => {
  test("is omitted, because an absent field already reads as nil", async () => {
    const form = await buildFormData({ title: "Dune", author: null, isbn: undefined });

    expect(form.get("title")).toBe("Dune");
    expect(form.has("author")).toBe(false);
    expect(form.has("isbn")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (B) dates in a query string
// ---------------------------------------------------------------------------

describe("a Date in a query string", () => {
  test("serialises to ISO-8601 instead of vanishing", () => {
    // Before this branch existed, a Date fell into the generic object case,
    // Object.entries(date) was [], and the whole key disappeared - an
    // unfiltered listing, not a malformed filter.
    const since = new Date("2026-08-29T09:00:00.000Z");

    expect(encodeQuery({ since })).toBe("since=2026-08-29T09%3A00%3A00.000Z");
    expect(encodeQuery({ search: { created_at: since } })).toBe("search%5Bcreated_at%5D=2026-08-29T09%3A00%3A00.000Z");
  });

  test("works inside an array, the way a range filter is written", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-12-31T00:00:00.000Z");

    expect(encodeQuery({ search: { created_at: [from, to] } })).toBe(
      "search%5Bcreated_at%5D%5B%5D=2026-01-01T00%3A00%3A00.000Z&search%5Bcreated_at%5D%5B%5D=2026-12-31T00%3A00%3A00.000Z",
    );
  });

  test("an invalid Date is rejected here rather than sent as garbage", () => {
    // String#to_date_safe rescues ArgumentError and returns nil, so an
    // unparseable value drops that side of the range without complaint.
    expect(() => encodeQuery({ since: new Date("not a date") })).toThrow(TypeError);
    expect(() => encodeQuery({ since: new Date("not a date") })).toThrow(/invalid Date/);
  });

  test("needs no special case in a body, where JSON.stringify already does it", async () => {
    const { http, attempts } = harness([json({ ok: true })]);

    await http.post("/events", { at: new Date("2026-08-29T09:00:00.000Z") });

    expect(JSON.parse(attempts[0]!.body!)).toEqual({ at: "2026-08-29T09:00:00.000Z" });
  });
});

// ---------------------------------------------------------------------------
// (C) the retry policy
// ---------------------------------------------------------------------------

describe("which methods may be replayed", () => {
  test("safe methods are the ones with nothing to duplicate", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("head")).toBe(true);
    expect(isSafeMethod("POST")).toBe(false);
    // Idempotent by RFC, still excluded: Rails' destroy answers 404 the second
    // time, turning a successful delete into a "not found" the caller acts on.
    expect(isSafeMethod("DELETE")).toBe(false);
    expect(isSafeMethod("PUT")).toBe(false);
  });

  test("a GET retries a 5xx", async () => {
    const { http, attempts } = harness([boom, json({ id: "1" })]);

    expect(await http.get<{ id: string }>("/songs")).toEqual({ id: "1" });
    expect(attempts).toHaveLength(2);
  });

  test("a POST does NOT retry a 5xx, because the server may already have written", async () => {
    const { http, attempts } = harness([boom]);

    await expect(http.post("/songs", { name: "x" })).rejects.toThrow();
    expect(attempts).toHaveLength(1);
  });

  test("a POST does not retry a lost connection either", async () => {
    const { http, attempts } = harness([dropped]);

    await expect(http.post("/songs", { name: "x" })).rejects.toThrow(/Network request failed/);
    expect(attempts).toHaveLength(1);
  });

  test("a GET does retry a lost connection", async () => {
    const { http, attempts } = harness([dropped, json({ id: "1" })]);

    expect(await http.get<{ id: string }>("/songs")).toEqual({ id: "1" });
    expect(attempts).toHaveLength(2);
  });

  test("a DELETE is not replayed, so a deleted row never reports itself missing", async () => {
    const { http, attempts } = harness([boom]);

    await expect(http.delete("/songs/abc")).rejects.toThrow();
    expect(attempts).toHaveLength(1);
  });

  test("a POST DOES retry a 429, which this API only ever sends before it writes", async () => {
    // Rack::Attack answers from middleware, and every in-app 429 comes from a
    // `too_many_requests!` guard placed ahead of the write it protects.
    const { http, attempts } = harness([throttled, json({ id: "1" })]);

    expect(await http.post<{ id: string }>("/songs", { name: "x" })).toEqual({ id: "1" });
    expect(attempts).toHaveLength(2);
  });

  test("a per-call retry object opts a mutator back in", async () => {
    const { http, attempts } = harness([boom, json({ id: "1" })]);

    const created = await http.post(
      "/songs",
      { name: "x" },
      { retry: { maxAttempts: 2, baseDelayMs: 0, jitter: false } },
    );

    expect(created).toEqual({ id: "1" });
    expect(attempts).toHaveLength(2);
  });

  test("a client-wide retry policy does not, it only shapes the backoff", async () => {
    // Constructing a client is the wrong place to decide that every POST in
    // the process may be replayed, so the client default sets attempts and
    // delays and leaves the method gate alone.
    const { http, attempts } = harness([boom], { retry: { maxAttempts: 5, baseDelayMs: 0, jitter: false } });

    await expect(http.post("/songs", { name: "x" })).rejects.toThrow();
    expect(attempts).toHaveLength(1);
  });

  test("retry:false still beats everything, 429 included", async () => {
    const { http, attempts } = harness([throttled]);

    await expect(http.get("/notepads/show_or_create", { retry: false })).rejects.toThrow();
    expect(attempts).toHaveLength(1);
  });

  test("a 4xx that is not 429 never retries, on any method", async () => {
    const { http, attempts } = harness([json({ error: "nope" }, 422)]);

    await expect(http.get("/songs")).rejects.toThrow();
    expect(attempts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (D) the page-size ceiling
// ---------------------------------------------------------------------------

describe("the page size ceiling", () => {
  test("the wire form is clamped to the server's own maximum", () => {
    expect(MAX_PAGE_SIZE).toBe(500);
    expect(pageModifier(2, 100)).toBe("2:100");
    expect(pageModifier(1, 1200)).toBe("1:500");
    expect(pageModifier()).toBe(`1:${DEFAULT_PAGE_SIZE}`);
  });

  test("a page number below 1 is 1, so the first page is not fetched twice", () => {
    expect(pageModifier(0, 50)).toBe("1:50");
    expect(pageModifier(-3, 50)).toBe("1:50");
  });

  test("the effective size is the one Paginated reports and the one hasMore uses", () => {
    // The bug: 500 items measured against a requested 1200 looked like a short
    // page, so hasMore said false and 700 rows were dropped in silence.
    const items = Array.from({ length: MAX_PAGE_SIZE }, (_, index) => index);

    const page = createPage(items, 1, 1200, async () => []);

    expect(page.pageSize).toBe(MAX_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
  });

  test("next() then asks for the size the server will actually honour", async () => {
    const asked: Array<{ page: number; pageSize: number }> = [];
    const items = Array.from({ length: MAX_PAGE_SIZE }, (_, index) => index);
    const load = async (at: { page: number; pageSize: number }): Promise<number[]> => {
      asked.push(at);
      return [1, 2, 3];
    };

    const second = await createPage(items, 1, 1200, load).next();

    expect(asked).toEqual([{ page: 2, pageSize: MAX_PAGE_SIZE }]);
    expect(second?.page).toBe(2);
    expect(second?.pageSize).toBe(MAX_PAGE_SIZE);
    expect(second?.hasMore).toBe(false);
  });

  test("a page below the ceiling is untouched and still ends the walk", () => {
    const page = createPage([1, 2, 3], 1, 50, async () => []);

    expect(page.pageSize).toBe(50);
    expect(page.hasMore).toBe(false);
  });

  test("a size the server cannot parse is an error, not a silent full-table scan", () => {
    // "1:NaN" reads as size 0 in QueryModifier#apply_pagination, which bails
    // out before limit/offset and answers with the whole table.
    expect(() => resolvePageSize(Number.NaN)).toThrow(TypeError);
    expect(() => resolvePageSize(0)).toThrow(TypeError);
    expect(() => resolvePageSize(-10)).toThrow(TypeError);
    expect(() => resolvePageSize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => pageModifier(1, Number.NaN)).toThrow(/finite number/);
    expect(() => createPage([], 1, Number.NaN, async () => [])).toThrow(TypeError);
  });

  test("a fractional size truncates rather than reaching the wire as a decimal", () => {
    expect(resolvePageSize(10.9)).toBe(10);
    expect(pageModifier(1.7, 10.9)).toBe("1:10");
  });
});
