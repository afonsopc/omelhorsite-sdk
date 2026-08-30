/**
 * The `music.imports` namespace: getting audio INTO the library, and keeping a
 * Spotify account mirrored into it.
 *
 * Four route families sit behind one namespace because they are the four
 * doors a track can walk through:
 *
 * | Route family | What it is | Who may call it |
 * |---|---|---|
 * | `/song_imports` | one track, downloaded from a URL or found by search | any signed-in user |
 * | `/playlist_imports/preview` | read a playlist URL without importing it | any signed-in user |
 * | `/spotify_syncs/*` | mirror a Spotify account into playlists | Spotify-enabled accounts only |
 *
 * ## An import is not a `Job`
 *
 * `POST /song_imports` answers a song import, not a generic job, and there is
 * no `job_id` anywhere on it. So `oms.jobs.get()` will never find it and
 * `watch_token` means nothing here.
 *
 * What this namespace DOES share with `oms.jobs` is the polling loop:
 * {@link MusicImportsNamespace.wait} and {@link MusicImportsNamespace.watch}
 * poll `GET /song_imports/:id` until {@link isSongImportTerminal}, with the
 * same backoff, the same `waitTimeoutMs`, the same `signal` semantics and the
 * same two `OmsTimeoutError` codes. {@link SpotifySyncNamespace.waitForSync}
 * does the same against `GET /spotify_syncs/status`.
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
 * budgets of its own. Read its doc comment before writing a loop around it.
 *
 * ## OAuth tokens cannot reach any of this
 *
 * An OAuth access token gets `403 {"error":"insufficient_scope"}` on every
 * route here. Imports need a session cookie or a personal token, like the rest
 * of music.
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

/** The four states. */
export const SONG_IMPORT_STATES = Object.freeze({
  pending: "pending",
  processing: "processing",
  complete: "complete",
  failed: "failed",
} as const);

/**
 * The states that are final, and the ones {@link MusicImportsNamespace.wait}
 * stops on.
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
 * The state machine is NOT monotonic on the way there. A transient download
 * error puts the row back to `"pending"` with `progress_pct: 0.0` before a
 * retry, so a poller legitimately observes `processing -> pending ->
 * processing -> complete` and a progress bar legitimately goes backwards.
 * Never latch a UI on "it was processing, so it cannot be pending again"; read
 * the state every time.
 *
 * `"failed"`, by contrast, is only ever written when the server has decided
 * NOT to retry, so it really is the end.
 */
