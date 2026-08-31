/**
 * `bun test` coverage for the `music.songs` namespace.
 *
 * The assertions here are almost all about the WIRE, because that is where
 * this namespace's bugs live. Four of them are worth naming:
 *
 * - `album: null` has to leave as the `\b` sentinel, or "songs with no album"
 *   silently becomes "songs whose album is the empty string";
 * - `artist_role` has to sit at the TOP LEVEL. Nested inside `exact_search` it
 *   would both miss the filter and trip the fail-closed unknown-key check;
 * - a multipart update has to encode `null` as the sentinel and an empty
 *   `featured_artist_names` as one empty string, because an absent key means
 *   the OPPOSITE thing server-side (re-parse the title);
 * - `external_search` answers 400 for a rate limit, so the classification
 *   helper is the only thing standing between a spent budget and a retry loop.
 *
 * The retry assertions count requests rather than measure time: the point is
 * that the translation and sync endpoints, whose hourly counters increment even
 * on a rejection, are attempted exactly once.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError } from "../src/errors";
import { ApiClient, NULL_SENTINEL } from "../src/http";
import {
  LIKED_SONGS_DEFAULT_LIMIT,
  LYRICS_TRANSLATION_TARGETS,
  MusicSongsNamespace,
  SONG_FILTER_COLUMNS,
  isMusicExternalSearchRateLimited,
  songArtistsLine,
  type Song,
  type SongArtistCredit,
} from "../src/resources/music/songs";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
  readonly form: FormData | undefined;
}

interface Harness {
  readonly songs: MusicSongsNamespace;
  readonly calls: Call[];
}

interface Reply {
  readonly body?: unknown;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** Raw text, for the endpoints that do not answer JSON. */
  readonly text?: string;
}

/** A fetch double that records every attempt and replays scripted answers. */
function harness(replies: Reply | Reply[]): Harness {
  const script = Array.isArray(replies) ? [...replies] : [replies];
  const calls: Call[] = [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    calls.push({
      method: init?.method ?? "GET",
      url: new URL(input),
      body: typeof body === "string" ? JSON.parse(body) : undefined,
      form: body instanceof FormData ? body : undefined,
    });

    const reply = script.length > 1 ? (script.shift() as Reply) : (script[0] as Reply);
    const status = reply.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(reply.text ?? JSON.stringify(reply.body ?? null), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...(reply.headers ?? {}) },
    });
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
  });
  return { songs: new MusicSongsNamespace(http), calls };
}

function credit(overrides: Partial<SongArtistCredit> = {}): SongArtistCredit {
  return {
    id: 55,
    created_at: "2026-01-01T10:00:00.000Z",
    updated_at: "2026-01-01T10:00:00.000Z",
    song_id: 123,
    artist_id: 9,
    position: 0,
    role: "primary",
    name: "Chico Buarque",
    slug: "chico-buarque",
    image_media_id: null,
    compressed_image_media_id: null,
    picture: null,
    picture_medium: null,
    external_image_url: null,
    ...overrides,
  };
}

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: 123,
    created_at: "2026-01-01T10:00:00.000Z",
    updated_at: "2026-01-01T10:00:00.000Z",
    title: "Construção",
    album: "Construção",
    duration: 380,
    position: 4,
    year: 1971,
    user_id: "3f1c-uuid",
    source_kind: "upload",
    source_provider: null,
    source_url: null,
    source_id: null,
    isrc: null,
    language: null,
    tags: [],
    bpm: null,
    original_filename: "construcao.flac",
    audio_codec: "flac",
    audio_bitrate_kbps: 1411,
    audio_sample_rate_hz: 44_100,
    audio_channels: 2,
    audio_lossless: true,
    audio_filesize_bytes: 31_457_280,
    audio_media_id: "node-audio",
    compressed_audio_media_id: "node-audio-small",
    artwork_media_id: "node-art",
    compressed_artwork_media_id: "node-art-small",
    vocals_media_id: null,
    instrumental_media_id: null,
    vocal_separation_started_at: null,
    artists: [credit()],
    ...overrides,
  };
}

