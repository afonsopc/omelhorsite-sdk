/**
 * `bun test` coverage for `music.artists.syncs` (`/artist_syncs`).
 *
 * The sync namespace sits one property away from `music.artists.imports` and
 * talks to a controller that breaks three house rules at once, so the
 * assertions here are all about failures that produce a plausible-looking
 * result rather than an error:
 *
 * - the index is wrapped in `{ items }` while most of the API answers bare, so
 *   forgetting to unwrap yields `undefined`, not a throw;
 * - `POST` is idempotent server-side (`find_or_initialize_by` behind a unique
 *   index), which is why this is the one create in the music domain that opts
 *   INTO retries. Its neighbour `imports.create` must not, and a copy-paste in
 *   either direction is invisible until a user has two of something;
 * - `DELETE` answers `200 {"ok": true}`, not the `204` every other destroy in
 *   the API uses. A client that asserted 204 would break on a working call;
 * - the id in the path is the {@link ArtistSyncId}, and a Spotify artist id is
 *   also a plausible-looking string in that position. Sending the wrong one is
 *   a 404 that reads like "already unfollowed".
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  MusicArtistSyncsNamespace,
  MusicArtistsNamespace,
  type ArtistSync,
} from "../src/resources/music/artists";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly url: URL;
  /** Raw query string, before decoding, so a stray List DSL key is visible. */
  readonly search: string;
  readonly body: unknown;
}

interface Harness {
  readonly artists: MusicArtistsNamespace;
  readonly syncs: MusicArtistSyncsNamespace;
  readonly calls: Call[];
}

/**
 * Mounts the namespace on a recording fetch.
 *
 * The client default is `retry: false` so nothing retries by accident; the only
 * calls that repeat are the ones whose own method asked to.
 */
function harness(...responses: Array<{ body?: unknown; status?: number }>): Harness {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ method: init?.method ?? "GET", url, search: url.search, body: init?.body });
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
  const artists = new MusicArtistsNamespace(http);
  return { artists, syncs: artists.syncs, calls };
}

function sync(overrides: Partial<ArtistSync> = {}): ArtistSync {
  return {
    id: 12,
    spotify_artist_id: "4Z8W4fKeB5YxbusRsdQVPb",
    artist_name: "Radiohead",
    enabled: true,
    last_checked_at: "2026-08-29T05:12:00.000Z",
    known_album_count: 61,
    ...overrides,
  };
}