export function isSongImportTerminal(state: string): boolean {
  return (SONG_IMPORT_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * One song import.
 *
 * Every key below is present on every response; what varies is the value.
 *
 * ## Five fields you can write but never read back
 *
 * `search_artist`, `search_title`, `search_album`, `isrc` and `artwork_url` are
 * all accepted by `POST /song_imports` and NONE of them is echoed back.
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
   * `"yt_dlp"` (the default, and what every user-driven import is) or
   * `"spotify_sync"` (written by the Spotify sync, one row per track per run).
   * Never `"upload"` - that is a `Song.source_kind` value, not one of these.
   */
  readonly source_kind: string;
  readonly override_title: string | null;
  readonly override_artist: string | null;
  readonly override_album: string | null;
  /** Seconds, as a float. A hint the downloader uses to pick between candidates. */
  readonly expected_duration_s: number | null;
  /** Requested position in {@link SongImport.playlist_id}. See the note on `create`. */
  readonly position: number | null;
  /** The downloader's own request id. Diagnostics only; nothing here takes it. */
  readonly sidecar_request_id: string | null;
  readonly state: SongImportState;
  /**
   * Free text from the downloader (`"starting"`, `"complete"`, `"a repetir"`,
   * or whatever it last said). Human-facing, not a state: switch on
   * {@link SongImport.state}.
   */
  readonly progress_message: string | null;
  /**
   * A FLOAT between 0 and 1, not a percentage. `0.05` means 5%.
   *
   * It is a real number from the moment the row exists. It can go DOWN - a
   * transient retry resets it to `0.0`.
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
 * 1. **URL mode** - `sourceUrl` present. It must be a public http(s) URL:
 *    public DNS only, no redirect to a private address. Anything else is
 *    `400 "source_url is not allowed"`.
 * 2. **Search mode** - `searchArtist` AND `searchTitle` both non-blank, with no
 *    `sourceUrl`. The server goes and finds the track itself.
 *
 * Neither one satisfied is `400 "source_url or (search_artist + search_title)
 * required"`. One without the other counts as neither: `searchArtist` alone is
 * not search mode.
 *
 * Every other field is optional and every unknown field is dropped in silence,
 * so a typo here is a successful import that ignored what you asked for.
 */
export interface CreateSongImportInput {
  /** URL mode. Public http(s) only; see the note above. */
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
   * bad idea: it moves the import onto the slow bulk lane and makes the row
   * eligible for the playlist-position rewriting the sync does.
   */
  readonly sourceKind?: string;
  /** Tag overrides written onto the finished song instead of what the download carried. */
  readonly overrideTitle?: string;
  readonly overrideArtist?: string;
  readonly overrideAlbum?: string;
  /** Cover to embed. Must be a public http(s) URL, exactly like `sourceUrl`. */
  readonly artworkUrl?: string;
  /**
   * Cover as base64, for a picture that has no public URL. Wiped as soon as
   * the import settles. Keep it small: it is a JSON body, not a multipart
   * upload, and the CDN in front of the API caps a request body at roughly
   * 100 MB.
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
 * The server allowlists six columns and nothing else. An unrecognised
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
 * shape `oms.tools.downloader.preview()` returns, because both read metadata
 * the same way.
 *
 * Check `kind` first: a `"playlist"` carries `count` and `tracks` and none of
 * the track fields, a `"track"` carries the track fields and neither of those.
 * Note that `formats` is absent here even on a `"track"` - unlike the
 * downloader's own preview.
 */
export type PlaylistImportPreview = DownloaderPreview;

/**
 * Sustained ceiling on `POST /playlist_imports/preview`: 60 an hour, keyed by
 * user id.
 */
export const PLAYLIST_IMPORT_PREVIEW_HOURLY_LIMIT = 60;

/**
 * Burst ceiling on the same route: 20 a minute, from a bucket SHARED with
 * every other expensive tool (`/upscales`, `/vocal_separations`,
 * `/transcriptions`, `/caption_jobs`, `/jumpstyle_jobs`, `/songs/:id/separate`,
 * `/tools_downloader/*`).
 */
export const PLAYLIST_IMPORT_PREVIEW_BURST_LIMIT_PER_MINUTE = 20;

/**
 * How long the server waits on a download before giving up on one import:
 * ten minutes. A sensible floor for `waitTimeoutMs`, and the reason a shorter
 * one is a client-side deadline rather than a cancellation.
 */
export const SONG_IMPORT_SERVER_TIMEOUT_MS = 600_000;

/**
 * Default pause between polls of a song import: 1.5s. Slower than the jobs
 * default because progress is only written every 3 seconds anyway.
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
  /** Spotify account mirroring. Spotify-enabled accounts only - see the class. */
  readonly spotify: SpotifySyncNamespace;


  constructor(http: ApiClient) {
    super(http);
    this.spotify = new SpotifySyncNamespace(http);
  }

  /**
   * `GET /song_imports` - your import history, newest first only if you ask.
   *
   * Scoped to the caller, so `userId` can only ever narrow to yourself and a
   * foreign one answers an empty page rather than a 403.
   *
   * **The list is pruned.** `complete` and `deduped` rows older than 30 days
   * and `failed` rows older than 90 are deleted, so this is a recent-activity
   * feed, not an archive. It is also dominated by
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
   *   yours, never a 403 - and for one that has already been pruned.
   */
  async get(id: SongImportId, options: RequestOptions = {}): Promise<SongImport> {
    return this.http.get<SongImport>(`/song_imports/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `POST /song_imports` - 201 with the row, before any downloading starts.
   *
   * Returns immediately in every case. Either the row is already terminal
   * because dedupe hit ({@link SongImport.deduped}), or it is `"pending"` and
   * the download has been queued. Nothing about this call waits for audio.
   *
   * Which lane the download runs on depends on `sourceKind`: anything but
   * `"spotify_sync"` goes on the interactive lane precisely so a person
   * watching a spinner is not queued behind thousands of sync imports. Leave
   * `sourceKind` alone and you get the good lane.
   *
   * ## The 401 that is really a 403
   *
   * `playlistId` pointing at a playlist you cannot update answers
   * `401 "playlist not yours"`, an authorization failure wearing an
   * authentication status. Two consequences: it is an {@link OmsAuthError}, not an
   * {@link OmsApiError}, so a `catch` sorting by class puts it in the wrong
   * pile; and if the client was built with a token provider that implements
   * `onUnauthorized`, the transport spends one pointless refresh on it before
   * giving up. Test the message, not just the status.
   *
   * @throws {TypeError} before any request when neither mode is satisfied.
   * @throws {OmsApiError} 400 `"source_url is not allowed"` /
   *   `"artwork_url is not allowed"` for a URL that is not public http(s),
   *   `400` naming the missing mode, `404 "playlist not found"`.
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
   * Resolves for `"failed"` as well as `"complete"`: a download the server
   * could not do is an ANSWER. Check `state` before reading `song_id`.
   *
   * `waitTimeoutMs` has no default here either. The server gives a download
   * ten minutes ({@link SONG_IMPORT_SERVER_TIMEOUT_MS}) and may then retry it,
   * so a real import can outlive any deadline you pick; a deadline
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
   * ## It is not cheap
   *
   * Each call fetches metadata for a URL the CALLER chose and holds a server
   * thread for up to 60 seconds while it does. It therefore carries two
   * budgets:
   *
   * - {@link PLAYLIST_IMPORT_PREVIEW_HOURLY_LIMIT} 60 an hour, keyed by user
   *   id. This one does NOT set `Retry-After`;
   * - {@link PLAYLIST_IMPORT_PREVIEW_BURST_LIMIT_PER_MINUTE} 20 a minute, from
   *   a bucket SHARED with upscale, background removal, transcription, vocal
   *   separation, captions, jumpstyle, `/songs/:id/separate` and the
   *   downloader. Importing a playlist while a separation is running spends
   *   the same budget. This one does set `Retry-After`, which the transport
   *   honours.
   *
   * So: one preview per user action, never one per row of a list, and never
   * inside a retry loop. This method therefore does NOT retry by default -
   * every attempt burns one of the 60 - and a 502 here means an upstream said
   * no, which a replay will not change. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 400 `"url is required"` when blank; 400
   *   `"url is not allowed"` for a URL that is not public http(s); 400 with a
   *   message pointing at `/account/dashboard` for ANY `open.spotify.com` or
   *   `spotify.com` URL - Spotify is never previewed here, it goes through
   *   {@link MusicImportsNamespace.spotify}; 502 carrying the first 200
   *   characters of the downloader's own error.
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
 * song import was created on the slow bulk lane. The audio arrives minutes or
 * hours later.
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
 * rather than as a job.
 *
 * Every key is optional here because a freshly linked identity carries `{}`
 * until the first sync starts. Treat a missing `state` as `"idle"`.
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
   * `"Sincronização interrompida"` (the server writes that one in Portuguese).
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
 * - `sync_liked` defaults to `true`;
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
   * Whether this playlist is currently selected. On an unconfigured identity
   * (no `enabled_playlists` saved) EVERY row comes back `true`.
   */
  readonly enabled: boolean;
}

/**
 * What `GET /spotify_syncs/preview` answers.
 *
 * The list is already filtered to what can actually be synced: playlists owned
 * by `"spotify"` (the editorial ones) and other people's non-collaborative
 * playlists are dropped, because Spotify does not let this integration read
 * their tracks. A playlist the user can see in the Spotify app and not here is
 * that rule, not a bug.
 */
export interface SpotifySyncPreview {
  readonly sync_liked: boolean;
  readonly playlists: SpotifyPlaylistOption[];
}

/**
 * Body of `PATCH /spotify_syncs/settings`.
 *
 * **Presence-sensitive, and two of the three keys delete data.** An omitted
 * key is left alone and a present one is applied - which means you cannot
 * express "leave enabled_playlists alone" by sending `null`, and you must send
 * the WHOLE list every time rather than a delta.
 *
 * The destruction is immediate and synchronous, inside the PATCH:
 *
 * - `enabledPlaylists` **destroys the local copy** of every synced playlist
 *   whose Spotify id is not in the new list. Songs stay in the library; the
 *   playlist and its rows do not. Re-enabling it later
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

/** A `"running"` sync older than this is treated as lost. Two hours. */
export const SPOTIFY_SYNC_STALE_AFTER_MS = 7_200_000;

/** True while a sync run is in flight. Anything else - `"idle"` included - is not. */
export function isSpotifySyncRunning(status: SpotifySyncStatus): boolean {
  return status.sync_progress?.state === "running";
}

/**
 * Spotify account mirroring, reachable as `oms.music.imports.spotify`.
 *
 * ## Every method here 403s unless Spotify is enabled for the account
 *
 * Every route answers `403 "Spotify is not enabled for this account"` unless
 * an administrator has enabled Spotify for the account. That is step one of
 * two, and the two fail in completely different places:
 *
 * 1. **The account flag.** Without it, `GET /auth/link/spotify` refuses before
 *    it ever redirects to Spotify: the user is bounced straight back with
 *    `?error=spotify_not_allowlisted`, having seen no Spotify screen at all.
 *    Every method in this class also 403s.
 * 2. **Spotify's own allowlist.** The integration runs in Spotify's
 *    Development Mode, which admits at most 25 named users. With the flag set
 *    but the user not registered on Spotify's side, the link flow LOOKS right
 *    up to the last moment: the redirect to Spotify happens, the user signs
 *    in, and then Spotify refuses the authorization itself. The user is
 *    redirected back with the same `?error=spotify_not_allowlisted`, never
 *    linked, with nothing in this API having recorded an attempt. From the
 *    outside it looks like the login silently died, and the fix is on
 *    Spotify's side.
 *
 * Because step 2 fails outside this API, {@link SpotifySyncNamespace.status}
 * answering `{ connected: false }` on an enabled account is the normal symptom
 * of it. `connected: false` means "no linked identity", which covers both
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
   * more than {@link SPOTIFY_SYNC_STALE_AFTER_MS} ago, the server rewrites it
   * to `"failed"` before answering, because a run that died leaves an eternal
   * `"running"` behind and
   * {@link SpotifySyncNamespace.start} refuses to queue another while one is
   * "in flight". Calling this is therefore how a stuck account gets unstuck -
   * which also means it is not safe to treat as a cacheable read.
   *
   * @throws {OmsApiError} 403 `"Spotify is not enabled for this account"` when
   *   Spotify is not enabled for the account. See the class comment.
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
   *   else upstream; 403 when Spotify is not enabled for the account.
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
   * @throws {OmsApiError} 404 `"link your Spotify account first"`; 403 when
   *   Spotify is not enabled for the account.
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
   * A manual run is not the same as the nightly one. It re-walks every
   * enabled playlist even when Spotify says nothing changed - it is the "I
   * think something is out of step" button - which is why it is much more
   * expensive than the automatic sync and why it should be user-initiated,
   * never polled into.
   *
   * What finishing means: `"complete"` says the walk is done and a song import
   * exists for every new track. The downloads themselves are still queued
   * behind however many thousand imports the run just created. The library
   * fills in for a long time afterwards.
   *
   * @throws {OmsApiError} 409 `"a sync is already running"` - unless the
   *   running one is over two hours old, in which case
   *   {@link SpotifySyncNamespace.status} rewrites it to failed first and this
   *   then succeeds; 404 `"link your Spotify account first"`; 403 when Spotify
   *   is not enabled for the account.
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
   * a stale one - so a wait against a run that died ends after two hours
   * rather than never.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` / `"aborted"`, as everywhere.
   * @throws {OmsApiError} 403 when Spotify is not enabled for the account, on
   *   the first poll.
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

/** Turns the camelCase input into the snake_case body the server accepts. */
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
 * One filter value, as either a scalar or the array form the server matches
 * as a set.
 *
 * Numbers are left as numbers: `encodeQuery` stringifies them, and the
 * null sentinel has no business here - none of these six fields is usefully
 * filtered on null.
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