/** All the `key=value` pairs of a query, decoded. */
function query(call: Call): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of call.url.searchParams) out[key] = value;
  return out;
}

describe("songs.list", () => {
  test("always sends a page modifier, because the server forces one anyway", async () => {
    const { songs, calls } = harness({ body: [song()] });

    const page = await songs.list();

    expect(calls[0]?.url.pathname).toBe("/songs");
    expect(query(calls[0] as Call)["modifiers[page]"]).toBe("1:100");
    expect(page.items).toHaveLength(1);
    expect(page.pageSize).toBe(100);
  });

  test("defaults to the endpoint's own base order, which is what makes paging stable", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.list();

    expect(query(calls[0] as Call)["modifiers[order]"]).toBe("created_at:asc");
  });

  test("clamps the page size to the server's ceiling instead of reporting a lie", async () => {
    const { songs, calls } = harness({ body: [] });

    const page = await songs.list({ pageSize: 1200 });

    expect(query(calls[0] as Call)["modifiers[page]"]).toBe("1:500");
    expect(page.pageSize).toBe(500);
  });

  test("a short page ends the list; a full one does not", async () => {
    const full = harness({ body: Array.from({ length: 2 }, (_, i) => song({ id: i + 1 })) });
    const short = harness({ body: [song()] });

    expect((await full.songs.list({ pageSize: 2 })).hasMore).toBe(true);
    expect((await short.songs.list({ pageSize: 2 })).hasMore).toBe(false);
  });

  test("album null leaves as the backend's null sentinel, not as an empty string", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.list({ album: null });

    expect(query(calls[0] as Call)["exact_search[album]"]).toBe(NULL_SENTINEL);
    expect(query(calls[0] as Call)["exact_search[album]"]).not.toBe("");
  });

  test("a named album is an exact filter, and a title is a partial one", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.list({ album: "Clube da Esquina", title: "cafe" });

    const sent = query(calls[0] as Call);
    expect(sent["exact_search[album]"]).toBe("Clube da Esquina");
    expect(sent["search[title]"]).toBe("cafe");
  });

  test("artist_role rides at the top level, and the artist inside exact_search", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.list({ artist: "chico-buarque", artistRole: "featured" });

    const sent = query(calls[0] as Call);
    expect(sent["exact_search[artist]"]).toBe("chico-buarque");
    expect(sent["artist_role"]).toBe("featured");
    expect(sent["exact_search[artist_role]"]).toBeUndefined();
  });

  test("an id list is encoded the way Rails reads an array", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.list({ ids: [1, 2, 3] });

    expect(calls[0]?.url.searchParams.getAll("exact_search[id][]")).toEqual(["1", "2", "3"]);
  });

  test("the escape hatches pass through verbatim", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.list({ search: { album: "esquina" }, exactSearch: { year: 1972 } });

    const sent = query(calls[0] as Call);
    expect(sent["search[album]"]).toBe("esquina");
    expect(sent["exact_search[year]"]).toBe("1972");
  });

  test("random is sent as a modifier", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.list({ random: true });

    expect(query(calls[0] as Call)["modifiers[random]"]).toBe("true");
  });

  test("survives a body that is not an array rather than throwing", async () => {
    const { songs } = harness({ body: null });

    expect((await songs.list()).items).toEqual([]);
  });
});