/** Parses a recorded JSON request body. */
function jsonBody(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

describe("music.artists.syncs.list", () => {
  test("unwraps the { items } envelope the controller hand-builds", async () => {
    const { syncs, calls } = harness({ body: { items: [sync(), sync({ id: 13 })] } });

    const rows = await syncs.list();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(12);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/artist_syncs");
  });

  test("returns an empty array rather than undefined when the envelope is empty", async () => {
    const { syncs } = harness({ body: {} });
    expect(await syncs.list()).toEqual([]);
  });

  test("sends no query at all: this index is not the List DSL", async () => {
    const { syncs, calls } = harness({ body: { items: [] } });

    await syncs.list();

    // No search[], no exact_search[], no modifiers[page] - the controller
    // allowlists nothing and unknown keys elsewhere in the API fail closed.
    expect(calls[0]?.search).toBe("");
  });

  test("rows carry no created_at/updated_at, so newest-first is the server's job", async () => {
    const { syncs } = harness({ body: { items: [sync({ id: 30 }), sync({ id: 4 })] } });

    const rows = await syncs.list();

    // Order is preserved exactly as received. There is no timestamp on the
    // record to re-sort by, which is the point of asserting it.
    expect(rows.map((row) => row.id)).toEqual([30, 4]);
    expect(rows[0]).not.toHaveProperty("created_at");
  });
});

describe("music.artists.syncs.create", () => {
  test("posts snake_case to /artist_syncs, not to /artist_imports", async () => {
    const { syncs, calls } = harness({ status: 201, body: sync() });

    const row = await syncs.create({
      spotifyArtistId: "4Z8W4fKeB5YxbusRsdQVPb",
      spotifyArtistName: "Radiohead",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/artist_syncs");
    expect(jsonBody(calls[0]!)).toEqual({
      spotify_artist_id: "4Z8W4fKeB5YxbusRsdQVPb",
      spotify_artist_name: "Radiohead",
    });
    expect(row.known_album_count).toBe(61);
  });

  test("omitted name goes out blank, which the server reads as 'leave it alone'", async () => {
    const { syncs, calls } = harness({ status: 201, body: sync({ artist_name: null }) });

    await syncs.create({ spotifyArtistId: "abc" });

    expect(jsonBody(calls[0]!).spotify_artist_name).toBe("");
  });

  test("a blank artist id is refused locally, before the request", async () => {
    const { syncs, calls } = harness({ status: 201, body: sync() });

    await expect(syncs.create({ spotifyArtistId: "   " })).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("surfaces the bare-string Spotify errors with their text intact", async () => {
    const { syncs } = harness({ status: 400, body: "Connect Spotify first." });

    const error = (await syncs
      .create({ spotifyArtistId: "abc" })
      .catch((thrown: unknown) => thrown)) as OmsApiError;

    expect(error).toBeInstanceOf(OmsApiError);
    expect(error.status).toBe(400);
    // The only thing separating "connect" from "relink" is this string.
    expect(error.message).toContain("Connect Spotify first.");
  });

  test("retries a 5xx: the create is idempotent, unlike imports.create", async () => {
    const { syncs, calls } = harness(
      { status: 500, body: "boom" },
      { status: 201, body: sync() },
    );

    // The method hardcodes `retry: {}`; the caller only tightens the timing so
    // the test does not sit through the default 400ms backoff.
    const row = await syncs.create(
      { spotifyArtistId: "abc" },
      { retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false } },
    );

    expect(calls).toHaveLength(2);
    expect(row.id).toBe(12);
  });

  test("a caller can still opt back out of retrying", async () => {
    const { syncs, calls } = harness({ status: 500, body: "boom" });

    await expect(
      syncs.create({ spotifyArtistId: "abc" }, { retry: false }),
    ).rejects.toBeInstanceOf(OmsApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("music.artists.syncs.delete", () => {
  test("uses the sync id in the path, never the Spotify artist id", async () => {
    const { syncs, calls } = harness({ body: { ok: true } });

    await syncs.delete(12);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe("/artist_syncs/12");
  });

  test("swallows the 200 { ok: true } body this controller answers instead of 204", async () => {
    const { syncs } = harness({ status: 200, body: { ok: true } });
    expect(await syncs.delete(12)).toBeUndefined();
  });

  test("is not retried, so a torn connection cannot turn a success into a 404", async () => {
    const { syncs, calls } = harness({ status: 500, body: "boom" });

    await expect(syncs.delete(12)).rejects.toBeInstanceOf(OmsApiError);
    expect(calls).toHaveLength(1);
  });

  test("404 carries the controller's message", async () => {
    const { syncs } = harness({ status: 404, body: "Artist sync not found" });

    const error = (await syncs.delete(999).catch((thrown: unknown) => thrown)) as OmsApiError;

    expect(error.status).toBe(404);
    expect(error.message).toContain("Artist sync not found");
  });
});

describe("mounting", () => {
  test("hangs off music.artists as a sibling of imports", () => {
    const { artists } = harness({ body: { items: [] } });

    expect(artists.syncs).toBeInstanceOf(MusicArtistSyncsNamespace);
    expect(artists.syncs).not.toBe(artists.imports as unknown);
  });

  test("following an artist and importing it are different requests", async () => {
    const { artists, calls } = harness({ status: 201, body: sync() }, { status: 201, body: {} });

    await artists.syncs.create({ spotifyArtistId: "abc" });
    await artists.imports.create({ spotifyArtistId: "abc", albumIds: ["one"] });

    expect(calls.map((call) => call.url.pathname)).toEqual(["/artist_syncs", "/artist_imports"]);
    // The sync body has no album list: a follow never names albums.
    expect(jsonBody(calls[0]!)).not.toHaveProperty("album_ids");
  });
});
