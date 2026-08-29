/**
 * `bun test` coverage for the `movies` namespace.
 *
 * The tests here are not "does it call the right path". They pin the five
 * places where this API does something a reader would not guess, and where
 * getting it wrong is silent rather than loud:
 *
 * 1. `PATCH /movie_addons/:id` assigns `manifest_json` unconditionally, so a
 *    partial patch wipes it and 400s. The manifest must be on the wire every
 *    time, and `moveToGroup` must put it there.
 * 2. `finished` is three-state. `null` and "absent" mean the same thing to the
 *    server, and only a real boolean makes "marcar como nao visto" stick.
 * 3. `/movie_watch_progresses/bulk` truncates past 200 entries in SILENCE and
 *    still answers 200, so the SDK has to refuse before sending.
 * 4. Array id filters only work on the two indexes whose controller declared
 *    `id: []`; elsewhere `permit` drops them and the answer is the UNFILTERED
 *    list, which is why the types only take a scalar there.
 * 5. The watch-progress index ignores the query string entirely, so anything
 *    that looks like a filter would be a lie.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { OmsError } from "../src/errors";
import {
  MOVIE_COLLECTION_FAVORITES_KIND,
  MOVIE_WATCH_BULK_LIMIT,
  MoviesNamespace,
  isSystemMovieCollection,
  movieWatchFinished,
  type MovieAddon,
  type MovieCollection,
  type MovieWatchProgressInput,
  type StremioManifest,
} from "../src/resources/movies";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  /** Decoded query string, so a test can assert on `exact_search[id][]=a`. */
  readonly query: string;
  readonly body: Record<string, unknown> | undefined;
}

interface Harness {
  readonly movies: MoviesNamespace;
  readonly calls: Call[];
}

/** Answers every request with `body`, recording what was asked. */
function harness(body: unknown, status = 200): Harness {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: decodeURIComponent(url.search.replace(/^\?/, "")),
      body: raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>),
    });
    if (status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
  });
  return { movies: new MoviesNamespace(http), calls };
}

function addon(overrides: Partial<MovieAddon> = {}): MovieAddon {
  return {
    id: "aaaaaaaaaaaa",
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    user_id: "uuuuuuuuuuuu",
    movie_addon_group_id: null,
    manifest_url: "https://addon.example/manifest.json",
    manifest_json: { id: "org.example", name: "Example", version: "1.0.0" },
    shared: false,
    ...overrides,
  };
}

function progressInput(overrides: Partial<MovieWatchProgressInput> = {}): MovieWatchProgressInput {
  return {
    movie_type: "series",
    movie_id: "tt0903747",
    video_id: "tt0903747:1:1",
    position: 120,
    duration: 2820,
    last_watched_at: "2026-08-29T12:00:00Z",
    ...overrides,
  };
}

