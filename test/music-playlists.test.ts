/**
 * `bun test` coverage for the `music.playlists` namespace.
 *
 * The assertions here are chosen around the ways this particular family of
 * endpoints fails QUIETLY, because those are the ones a type signature cannot
 * catch:
 *
 * - `reorder` matches song ids by identity on the server, so a numeric STRING
 *   moves nothing and still answers 200. The wire body has to carry numbers;
 *   anything else must not reach the network at all.
 * - `PATCH /playlists/:id` distinguishes an absent `artwork_media_id` key
 *   (leave the cover alone) from an explicit `null` (purge it), so the two must
 *   serialise differently.
 * - `POST /play_events` answers with two different shapes on two different
 *   statuses, and the parsed body is the only thing a caller sees.
 * - a mix slug contains colons and must be percent-encoded into the path.
 * - `limit` is silently substituted server-side when it is not a positive
 *   integer, and silently clamped when it is too big.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { OmsApiError } from "../src/errors";
import {
  MIX_KINDS,
  MusicPlaylistsNamespace,
  PLAY_EVENT_MAX_LIMIT,
  PLAY_EVENT_SOURCES,
  PLAYLIST_SEED_CAP,
  isLikedMirror,
  isSystemPlaylist,
  playWasDeduped,
  type MusicPlaylist,
  type RecordPlayResult,
} from "../src/resources/music/playlists";

const BASE_URL = "https://api.test";

/** One recorded request, decomposed into what the assertions actually look at. */
interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly rawQuery: string;
  readonly body: unknown;
  readonly form: FormData | undefined;
  readonly headers: Record<string, string>;
}

interface Harness {
  readonly music: MusicPlaylistsNamespace;
  readonly calls: Call[];
}

type Reply = { body: unknown; status?: number };

/**
 * A fetch double that replays a queue of canned answers and records what it was
 * asked. Answers are consumed in order; the last one repeats, so a test that
 * makes one call passes one reply.
 */
function harness(...replies: Reply[]): Harness {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = init?.body;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      rawQuery: url.search,
      body: typeof body === "string" ? JSON.parse(body) : undefined,
      form: isForm ? (body as FormData) : undefined,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });

    const reply = replies[Math.min(index, replies.length - 1)] ?? { body: null };
    index += 1;
    const status = reply.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(reply.body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
    // No test here exercises the retry policy, and a stray 429 would otherwise
    // sleep out a Retry-After inside the test run.
    retry: false,
  });
  return { music: new MusicPlaylistsNamespace(http), calls };
}

function playlist(overrides: Partial<MusicPlaylist> = {}): MusicPlaylist {
  return {
    id: 7,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    name: "Minhas",
    user_id: "6f1c-user",
    visibility: "private",
    owned: true,
    source_kind: "manual",
    source_provider: null,
    source_url: null,
    source_external_id: null,
    synced_at: null,
    artwork_media_id: null,
    ...overrides,
  };
}