describe("songs.albums", () => {
  test("sends no page modifier by default: paging it pages SONGS, not albums", async () => {
    const { songs, calls } = harness({ body: [{ name: "Acabou Chorare", artist: "Novos Baianos" }] });

    const albums = await songs.albums();

    expect(calls[0]?.url.pathname).toBe("/songs/albums");
    expect(query(calls[0] as Call)["modifiers[page]"]).toBeUndefined();
    expect(albums).toHaveLength(1);
  });

  test("still pages when explicitly asked to", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.albums({ page: 2, pageSize: 500 });

    expect(query(calls[0] as Call)["modifiers[page]"]).toBe("2:500");
  });

  test("carries the same artist filter as the listing", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.albums({ artist: "Novos Baianos" });

    expect(query(calls[0] as Call)["exact_search[artist]"]).toBe("Novos Baianos");
  });
});

describe("songs.update", () => {
  test("stays JSON while there is no artwork, and keeps null as null", async () => {
    const { songs, calls } = harness({ body: song({ album: null }) });

    await songs.update(123, { album: null, title: "Construção" });

    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/songs/123");
    expect(calls[0]?.body).toEqual({ album: null, title: "Construção" });
  });

  test("an empty featured list is sent, not dropped: absent means re-parse the title", async () => {
    const { songs, calls } = harness({ body: song() });

    await songs.update(123, { artistNames: ["Chico Buarque"], featuredArtistNames: [] });

    expect(calls[0]?.body).toEqual({ artist_names: ["Chico Buarque"], featured_artist_names: [] });
  });

  test("omits every field the caller did not name", async () => {
    const { songs, calls } = harness({ body: song() });

    await songs.update(123, { title: "Deus lhe pague" });

    expect(calls[0]?.body).toEqual({ title: "Deus lhe pague" });
  });

  test("artwork switches the request to multipart", async () => {
    const { songs, calls } = harness({ body: song() });

    await songs.update(123, {
      title: "Construção",
      artwork: { data: new Blob(["png"]), filename: "cover.png", contentType: "image/png" },
    });

    const form = calls[0]?.form;
    expect(form).toBeDefined();
    expect(form?.get("title")).toBe("Construção");
    expect(form?.get("artwork")).toBeInstanceOf(Blob);
  });

  test("multipart CAN clear a column: null goes out as the sentinel", async () => {
    const { songs, calls } = harness({ body: song() });

    await songs.update(123, {
      album: null,
      year: null,
      artwork: { data: new Blob(["png"]), filename: "cover.png" },
    });

    expect(calls[0]?.form?.get("album")).toBe(NULL_SENTINEL);
    expect(calls[0]?.form?.get("year")).toBe(NULL_SENTINEL);
  });

  test("multipart spells an empty featured list as one empty string, never as no parts", async () => {
    const { songs, calls } = harness({ body: song() });

    await songs.update(123, {
      featuredArtistNames: [],
      artwork: { data: new Blob(["png"]), filename: "cover.png" },
    });

    // Appending [] would append nothing, which is the same wire as an absent
    // key - and an absent key puts the backend back into title-parsing mode.
    expect(calls[0]?.form?.getAll("featured_artist_names[]")).toEqual([""]);
  });

  test("multipart keeps a real featured list as one part per name", async () => {
    const { songs, calls } = harness({ body: song() });

    await songs.update(123, {
      featuredArtistNames: ["Elis Regina", "Milton Nascimento"],
      artwork: { data: new Blob(["png"]), filename: "cover.png" },
    });

    expect(calls[0]?.form?.getAll("featured_artist_names[]")).toEqual(["Elis Regina", "Milton Nascimento"]);
  });
});

describe("songs.import and songs.delete", () => {
  test("import posts multipart to /songs/import", async () => {
    const { songs, calls } = harness({ body: song() });

    const created = await songs.import({ data: new Blob(["audio"]), filename: "a.flac" });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/songs/import");
    expect(calls[0]?.form?.get("file")).toBeInstanceOf(Blob);
    expect(created.id).toBe(123);
  });

  test("delete takes a 204 without trying to parse it", async () => {
    const { songs, calls } = harness({ status: 204 });

    await songs.delete(123);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe("/songs/123");
  });
});

