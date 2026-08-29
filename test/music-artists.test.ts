/**
 * `bun test` coverage for the `music.artists` namespace.
 *
 * Every assertion here pins a backend behaviour that fails SILENTLY when the
 * client gets it wrong, which is why they are worth a test at all:
 *
 * - a `PATCH` body nested under `artist` (what the web frontend sends) is
 *   permitted down to an empty hash, saved, and answered with `200` and an
 *   unchanged record. A test that only checked the status would pass;
 * - the banner upload field is `banner`. Send `image` - again, what the web
 *   sends - and the answer is a 400 that looks like a missing file;
 * - the roster index has no default order, so a page request without
 *   `modifiers[order]` walks an unordered relation and quietly loses rows;
 * - `/artist_imports` and `/artist_imports/albums` wrap their arrays in
 *   `{ items }` while everything else in the API answers bare, so an unwrapping
 *   slip yields `undefined` rather than an error;
 * - query brackets must go out percent-encoded or iOS re-encodes the whole
 *   query and the search matches nothing.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { OmsApiError, OmsAuthError, OmsError } from "../src/errors";
import { file, type NativeFile } from "../src/types";
import {
  ARTIST_IMAGE_MAX_BYTES,
  ARTIST_IMPORT_STATES,
  ARTIST_ROSTER_PAGE_SIZE,
  MusicArtistsNamespace,
  isArtistImportTerminal,
  type Artist,
  type ArtistImport,
} from "../src/resources/music/artists";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly url: URL;
  /** Raw query string, BEFORE any decoding, so bracket encoding is visible. */
  readonly search: string;
  readonly body: unknown;
}

interface Harness {
  readonly artists: MusicArtistsNamespace;
  readonly calls: Call[];
}

/** Mounts the namespace on a fetch that records what it was asked to send. */
function harness(...responses: Array<{ body?: unknown; status?: number }>): Harness {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      search: url.search,
      body: init?.body,
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const status = next?.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next?.body ?? null), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl as unknown as typeof fetch,
    tokens: { getToken: () => "session-token" },
    retry: false,
  });
  return { artists: new MusicArtistsNamespace(http), calls };
}

function artist(overrides: Partial<Artist> = {}): Artist {
  return {
    id: 9,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    name: "Chico Buarque",
    canonical_name: "chico buarque",
    slug: "chico-buarque",
    user_id: "user-uuid",
    image_media_id: null,
    image_fs_node_id: null,
    compressed_image_media_id: null,
    compressed_image_fs_node_id: null,
    banner_media_id: null,
    banner_fs_node_id: null,
    compressed_banner_media_id: null,
    compressed_banner_fs_node_id: null,
    mbid: null,
    lastfm_listeners: null,
    lastfm_playcount: null,
    external_image_url: null,
    picture: null,
    picture_small: null,
    picture_medium: null,
    picture_big: null,
    picture_xl: null,
    pictures_fetched_at: null,
    bio_fetched_at: null,
    similar_fetched_at: null,
    songs_count: 0,
    fallback_artwork_media_id: null,
    fallback_artwork_fs_node_id: null,
    ...overrides,
  };
}

