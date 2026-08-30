import { describe, expect, test } from "bun:test";

import { ApiClient, NULL_SENTINEL, encodeQuery } from "../src/http";
import { listQuery, paginate } from "../src/listing";
import { LibraryBooksNamespace } from "../src/resources/library";
import { DirectMessagesNamespace } from "../src/resources/social";
import { StorageNamespace } from "../src/resources/storage";

const BASE_URL = "https://api.test";

function client(body: unknown = []): { http: ApiClient; calls: URL[] } {
  const calls: URL[] = [];
  const http = new ApiClient({
    baseUrl: BASE_URL,
    tokens: { getToken: () => "t" },
    fetch: async (input) => {
      calls.push(new URL(input));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { http, calls };
}

describe("listQuery", () => {
  test("writes every part of the DSL under its wire name", () => {
    const query = listQuery(
      {
        search: { title: "maias" },
        exactSearch: { format: "epub", id: [1, 2] },
        order: "created_at:desc",
        random: true,
        extraOptions: { scope: "mine", tags: ["pt"] },
      },
      { page: 2, pageSize: 25 },
    );
    expect(query).toEqual({
      search: { title: "maias" },
      exact_search: { format: "epub", id: [1, 2] },
      modifiers: { page: "2:25", order: "created_at:desc", random: true },
      extra_options: { scope: "mine", tags: ["pt"] },
    });
  });

  test("omits empty buckets and undefined values", () => {
    expect(listQuery({ search: { title: undefined }, exactSearch: {} }, { page: 1, pageSize: 100 })).toEqual({
      modifiers: { page: "1:100" },
    });
  });

  test("the caller's bucket wins over the resource's shortcut, key by key", () => {
    const query = listQuery(
      { exactSearch: { user_id: "b" } },
      { page: 1, pageSize: 100 },
      { exactSearch: { user_id: "a", status: "open" } },
    );
    expect(query.exact_search).toEqual({ user_id: "b", status: "open" });
  });

  test("the base order applies only when the caller gave none", () => {
    const base = { order: "created_at:desc" };
    expect(listQuery({}, { page: 1, pageSize: 10 }, base).modifiers).toEqual({ page: "1:10", order: "created_at:desc" });
    expect(listQuery({ order: "name:asc" }, { page: 1, pageSize: 10 }, base).modifiers).toEqual({
      page: "1:10",
      order: "name:asc",
    });
  });

  test("random sends no order, not even the resource's default", () => {
    const query = listQuery({ random: true }, { page: 1, pageSize: 10 }, { order: "created_at:asc" });
    expect(query.modifiers).toEqual({ page: "1:10", random: true });
  });

  test("order: null sends no order at all", () => {
    const query = listQuery({ order: null }, { page: 1, pageSize: 10 }, { order: "created_at:desc" });
    expect(query.modifiers).toEqual({ page: "1:10" });
  });

  test("no page is written when the caller wants the whole scope", () => {
    expect(listQuery({ search: { title: "x" } }, undefined)).toEqual({ search: { title: "x" } });
  });

  test("null survives to the wire as the null sentinel", () => {
    const query = listQuery({ exactSearch: { album: null } }, undefined);
    expect(query.exact_search).toEqual({ album: null });
    expect(encodeQuery(query)).toBe(`exact_search%5Balbum%5D=${encodeURIComponent(NULL_SENTINEL)}`);
  });

  test("readonly arrays are copied, not aliased", () => {
    const ids: readonly number[] = Object.freeze([1, 2]);
    const query = listQuery({ exactSearch: { id: ids } }, undefined);
    expect(query.exact_search).toEqual({ id: [1, 2] });
    expect(Object.isFrozen((query.exact_search as { id: unknown }).id)).toBe(false);
  });

  test("top-level keys ride along untouched", () => {
    expect(listQuery({}, undefined, { top: { q: "x", sort: "recent" } })).toEqual({ q: "x", sort: "recent" });
  });
});

describe("paginate", () => {
  test("clamps the size once and measures hasMore against the clamped size", async () => {
    const asked: number[] = [];
    const page = await paginate({ pageSize: 1200 }, 100, async (at) => {
      asked.push(at.pageSize);
      return Array.from({ length: 500 }, (_, i) => i);
    });
    expect(asked).toEqual([500]);
    expect(page.pageSize).toBe(500);
    expect(page.hasMore).toBe(true);
  });

  test("next() asks for the following page at the same size", async () => {
    const asked: Array<[number, number]> = [];
    const first = await paginate({ page: 3, pageSize: 2 }, 100, async (at) => {
      asked.push([at.page, at.pageSize]);
      return [1, 2];
    });
    await first.next();
    expect(asked).toEqual([
      [3, 2],
      [4, 2],
    ]);
  });

  test("a body that is not an array is an empty page", async () => {
    const page = await paginate({}, 100, async () => undefined);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

describe("extraOptions reach the wire on the resources that declare them", () => {
  test("books: the bucket and its shortcuts write the same keys", async () => {
    const { http, calls } = client();
    const books = new LibraryBooksNamespace(http);

    await books.list({ extraOptions: { scope: "explore", tags: ["pt"] } });
    await books.list({ scope: "explore", tags: ["pt"] });

    expect(calls[0]!.search).toBe(calls[1]!.search);
    expect(calls[0]!.searchParams.get("extra_options[scope]")).toBe("explore");
    expect(calls[0]!.searchParams.getAll("extra_options[tags][]")).toEqual(["pt"]);
  });

  test("messages: an explicit other_user_id overrides withUser", async () => {
    const { http, calls } = client();
    const messages = new DirectMessagesNamespace(http);

    await messages.list({ withUser: "a", extraOptions: { other_user_id: "b" } });

    expect(calls[0]!.searchParams.get("extra_options[other_user_id]")).toBe("b");
  });

  test("storage: no parentId means no parent filter at all", async () => {
    const { http, calls } = client();
    const storage = new StorageNamespace(http);

    await storage.list({ search: { name: "relatorio" } });
    await storage.list({ parentId: null });
    await storage.list({ parentId: "dir_1", includeSelf: true, extraOptions: { include_pending: true } });

    expect([...calls[0]!.searchParams.keys()]).toEqual(["search[name]", "modifiers[page]"]);
    expect(calls[1]!.searchParams.get("exact_search[parent_id]")).toBe(NULL_SENTINEL);
    expect(calls[2]!.searchParams.get("extra_options[parent_id]")).toBe("dir_1");
    expect(calls[2]!.searchParams.get("extra_options[include_pending]")).toBe("true");
    expect(calls[2]!.searchParams.has("exact_search[parent_id]")).toBe(false);
  });
});
