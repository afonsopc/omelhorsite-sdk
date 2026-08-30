/**
 * The `music.imports` namespace: getting audio INTO the library, and keeping a
 * Spotify account mirrored into it.
 *
 * Four unrelated backends sit behind one namespace because they are the four
 * doors a track can walk through:
 *
 * | Route family | What it is | Who may call it |
 * |---|---|---|
 * | `/song_imports` | one track, downloaded by the yt-dlp sidecar | any signed-in user |
 * | `/playlist_imports/preview` | read a playlist URL without importing it | any signed-in user |
 * | `/spotify_syncs/*` | mirror a Spotify account into playlists | Dev-Mode allowlisted users only |
 * | `/s_r_machine/*` | raw fetch + transcode helpers | **admins only** |
 *
 * ## An import is not a `Job`
 *
 * `POST /song_imports` answers a row of the `song_imports` table, not a row of
 * the generic `jobs` table, and there is no `job_id` anywhere on it. So
 * `oms.jobs.get()` will never find it and `watch_token` means nothing here.
 *
 * What this namespace DOES take from `oms.jobs` is the loop: {@link
 * MusicImportsNamespace.wait} and {@link MusicImportsNamespace.watch} are
 * `pollUntilTerminal` / `watchUntilTerminal` from `../jobs` with `poll` bound
 * to `GET /song_imports/:id` and `terminal` bound to
 * {@link isSongImportTerminal}. Same backoff, same `waitTimeoutMs`, same
 * `signal` semantics, same two `OmsTimeoutError` codes. There is exactly one
 * polling engine in this SDK and this is not a second one. The same is true of
 * {@link SpotifySyncNamespace.waitForSync}, which binds `poll` to
 * `GET /spotify_syncs/status`.
 *
 * Three scales, all called "progress", none of them the same number:
 *
 * - `Job.progress` is an INTEGER 0..100;
 * - {@link SongImport.progress_pct} is a FLOAT 0..1;
 * - a Spotify sync has no percentage at all, only per-playlist counters.
 *
 * {@link songImportProgress} does the conversion so a shared progress bar is
 * not fed a 0.42 where it wanted a 42.
 *
 * ## Rate limits, per method
 *
 * Everything here sits under the general authenticated ceiling of 600/min
 * except {@link MusicImportsNamespace.previewPlaylist}, which carries TWO
 * budgets of its own and is the only endpoint in this file that has already
 * been used to take the site down. Read its doc comment before writing a loop
 * around it.
 *
 * ## OAuth tokens cannot reach any of this
 *
 * None of these controllers declares an `oauth_scope`, and
 * `enforce_oauth_scope!` denies by omission, so an OAuth access token gets
 * `403 {"error":"insufficient_scope"}` before the action runs. Imports need a
 * session cookie or a personal token, like the rest of music.
 */

import { type ApiClient, Resource, buildFormData, filenameFromDisposition } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { ListParams } from "../../listing";
import { createPage } from "../../types";
import type {
  BaseRecord,
  FileInput,
  FileOutput,
  Id,
  NativeFile,
  PageParams,
  Paginated,
  Progress,
  QueryValue,
  RequestOptions,
  Timestamp,
  WaitOptions,
} from "../../types";
import { pollUntilTerminal, watchUntilTerminal, type PollUntilTerminalOptions } from "../jobs";
import type { DownloaderPreview } from "../tools/downloader";

/**
 * Primary key of a song import. An **integer**, like `songs` and `playlists`
 * and unlike `users` or `fs_nodes`.
 *
 * Both spellings are accepted as an argument because a caller that read the id
 * out of a URL is holding a string, but the JSON these methods RETURN always
 * carries a number.
 */
export type SongImportId = number | string;

/**
 * Where a `song_imports` row is in its life.
 *
 * Four values, and note what is NOT among them: there is no `"canceled"`. A
 * `jobs` row has one, a song import does not, so a `switch` ported from the
 * jobs namespace has a dead branch here and a missing one there.
 */
export type SongImportState = "pending" | "processing" | "complete" | "failed";

/** The four states, spelled the way `SongImport::STATES` spells them. */
export const SONG_IMPORT_STATES = Object.freeze({
  pending: "pending",
  processing: "processing",
  complete: "complete",
  failed: "failed",
} as const);

/**
 * The states `SongImport#terminal?` treats as final, and the ones
 * {@link MusicImportsNamespace.wait} stops on.
 *
 * `"pending"` is deliberately absent even though a row can go BACK to it: see
 * {@link isSongImportTerminal}.
 */
export const SONG_IMPORT_TERMINAL_STATES: readonly SongImportState[] = Object.freeze([
  SONG_IMPORT_STATES.complete,
  SONG_IMPORT_STATES.failed,
] as const);

/**
 * True once this state can never change again.
 *
 * The state machine is NOT monotonic on the way there. `SongImportJob` rescues
 * a transient sidecar error by writing the row back to `"pending"` with
 * `progress_pct: 0.0` so the retried run passes its own `terminal?` guard, so a
 * poller legitimately observes `processing -> pending -> processing ->
 * complete` and a progress bar legitimately goes backwards. Never latch a UI on
 * "it was processing, so it cannot be pending again"; read the state every time.
 *
 * `"failed"`, by contrast, is only ever written when the job has decided NOT to
 * retry, so it really is the end.
 */