describe("addons", () => {
  test("list filters through exact_search and pages 1-based", async () => {
    const { movies, calls } = harness([addon()]);

    const page = await movies.addons.list({
      userId: "uuuuuuuuuuuu",
      order: "created_at:desc",
      pageSize: 25,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/movie_addons");
    // user_id is a string column: `search` would be a slugified LIKE, which
    // would match other people's ids by prefix. It has to be exact_search.
    expect(calls[0]!.query).toContain("exact_search[user_id]=uuuuuuuuuuuu");
    expect(calls[0]!.query).toContain("modifiers[page]=1:25");
    expect(calls[0]!.query).toContain("modifiers[order]=created_at:desc");
    expect(page.items).toHaveLength(1);
    expect(page.pageSize).toBe(25);
  });

  test("update always sends manifest_json, even when only the group changes", async () => {
    const { movies, calls } = harness(addon({ movie_addon_group_id: "gggggggggggg" }));

    await movies.addons.update("aaaaaaaaaaaa", {
      manifest_json: { id: "org.example", name: "Example" },
      movie_addon_group_id: "gggggggggggg",
    });

    expect(calls[0]!.method).toBe("PATCH");
    // The controller does `permitted[:manifest_json] = params[:manifest_json]`
    // unconditionally, so an absent key becomes nil and trips a presence
    // validation. The manifest is not optional on a patch.
    expect(calls[0]!.body).toHaveProperty("manifest_json");
    expect(calls[0]!.body!.movie_addon_group_id).toBe("gggggggggggg");
  });

  test("moveToGroup carries the manifest across and can un-group with null", async () => {
    const { movies, calls } = harness(addon());

    await movies.addons.moveToGroup(addon(), null);

    expect(calls[0]!.body!.manifest_json).toEqual({
      id: "org.example",
      name: "Example",
      version: "1.0.0",
    });
    expect(calls[0]!.body!.movie_addon_group_id).toBeNull();
  });

  test("moveToGroup refuses a shared addon before spending a request", async () => {
    const { movies, calls } = harness(addon());

    await expect(movies.addons.moveToGroup(addon({ shared: true }), "gggggggggggg")).rejects.toThrow(
      OmsError,
    );
    expect(calls).toHaveLength(0);
  });

  test("create refuses an empty manifest, which the server reads as blank", async () => {
    const { movies, calls } = harness(addon());

    await expect(
      movies.addons.create({
        manifest_url: "https://addon.example/manifest.json",
        // `{}` is not a valid manifest, and the point of the test is that the
        // server calls it blank rather than storing it.
        manifest_json: {} as unknown as StremioManifest,
      }),
    ).rejects.toThrow(/cannot be empty/);
    expect(calls).toHaveLength(0);
  });

  test("create omits movie_addon_group_id entirely when the key is absent", async () => {
    const { movies, calls } = harness(addon());

    await movies.addons.create({
      manifest_url: "https://addon.example/manifest.json",
      manifest_json: { id: "org.example", name: "Example" },
    });

    // Re-installing with the key absent leaves the stored group alone; sending
    // null would clear it. The two must not be conflated.
    expect(Object.keys(calls[0]!.body!)).not.toContain("movie_addon_group_id");
  });
});

describe("addon grants", () => {
  test("refuses both targets and refuses neither", async () => {
    const { movies, calls } = harness({});

    await expect(
      movies.addons.grants.create({
        movie_addon_id: "aaaaaaaaaaaa",
        movie_addon_group_id: "gggggggggggg",
        grantee_id: "uuuuuuuuuuuu",
      }),
    ).rejects.toThrow(OmsError);
    await expect(movies.addons.grants.create({ grantee_id: "uuuuuuuuuuuu" })).rejects.toThrow(
      OmsError,
    );
    expect(calls).toHaveLength(0);
  });

  test("sends exactly one target", async () => {
    const { movies, calls } = harness({});

    await movies.addons.grants.create({
      movie_addon_group_id: "gggggggggggg",
      grantee_id: "uuuuuuuuuuuu",
    });

    expect(calls[0]!.path).toBe("/movie_addon_grants");
    expect(calls[0]!.body!.movie_addon_group_id).toBe("gggggggggggg");
    expect(calls[0]!.body).not.toHaveProperty("movie_addon_id");
  });
});

describe("addon groups", () => {
  test("rejects a name past the 80 character column limit", async () => {
    const { movies, calls } = harness({});

    await expect(movies.addons.groups.create("x".repeat(81))).rejects.toThrow(OmsError);
    expect(calls).toHaveLength(0);
  });
});

describe("collections", () => {
  test("name goes through search, kind and id arrays through exact_search", async () => {
    const { movies, calls } = harness([]);

    await movies.collections.list({
      name: "favor",
      kind: "manual",
      id: ["cccccccccccc", "dddddddddddd"],
      order: "position:asc",
    });

    // `name` is the slugifying LIKE a search box wants.
    expect(calls[0]!.query).toContain("search[name]=favor");
    // `kind` and `id` are equality; `id` is one of the two indexes that
    // declared `id: []`, so the array form actually filters here.
    expect(calls[0]!.query).toContain("exact_search[kind]=manual");
    expect(calls[0]!.query).toContain("exact_search[id][]=cccccccccccc");
    expect(calls[0]!.query).toContain("exact_search[id][]=dddddddddddd");
  });

  test("favorites() asks for the system row and reads it back", async () => {
    const favorite: MovieCollection = {
      id: "ffffffffffff",
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-08-01T10:00:00Z",
      user_id: "uuuuuuuuuuuu",
      name: "Favoritos",
      kind: MOVIE_COLLECTION_FAVORITES_KIND,
      position: -1,
      system: true,
      items_count: 3,
    };
    const { movies, calls } = harness([favorite]);

    const found = await movies.collections.favorites();

    expect(calls[0]!.query).toContain("exact_search[kind]=favorites");
    expect(found?.id).toBe("ffffffffffff");
    expect(isSystemMovieCollection(favorite)).toBe(true);
  });

  test("reorder posts to the member route and answers with the collection", async () => {
    const { movies, calls } = harness({ id: "cccccccccccc", kind: "manual" });

    await movies.collections.reorder("cccccccccccc", ["i1", "i2"]);

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/movie_collections/cccccccccccc/reorder");
    expect(calls[0]!.body!.item_ids).toEqual(["i1", "i2"]);
  });

  test("items list narrows to several collections in one request", async () => {
    const { movies, calls } = harness([]);

    await movies.collections.items.list({ collectionId: ["cccccccccccc", "dddddddddddd"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("exact_search[movie_collection_id][]=cccccccccccc");
    expect(calls[0]!.query).toContain("exact_search[movie_collection_id][]=dddddddddddd");
  });

  test("items create keeps an explicit null so a stale poster can be cleared", async () => {
    const { movies, calls } = harness({});

    await movies.collections.items.create({
      movie_collection_id: "cccccccccccc",
      movie_type: "movie",
      movie_id: "tt1375666",
      name: "Inception",
      poster: null,
    });

    expect(calls[0]!.body!.name).toBe("Inception");
    expect(calls[0]!.body!.poster).toBeNull();
    // Omitted keys must not appear at all: absent means "leave it alone".
    expect(Object.keys(calls[0]!.body!)).not.toContain("background");
  });

  test("items create refuses a blank movie id before spending a request", async () => {
    const { movies, calls } = harness({});

    await expect(
      movies.collections.items.create({
        movie_collection_id: "cccccccccccc",
        movie_type: "movie",
        movie_id: "   ",
      }),
    ).rejects.toThrow(OmsError);
    expect(calls).toHaveLength(0);
  });
});

describe("watch progress", () => {
  test("list sends no query at all, because the index ignores one", async () => {
    const { movies, calls } = harness([]);

    const rows = await movies.watchProgress.list();

    expect(calls[0]!.path).toBe("/movie_watch_progresses");
    // The controller never reads search/exact_search/modifiers here. Emitting
    // any of them would look like a filter and silently do nothing.
    expect(calls[0]!.query).toBe("");
    expect(rows).toEqual([]);
  });

  test("a plain tick leaves `finished` off the wire", async () => {
    const { movies, calls } = harness({});

    await movies.watchProgress.save(progressInput());

    expect(calls[0]!.method).toBe("POST");
    expect(Object.keys(calls[0]!.body!)).not.toContain("finished");
    expect(calls[0]!.body!.last_watched_at).toBe("2026-08-29T12:00:00Z");
  });

  test("`finished: null` is dropped, exactly as the controller would drop it", async () => {
    const { movies, calls } = harness({});

    // The field is typed `boolean | undefined`, so this is the shape that
    // reaches the SDK from untyped JavaScript rather than one TS would allow.
    await movies.watchProgress.save({
      ...progressInput(),
      finished: null as unknown as boolean,
    });

    expect(Object.keys(calls[0]!.body!)).not.toContain("finished");
  });

  test("setWatched(false) sends a real false, which is what makes it stick", async () => {
    const { movies, calls } = harness({});

    await movies.watchProgress.setWatched(
      { movie_type: "movie", movie_id: "tt1375666", video_id: "tt1375666" },
      false,
    );

    // position 0 / duration 0 would make the model's derivation bail out and
    // leave the stored flag alone. The explicit boolean sets `finished_given`,
    // which is the whole fix for "marcar como nao visto".
    expect(calls[0]!.body!.finished).toBe(false);
    expect(calls[0]!.body!.position).toBe(0);
    expect(calls[0]!.body!.duration).toBe(0);
  });

  test("saveMany sends one request for a whole season", async () => {
    const { movies, calls } = harness([]);
    const season = Array.from({ length: 24 }, (_, index) =>
      progressInput({ video_id: `tt0903747:1:${index + 1}`, finished: true }),
    );

    await movies.watchProgress.saveMany(season);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/movie_watch_progresses/bulk");
    expect((calls[0]!.body!.items as unknown[]).length).toBe(24);
  });

  test("saveMany refuses a batch the server would truncate in silence", async () => {
    const { movies, calls } = harness([]);
    const tooMany = Array.from({ length: MOVIE_WATCH_BULK_LIMIT + 1 }, (_, index) =>
      progressInput({ video_id: `tt0903747:1:${index + 1}` }),
    );

    await expect(movies.watchProgress.saveMany(tooMany)).rejects.toThrow(OmsError);
    await expect(movies.watchProgress.saveMany([])).rejects.toThrow(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("forgetMovie is a DELETE carrying the addon's title id as a query param", async () => {
    const { movies, calls } = harness(null, 204);

    await movies.watchProgress.forgetMovie("tt0903747");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe("/movie_watch_progresses/for_movie");
    expect(calls[0]!.query).toBe("movie_id=tt0903747");
  });

  test("delete answers 204 with no body", async () => {
    const { movies, calls } = harness(null, 204);

    await expect(movies.watchProgress.delete("pppppppppppp")).resolves.toBeUndefined();
    expect(calls[0]!.path).toBe("/movie_watch_progresses/pppppppppppp");
  });
});

describe("movieWatchFinished", () => {
  test("mirrors the server's 95% threshold", () => {
    expect(movieWatchFinished(2679, 2820)).toBe(true);
    expect(movieWatchFinished(120, 2820)).toBe(false);
  });

  test("returns null when the server would decline to decide", () => {
    // duration <= 0 is exactly the branch where `set_finished` leaves the
    // stored flag untouched. Reporting `false` here is how an optimistic UI
    // un-ticks something the server still considers watched.
    expect(movieWatchFinished(0, 0)).toBeNull();
    expect(movieWatchFinished(10, -1)).toBeNull();
  });
});