describe("playlists", () => {
  test("list pages with an explicit order, because offset paging without one is unstable", async () => {
    const { music, calls } = harness({ body: [playlist()] });

    const page = await music.list();

    expect(calls[0]?.path).toBe("/playlists");
    expect(calls[0]?.query.get("modifiers[page]")).toBe("1:100");
    expect(calls[0]?.query.get("modifiers[order]")).toBe("created_at:desc");
    expect(page.items).toHaveLength(1);
    expect(page.pageSize).toBe(100);
  });

  test("name filters partially through search, ids exactly through exact_search", async () => {
    const { music, calls } = harness({ body: [] });

    await music.list({ name: "verao", ids: [7, 9] });

    expect(calls[0]?.query.get("search[name]")).toBe("verao");
    expect(calls[0]?.query.getAll("exact_search[id][]")).toEqual(["7", "9"]);
  });

  test("an index that answers with no body at all is an empty page, not a crash", async () => {
    const { music } = harness({ body: null });

    const page = await music.list();

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  test("create sends the seed ids as numbers and refuses more than the server keeps", async () => {
    const { music, calls } = harness({ body: playlist(), status: 201 });

    await music.create({ name: "Radio save", visibility: "friends", artworkMediaId: "blob-1", songIds: [3, 1, 2] });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      name: "Radio save",
      visibility: "friends",
      artwork_media_id: "blob-1",
      song_ids: [3, 1, 2],
    });

    const tooMany = Array.from({ length: PLAYLIST_SEED_CAP + 1 }, (_, i) => i + 1);
    await expect(music.create({ name: "x", songIds: tooMany })).rejects.toThrow(TypeError);
    // The refusal happened before the network, not after a truncated 201.
    expect(calls).toHaveLength(1);
  });

  test("update tells an absent artwork key apart from an explicit null", async () => {
    const { music, calls } = harness({ body: playlist() });

    await music.update(7, { name: "Renamed" });
    expect(calls[0]?.body).toEqual({ name: "Renamed" });
    expect(Object.keys(calls[0]?.body as object)).not.toContain("artwork_media_id");

    await music.update(7, { artworkMediaId: null });
    expect(calls[1]?.body).toEqual({ artwork_media_id: null });
  });

  test("delete accepts the 204 with no body", async () => {
    const { music, calls } = harness({ body: null, status: 204 });

    await expect(music.delete(7)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/playlists/7");
  });

  test("copy posts to the member route with no body", async () => {
    const { music, calls } = harness({ body: playlist({ id: 8, name: "Minhas (cópia)" }), status: 201 });

    const fork = await music.copy(7);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/playlists/7/copy");
    expect(fork.id).toBe(8);
  });
});

describe("reorder", () => {
  test("sends the complete order as numbers", async () => {
    const { music, calls } = harness({ body: [] });

    await expect(music.reorder(7, [23, 11, 42])).resolves.toBeUndefined();

    expect(calls[0]?.path).toBe("/playlists/7/reorder");
    expect(calls[0]?.body).toEqual({ song_ids: [23, 11, 42] });
  });

  test("a numeric string is converted rather than sent, because the server matches by identity", async () => {
    const { music, calls } = harness({ body: [] });

    await music.reorder(7, ["23", "11"] as unknown as number[]);

    // Not ["23","11"]: Array#index against an Integer column would match
    // nothing and the endpoint would answer 200 having moved no rows.
    expect(calls[0]?.body).toEqual({ song_ids: [23, 11] });
  });

  test("a non-integer id is refused locally instead of being a silent no-op", async () => {
    const { music, calls } = harness({ body: [] });

    await expect(music.reorder(7, ["not-an-id"] as unknown as number[])).rejects.toThrow(TypeError);
    await expect(music.reorder(7, [1.5])).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  test("an empty order is refused, because the backend answers it with a 500", async () => {
    const { music, calls } = harness({ body: [] });

    await expect(music.reorder(7, [])).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("artwork upload", () => {
  test("goes out as multipart in the field the controller reads, with no Content-Type of ours", async () => {
    const { music, calls } = harness({ body: playlist({ artwork_media_id: "blob-9" }) });

    await music.uploadArtwork(7, { data: new Uint8Array([1, 2, 3]), filename: "cover.jpg", contentType: "image/jpeg" });

    const call = calls[0];
    expect(call?.path).toBe("/playlists/7/upload_artwork");
    expect(call?.method).toBe("POST");
    expect(call?.form).toBeDefined();

    const part = call?.form?.get("artwork");
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe("cover.jpg");
    expect((part as Blob).type).toBe("image/jpeg");
    // The runtime has to write the boundary; a Content-Type from us would not
    // carry one and the upload would arrive unparsable.
    expect(call?.headers["Content-Type"]).toBeUndefined();
    expect(call?.headers["content-type"]).toBeUndefined();
  });

  test("a React Native descriptor is refused on a web FormData rather than uploaded as text", async () => {
    const { music } = harness({ body: playlist() });

    // Bun's FormData is the web one, so this is the non-RN branch: appending the
    // descriptor verbatim would send the string "[object Object]" and answer 200.
    await expect(
      music.uploadArtwork(7, { uri: "file:///tmp/cover.jpg", name: "cover.jpg", type: "image/jpeg" }),
    ).rejects.toThrow(TypeError);
  });
});

describe("playlist songs", () => {
  test("a playlist is read in position order, filtered through exact_search", async () => {
    const { music, calls } = harness({ body: [] });

    await music.songs.list({ playlistId: 7, pageSize: 100, page: 2 });

    expect(calls[0]?.path).toBe("/playlist_songs");
    expect(calls[0]?.query.get("exact_search[playlist_id]")).toBe("7");
    expect(calls[0]?.query.get("modifiers[page]")).toBe("2:100");
    expect(calls[0]?.query.get("modifiers[order]")).toBe("position:asc");
  });

  test("hidden: false survives as a filter instead of being dropped as falsy", async () => {
    const { music, calls } = harness({ body: [] });

    await music.songs.list({ playlistId: 7, hidden: false, origin: "sync" });

    expect(calls[0]?.query.get("exact_search[hidden]")).toBe("false");
    expect(calls[0]?.query.get("exact_search[origin]")).toBe("sync");
  });

  test("no filters means no exact_search bucket at all", async () => {
    const { music, calls } = harness({ body: [] });

    await music.songs.list();

    expect(calls[0]?.rawQuery).not.toContain("exact_search");
  });

  test("add posts the pair, remove and hide address the JOIN ROW id", async () => {
    const { music, calls } = harness({ body: null, status: 204 });

    await music.songs.remove(900);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/playlist_songs/900");

    const second = harness({ body: {} });
    await second.music.songs.hide(900);
    expect(second.calls[0]?.path).toBe("/playlist_songs/900/hide");
    await second.music.songs.unhide(900);
    expect(second.calls[1]?.path).toBe("/playlist_songs/900/unhide");

    const third = harness({ body: {}, status: 201 });
    await third.music.songs.add(7, 123);
    expect(third.calls[0]?.body).toEqual({ playlist_id: 7, song_id: 123 });
  });
});

describe("mixes and radios", () => {
  test("a mix slug is percent-encoded, colons included", async () => {
    const { music, calls } = harness({ body: { slug: "mix:top_artist:1:ab12cd34", songs: [] } });

    await music.mixes.get("mix:top_artist:1:ab12cd34");

    // The raw path must not carry bare colons through to the router.
    expect(calls[0]?.path).toBe("/music_mixes/mix%3Atop_artist%3A1%3Aab12cd34");
  });

  test("a rotated slug surfaces as a plain 404, which is an ordinary outcome here", async () => {
    const { music } = harness({ body: "Mix not found", status: 404 });

    await expect(music.mixes.get("mix:gone:1:0000")).rejects.toThrow(OmsApiError);
  });

  test("the mix list tolerates an empty answer", async () => {
    const { music } = harness({ body: null });

    await expect(music.mixes.list()).resolves.toEqual([]);
    expect(MIX_KINDS).toContain("top_artist");
  });

  test("radios encode the artist segment and take the song id as a path segment", async () => {
    const { music, calls } = harness({ body: { slug: "radio:artist:abc", songs: [] } });

    await music.radios.forArtist("chico buarque");
    expect(calls[0]?.path).toBe("/music_radios/artist/chico%20buarque");

    await music.radios.forSong(123);
    expect(calls[1]?.path).toBe("/music_radios/song/123");
  });
});

describe("play events", () => {
  test("a deduped play and a stored one are told apart by shape, not by status", async () => {
    const stored = harness({ body: { id: 1, song_id: 123, deduped: undefined }, status: 201 });
    const first: RecordPlayResult = await stored.music.plays.record({ songId: 123, source: "oms-ios" });
    expect(playWasDeduped(first)).toBe(false);
    expect(stored.calls[0]?.body).toEqual({ song_id: 123, source: "oms-ios" });

    const swallowed = harness({ body: { deduped: true }, status: 200 });
    const second = await swallowed.music.plays.record({ songId: 123 });
    expect(playWasDeduped(second)).toBe(true);
    // `deduped` is the only key; reaching for `.id` on it would be undefined.
    expect(swallowed.calls[0]?.body).toEqual({ song_id: 123 });
  });

  test("listened seconds ride along when given", async () => {
    const { music, calls } = harness({ body: { deduped: true } });

    await music.plays.record({ songId: 5, source: PLAY_EVENT_SOURCES[2], listenedSeconds: 182.4 });

    expect(calls[0]?.body).toEqual({ song_id: 5, source: "web", listened_s: 182.4 });
  });

  test("recent reads send group_by and nothing from the list DSL", async () => {
    const { music, calls } = harness({ body: [] });

    await music.plays.recentSongs({ limit: 24 });
    expect(calls[0]?.path).toBe("/play_events/recent");
    expect(calls[0]?.query.get("group_by")).toBe("song");
    expect(calls[0]?.query.get("limit")).toBe("24");
    expect(calls[0]?.rawQuery).not.toContain("modifiers");

    await music.plays.recentAlbums();
    expect(calls[1]?.query.get("group_by")).toBe("album");
    // Omitted rather than guessed: the server's own default is 24.
    expect(calls[1]?.query.get("limit")).toBeNull();
  });

  test("top reads carry scope, and since only when asked for", async () => {
    const { music, calls } = harness({ body: [] });

    await music.plays.topSongs({ since: "30d", artist: "Chico" });
    expect(calls[0]?.query.get("scope")).toBe("song");
    expect(calls[0]?.query.get("since")).toBe("30d");
    expect(calls[0]?.query.get("artist")).toBe("Chico");

    await music.plays.topArtists();
    expect(calls[1]?.query.get("scope")).toBe("artist");
    expect(calls[1]?.query.get("since")).toBeNull();

    await music.plays.topAlbums({ since: "all" });
    expect(calls[2]?.query.get("scope")).toBe("album");
    expect(calls[2]?.query.get("since")).toBe("all");
  });

  test("a limit the server would silently replace or clamp is caught or clamped here", async () => {
    const { music, calls } = harness({ body: [] });

    // 0 and negatives read as "use the default" server-side, which hides the bug.
    await expect(music.plays.topSongs({ limit: 0 })).rejects.toThrow(TypeError);
    await expect(music.plays.recentSongs({ limit: -1 })).rejects.toThrow(TypeError);
    await expect(music.plays.recentSongs({ limit: 2.5 })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);

    // An overshoot is legitimate and is clamped to the same number the server
    // would have applied, so the caller is not told it got 5000 rows.
    await music.plays.recentSongs({ limit: 5000 });
    expect(calls[0]?.query.get("limit")).toBe(String(PLAY_EVENT_MAX_LIMIT));
  });
});

describe("system playlist predicates", () => {
  test("anything but manual counts as synced, including a kind nobody has seen", async () => {
    expect(isSystemPlaylist(playlist({ source_kind: "manual" }))).toBe(false);
    expect(isSystemPlaylist(playlist({ source_kind: null }))).toBe(false);
    expect(isSystemPlaylist(playlist({ source_kind: "spotify_sync" }))).toBe(true);
    expect(isSystemPlaylist(playlist({ source_kind: "some_future_provider" }))).toBe(true);
  });

  test("the liked mirror is a system playlist with the reserved external id", async () => {
    expect(isLikedMirror(playlist({ source_kind: "spotify_sync", source_external_id: "liked" }))).toBe(true);
    // A manual playlist that happens to carry the marker is not the mirror.
    expect(isLikedMirror(playlist({ source_kind: "manual", source_external_id: "liked" }))).toBe(false);
    expect(isLikedMirror(playlist({ source_kind: "spotify_sync", source_external_id: "37i9" }))).toBe(false);
  });
});