describe("songs.artistNames and songs.artistPictures", () => {
  test("artistNames takes no filters, because the endpoint ignores them", async () => {
    const { songs, calls } = harness({ body: ["Chico Buarque", "Elis Regina"] });

    const names = await songs.artistNames();

    expect(calls[0]?.url.search).toBe("");
    expect(names).toEqual(["Chico Buarque", "Elis Regina"]);
  });

  test("artistPictures unwraps the envelope", async () => {
    const { songs, calls } = harness({
      body: { pictures: [{ picture: "https://deezer/x", picture_small: null, picture_medium: null, picture_big: null, picture_xl: null }] },
    });

    const pictures = await songs.artistPictures("Chico Buarque");

    expect(query(calls[0] as Call)["name"]).toBe("Chico Buarque");
    expect(pictures[0]?.picture).toBe("https://deezer/x");
  });

  test("an artist outside the roster is an empty array, not an error", async () => {
    const { songs } = harness({ body: { pictures: [] } });

    expect(await songs.artistPictures("Nobody")).toEqual([]);
  });
});

describe("songs.modifyMetadata", () => {
  test("refuses an empty tag bag locally rather than earning a 500", async () => {
    const { songs, calls } = harness({ body: null });

    await expect(
      songs.modifyMetadata({ audio: { data: new Blob(["a"]), filename: "a.mp3" }, metadata: {} }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  test("nests the tags the way the controller permits them, and returns the bytes", async () => {
    const { songs, calls } = harness({
      text: "RETAGGED",
      headers: { "content-type": "audio/mpeg", "content-disposition": 'attachment; filename="a.mp3"' },
    });

    const out = await songs.modifyMetadata({
      audio: { data: new Blob(["a"]), filename: "a.mp3" },
      metadata: { title: "Construção", year: "1971" },
    });

    const form = calls[0]?.form;
    expect(form?.get("metadata[title]")).toBe("Construção");
    expect(form?.get("metadata[year]")).toBe("1971");
    expect(form?.get("audio_file")).toBeInstanceOf(Blob);
    expect(out.filename).toBe("a.mp3");
    expect(out.contentType).toBe("audio/mpeg");
    expect(await out.data.text()).toBe("RETAGGED");
  });
});

describe("vocal separation", () => {
  test("start posts to the member route and passes the model through", async () => {
    const { songs, calls } = harness({ status: 201, body: { id: "sep-uuid", status: "pending" } });

    const run = await songs.startSeparation(123, { modelId: "bs-roformer" });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/songs/123/separate");
    expect(calls[0]?.body).toEqual({ model_id: "bs-roformer" });
    expect(run.id).toBe("sep-uuid");
  });

  test("an omitted model sends an empty body, not a null model_id", async () => {
    const { songs, calls } = harness({ status: 201, body: { id: "sep-uuid" } });

    await songs.startSeparation(123);

    expect(calls[0]?.body).toEqual({});
  });

  test("a song that never ran one answers 200 with a null job, not a 404", async () => {
    const { songs } = harness({
      body: { stems_ready: false, vocals_media_id: null, instrumental_media_id: null, progress_percent: null, job: null },
    });

    const status = await songs.separation(123);

    expect(status.job).toBeNull();
    expect(status.stems_ready).toBe(false);
  });

  test("deleting the stems is a 204 on the member route", async () => {
    const { songs, calls } = harness({ status: 204 });

    await songs.deleteSeparation(123);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe("/songs/123/separation");
  });
});

describe("liked songs", () => {
  test("sends the client's default limit rather than letting the server pick 200", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.listLiked();

    expect(query(calls[0] as Call)["limit"]).toBe(String(LIKED_SONGS_DEFAULT_LIMIT));
    expect(query(calls[0] as Call)["before"]).toBeUndefined();
  });

  test("a Date cursor is encoded as ISO-8601, which is what Time.zone.parse wants", async () => {
    const { songs, calls } = harness({ body: [] });

    await songs.listLiked({ limit: 100, before: new Date("2026-07-01T20:11:00.000Z") });

    expect(query(calls[0] as Call)["before"]).toBe("2026-07-01T20:11:00.000Z");
    expect(query(calls[0] as Call)["limit"]).toBe("100");
  });

  test("ids come back as numbers, matching Song.id", async () => {
    const { songs, calls } = harness({ body: [1, 2, 3] });

    const ids = await songs.likedIds();

    expect(calls[0]?.url.pathname).toBe("/liked_songs/ids");
    expect(ids).toEqual([1, 2, 3]);
  });

  test("unlike is keyed by the SONG id, not by the id of the like", async () => {
    const { songs, calls } = harness({ status: 204 });

    await songs.unlike(123);

    expect(calls[0]?.url.pathname).toBe("/liked_songs/123");
  });

  test("like opts into retrying, because find_or_create_by cannot duplicate", async () => {
    const { songs, calls } = harness([
      { status: 500, body: "boom" },
      { status: 201, body: { id: 41, song_id: 123 } },
    ]);

    const liked = await songs.like(123);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({ song_id: 123 });
    expect(liked.id).toBe(41);
  });
});

describe("lyrics", () => {
  test("both fields null is the no-lyrics answer, not a failure", async () => {
    const { songs, calls } = harness({ body: { synced: null, plain: null, attribution: "lrclib.net" } });

    const lyrics = await songs.lyrics(123);

    expect(query(calls[0] as Call)["song_id"]).toBe("123");
    expect(lyrics.synced).toBeNull();
    expect(lyrics.plain).toBeNull();
    expect(lyrics.attribution).toBe("lrclib.net");
  });

  test("translation asks for one target and echoes it back", async () => {
    const { songs, calls } = harness({ body: { synced: null, plain: "linha", attribution: "lrclib.net", target: "pt" } });

    const translated = await songs.lyricsTranslation(123, "pt");

    expect(query(calls[0] as Call)["target"]).toBe("pt");
    expect(translated.target).toBe("pt");
    expect(LYRICS_TRANSLATION_TARGETS).toContain("pt");
  });

  test("a translation 429 is attempted ONCE: the hourly counter increments on rejection too", async () => {
    const { songs, calls } = harness({ status: 429, body: "Translation limit reached, try again later" });

    await expect(songs.lyricsTranslation(123, "pt")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("a sync 429 is attempted once for the same reason", async () => {
    const { songs, calls } = harness({ status: 429, body: "Sync limit reached, try again later" });

    await expect(songs.syncLyrics(123)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("sync posts the song id and hands back a job id", async () => {
    const { songs, calls } = harness({ status: 201, body: { job_id: "job-uuid" } });

    const handle = await songs.syncLyrics(123);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/lyrics/sync");
    expect(calls[0]?.body).toEqual({ song_id: 123 });
    expect(handle.job_id).toBe("job-uuid");
  });
});

describe("external search", () => {
  test("always answers with three arrays, even from a body missing them", async () => {
    const { songs, calls } = harness({ body: { tracks: [{ source: "youtube", kind: "track" }] } });

    const result = await songs.externalSearch({ q: "construcao", kind: "any" });

    const sent = query(calls[0] as Call);
    expect(sent["q"]).toBe("construcao");
    expect(sent["kind"]).toBe("any");
    expect(result.tracks).toHaveLength(1);
    expect(result.albums).toEqual([]);
    expect(result.artists).toEqual([]);
  });

  test("the rate limit arrives as a 400 and is recognised as one", async () => {
    const { songs, calls } = harness({ status: 400, body: "Rate limit exceeded" });

    let thrown: unknown;
    try {
      await songs.externalSearch({ q: "construcao" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OmsApiError);
    expect((thrown as OmsApiError).status).toBe(400);
    // The status alone says "invalid request", which is the whole trap.
    expect((thrown as OmsApiError).code).toBe("invalid_request");
    expect(isMusicExternalSearchRateLimited(thrown)).toBe(true);
    // And it must not be retried into the same wall.
    expect(calls).toHaveLength(1);
  });

  test("a genuine 400 is not mistaken for the rate limit", async () => {
    const { songs } = harness({ status: 400, body: "Something else entirely" });

    const thrown = await songs.externalSearch({ q: "x" }).catch((error: unknown) => error);

    expect(isMusicExternalSearchRateLimited(thrown)).toBe(false);
  });

  test("the classifier ignores anything that is not an api error", () => {
    expect(isMusicExternalSearchRateLimited(new Error("Rate limit exceeded"))).toBe(false);
    expect(isMusicExternalSearchRateLimited(undefined)).toBe(false);
  });
});

describe("artist metadata", () => {
  test("encodes the name into the path so a slash cannot become a route segment", async () => {
    const { songs, calls } = harness({ body: { id: 9, name: "AC/DC", similar: [] } });

    await songs.artistMetadata("AC/DC");

    expect(calls[0]?.url.pathname).toBe("/artist_metadata/AC%2FDC");
  });

  test("an unknown artist is a 200 of nulls, so the check is on id", async () => {
    const { songs } = harness({
      body: { id: null, name: "Nobody At All", slug: null, mbid: null, similar: [] },
    });

    const metadata = await songs.artistMetadata("Nobody At All");

    expect(metadata.id).toBeNull();
    expect(metadata.name).toBe("Nobody At All");
    expect(metadata.similar).toEqual([]);
  });
});

describe("songArtistsLine", () => {
  test("sorts by position, because the payload arrives unsorted", () => {
    const line = songArtistsLine({
      artists: [
        credit({ id: 2, position: 1, name: "Milton Nascimento" }),
        credit({ id: 1, position: 0, name: "Chico Buarque" }),
      ],
    });

    expect(line).toBe("Chico Buarque, Milton Nascimento");
  });

  test("adds the feat. clause and hides `with` unless asked", () => {
    const credits = [
      credit({ id: 1, position: 0, name: "Chico Buarque", role: "primary" }),
      credit({ id: 2, position: 1, name: "Elis Regina", role: "featured" }),
      credit({ id: 3, position: 2, name: "Tom Jobim", role: "with" }),
    ];

    expect(songArtistsLine({ artists: credits })).toBe("Chico Buarque (feat. Elis Regina)");
    expect(songArtistsLine({ artists: credits }, true)).toBe("Chico Buarque (feat. Elis Regina) (with Tom Jobim)");
  });

  test("falls back to the whole list when nobody is marked primary", () => {
    const line = songArtistsLine({
      artists: [credit({ id: 1, position: 0, name: "A", role: "with" }), credit({ id: 2, position: 1, name: "B", role: "with" })],
    });

    expect(line).toBe("A, B");
  });

  test("uses the pre-joined string a jam entry carries instead of an empty line", () => {
    expect(songArtistsLine({ artists: [], artist_names: "Chico Buarque, Elis Regina" })).toBe(
      "Chico Buarque, Elis Regina",
    );
    expect(songArtistsLine({ artists: [], artist_names: ["Chico", "Elis"] })).toBe("Chico, Elis");
    expect(songArtistsLine({ artists: [] })).toBe("");
  });
});

describe("the exported filter allowlist", () => {
  test("names the columns the backend actually permits, artist included", () => {
    expect(SONG_FILTER_COLUMNS).toContain("title");
    expect(SONG_FILTER_COLUMNS).toContain("album");
    expect(SONG_FILTER_COLUMNS).toContain("artist");
    // `duration` is orderable but NOT searchable: sending it is a 400.
    expect(SONG_FILTER_COLUMNS).not.toContain("duration");
  });
});