function importRecord(overrides: Partial<ArtistImport> = {}): ArtistImport {
  return {
    id: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    user_id: "user-uuid",
    spotify_artist_id: "spotify-artist",
    spotify_artist_name: "Chico Buarque",
    album_ids: ["a1", "a2"],
    state: "queued",
    total_albums: 2,
    total_tracks: null,
    processed_albums: 0,
    queued_count: 0,
    skipped_count: 0,
    failed_count: 0,
    last_message: "Waiting in queue…",
    error_message: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

/** Reads a multipart body back as field name -> value. */
async function formEntries(body: unknown): Promise<Record<string, unknown>> {
  const form = body as FormData;
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) out[key] = value;
  return out;
}

describe("artists.list", () => {
  test("pages at the roster size and sends the order the caller asked for", async () => {
    const { artists, calls } = harness({ body: [artist()] });

    await artists.list({ order: "name:asc" });

    expect(calls[0]?.url.pathname).toBe("/artists");
    expect(calls[0]?.search).toContain(`modifiers%5Bpage%5D=1%3A${ARTIST_ROSTER_PAGE_SIZE}`);
    expect(calls[0]?.search).toContain("modifiers%5Border%5D=name%3Aasc");
  });

  test("brackets are percent-encoded, because iOS re-encodes a raw one", async () => {
    const { artists, calls } = harness({ body: [] });

    await artists.list({ name: "Café" });

    expect(calls[0]?.search).not.toContain("[");
    expect(calls[0]?.search).toContain("search%5Bname%5D=Caf%C3%A9");
  });

  test("name is a partial search, slug and canonical name are exact", async () => {
    const { artists, calls } = harness({ body: [] });

    await artists.list({ name: "chico", slug: "chico-buarque", canonicalName: "chico buarque" });

    const search = calls[0]?.search ?? "";
    expect(search).toContain("search%5Bname%5D=chico");
    expect(search).toContain("exact_search%5Bslug%5D=chico-buarque");
    expect(search).toContain("exact_search%5Bcanonical_name%5D=chico%20buarque");
  });

  test("a filter the caller did not set is omitted, never sent as the null sentinel", async () => {
    const { artists, calls } = harness({ body: [] });

    await artists.list({ name: "chico" });

    // "\b" would be decoded to nil by the server and become `slug IS NULL`,
    // which matches no artist: slug is NOT NULL. An omitted key is the only
    // encoding that means "not filtering".
    expect(calls[0]?.search).not.toContain("exact_search%5Bslug%5D");
    expect(calls[0]?.search).not.toContain("%08");
  });

  test("a full page can be walked, and next() carries the same order", async () => {
    const full = Array.from({ length: ARTIST_ROSTER_PAGE_SIZE }, (_, index) =>
      artist({ id: index + 1 }),
    );
    const { artists, calls } = harness({ body: full }, { body: [artist({ id: 999 })] });

    const first = await artists.list({ order: "created_at:desc" });
    expect(first.hasMore).toBe(true);

    const second = await first.next();

    expect(second?.items).toHaveLength(1);
    expect(second?.hasMore).toBe(false);
    expect(calls[1]?.search).toContain(`modifiers%5Bpage%5D=2%3A${ARTIST_ROSTER_PAGE_SIZE}`);
    expect(calls[1]?.search).toContain("modifiers%5Border%5D=created_at%3Adesc");
  });

  test("an unknown filter key is the server's 400, surfaced as a bare string", async () => {
    const { artists } = harness({ status: 400, body: "Unknown search filter: bio_html" });

    await expect(artists.list({ name: "x" })).rejects.toBeInstanceOf(OmsApiError);
  });
});

describe("artists.get", () => {
  test("takes a numeric id", async () => {
    const { artists, calls } = harness({ body: artist() });

    await artists.get(9);

    expect(calls[0]?.url.pathname).toBe("/artists/9");
  });

  test("takes a slug, and encodes a canonical name with spaces and accents", async () => {
    const { artists, calls } = harness({ body: artist() });

    await artists.get("Beyoncé Knowles");

    expect(calls[0]?.url.pathname).toBe("/artists/Beyonc%C3%A9%20Knowles");
  });

  test("a burnt metadata fetch is a 200 with nulls, not an error", async () => {
    // ArtistResolver rescues every upstream failure and stamps the freshness
    // columns anyway, so this shape is indistinguishable from "Last.fm has
    // never heard of them". Both must read as "no biography".
    const { artists } = artistsWithExtended({
      bio_html: null,
      similar: [],
      bio_fetched_at: "2026-01-01T00:00:00.000Z",
    });

    const found = await artists.get("chico-buarque");

    expect(found.bio_html).toBeNull();
    expect(found.similar).toEqual([]);
  });
});

describe("artists.overview", () => {
  test("is one request to the cached endpoint", async () => {
    const { artists, calls } = harness({
      body: {
        stats: { artists: 2, songs: 40, new_artists: 1, seconds_played: 900 },
        heavy_rotation_window: "all",
        spotlight: null,
        heavy_rotation: [],
        similar: null,
        neglected: [],
      },
    });

    const overview = await artists.overview();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/artists/overview");
    // "all" is not a fallback the client invents; it is how the server says
    // "nothing was played in the last 30 days, so these shelves are all-time".
    expect(overview.heavy_rotation_window).toBe("all");
  });
});

describe("artists.update", () => {
  test("sends a FLAT body - a nested one is a silent no-op on the server", async () => {
    const { artists, calls } = harness({ body: artist({ name: "Chico" }) });

    await artists.update(9, { name: "Chico" });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/artists/9");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ name: "Chico" });
  });

  test("a field the caller did not touch is left out of the body entirely", async () => {
    const { artists, calls } = harness({ body: artist() });

    await artists.update(9, { gallery_image_urls: [] });

    // Sending `name: undefined` would serialise away, but sending `name: null`
    // would blank a NOT NULL column and fail validation. Only what was asked
    // for goes out.
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ gallery_image_urls: [] });
  });

  test("a gallery URL without a scheme is the server's 400", async () => {
    const { artists } = harness({
      status: 400,
      body: "Gallery URLs must start with http:// or https://",
    });

    await expect(
      artists.update(9, { gallery_image_urls: ["example.com/photo.jpg"] }),
    ).rejects.toThrow("Gallery URLs must start with http:// or https://");
  });
});

