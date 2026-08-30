/**
 * `bun test` coverage for the `music.imports` namespace.
 *
 * Five things here can quietly ruin somebody's day, and they are what the
 * assertions are about:
 *
 * - `progress_pct` is a 0..1 float while every other progress in this SDK is a
 *   0..100 integer. A shared progress bar fed the raw value shows 0% for an
 *   import that is 42% done;
 * - a DEDUPED import is already terminal in the 201 body. Polling it is not
 *   wrong, it is just a request that answers the same thing forever, so
 *   `createAndWait` must make exactly ONE call;
 * - the import state machine goes BACKWARDS on a transient retry
 *   (`processing -> pending`). A waiter that latched would stop early;
 * - `previewPlaylist` costs one of 60 an hour and once took the API down, so it
 *   must be attempted exactly once and never replayed;
 * - `PATCH /spotify_syncs/settings` DELETES playlists, and the updater keys off
 *   presence. An input field that is `undefined` must not reach the wire as
 *   `null`, which would read as "an empty list" and destroy everything.
 *
 * The request count is asserted as often as the payload, because most of these
 * failures look like success from the outside.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsAuthError, OmsTimeoutError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  MusicImportsNamespace,
  PLAYLIST_IMPORT_PREVIEW_HOURLY_LIMIT,
  SONG_IMPORT_FILTER_COLUMNS,
  SONG_IMPORT_TERMINAL_STATES,
  isSongImportTerminal,
  isSpotifySyncRunning,
  songImportProgress,
  spotifySyncProgress,
  type SongImport,
  type SpotifySyncStatus,
} from "../src/resources/music/imports";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
  readonly form: FormData | undefined;
}

interface Reply {
  readonly body?: unknown;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** Raw text, for the endpoints that answer bytes rather than JSON. */
  readonly text?: string;
}

interface Harness {
  readonly imports: MusicImportsNamespace;
  readonly calls: Call[];
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
  return { imports: new MusicImportsNamespace(http), calls };
}

function songImport(overrides: Partial<SongImport> = {}): SongImport {
  return {
    id: 4321,
    created_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:03.000Z",
    user_id: "1f0b8c2e-0000-4000-8000-000000000001",
    playlist_id: null,
    song_id: null,
    source_url: "https://www.youtube.com/watch?v=abc123",
    source_provider: null,
    source_id: null,
    source_kind: "yt_dlp",
    override_title: null,
    override_artist: null,
    override_album: null,
    expected_duration_s: null,
    position: null,
    sidecar_request_id: null,
    state: "pending",
    progress_message: null,
    progress_pct: 0,
    error_message: null,
    deduped: false,
    ...overrides,
  };
}

function syncStatus(overrides: Partial<SpotifySyncStatus> = {}): SpotifySyncStatus {
  return {
    connected: true,
    identity_id: "8b1f0000-0000-4000-8000-00000000000a",
    spotify_user_name: "afonso",
    last_synced_at: "2026-08-28T04:00:00.000Z",
    sync_settings: { sync_liked: true, enabled_playlists: null, auto_sync: true },
    sync_progress: {
      state: "running",
      started_at: "2026-08-29T10:00:00.000Z",
      finished_at: null,
      error: null,
      playlists: [],
    },
    ...overrides,
  };
}