export function isSongImportTerminal(state: string): boolean {
  return (SONG_IMPORT_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * One row of `song_imports`.
 *
 * `SongImportBlueprint` declares nineteen fields plus the three from
 * `ApplicationBlueprint`, so every key below is present on every response;
 * what varies is the value.
 *
 * ## Five columns you can write but never read back
 *
 * `search_artist`, `search_title`, `search_album`, `isrc` and `artwork_url` are
 * all accepted by `POST /song_imports` and NONE of them is in the blueprint.
 * `artwork_data_b64` likewise (and it is wiped from the row the moment the
 * import settles, deduped or not). So an import created in search mode answers
 * with `source_url: null` and no trace of what was searched for: if the caller
 * needs to show "importing <artist> - <title>", it has to keep that string
 * itself. This is the single most common surprise in this namespace.
 */
export interface SongImport extends Omit<BaseRecord, "id"> {
  /** Integer primary key. See {@link SongImportId}. */
  readonly id: number;
  /** Owner. A string uuid, sitting next to an integer `id`. */
  readonly user_id: Id;
  /** Playlist the finished track is filed into, when one was asked for. */
  readonly playlist_id: number | null;
  /**
   * The resulting song, once there is one. `null` while the import runs and
   * forever if it fails.
   *
   * On a deduped import this is set at CREATE time, in the same response as the
   * 201: see {@link SongImport.deduped}.
   */
  readonly song_id: number | null;
  /** `null` on a search-mode import, which is a legal way to create one. */
  readonly source_url: string | null;
  /** `"youtube"`, `"spotify"`, `"soundcloud"`, ... Free text, not an enum. */
  readonly source_provider: string | null;
  /** The provider's own id for the track. Half of the dedupe key. */
  readonly source_id: string | null;
  /**
   * `"yt_dlp"` (the column default, and what every user-driven import is) or
   * `"spotify_sync"` (written by `SpotifyPlaylistSyncJob`, one row per track
   * per run). Never `"upload"` - that is a `Song.source_kind` value, not one of
   * these.
   */
  readonly source_kind: string;
  readonly override_title: string | null;
  readonly override_artist: string | null;
  readonly override_album: string | null;
  /** Seconds, as a float. A hint the sidecar uses to pick between candidates. */
  readonly expected_duration_s: number | null;
  /** Requested position in {@link SongImport.playlist_id}. See the note on `create`. */
  readonly position: number | null;
  /** The yt-dlp sidecar's own job id. Diagnostics only; nothing here takes it. */
  readonly sidecar_request_id: string | null;
  readonly state: SongImportState;
  /**
   * Free text from the sidecar (`"starting"`, `"complete"`, `"a repetir"`, or
   * whatever yt-dlp last said). Human-facing, not a state: switch on
   * {@link SongImport.state}.
   */
  readonly progress_message: string | null;
  /**
   * A FLOAT between 0 and 1, not a percentage. `0.05` means 5%.
   *
   * The column is `float DEFAULT 0.0`, so it is a real number from the moment
   * the row exists. It can go DOWN - a transient retry resets it to `0.0`.
   * Multiply by 100 before showing it, or use {@link songImportProgress}.
   */
  readonly progress_pct: number;
  /** Set when `state === "failed"`. Truncated to ~240 characters server-side. */
  readonly error_message: string | null;
  /**
   * The import matched a track already in the library and no download
   * happened.
   *
   * Dedupe runs INSIDE the create request, before anything is enqueued, in
   * this order: `isrc`, then `source_provider` + `source_id`, then
   * `source_url`. On a hit the 201 body is ALREADY terminal -
   * `state: "complete"`, `progress_pct: 1.0`, `song_id` set, `deduped: true` -
   * and the existing song is filed into the target playlist. Polling such a row
   * is harmless but pointless; {@link MusicImportsNamespace.createAndWait}
   * short-circuits on it.
   */
  readonly deduped: boolean;
}

/**
 * Body of `POST /song_imports`.
 *
 * Exactly one of the two modes must be satisfied, and the server checks it in
 * this order:
 *
 * 1. **URL mode** - `sourceUrl` present. It must pass `SsrfGuard.
 *    public_http_url?`: http(s) only, public DNS only, no redirect to a private
 *    address. Anything else is `400 "source_url is not allowed"`.
 * 2. **Search mode** - `searchArtist` AND `searchTitle` both non-blank, with no
 *    `sourceUrl`. The sidecar goes and finds the track itself.
 *
 * Neither one satisfied is `400 "source_url or (search_artist + search_title)
 * required"`. One without the other counts as neither: `searchArtist` alone is
 * not search mode.
 *
 * Every other field is optional and every unknown field is dropped in silence
 * by the controller's `create_params` allowlist, so a typo here is a
 * successful import that ignored what you asked for.
 */
export interface CreateSongImportInput {
  /** URL mode. Public http(s) only; see the SSRF note above. */
  readonly sourceUrl?: string;
  /** Search mode. Needs {@link CreateSongImportInput.searchTitle} beside it. */
  readonly searchArtist?: string;
  /** Search mode. Needs {@link CreateSongImportInput.searchArtist} beside it. */
  readonly searchTitle?: string;
  /** Narrows a search. Optional even in search mode. */
  readonly searchAlbum?: string;
  /**
   * Recording identifier. The FIRST dedupe key tried, and the reason a
   * Spotify-driven re-sync finds the YouTube-sourced download it already has.
   * Pass it whenever you have one.
   */
  readonly isrc?: string;
  /** Free text (`"spotify"`, `"youtube"`). Half of the second dedupe key. */
  readonly sourceProvider?: string;
  /** The provider's id. Only used for dedupe alongside `sourceProvider`. */
  readonly sourceId?: string;
  /**
   * Defaults server-side to `"yt_dlp"`. Passing `"spotify_sync"` by hand is a
   * bad idea: it changes the queue the job runs on (the slow bulk lane), it
   * suppresses the Discord alert, and it makes the row eligible for the
   * playlist-position rewriting the sync does.
   */
  readonly sourceKind?: string;
  /** Tag overrides written onto the finished song instead of what yt-dlp read. */
  readonly overrideTitle?: string;
  readonly overrideArtist?: string;
  readonly overrideAlbum?: string;
  /** Cover to embed. SSRF-guarded exactly like `sourceUrl`. */
  readonly artworkUrl?: string;
  /**
   * Cover as base64, for a picture that has no public URL. Goes into a `text`
   * column and is wiped as soon as the import settles, so keep it small: it is
   * a JSON body, not a multipart upload, and Cloudflare caps a request body at
   * roughly 100 MB well before Rails complains.
   */
  readonly artworkDataB64?: string;
  /** Seconds. A hint, not a constraint. */
  readonly expectedDurationS?: number;
  /**
   * File the finished track into this playlist. It must be yours: a foreign or
   * missing id is `404 "playlist not found"`, and one you cannot update is
   * `401 "playlist not yours"` - see {@link MusicImportsNamespace.create} for
   * why that 401 is worth knowing about.
   */
  readonly playlistId?: number | string;
  /**
   * Position inside that playlist. Left out, the track lands after the last
   * one - and on a `spotify_sync` playlist it lands in the manual block at or
   * above `PLAYLIST_MANUAL_BLOCK_FLOOR` (100000), where the next sync will
   * leave it alone.
   */
  readonly position?: number;
}

/**
 * Filters for {@link MusicImportsNamespace.list}.
 *
 * The controller allowlists six columns and nothing else. An unrecognised
 * `search[...]` key is a `400` naming it, never a silently wider result.
 */
export interface ListSongImportsParams extends ListParams<(typeof SONG_IMPORT_FILTER_COLUMNS)[number]> {
  readonly state?: SongImportState | readonly SongImportState[];
  readonly playlistId?: number | string | ReadonlyArray<number | string>;
  /** Only ever your own id: the listing is scoped to the caller. */
  readonly userId?: Id;
  readonly id?: SongImportId | readonly SongImportId[];
}

/** Filter columns of `GET /song_imports`. */
export const SONG_IMPORT_FILTER_COLUMNS = Object.freeze([
  "id",
  "state",
  "playlist_id",
  "user_id",
  "created_at",
  "updated_at",
] as const);

/**
 * What `POST /playlist_imports/preview` answers: the SAME `DownloaderPreview`
 * shape `oms.tools.downloader.preview()` returns, because both call
 * `YtDlpClient.fetch_metadata` on the same sidecar.
 *
 * Check `kind` first: a `"playlist"` carries `count` and `tracks` and none of
 * the track fields, a `"track"` carries the track fields and neither of those.
 * Note this endpoint asks for `include_formats: false`, so `formats` is absent
 * even on a `"track"` - unlike the downloader's own preview.
 */
export type PlaylistImportPreview = DownloaderPreview;

/**
 * Sustained ceiling on `POST /playlist_imports/preview`: 60 an hour, keyed by
 * user id. A controller-level `rate_limit`, not rack-attack.
 */
export const PLAYLIST_IMPORT_PREVIEW_HOURLY_LIMIT = 60;

/**
 * Burst ceiling on the same route: 20 a minute, from rack-attack's
 * `expensive_tools/client` bucket, SHARED with every other expensive tool
 * (`/upscales`, `/vocal_separations`, `/transcriptions`, `/caption_jobs`,
 * `/jumpstyle_jobs`, `/songs/:id/separate`, `/tools_downloader/*`).
 */
export const PLAYLIST_IMPORT_PREVIEW_BURST_LIMIT_PER_MINUTE = 20;

/**
 * How long `SongImportJob` polls the sidecar before giving up on one import:
 * ten minutes. A sensible floor for `waitTimeoutMs`, and the reason a shorter
 * one is a client-side deadline rather than a cancellation.
 */
export const SONG_IMPORT_SERVER_TIMEOUT_MS = 600_000;

/**
 * Default pause between polls of a song import: 1.5s, which is what the app
 * uses. Slower than the jobs default because `SongImportJob` only writes
 * progress every 3 seconds anyway.
 */
export const SONG_IMPORT_POLL_INTERVAL_MS = 1_500;

/**
 * Renders a {@link SongImport} as the SDK's shared {@link Progress}.
 *
 * The whole point is the scale change: `progress_pct` is a 0..1 float and
 * `Progress.loaded` is compared against `total`, so this multiplies by 100 and
 * reports out of 100, matching what `oms.jobs` reports for a real job. A UI can
 * then feed both to the same bar.
 */
export function songImportProgress(record: SongImport): Progress {
  const fraction = typeof record.progress_pct === "number" ? record.progress_pct : 0;
  return {
    phase: "processing",
    loaded: Math.max(0, Math.min(100, Math.round(fraction * 100))),
    total: 100,
    status: record.state,
  };
}

/** The `music.imports` namespace, reachable as `oms.music.imports`. */
export class MusicImportsNamespace extends Resource {
  /** Spotify account mirroring. Allowlisted accounts only - see the class. */
  readonly spotify: SpotifySyncNamespace;

  /** Admin-only fetch and transcode helpers. */
  readonly srMachine: SRMachineNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.spotify = new SpotifySyncNamespace(http);
    this.srMachine = new SRMachineNamespace(http);
  }

  /**
   * `GET /song_imports` - your import history, newest first only if you ask.
   *
   * Scoped `where(user: current_user)`, so `userId` can only ever narrow to
   * yourself and a foreign one answers an empty page rather than a 403.
   *
   * **The table is pruned.** `SongImportPruneJob` deletes `complete` and
   * `deduped` rows older than 30 days and `failed` rows older than 90, so this
   * is a recent-activity feed, not an archive. It is also dominated by
   * `spotify_sync` rows on any account with the sync on - one per track per
   * daily run, thousands a day - so filter by `state` or `playlistId` unless
   * you actually want that.
   *
   * @throws {OmsApiError} 400 naming the key when a filter is not in
   *   {@link SONG_IMPORT_FILTER_COLUMNS}.
   */
  async list(params: ListSongImportsParams = {}, options: RequestOptions = {}): Promise<Paginated<SongImport>> {
    const base = {
      exactSearch: { state: params.state, playlist_id: params.playlistId, user_id: params.userId, id: params.id },
    };
    return paginate(params, 100, (at) =>
      this.http.get<SongImport[]>("/song_imports", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /song_imports/:id` - one read, no waiting.
   *
   * @throws {OmsApiError} 404 `"song import not found"` for an id that is not
   *   yours, never a 403 - and for one the prune job has already deleted.
   */
  async get(id: SongImportId, options: RequestOptions = {}): Promise<SongImport> {
    return this.http.get<SongImport>(`/song_imports/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `POST /song_imports` - 201 with the row, before any downloading starts.
   *
   * Returns immediately in every case. Either the row is already terminal
   * because dedupe hit ({@link SongImport.deduped}), or it is `"pending"` and a
   * `SongImportJob` has been enqueued. Nothing about this call waits for audio.
   *
   * Which queue that job runs on depends on `sourceKind`: anything but
   * `"spotify_sync"` goes on the `:interactive` lane precisely so a person
   * watching a spinner is not queued behind the thousands of sync imports on
   * `:default`. Leave `sourceKind` alone and you get the good lane.
   *
   * ## The 401 that is really a 403
   *
   * `playlistId` pointing at a playlist you cannot update answers
   * `401 "playlist not yours"` - the controller uses `unauthorized!` where it
   * means `forbidden!`. Two consequences: it is an {@link OmsAuthError}, not an
   * {@link OmsApiError}, so a `catch` sorting by class puts it in the wrong
   * pile; and if the client was built with a token provider that implements
   * `onUnauthorized`, the transport spends one pointless refresh on it before
   * giving up. Test the message, not just the status.
   *
   * @throws {TypeError} before any request when neither mode is satisfied.
   * @throws {OmsApiError} 400 `"source_url is not allowed"` /
   *   `"artwork_url is not allowed"` from the SSRF guard, `400` naming the
   *   missing mode, `404 "playlist not found"`.
   * @throws {OmsAuthError} 401 `"playlist not yours"`. See above.
   */
  async create(input: CreateSongImportInput, options: RequestOptions = {}): Promise<SongImport> {
    const sourceUrl = input.sourceUrl?.trim();
    const searchMode = Boolean(input.searchArtist?.trim()) && Boolean(input.searchTitle?.trim());
    if (!sourceUrl && !searchMode) {
      throw new TypeError(
        "createSongImport needs either `sourceUrl`, or BOTH `searchArtist` and `searchTitle`. " +
          "One search field without the other is not search mode and the server answers 400.",
      );
    }

    return this.http.post<SongImport>("/song_imports", createBody(input, sourceUrl), options);
  }

  /**
   * Polls `GET /song_imports/:id` until the row is `"complete"` or `"failed"`,
   * then returns it.
   *
   * This is `pollUntilTerminal` from the `jobs` namespace with a different
   * `poll` - the same backoff, the same deadline handling, the same abort
   * semantics. `onProgress` is fed through {@link songImportProgress}, so its
   * `loaded` is out of 100 even though the wire value is out of 1.
   *
   * Resolves for `"failed"` as well as `"complete"`: a download the sidecar
   * could not do is an ANSWER. Check `state` before reading `song_id`.
   *
   * `waitTimeoutMs` has no default here either. `SongImportJob` gives the
   * sidecar ten minutes ({@link SONG_IMPORT_SERVER_TIMEOUT_MS}) and may then be
   * retried, so a real import can outlive any deadline you pick; a deadline
   * here abandons the WAIT, never the import, which keeps running and can be
   * read later with {@link get}.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when `signal` fires.
   * @throws {OmsApiError} 404 if the row is deleted while waiting.
   */
  async wait(id: SongImportId, options: WaitOptions = {}): Promise<SongImport> {
    return pollUntilTerminal(this.pollPlan(id, options));
  }

  /**
   * Yields the row on every poll until it settles, for a host that would rather
   * render each step than take a callback.
   *
   * The terminal row is both the last value yielded and the generator's return
   * value. Breaking out of the `for await` stops the loop and leaves nothing
   * running client-side; the import itself carries on.
   */
  watch(id: SongImportId, options: WaitOptions = {}): AsyncGenerator<SongImport, SongImport, undefined> {
    return watchUntilTerminal(this.pollPlan(id, options));
  }

  /**
   * {@link create} then {@link wait}, with the dedupe short-circuit already
   * handled: a deduped 201 comes back `"complete"` and this returns it without
   * a single extra request.
   *
   * The convenience most callers actually want. It is a plain composition of
   * the two public methods and adds no polling of its own.
   */
  async createAndWait(input: CreateSongImportInput, options: WaitOptions = {}): Promise<SongImport> {
    const created = await this.create(input, requestPartOf(options));
    if (isSongImportTerminal(created.state)) return created;
    return this.wait(created.id, options);
  }

  /**
   * `POST /playlist_imports/preview` - read a URL's metadata without importing
   * anything.
   *
   * Answers a `"track"` or a `"playlist"`; check `kind` before reading the rest.
   * Nothing is written and nothing is enqueued, which is exactly why it is easy
   * to mistake for cheap.
   *
   * ## It is not cheap. It has been used to take the API down.
   *
   * Each call shells out to yt-dlp against a URL the CALLER chose and parks a
   * Puma thread for up to the sidecar's 60-second metadata timeout. There are
   * only `RAILS_MAX_THREADS` of those, shared with every other request the site
   * serves. On 2026-07-27 a load generator drove this endpoint at roughly 900
   * requests a minute with each one parked 20-40 seconds, and the whole API -
   * health check included - went down with it. At the time it was the one
   * yt-dlp-backed route with neither a rack-attack rule nor a controller-level
   * limit. It now has both:
   *
   * - {@link PLAYLIST_IMPORT_PREVIEW_HOURLY_LIMIT} 60 an hour, keyed by user
   *   id, from the controller. This one does NOT set `Retry-After`;
   * - {@link PLAYLIST_IMPORT_PREVIEW_BURST_LIMIT_PER_MINUTE} 20 a minute, from
   *   rack-attack's `expensive_tools` bucket, SHARED with upscale, background
   *   removal, transcription, vocal separation, captions, jumpstyle,
   *   `/songs/:id/separate` and the downloader. Importing a playlist while a
   *   separation is running spends the same budget. This one does set
   *   `Retry-After`, which the transport honours.
   *
   * So: one preview per user action, never one per row of a list, and never
   * inside a retry loop. This method therefore does NOT retry by default -
   * every attempt burns one of the 60 - and a 502 here means an upstream said
   * no, which a replay will not change. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 400 `"url is required"` when blank; 400
   *   `"url is not allowed"` from the SSRF guard; 400 with a message pointing
   *   at `/account/dashboard` for ANY `open.spotify.com` or `spotify.com` URL -
   *   Spotify is never previewed here, it goes through
   *   {@link MusicImportsNamespace.spotify}; 502 carrying the first 200
   *   characters of whatever yt-dlp said.
   * @throws {OmsQuotaError} 429 from either budget above.
   */
  async previewPlaylist(url: string, options: RequestOptions = {}): Promise<PlaylistImportPreview> {
    return this.http.post<PlaylistImportPreview>(
      "/playlist_imports/preview",
      { url },
      { timeoutMs: 120_000, ...options, retry: options.retry ?? false },
    );
  }

  /** The one description of "watching an import", shared by `wait` and `watch`. */
  private pollPlan(id: SongImportId, options: WaitOptions): PollUntilTerminalOptions<SongImport> {
    return {
      pollIntervalMs: SONG_IMPORT_POLL_INTERVAL_MS,
      ...options,
      label: `song import ${id}`,
      poll: (request) => this.get(id, request),
      terminal: (record) => isSongImportTerminal(record.state),
      progress: songImportProgress,
    };
  }
}

/**
 * State of a whole sync run, as it appears in
 * {@link SpotifySyncProgress.state}.
 *
 * `"idle"` is what an identity that has never synced carries. There is no
 * `"canceled"`: a run cannot be stopped once queued.
 */
export type SpotifySyncRunState = "idle" | "running" | "complete" | "failed";

/** State of one playlist inside a run. Note there is no `"idle"` at this level. */
export type SpotifySyncPlaylistState = "pending" | "running" | "complete" | "failed";

/**
 * Per-playlist counters inside a running sync.
 *
 * `queued` and `skipped` count TRACKS, and together they are the walk's
 * progress against `total`. What they are not is downloads: `queued` means a
 * `song_imports` row was created and a `SongImportJob` enqueued on the slow
 * `:default` lane. The audio arrives minutes or hours later.
 */
export interface SpotifySyncPlaylistProgress {
  /** Spotify's playlist id, or the literal `"liked"` for the liked-songs mirror. */
  readonly id: string;
  readonly name: string;
  /** Track count Spotify reported. `null` for `"liked"`, which is not known up front. */
  readonly total: number | null;
  /** Tracks that produced a new import. */
  readonly queued: number;
  /** Tracks dedupe matched against a song already in the library. */
  readonly skipped: number;
  readonly state: SpotifySyncPlaylistState;
}

/**
 * Progress of the last (or current) sync run, stored on the Spotify identity
 * rather than in any job table.
 *
 * Every key is optional here because a freshly linked identity carries `{}` -
 * the column defaults to an empty hash and nothing writes it until the first
 * sync starts. Treat a missing `state` as `"idle"`.
 */
export interface SpotifySyncProgress {
  readonly state?: SpotifySyncRunState;
  readonly started_at?: Timestamp | null;
  readonly finished_at?: Timestamp | null;
  /**
   * Failure reason once `state === "failed"`. Two are worth telling apart by
   * their text: `"Token refresh failed - please relink Spotify."` means the
   * refresh token is dead and the user must go through the link flow again,
   * while a stale run rewritten by {@link SpotifySyncNamespace.status} says
   * `"Sincronização interrompida"` (the backend writes that one in Portuguese).
   */
  readonly error?: string | null;
  readonly playlists?: SpotifySyncPlaylistProgress[];
}

/**
 * The persisted sync settings.
 *
 * All three keys are absent on an identity that has never been configured, and
 * absent is NOT `false` for any of them - each defaults differently:
 *
 * - `sync_liked` defaults to `true` (`fetch("sync_liked", true)`);
 * - `enabled_playlists` absent or `null` means EVERY eligible playlist, not
 *   none. An empty array means none;
 * - `auto_sync` absent means "on if this identity has ever synced before",
 *   which is why {@link SpotifySyncStatus.sync_settings} always carries a real
 *   boolean for it: `status` resolves that rule server-side before answering.
 */
export interface SpotifySyncSettings {
  readonly sync_liked?: boolean;
  /** `null` or absent means all eligible playlists. `[]` means none. */
  readonly enabled_playlists?: string[] | null;
  readonly auto_sync?: boolean;
}

/**
 * What `GET /spotify_syncs/status` answers.
 *
 * A discriminated union in practice: when `connected` is `false` that is the
 * ONLY key in the body, so every other field has to be read behind a check on
 * it.
 */
export interface SpotifySyncStatus {
  /** `false` when the account has no linked Spotify identity. */
  readonly connected: boolean;
  /** Identity row id, a string uuid. Absent when disconnected. */
  readonly identity_id?: Id;
  /** Spotify display name as it was at link time; not refreshed. */
  readonly spotify_user_name?: string | null;
  /** Stamped only by a run that finished cleanly. */
  readonly last_synced_at?: Timestamp | null;
  /**
   * The persisted settings, with `auto_sync` always resolved to a real boolean
   * even when the stored hash has no such key.
   */
  readonly sync_settings?: SpotifySyncSettings;
  readonly sync_progress?: SpotifySyncProgress;
}

/** One row of the playlist toggle list from `GET /spotify_syncs/preview`. */
export interface SpotifyPlaylistOption {
  readonly id: string;
  readonly name: string;
  /** `null` when Spotify did not report one. */
  readonly track_count: number | null;
  /** Owner's display name, not their id. */
  readonly owner: string | null;
  readonly cover_url: string | null;
  /**
   * Whether this playlist is currently selected. Computed as
   * `enabled_playlists.nil? || enabled_playlists.include?(id)`, so on an
   * unconfigured identity EVERY row comes back `true`.
   */
  readonly enabled: boolean;
}

/**
 * What `GET /spotify_syncs/preview` answers.
 *
 * The list is already filtered to what can actually be synced: playlists owned
 * by `"spotify"` (the editorial ones) and other people's non-collaborative
 * playlists are dropped, because Dev Mode plus the February 2026 API change
 * left us unable to read their tracks. A playlist the user can see in the
 * Spotify app and not here is that rule, not a bug.
 */
export interface SpotifySyncPreview {
  readonly sync_liked: boolean;
  readonly playlists: SpotifyPlaylistOption[];
}

/**
 * Body of `PATCH /spotify_syncs/settings`.
 *
 * **Presence-sensitive, and two of the three keys delete data.** The updater
 * tests `params.key?`, so an omitted key is left alone and a present one is
 * applied - which means you cannot express "leave enabled_playlists alone" by
 * sending `null`, and you must send the WHOLE list every time rather than a
 * delta.
 *
 * The destruction is immediate and synchronous, inside the PATCH:
 *
 * - `enabledPlaylists` **destroys the local copy** of every synced playlist
 *   whose Spotify id is not in the new list. Songs stay in the library; the
 *   playlist row and its `playlist_songs` do not. Re-enabling it later
 *   re-creates it from scratch on the next sync;
 * - `syncLiked: false` **destroys the local "liked" mirror** the same way.
 *
 * Confirm with the user before sending either. There is no undo and no
 * soft-delete.
 */
export interface UpdateSpotifySyncSettingsInput {
  /** The COMPLETE list of Spotify playlist ids to keep synced. See above. */
  readonly enabledPlaylists?: string[];
  /** Mirror the user's Spotify liked songs. Turning it off deletes the mirror. */
  readonly syncLiked?: boolean;
  /** Whether the nightly dispatcher picks this identity up. */
  readonly autoSync?: boolean;
}

/** What `PATCH /spotify_syncs/settings` answers: `ok` plus the persisted hash. */
export interface SpotifySyncSettingsResult {
  readonly ok: boolean;
  readonly sync_settings: SpotifySyncSettings;
}

/** What `POST /spotify_syncs` answers. Note there is no id of any kind. */
export interface SpotifySyncQueued {
  readonly ok: boolean;
  /** Server clock at enqueue time. Not a handle: nothing accepts it back. */
  readonly queued_at: Timestamp;
}

/** Body of `POST /spotify_syncs`. */
export interface StartSpotifySyncInput {
  /**
   * Sync only these Spotify playlist ids, ignoring the saved selection for this
   * one run. Omit to use the saved `enabled_playlists`, and note that an
   * unconfigured identity therefore means "all of them".
   *
   * This does not persist: the next automatic run reads the saved settings
   * again.
   */
  readonly playlistIds?: string[];
}

/**
 * A `"running"` sync older than this is treated as lost. Two hours, matching
 * `SpotifySyncsController::STALE_RUNNING_AFTER`.
 */
export const SPOTIFY_SYNC_STALE_AFTER_MS = 7_200_000;

/** True while a sync run is in flight. Anything else - `"idle"` included - is not. */
export function isSpotifySyncRunning(status: SpotifySyncStatus): boolean {
  return status.sync_progress?.state === "running";
}

/**
 * Spotify account mirroring, reachable as `oms.music.imports.spotify`.
 *
 * ## Every method here 403s unless the account is Dev-Mode allowlisted
 *
 * `before_action :require_spotify_allowed` gates the whole controller on the
 * `users.allowed_to_use_spotify` column and answers
 * `403 "Spotify is not enabled for this account"` without it. That is step one
 * of two, and the two fail in completely different places:
 *
 * 1. **The database flag.** Without it, `GET /auth/link/spotify` refuses before
 *    it ever redirects to Spotify: the user is bounced straight back with
 *    `?error=spotify_not_allowlisted`, having seen no Spotify screen at all.
 *    Every method in this class also 403s.
 * 2. **The email in the Spotify dashboard's User Management list.** Our app is
 *    still in Spotify's Development Mode, which admits at most 25 named users.
 *    With the flag set but the email missing, the link flow LOOKS right up to
 *    the last moment: the redirect to Spotify happens, the user signs in, and
 *    then Spotify refuses the authorization itself. OmniAuth lands on
 *    `/auth/failure` with `"not registered for this application"` and the user
 *    is redirected back with the same `?error=spotify_not_allowlisted`, never
 *    linked, with nothing in this API having recorded an attempt. From the
 *    outside it looks like the login silently died - and the fix is not in this
 *    codebase at all, it is in the Spotify dashboard.
 *
 * Because step 2 fails outside our API, {@link SpotifySyncNamespace.status}
 * answering `{ connected: false }` on an allowlisted account is the normal
 * symptom of it. `connected: false` means "no identity row", which covers both
 * "never tried" and "tried and Spotify said no".
 *
 * ## There is no sync id
 *
 * `POST /spotify_syncs` answers `{ ok, queued_at }`. Progress lives on the
 * identity, one slot, overwritten by each run, and is read back through
 * {@link SpotifySyncNamespace.status}. So two runs cannot be told apart, a
 * finished run's report is destroyed by the next one starting, and there is
 * nothing to hand to `oms.jobs`. {@link SpotifySyncNamespace.waitForSync} works
 * within that limit rather than pretending otherwise.
 */
export class SpotifySyncNamespace extends Resource {
  /**
   * `GET /spotify_syncs/status` - the whole state of the link in one call.
   *
   * **This GET writes.** If the stored progress says `"running"` and started
   * more than {@link SPOTIFY_SYNC_STALE_AFTER_MS} ago, the controller rewrites
   * it to `"failed"` before answering, because a worker that was SIGKILLed
   * leaves an eternal `"running"` behind and
   * {@link SpotifySyncNamespace.start} refuses to queue another while one is
   * "in flight". Calling this is therefore how a stuck account gets unstuck -
   * which also means it is not safe to treat as a cacheable read.
   *
   * @throws {OmsApiError} 403 `"Spotify is not enabled for this account"` when
   *   the account lacks the Dev-Mode flag. See the class comment.
   */
  async status(options: RequestOptions = {}): Promise<SpotifySyncStatus> {
    return this.http.get<SpotifySyncStatus>("/spotify_syncs/status", options);
  }

  /**
   * `GET /spotify_syncs/preview` - the user's syncable playlists, each with its
   * current toggle state.
   *
   * Walks Spotify's playlist pages live, so it is slow (seconds, and more on a
   * large account) and it is the only method here that can fail because of
   * somebody else's outage. Not retried by default for that reason: a 502 means
   * Spotify said no, and hammering it is how an app-wide Spotify rate limit
   * gets hit. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 404 `"link your Spotify account first"` when there is
   *   no identity; 502 `"Spotify auth failed: ..."` when the refresh token is
   *   dead (the user must relink); 502 with Spotify's own message for anything
   *   else upstream; 403 without the Dev-Mode flag.
   */
  async preview(options: RequestOptions = {}): Promise<SpotifySyncPreview> {
    return this.http.get<SpotifySyncPreview>("/spotify_syncs/preview", {
      timeoutMs: 60_000,
      ...options,
      retry: options.retry ?? false,
    });
  }

  /**
   * `PATCH /spotify_syncs/settings` - **destructive**. Read
   * {@link UpdateSpotifySyncSettingsInput} before calling.
   *
   * Deselecting a playlist deletes its local copy in this same request, and
   * `syncLiked: false` deletes the liked mirror. Only the keys you pass are
   * touched, and `enabledPlaylists` is a full replacement rather than a delta,
   * so building it from a stale preview is how a user loses playlists they
   * never deselected. Read {@link SpotifySyncNamespace.preview} first and send
   * back the ids you got from it.
   *
   * @throws {OmsApiError} 404 `"link your Spotify account first"`; 403 without
   *   the Dev-Mode flag.
   */
  async updateSettings(
    input: UpdateSpotifySyncSettingsInput,
    options: RequestOptions = {},
  ): Promise<SpotifySyncSettingsResult> {
    const body: Record<string, unknown> = {};
    if (input.enabledPlaylists !== undefined) body["enabled_playlists"] = input.enabledPlaylists;
    if (input.syncLiked !== undefined) body["sync_liked"] = input.syncLiked;
    if (input.autoSync !== undefined) body["auto_sync"] = input.autoSync;
    return this.http.patch<SpotifySyncSettingsResult>("/spotify_syncs/settings", body, options);
  }

  /**
   * `POST /spotify_syncs` - queue a manual sync.
   *
   * The progress slot is flipped to `"running"` synchronously, BEFORE the
   * response is written, so a poll that starts the moment this resolves is
   * guaranteed to see `"running"` and never a stale `"complete"` from the
   * previous run. That is what makes {@link SpotifySyncNamespace.waitForSync}
   * race-free when it follows a `start()`.
   *
   * A manual run is not the same as the nightly one. It ignores the
   * `snapshot_id` shortcut and re-walks every enabled playlist even when
   * Spotify says nothing changed - it is the "I think something is out of step"
   * button - which is why it is much more expensive than the automatic sync and
   * why it should be user-initiated, never polled into.
   *
   * What finishing means: `"complete"` says the walk is done and a
   * `song_imports` row exists for every new track. The downloads themselves are
   * still queued behind however many thousand rows the run just created, on the
   * `:default` lane. The library fills in for a long time afterwards.
   *
   * @throws {OmsApiError} 409 `"a sync is already running"` - unless the
   *   running one is over two hours old, in which case
   *   {@link SpotifySyncNamespace.status} rewrites it to failed first and this
   *   then succeeds; 404 `"link your Spotify account first"`; 403 without the
   *   Dev-Mode flag.
   */
  async start(input: StartSpotifySyncInput = {}, options: RequestOptions = {}): Promise<SpotifySyncQueued> {
    return this.http.post<SpotifySyncQueued>(
      "/spotify_syncs",
      input.playlistIds === undefined ? {} : { playlist_ids: input.playlistIds },
      options,
    );
  }

  /**
   * Polls {@link SpotifySyncNamespace.status} until the run stops being
   * `"running"`, then returns the final status.
   *
   * Same engine as everything else that waits in this SDK -
   * `pollUntilTerminal` from the `jobs` namespace - with `poll` bound to the
   * status endpoint. There is no job id to watch, so this watches the one
   * progress slot on the identity.
   *
   * Two consequences of that slot being the only handle:
   *
   * - **Call it after {@link SpotifySyncNamespace.start}, not before.** Started
   *   on an idle account it returns on the FIRST poll, because `"idle"` is not
   *   `"running"` and honestly reporting "nothing is running" beats hanging
   *   until the deadline. An account with no Spotify identity at all is
   *   terminal for the same reason: `{ connected: false }` carries no progress,
   *   so this answers it straight back rather than waiting for a run that
   *   cannot start;
   * - it cannot tell your run from one the nightly dispatcher started thirty
   *   seconds earlier. If both are somehow in flight, this returns when
   *   whichever one owns the slot finishes.
   *
   * `onProgress` reports tracks seen against tracks expected, summed across
   * playlists, with `total` left `undefined` while any playlist has a `null`
   * count (the liked mirror always does until it finishes).
   *
   * Polling here is also what clears a lost `"running"`, since `status` rewrites
   * a stale one - so a wait against a dead worker ends after two hours rather
   * than never.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` / `"aborted"`, as everywhere.
   * @throws {OmsApiError} 403 without the Dev-Mode flag, on the first poll.
   */
  async waitForSync(options: WaitOptions = {}): Promise<SpotifySyncStatus> {
    return pollUntilTerminal(this.syncPollPlan(options));
  }

  /**
   * Yields the status on every poll while a sync runs, for a host rendering a
   * per-playlist progress list.
   *
   * The terminal status is both the last value yielded and the return value.
   */
  watchSync(options: WaitOptions = {}): AsyncGenerator<SpotifySyncStatus, SpotifySyncStatus, undefined> {
    return watchUntilTerminal(this.syncPollPlan(options));
  }

  /**
   * {@link SpotifySyncNamespace.start} then
   * {@link SpotifySyncNamespace.waitForSync}, which is race-free in that order
   * for the reason given on `start`.
   */
  async startAndWait(input: StartSpotifySyncInput = {}, options: WaitOptions = {}): Promise<SpotifySyncStatus> {
    await this.start(input, requestPartOf(options));
    return this.waitForSync(options);
  }

  /** The one description of "watching a sync", shared by the two watchers. */
  private syncPollPlan(options: WaitOptions): PollUntilTerminalOptions<SpotifySyncStatus> {
    return {
      ...options,
      label: "the Spotify sync",
      poll: (request) => this.status(request),
      terminal: (status) => !isSpotifySyncRunning(status),
      progress: spotifySyncProgress,
    };
  }
}

/** What `GET /s_r_machine/metadata` answers. Two keys, both nullable. */
export interface SRMachineMetadata {
  readonly title: string | null;
  readonly artist: string | null;
}

/**
 * The SR Machine helpers, reachable as `oms.music.imports.srMachine`.
 *
 * ## Admin only, and the check is blunt
 *
 * `before_action :gatekeep` answers `403 "You SHALL NOT use this resource"` to
 * anyone who is not an administrator. There is no allowlist, no scope and no
 * per-user quota; the whole guard is `Current.user.admin?`.
 *
 * ## What it is
 *
 * Four unrelated primitives left over from the "slowed + reverb" video tool:
 * fetch the artwork behind a URL, fetch its audio, read its title and artist,
 * and transcode an arbitrary audio blob to Opus. Nothing here touches the
 * library - no song is created, nothing is stored, and the bytes come back in
 * the response body. If you want a track IN the library, use
 * {@link MusicImportsNamespace.create} instead; this is the raw pipe.
 *
 * Three of the four shell out to yt-dlp against a caller-supplied URL and hold
 * a Puma thread while they do it, exactly like
 * {@link MusicImportsNamespace.previewPlaylist} - but note they are NOT in
 * rack-attack's `expensive_tools` pattern and have no controller-level limit
 * either, so the only ceiling is the general 600/min. The admin gate is what
 * stands in for a budget here. Do not build a batch loop on top of these.
 *
 * A YouTube URL carrying `?list=` is truncated at the `?list=` before the fetch,
 * so a link copied from inside a playlist resolves to the single video rather
 * than the playlist. That happens server-side, in all three fetchers.
 *
 * All three fetchers respond with `Content-Disposition: attachment` and a
 * fixed filename (`artwork.jpg`, `audio.opus`), so `FileOutput.filename` is
 * that constant rather than anything derived from the source.
 */
export class SRMachineNamespace extends Resource {
  /**
   * `GET /s_r_machine/metadata` - the title and artist yt-dlp reads off a URL.
   *
   * Both keys can be `null` for a source that carries no tags; it is a
   * best-effort read, not a lookup.
   *
   * Not retried by default: it parks a thread for up to the sidecar's
   * 60-second metadata timeout, and a failure means the source refused.
   *
   * @throws {OmsAuthError} 403 `"You SHALL NOT use this resource"` for a
   *   non-admin.
   * @throws {OmsApiError} 400 `"url is not allowed"` from the SSRF guard; 500
   *   when yt-dlp itself blows up - this controller has no `bad_gateway!`
   *   rescue, so an upstream failure surfaces as a server error AND fires a
   *   Discord alert.
   */
  async metadata(url: string, options: RequestOptions = {}): Promise<SRMachineMetadata> {
    return this.http.get<SRMachineMetadata>("/s_r_machine/metadata", {
      timeoutMs: 120_000,
      ...options,
      query: { url },
      retry: options.retry ?? false,
    });
  }

  /**
   * `GET /s_r_machine/artwork` - the cover behind a URL, as `image/jpeg`.
   *
   * Buffered fully into memory in every runtime, React Native included. It is a
   * cover, so that is fine; {@link SRMachineNamespace.audio} is where it is not.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   * @throws {OmsApiError} 400 `"url is not allowed"`; 500 on a fetch failure.
   */
  async artwork(url: string, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download("/s_r_machine/artwork", {
      timeoutMs: 120_000,
      ...options,
      query: { url },
      retry: options.retry ?? false,
    });
  }

  /**
   * `GET /s_r_machine/audio` - the audio behind a URL, as `audio/opus`.
   *
   * The whole track is downloaded server-side, held in memory there, and sent
   * back in one body which this then buffers into memory again on the client.
   * Nothing streams. On a phone that is a whole track in the JavaScript heap,
   * and there is no signed-URL alternative here the way there is for library
   * media - this endpoint has no storage node behind it. Reach for it on
   * desktop, think twice on React Native, and never for a batch.
   *
   * Generous `timeoutMs` by default because a long track legitimately takes
   * minutes.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   * @throws {OmsApiError} 400 `"url is not allowed"`; 500 on a fetch failure.
   */
  async audio(url: string, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download("/s_r_machine/audio", {
      timeoutMs: 600_000,
      ...options,
      query: { url },
      retry: options.retry ?? false,
    });
  }

  /**
   * `POST /s_r_machine/convert-opus` - transcode an audio file to Opus.
   *
   * Multipart, field name `file`, and the only method in this namespace that
   * uploads. The response is `audio/opus` bytes, not JSON.
   *
   * Works on all three clients: a React Native `{ uri, name, type }` descriptor
   * goes into the `FormData` verbatim and is streamed off disk by the native
   * layer, while a browser or Bun caller passes a `FileInput` carrying a Blob
   * or a `Uint8Array`. A `ReadableStream` is buffered first, because
   * `FormData` has no streaming entry.
   *
   * The upload has no client-side size cap here because the server declares
   * none - but Cloudflare sits in front of production and rejects a request
   * body over roughly 100 MB with a 413 that never reaches Rails. There is no
   * chunked path for this route, so a file above that simply cannot go through
   * it.
   *
   * The server reads the whole part into memory (`params[:file].read`) and
   * hands it to ffmpeg, so a large input is a large allocation on the Mac Mini
   * as well as on the caller.
   *
   * @throws {OmsAuthError} 403 `"You SHALL NOT use this resource"` for a
   *   non-admin.
   * @throws {OmsApiError} 500 when no `file` part was sent (`params[:file]` is
   *   `nil` and `.read` raises) or when ffmpeg refuses the input. Neither is a
   *   graceful 400.
   * @throws {TypeError} when a React Native descriptor is passed on a runtime
   *   whose `FormData` is the web one, which would otherwise upload the literal
   *   text `"[object Object]"` and answer 500.
   */
  async convertToOpus(file: FileInput | NativeFile, options: RequestOptions = {}): Promise<FileOutput> {
    const form = await buildFormData({ file });
    const response = await this.http.raw("POST", "/s_r_machine/convert-opus", {
      timeoutMs: 600_000,
      ...options,
      body: form,
    });
    const data = await response.blob();
    return {
      data,
      filename: filenameFromDisposition(response.headers.get("content-disposition")),
      contentType: response.headers.get("content-type") ?? undefined,
      size: data.size,
    };
  }
}

/**
 * Renders a sync run as the SDK's shared {@link Progress}.
 *
 * `loaded` is tracks SEEN (`queued + skipped`) summed over every playlist, and
 * `total` is the sum of the reported track counts - left `undefined` as soon as
 * one playlist reports `null`, which the liked-songs mirror always does until
 * it has been walked. An undefined total is what a UI should read as "spinner,
 * not bar"; faking it with the partial sum would draw a bar that jumps
 * backwards when the liked mirror starts.
 */
export function spotifySyncProgress(status: SpotifySyncStatus): Progress {
  const playlists = status.sync_progress?.playlists ?? [];
  let loaded = 0;
  let total: number | undefined = 0;
  for (const entry of playlists) {
    loaded += (entry.queued ?? 0) + (entry.skipped ?? 0);
    if (total !== undefined) {
      total = typeof entry.total === "number" ? total + entry.total : undefined;
    }
  }
  return {
    phase: "processing",
    loaded,
    total,
    status: status.sync_progress?.state ?? "idle",
  };
}

/** Turns the camelCase input into the snake_case body the controller allows. */
function createBody(input: CreateSongImportInput, sourceUrl: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) body[key] = value;
  };

  put("source_url", sourceUrl);
  put("search_artist", input.searchArtist);
  put("search_title", input.searchTitle);
  put("search_album", input.searchAlbum);
  put("isrc", input.isrc);
  put("source_provider", input.sourceProvider);
  put("source_id", input.sourceId);
  put("source_kind", input.sourceKind);
  put("override_title", input.overrideTitle);
  put("override_artist", input.overrideArtist);
  put("override_album", input.overrideAlbum);
  put("artwork_url", input.artworkUrl);
  put("artwork_data_b64", input.artworkDataB64);
  put("expected_duration_s", input.expectedDurationS);
  put("playlist_id", input.playlistId);
  put("position", input.position);

  return body;
}

/**
 * One filter value, as either a scalar or the array form Rails reads as `IN`.
 *
 * Numbers are left as numbers: `encodeQuery` stringifies them, and the
 * null sentinel has no business here - none of these six columns is usefully
 * filtered on `IS NULL`.
 */
function asFilter(value: QueryValue | readonly QueryValue[]): QueryValue {
  return Array.isArray(value) ? [...value] : (value as QueryValue);
}

/**
 * Splits a {@link WaitOptions} into the half a single HTTP call understands,
 * so the `create` inside a `createAndWait` does not inherit `waitTimeoutMs` as
 * if it were a request deadline.
 */
function requestPartOf(options: WaitOptions): RequestOptions {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  };
}