describe("artists.delete", () => {
  test("204 resolves to nothing", async () => {
    const { artists, calls } = harness({ status: 204 });

    await expect(artists.delete(9)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
  });

  test("an artist that still has credits is refused as 401, not 400", async () => {
    // Artist#destroyable_by? folds "not yours" and "still referenced" into one
    // false, and CrudActions turns that into unauthorized!. A client that
    // treats every 401 as a dead session will try to re-authenticate here.
    const { artists } = harness({
      status: 401,
      body: "You are not authorized to destroy this resource",
    });

    await expect(artists.delete(9)).rejects.toBeInstanceOf(OmsAuthError);
  });
});

describe("artists uploads", () => {
  test("the avatar field is `image`", async () => {
    const { artists, calls } = harness({ body: artist() });

    await artists.uploadImage(9, file(new Blob([new Uint8Array([1, 2, 3])]), "avatar.png"));

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/artists/9/upload_image");
    expect(Object.keys(await formEntries(calls[0]?.body))).toEqual(["image"]);
  });

  test("the banner field is `banner`, NOT `image`", async () => {
    const { artists, calls } = harness({ body: artist() });

    await artists.uploadBanner(9, file(new Blob([new Uint8Array([1, 2, 3])]), "hero.jpg"));

    expect(calls[0]?.url.pathname).toBe("/artists/9/upload_banner");
    const entries = await formEntries(calls[0]?.body);
    expect(Object.keys(entries)).toEqual(["banner"]);
    expect(entries.image).toBeUndefined();
  });

  test("a file over the ceiling fails before the bytes leave the process", async () => {
    const { artists, calls } = harness({ body: artist() });
    const huge: NativeFile = {
      uri: "file:///tmp/huge.png",
      name: "huge.png",
      type: "image/png",
      size: ARTIST_IMAGE_MAX_BYTES + 1,
    };

    await expect(artists.uploadImage(9, huge)).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("a file of unknown size is sent and judged by the server", async () => {
    const { artists, calls } = harness({ body: artist() });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    // A stream declares no length, and buffering one just to measure it would
    // cost more than the round trip that would have 400ed. So it goes out.
    await artists.uploadImage(9, file(stream, "picked.webp"));

    expect(calls).toHaveLength(1);
    expect(Object.keys(await formEntries(calls[0]?.body))).toEqual(["image"]);
  });

  test("the response is the standalone extended view, with no fallback artwork", async () => {
    const { artists } = harness({
      body: { ...artist(), bio_html: null, gallery_image_urls: [], similar: [] },
    });

    const updated = await artists.uploadImage(
      9,
      file(new Blob([new Uint8Array([1])]), "avatar.png"),
    );

    // The blueprint renders without the controller's precomputed map here, so
    // a card redrawn straight from this loses its album-art fallback.
    expect(updated.fallback_artwork_media_id).toBeNull();
  });
});

describe("artists.imports", () => {
  test("search sends q and returns both halves", async () => {
    const { artists, calls } = harness({
      body: { roster: [{ kind: "roster", id: 9, name: "Chico", slug: "chico", image_url: null }], spotify: [] },
    });

    const result = await artists.imports.search("chico");

    expect(calls[0]?.url.pathname).toBe("/artist_imports/search");
    expect(calls[0]?.search).toBe("?q=chico");
    // An empty spotify half is ambiguous by design: no identity, no match, or
    // a swallowed upstream error. It is never an exception.
    expect(result.spotify).toEqual([]);
    expect(result.roster[0]?.kind).toBe("roster");
  });

  test("albums unwraps the { items } envelope", async () => {
    const { artists, calls } = harness({
      body: { items: [{ id: "album-1", name: "Construção" }] },
    });

    const albums = await artists.imports.albums("spotify-artist");

    expect(calls[0]?.search).toBe("?spotify_artist_id=spotify-artist");
    expect(albums).toHaveLength(1);
    expect(albums[0]?.id).toBe("album-1");
  });

  test("a blank spotify id never reaches the server, which would page the owner", async () => {
    const { artists, calls } = harness({ body: { items: [] } });

    // params.require raises ActionController::ParameterMissing, which escapes
    // the API's bare-string error convention AND fires a Discord alert.
    await expect(artists.imports.albums("   ")).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("create maps to the snake_case body the controller reads", async () => {
    const { artists, calls } = harness({ status: 201, body: importRecord() });

    const created = await artists.imports.create({
      spotifyArtistId: "spotify-artist",
      spotifyArtistName: "Chico Buarque",
      albumIds: ["a1", "a2"],
    });

    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      spotify_artist_id: "spotify-artist",
      spotify_artist_name: "Chico Buarque",
      album_ids: ["a1", "a2"],
    });
    expect(created.state).toBe("queued");
  });

  test("an empty album selection is refused locally", async () => {
    const { artists, calls } = harness({ status: 201, body: importRecord() });

    await expect(
      artists.imports.create({ spotifyArtistId: "spotify-artist", albumIds: [] }),
    ).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("list unwraps { items } and omits limit when the caller said nothing", async () => {
    const { artists, calls } = harness({ body: { items: [importRecord()] } });

    const imports = await artists.imports.list();

    expect(calls[0]?.url.pathname).toBe("/artist_imports");
    expect(calls[0]?.search).toBe("");
    expect(imports).toHaveLength(1);
  });

  test("list passes a limit through for the server to clamp", async () => {
    const { artists, calls } = harness({ body: { items: [] } });

    await artists.imports.list({ limit: 500 });

    // 500 is not an error: the controller clamps it to 50. Rejecting it here
    // would be stricter than the server for no gain.
    expect(calls[0]?.search).toBe("?limit=500");
  });

  test("a missing envelope answers with an empty list rather than undefined", async () => {
    const { artists } = harness({ body: {} });

    expect(await artists.imports.list()).toEqual([]);
  });
});

describe("the import state helpers", () => {
  test("the terminal success state is spelled `complete`", async () => {
    expect(ARTIST_IMPORT_STATES).toEqual(["queued", "running", "complete", "failed"]);
    expect(isArtistImportTerminal("complete")).toBe(true);
    expect(isArtistImportTerminal("failed")).toBe(true);
    // The spelling a poll loop reaches for from memory, and never sees.
    expect(isArtistImportTerminal("completed")).toBe(false);
  });

  test("an in-flight import is not terminal", () => {
    expect(isArtistImportTerminal("queued")).toBe(false);
    expect(isArtistImportTerminal("running")).toBe(false);
  });
});

/** A harness whose single response is an artist rendered in the extended view. */
function artistsWithExtended(extra: Record<string, unknown>): Harness {
  return harness({ body: { ...artist(), gallery_image_urls: [], similar: [], ...extra } });
}