describe("song imports: creating one", () => {
  test("URL mode sends only the keys that were given, in snake_case", async () => {
    const { imports, calls } = harness({ status: 201, body: songImport() });

    await imports.create({
      sourceUrl: "https://www.youtube.com/watch?v=abc123",
      overrideTitle: "Construção",
      playlistId: 12,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/song_imports");
    // Absent keys must stay absent: the create allowlist writes every permitted
    // key it receives, so a `null` here would blank a column rather than skip it.
    expect(calls[0]?.body).toEqual({
      source_url: "https://www.youtube.com/watch?v=abc123",
      override_title: "Construção",
      playlist_id: 12,
    });
  });

  test("search mode goes out with no source_url at all", async () => {
    const { imports, calls } = harness({ status: 201, body: songImport({ source_url: null }) });

    await imports.create({ searchArtist: "Chico Buarque", searchTitle: "Construção", isrc: "BRBMG0300729" });

    expect(calls[0]?.body).toEqual({
      search_artist: "Chico Buarque",
      search_title: "Construção",
      isrc: "BRBMG0300729",
    });
  });

  test("a half-filled search mode is refused before any request", async () => {
    const { imports, calls } = harness({ status: 201, body: songImport() });

    // `search_artist` alone is not search mode server-side either; this only
    // turns a 400 with a bare string into a message that says what to do.
    await expect(imports.create({ searchArtist: "Chico Buarque" })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  test("a blank source_url does not count as URL mode", async () => {
    const { imports, calls } = harness({ status: 201, body: songImport() });

    await expect(imports.create({ sourceUrl: "   " })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  test("a foreign playlist arrives as a 401, not a 403", async () => {
    // The controller calls `unauthorized!` where it means `forbidden!`, so this
    // lands in the auth-error pile. A caller sorting by class has to know.
    const { imports } = harness({ status: 401, body: "playlist not yours" });

    const failure = await imports
      .create({ sourceUrl: "https://youtu.be/abc", playlistId: 99 })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsAuthError);
    expect((failure as OmsAuthError).status).toBe(401);
  });
});

describe("song imports: waiting", () => {
  test("a deduped 201 is terminal and costs exactly one request", async () => {
    const deduped = songImport({ state: "complete", deduped: true, progress_pct: 1, song_id: 777 });
    const { imports, calls } = harness({ status: 201, body: deduped });

    const settled = await imports.createAndWait({ sourceUrl: "https://youtu.be/abc" });

    expect(settled.song_id).toBe(777);
    // One POST and NO poll: dedupe happened inside the create request.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
  });

  test("wait() polls the row until it settles and tolerates going backwards", async () => {
    // processing -> pending is what a transient sidecar retry writes. A waiter
    // that treated the regression as terminal would report an unfinished import.
    const { imports, calls } = harness([
      { body: songImport({ state: "processing", progress_pct: 0.42 }) },
      { body: songImport({ state: "pending", progress_pct: 0, progress_message: "a repetir" }) },
      { body: songImport({ state: "complete", progress_pct: 1, song_id: 900 }) },
    ]);

    const seen: number[] = [];
    const settled = await imports.wait(4321, {
      pollIntervalMs: 1,
      onProgress: (progress) => seen.push(progress.loaded),
    });

    expect(settled.state).toBe("complete");
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.url.pathname === "/song_imports/4321")).toBe(true);
    // Reported out of 100 even though the wire value is out of 1.
    expect(seen).toEqual([42, 0, 100]);
  });

  test("a failed import resolves rather than throwing", async () => {
    const { imports } = harness({
      body: songImport({ state: "failed", error_message: "Music storage quota exceeded" }),
    });

    const settled = await imports.wait(4321, { pollIntervalMs: 1 });

    expect(settled.state).toBe("failed");
    expect(settled.error_message).toBe("Music storage quota exceeded");
  });

  test("giving up first is a timeout that says the import is still running", async () => {
    const { imports } = harness({ body: songImport({ state: "processing" }) });

    const failure = await imports
      .wait(4321, { pollIntervalMs: 5, waitTimeoutMs: 12 })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).message).toContain("song import 4321");
    expect((failure as OmsTimeoutError).message).toContain("still working");
  });

  test("watch() yields every state and returns the terminal one", async () => {
    const { imports } = harness([
      { body: songImport({ state: "processing" }) },
      { body: songImport({ state: "complete", song_id: 12 }) },
    ]);

    const states: string[] = [];
    let last: SongImport | undefined;
    for await (const step of imports.watch(4321, { pollIntervalMs: 1 })) {
      states.push(step.state);
      last = step;
    }

    expect(states).toEqual(["processing", "complete"]);
    expect(last?.song_id).toBe(12);
  });
});

describe("song imports: listing", () => {
  test("filters go under exact_search[] with 1-based paging", async () => {
    const { imports, calls } = harness({ body: [songImport()] });

    await imports.list({ state: "failed", playlistId: 12, pageSize: 25 });

    const query = calls[0]?.url.searchParams;
    expect(query?.get("exact_search[state]")).toBe("failed");
    expect(query?.get("exact_search[playlist_id]")).toBe("12");
    expect(query?.get("modifiers[page]")).toBe("1:25");
  });

  test("an array filter becomes the IN form", async () => {
    const { imports, calls } = harness({ body: [] });

    await imports.list({ state: ["pending", "processing"] });

    expect(calls[0]?.url.searchParams.getAll("exact_search[state][]")).toEqual(["pending", "processing"]);
  });

  test("the documented filter columns are the six the controller allows", () => {
    // Anything else is a 400 naming the key, so this list is load-bearing
    // documentation rather than decoration.
    expect([...SONG_IMPORT_FILTER_COLUMNS].sort()).toEqual([
      "created_at",
      "id",
      "playlist_id",
      "state",
      "updated_at",
      "user_id",
    ]);
  });
});

describe("playlist import preview", () => {
  test("posts the url and is never replayed", async () => {
    // Each attempt spends one of 60 an hour and parks a Puma thread for up to a
    // minute. A retried 502 would spend two for one answer.
    const { imports, calls } = harness({ status: 502, body: "yt-dlp: unsupported URL" });

    await expect(imports.previewPlaylist("https://youtube.com/playlist?list=X")).rejects.toBeInstanceOf(OmsApiError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/playlist_imports/preview");
    expect(calls[0]?.body).toEqual({ url: "https://youtube.com/playlist?list=X" });
  });

  test("a playlist preview keeps its tracks", async () => {
    const { imports } = harness({
      body: { kind: "playlist", title: "Sertanejo", count: 2, tracks: [{ title: "a" }, { title: "b" }] },
    });

    const preview = await imports.previewPlaylist("https://youtube.com/playlist?list=X");

    expect(preview.kind).toBe("playlist");
    expect(preview.tracks).toHaveLength(2);
  });

  test("the documented hourly ceiling matches the controller", () => {
    expect(PLAYLIST_IMPORT_PREVIEW_HOURLY_LIMIT).toBe(60);
  });
});

describe("spotify sync", () => {
  test("a disconnected account answers with connected alone", async () => {
    const { imports } = harness({ body: { connected: false } });

    const status = await imports.spotify.status();

    expect(status.connected).toBe(false);
    expect(status.sync_progress).toBeUndefined();
    expect(isSpotifySyncRunning(status)).toBe(false);
  });

  test("the Dev-Mode gate is a 403 on every method", async () => {
    const { imports } = harness({ status: 403, body: "Spotify is not enabled for this account" });

    const failure = await imports.spotify.status().catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsAuthError);
    expect((failure as OmsAuthError).status).toBe(403);
  });

  test("settings only send the keys that were given", async () => {
    const { imports, calls } = harness({ body: { ok: true, sync_settings: { auto_sync: false } } });

    await imports.spotify.updateSettings({ autoSync: false });

    // `enabled_playlists: null` would be read as an empty list and DESTROY every
    // synced playlist, so an untouched key must not appear at all.
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ auto_sync: false });
  });

  test("an empty playlist list is sent as an empty list, not dropped", async () => {
    const { imports, calls } = harness({ body: { ok: true, sync_settings: {} } });

    await imports.spotify.updateSettings({ enabledPlaylists: [] });

    expect(calls[0]?.body).toEqual({ enabled_playlists: [] });
  });

  test("starting without ids sends an empty body", async () => {
    const { imports, calls } = harness({ body: { ok: true, queued_at: "2026-08-29T10:00:00.000Z" } });

    await imports.spotify.start();

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/spotify_syncs");
    expect(calls[0]?.body).toEqual({});
  });

  test("a sync already running is a 409", async () => {
    const { imports } = harness({ status: 409, body: "a sync is already running" });

    const failure = await imports.spotify.start().catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(409);
  });

  test("startAndWait posts once, then polls status until the run stops", async () => {
    const { imports, calls } = harness([
      { body: { ok: true, queued_at: "2026-08-29T10:00:00.000Z" } },
      { body: syncStatus() },
      {
        body: syncStatus({
          sync_progress: {
            state: "complete",
            started_at: "2026-08-29T10:00:00.000Z",
            finished_at: "2026-08-29T10:04:00.000Z",
            error: null,
            playlists: [{ id: "p1", name: "Sertanejo", total: 10, queued: 7, skipped: 3, state: "complete" }],
          },
        }),
      },
    ]);

    const final = await imports.spotify.startAndWait({}, { pollIntervalMs: 1 });

    expect(final.sync_progress?.state).toBe("complete");
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /spotify_syncs",
      "GET /spotify_syncs/status",
      "GET /spotify_syncs/status",
    ]);
  });

  test("waiting on an idle account returns on the first poll instead of hanging", async () => {
    // "idle" is not "running", and a wait that never ends is worse than an
    // honest "nothing is happening".
    const { imports, calls } = harness({ body: syncStatus({ sync_progress: { state: "idle" } }) });

    const status = await imports.spotify.waitForSync({ pollIntervalMs: 1, waitTimeoutMs: 50 });

    expect(status.sync_progress?.state).toBe("idle");
    expect(calls).toHaveLength(1);
  });

  test("preview is attempted once: a 502 means Spotify said no", async () => {
    const { imports, calls } = harness({ status: 502, body: "Spotify auth failed: invalid_grant" });

    await expect(imports.spotify.preview()).rejects.toBeInstanceOf(OmsApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("pure helpers", () => {
  test("terminal states are complete and failed, and pending is not one", () => {
    expect([...SONG_IMPORT_TERMINAL_STATES]).toEqual(["complete", "failed"]);
    expect(isSongImportTerminal("complete")).toBe(true);
    expect(isSongImportTerminal("failed")).toBe(true);
    expect(isSongImportTerminal("pending")).toBe(false);
    // There is no "canceled" here, unlike a jobs row. A switch ported across
    // would have a branch that can never run.
    expect(isSongImportTerminal("canceled")).toBe(false);
  });

  test("import progress converts the 0..1 float onto the 0..100 scale", () => {
    expect(songImportProgress(songImport({ progress_pct: 0.05 })).loaded).toBe(5);
    expect(songImportProgress(songImport({ progress_pct: 1 })).loaded).toBe(100);
    expect(songImportProgress(songImport({ progress_pct: 0 })).total).toBe(100);
  });

  test("a missing progress_pct reads as zero, never NaN", () => {
    const broken = { ...songImport(), progress_pct: undefined } as unknown as SongImport;
    expect(songImportProgress(broken).loaded).toBe(0);
  });

  test("sync progress sums tracks seen and drops the total when one is unknown", () => {
    const known = spotifySyncProgress(
      syncStatus({
        sync_progress: {
          state: "running",
          playlists: [
            { id: "p1", name: "A", total: 10, queued: 4, skipped: 1, state: "running" },
            { id: "p2", name: "B", total: 5, queued: 0, skipped: 0, state: "pending" },
          ],
        },
      }),
    );
    expect(known.loaded).toBe(5);
    expect(known.total).toBe(15);

    // The liked-songs mirror reports `total: null` until it has been walked, and
    // a bar drawn against a partial total jumps backwards when it starts.
    const unknown = spotifySyncProgress(
      syncStatus({
        sync_progress: {
          state: "running",
          playlists: [
            { id: "p1", name: "A", total: 10, queued: 4, skipped: 1, state: "running" },
            { id: "liked", name: "Liked Songs", total: null, queued: 0, skipped: 0, state: "pending" },
          ],
        },
      }),
    );
    expect(unknown.loaded).toBe(5);
    expect(unknown.total).toBeUndefined();
  });

  test("an unconfigured identity has no progress at all and is not running", () => {
    expect(spotifySyncProgress({ connected: true }).status).toBe("idle");
    expect(isSpotifySyncRunning({ connected: true })).toBe(false);
  });
});
