/**
 * Downloader: fetches media from a public URL, or finds it from artist plus
 * title.
 *
 * Different from its siblings in five ways worth knowing before writing a line
 * against it:
 *
 * - it uploads nothing, so there is no captcha and no multipart form. It is
 *   also the one tool with NO anonymous door at all: every endpoint here needs
 *   a credential;
 * - its job lives on the yt-dlp sidecar, NOT in the `jobs` table and NOT in the
 *   database, so poll it with {@link DownloaderNamespace.getJob} and never with
 *   `oms.jobs`;
 * - the sidecar's job record has no id in it, so this namespace stamps one on.
 *   See {@link DownloaderJob.id};
 * - every URL it is given passes an SSRF guard server-side. A private or
 *   link-local address comes back as a 400, by design. Do not try to work
 *   around it;
 * - {@link DownloaderNamespace.download} is ONE SHOT. Streaming the file
 *   deletes it from the sidecar, so a second call is a 404. Buffer the blob and
 *   write it somewhere before you need it twice.
 *
 * Limits, all enforced by the backend:
 *
 * | | |
 * |---|---|
 * | download jobs | 30 an hour |
 * | previews and artwork lookups | 60 an hour, together |
 * | all three `POST`s | 20 a minute, shared with every other expensive tool |
 *
 * The hourly limits are keyed on the user id, so they follow the account rather
 * than the machine. Unlike the other tools there is no daily quota and so no
 * `quota()` here: what bounds this tool is a rate, and the only way to read it
 * is to hit it. A 429 from the hourly limit and a 429 from the 20-a-minute
 * throttle are told apart by `retryAfterMs`, which only the latter sets.
 *
 * There is nothing metered about a byte of this: a two-hour video costs the
 * same one job as a three-minute song.
 */

import { Resource } from "../../http";
import type { FileOutput, Id, Progress, RequestOptions, WaitOptions } from "../../types";
import { pollUntilTerminal } from "../jobs";
import type { ToolRunOptions } from "./index";

/**
 * One downloadable rendition the source offers.
 *
 * VIDEO renditions only: the sidecar drops every format whose `vcodec` is
 * `"none"` before answering, so an audio-only download has no format list to
 * choose from and `formatId` is not worth passing for one.
 */
export interface DownloaderFormat {
  /** What to pass as {@link CreateDownloadInput.formatId}. */
  readonly format_id?: string;
  readonly ext?: string;
  /** `"1920x1080"`, or built from width and height when the source omits it. */
  readonly resolution?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly fps?: number | null;
  readonly vcodec?: string;
  readonly acodec?: string;
  /** Bytes, exact or approximate. `null` when the source will not say. */
  readonly filesize?: number | null;
  /** Total bitrate, kbps. */
  readonly tbr?: number | null;
  readonly format_note?: string | null;
  /** False for a video-only rendition that would need muxing. */
  readonly has_audio?: boolean;
  readonly [key: string]: unknown;
}

/** One entry of a playlist preview. */
export interface DownloaderPlaylistTrack {
  readonly title?: string | null;
  readonly artist?: string | null;
  readonly duration_s?: number | null;
  readonly thumbnails?: ReadonlyArray<{ readonly url?: string; readonly [key: string]: unknown }>;
  /** Feed this back to {@link DownloaderNamespace.preview} or as a `sourceUrl`. */
  readonly webpage_url?: string | null;
  readonly id?: string | null;
}

/**
 * `POST /tools_downloader/preview` - what the source says about a URL.
 *
 * Two shapes behind one type, told apart by {@link DownloaderPreview.kind}: a
 * `"track"` carries the metadata fields, a `"playlist"` carries `count` and
 * `tracks` and none of the rest. Check `kind` before reading anything else.
 */
export interface DownloaderPreview {
  readonly kind?: "track" | "playlist" | string;
  readonly title?: string | null;
  readonly artist?: string | null;
  readonly album?: string | null;
  /**
   * Seconds. Named `duration_s` because that is what the sidecar sends; there
   * is no `duration` key on this payload.
   */
  readonly duration_s?: number | null;
  /** Every thumbnail the source offers, worst first. */
  readonly thumbnails?: ReadonlyArray<{ readonly url?: string; readonly [key: string]: unknown }>;
  readonly webpage_url?: string | null;
  /** The source's own id for the item, not a job id. */
  readonly id?: string | null;
  /** Which yt-dlp extractor matched. */
  readonly extractor?: string | null;
  /** Video renditions. Absent on a playlist. */
  readonly formats?: DownloaderFormat[];
  /** Entries, on a `"playlist"`. */
  readonly tracks?: DownloaderPlaylistTrack[];
  /** How many entries the playlist has. */
  readonly count?: number | null;
  readonly [key: string]: unknown;
}

/** One cover-art candidate. */
export interface ArtworkCandidate {
  /** Full-size image. Pass it as {@link CreateDownloadInput.artworkUrl}. */
  readonly url: string;
  /** Smaller version of the same image, for a picker. */
  readonly thumb_url?: string | null;
  /** `"itunes"`, `"deezer"` or `"musicbrainz"`. */
  readonly source?: string;
  /** Pixels, when the source states them. `null` is common and means unknown. */
  readonly width?: number | null;
  readonly height?: number | null;
  /** Album or track name the candidate was found under. */
  readonly label?: string | null;
  /** Artist, or whatever the source offers as a second line. */
  readonly subtitle?: string | null;
  readonly [key: string]: unknown;
}

/** Arguments for an artwork lookup. Pass either the triple or a free query. */
export interface ArtworkSearchInput {
  readonly artist?: string;
  readonly title?: string;
  readonly album?: string;
  /**
   * Free text, used when neither `artist` nor `title` is given. It is thrown at
   * the sources as a title with no artist, so the triple beats it when you have
   * one.
   */
  readonly query?: string;
}

/** What to fetch. */
export type DownloaderKind = "audio" | "video";

/**
 * Arguments for a download job.
 *
 * Either `sourceUrl`, or BOTH `artist` and `title` so the sidecar can search.
 * Anything else is a 400.
 */
export interface CreateDownloadInput {
  /** Direct URL. Must be public: the SSRF guard rejects private ranges. */
  readonly sourceUrl?: string;
  /** Search terms, used when there is no `sourceUrl`. Both are required together. */
  readonly artist?: string;
  readonly title?: string;
  readonly album?: string;
  /** Which site to search. */
  readonly source?: string;
  readonly kind?: DownloaderKind;
  /**
   * A `format_id` from {@link DownloaderPreview.formats}. Video only - the
   * format list never contains an audio-only rendition.
   */
  readonly formatId?: string;
  /** Metadata written into the finished file, overriding what was detected. */
  readonly overrideTitle?: string;
  readonly overrideArtist?: string;
  readonly overrideAlbum?: string;
  /** Cover art by URL. Same SSRF guard as `sourceUrl`. */
  readonly artworkUrl?: string;
  /** Cover art inline, base64, when you already hold the bytes. */
  readonly artworkDataB64?: string;
}

/**
 * How far along a sidecar download is.
 *
 * These are the sidecar's own five strings. Note the two that trip people up:
 * it finishes on `"complete"` - the same word a tool row uses, NOT the `"done"`
 * an older draft of this SDK claimed - and it fails on `"failed"`, not
 * `"error"`.
 */
export type DownloaderJobStatus = "queued" | "fetching" | "downloading" | "complete" | "failed";

/** Statuses a sidecar download never leaves. */
export const DOWNLOADER_TERMINAL_STATUSES: readonly DownloaderJobStatus[] = Object.freeze([
  "complete",
  "failed",
] as const);

/** True once a sidecar download can never change again. */
export function isDownloaderTerminal(status: string): boolean {
  return (DOWNLOADER_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** A download job, as the sidecar reports it. */
export interface DownloaderJob {
  /**
   * The job id.
   *
   * Stamped on by this namespace, not sent by the server: the create call
   * answers `{ request_id, target }` and the progress call answers a bare
   * `{ status, message, progress }` with no identifier in it at all. Both are
   * normalised here so a job can be passed around as one object.
   */
  readonly id: Id;
  /** The sidecar's own name for {@link DownloaderJob.id}, on the create answer. */
  readonly request_id?: string;
  /** What the job was pointed at - the URL, or the search string. Create answer only. */
  readonly target?: string;
  /**
   * Absent on the create answer, which carries no status at all. Treat a
   * missing status as `"queued"`: the sidecar has just registered it.
   */
  readonly status?: DownloaderJobStatus | string;
  /** Fraction in `[0, 1]`, NOT a percentage. `1` once complete. */
  readonly progress?: number | null;
  /** Human sentence about the current step, and the failure reason once failed. */
  readonly message?: string | null;
  /**
   * Never sent by this sidecar. The real filename arrives on the download
   * response instead - see {@link DownloaderNamespace.downloadFile} - and
   * `message` holds `"saved <name>"` once complete.
   */
  readonly filename?: string | null;
  /**
   * Failure reason. The sidecar reports it as `message`, so this is normally
   * absent; read `message` when `status` is `"failed"`.
   */
  readonly error?: string | null;
  /** Metadata the sidecar resolved, present once complete. */
  readonly title?: string | null;
  readonly uploader?: string | null;
  readonly duration_s?: number | null;
  readonly source_url?: string | null;
  readonly source_provider?: string | null;
  readonly source_id?: string | null;
  readonly audio_codec?: string | null;
  readonly audio_bitrate_kbps?: number | null;
  readonly [key: string]: unknown;
}

/**
 * Renders a sidecar download as a {@link Progress}.
 *
 * The sidecar's `progress` is a FRACTION, so it is scaled to the 0-100 every
 * other tool in this SDK reports. `total` stays `undefined` while there is no
 * number at all, rather than inventing a denominator a spinner would then
 * render as 0%.
 */
export function downloaderProgress(job: DownloaderJob): Progress {
  const fraction = job.progress;
  const known = typeof fraction === "number";
  return {
    phase: "download",
    loaded: known ? Math.round(fraction * 100) : 0,
    total: known ? 100 : undefined,
    status: job.status ?? "queued",
  };
}

/** The `downloader` tool, reachable as `oms.tools.downloader`. */
export class DownloaderNamespace extends Resource {
  /**
   * `POST /tools_downloader/preview` - metadata and available formats for a
   * URL, without downloading anything.
   *
   * Answers a `"track"` or a `"playlist"`; check {@link DownloaderPreview.kind}
   * before reading anything else. A playlist URL previews as a listing, but
   * {@link createJob} downloads only what a single `sourceUrl` resolves to, so
   * feed the entries' `webpage_url` back one at a time.
   *
   * SLOW, and slower than the SDK's own default deadline: the sidecar waits up
   * to 60 seconds for yt-dlp and the transport's default `timeoutMs` is also
   * 60 seconds, so a source that is merely sluggish aborts client-side just
   * before the answer. Pass a `timeoutMs` above 60000 for anything but a
   * well-behaved host.
   *
   * NOT retried by default. The controller turns every failure into a 502,
   * including "this source refuses yt-dlp", which no amount of retrying fixes -
   * and each attempt spends one of the 60 hourly lookups and parks a server
   * thread for up to a minute. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 400 when the URL is blank or fails the SSRF guard,
   *   502 when the source refuses or yt-dlp cannot read it.
   * @throws {OmsQuotaError} 429 past 60 lookups an hour, or from the
   *   20-a-minute expensive-tools throttle - only the second sets
   *   `retryAfterMs`.
   * @throws {OmsAuthError} 401 when there is no credential. This tool has no
   *   anonymous door.
   */
  async preview(url: string, options: RequestOptions = {}): Promise<DownloaderPreview> {
    return this.http.post<DownloaderPreview>(
      "/tools_downloader/preview",
      { url },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `POST /tools_downloader/artwork_search` - cover-art candidates.
   *
   * Fans out to iTunes, Deezer and MusicBrainz in parallel and returns whatever
   * answered in time, deduplicated by URL. A source that is slow or down is
   * skipped silently, so an empty list means "nothing found right now", not
   * "this record has no cover".
   *
   * The controller answers `{ items: [...] }`; this unwraps it.
   *
   * NOT retried by default, for the same reason as {@link preview}: a failure
   * here is a 502 that means an upstream said no, and every attempt costs one
   * of the 60 hourly lookups.
   *
   * @throws {OmsQuotaError} 429 past 60 lookups an hour, or from the
   *   expensive-tools throttle.
   * @throws {OmsApiError} 502 when the lookup itself blew up.
   */
  async artworkSearch(input: ArtworkSearchInput, options: RequestOptions = {}): Promise<ArtworkCandidate[]> {
    const answer = await this.http.post<{ items?: ArtworkCandidate[] }>(
      "/tools_downloader/artwork_search",
      {
        ...(input.artist === undefined ? {} : { artist: input.artist }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.album === undefined ? {} : { album: input.album }),
        ...(input.query === undefined ? {} : { query: input.query }),
      },
      { ...options, retry: options.retry ?? false },
    );
    return answer?.items ?? [];
  }

  /**
   * `POST /tools_downloader/jobs` - starts a download.
   *
   * Answers immediately with an id and nothing else - no status, no progress.
   * The sidecar's own answer is `{ request_id, target }`; this maps
   * `request_id` onto {@link DownloaderJob.id} so the record matches every
   * other tool in the SDK, and keeps both original keys alongside it.
   *
   * NOT retried by default: replaying this `POST` after a 502 starts a SECOND
   * download of the same thing and spends another of the 30 hourly jobs, with
   * the first still running and no way to reach its id. Pass `retry: {}` to opt
   * back in.
   *
   * @throws {OmsApiError} 400 when neither a `sourceUrl` nor an artist+title
   *   pair was given, or when `sourceUrl` or `artworkUrl` fails the SSRF guard.
   *   502 when the sidecar refused the job.
   * @throws {OmsQuotaError} 429 past 30 jobs an hour, or from the 20-a-minute
   *   expensive-tools throttle - only the second sets `retryAfterMs`.
   * @throws {OmsAuthError} 401 when there is no credential.
   */
  async createJob(input: CreateDownloadInput, options: RequestOptions = {}): Promise<DownloaderJob> {
    const answer = await this.http.post<Record<string, unknown>>(
      "/tools_downloader/jobs",
      {
        ...(input.sourceUrl === undefined ? {} : { source_url: input.sourceUrl }),
        ...(input.artist === undefined ? {} : { artist: input.artist }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.album === undefined ? {} : { album: input.album }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.formatId === undefined ? {} : { format_id: input.formatId }),
        ...(input.overrideTitle === undefined ? {} : { override_title: input.overrideTitle }),
        ...(input.overrideArtist === undefined ? {} : { override_artist: input.overrideArtist }),
        ...(input.overrideAlbum === undefined ? {} : { override_album: input.overrideAlbum }),
        ...(input.artworkUrl === undefined ? {} : { artwork_url: input.artworkUrl }),
        ...(input.artworkDataB64 === undefined ? {} : { artwork_data_b64: input.artworkDataB64 }),
      },
      { ...options, retry: options.retry ?? false },
    );
    return withId(answer, readId(answer));
  }

  /**
   * `GET /tools_downloader/jobs/:id` - one poll against the sidecar.
   *
   * The sidecar answers a bare `{ status, message, progress }` with no id in
   * it, so the id you asked with is stamped back on. Once complete the same
   * payload carries the resolved metadata - title, uploader, duration, codec.
   *
   * The sidecar holds jobs in memory with a TTL sweep, so a 404 here means
   * "unknown or swept", and a process restart loses every job at once.
   *
   * @throws {OmsApiError} 404 when the sidecar does not know the id, 502 when
   *   the sidecar itself is unreachable.
   */
  async getJob(id: Id, options: RequestOptions = {}): Promise<DownloaderJob> {
    const answer = await this.http.get<Record<string, unknown>>(
      `/tools_downloader/jobs/${encodeURIComponent(id)}`,
      options,
    );
    return withId(answer, id);
  }

  /**
   * Starts a download and waits for it.
   *
   * Polls {@link getJob} directly: this job is not in the `jobs` table, so
   * `oms.jobs.wait` cannot see it. The loop is still `pollUntilTerminal` from
   * the jobs module - the same one every other tool uses.
   *
   * Resolves for `"failed"` as well as `"complete"`, because a source that
   * refuses is an answer. Check `status` before calling {@link download}, and
   * read `message` for the reason - the sidecar reports failures there, not in
   * `error`.
   *
   * Pass `waitTimeoutMs` (or a `signal`) to bound the wait; there is no default
   * deadline. The sidecar gives one download up to 10 minutes of its own before
   * giving up.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the download,
   *   which keeps running and can still be picked up with {@link getJob}.
   */
  async run(input: CreateDownloadInput, options: ToolRunOptions = {}): Promise<DownloaderJob> {
    const created = await this.createJob(input, options);
    options.onProgress?.(downloaderProgress(created));
    return this.wait(created.id, options);
  }

  /**
   * Waits for a download somebody else started.
   *
   * The half of {@link run} that does not spend one of the 30 hourly jobs -
   * useful after a `--no-wait` create, or in a second process holding only the
   * id.
   */
  async wait(id: Id, options: WaitOptions = {}): Promise<DownloaderJob> {
    return pollUntilTerminal<DownloaderJob>({
      ...options,
      label: `download ${id}`,
      poll: (request) => this.getJob(id, request),
      terminal: (job) => isDownloaderTerminal(job.status ?? ""),
      progress: downloaderProgress,
    });
  }

  /**
   * `GET /tools_downloader/jobs/:id/file` - the finished file, streamed
   * through Rails from the sidecar.
   *
   * ONE SHOT. The sidecar deletes the file as soon as it has finished streaming
   * it, so a second call to this - or to {@link downloadFile} - is a 404. Write
   * the blob somewhere before you need it twice.
   *
   * Buffers the whole file, because it is a file the caller is about to write
   * somewhere. That is fine for a song and a real consideration for a two-hour
   * video, which is the one place in this SDK where `http.raw` and the response
   * stream are worth reaching for directly.
   *
   * Unlike a tool artefact, this URL is a Rails endpoint and NOT a signed
   * object-store link, so it does carry the bearer token like any other call.
   *
   * NOT retried by default, and this is the one download in the SDK where that
   * is not a style choice: a retry after a torn stream finds a file the sidecar
   * has already deleted.
   *
   * @throws {OmsApiError} 409 when the job is not finished yet, 404 once the
   *   sidecar has swept it or once this has already been called, 502 when the
   *   result expired underneath the sidecar or the stream broke.
   */
  async download(id: Id, options: RequestOptions = {}): Promise<Blob> {
    return (await this.downloadFile(id, options)).data;
  }

  /**
   * The same one-shot download as {@link download}, keeping the filename.
   *
   * The only place the real filename appears: the sidecar's job record does not
   * carry one, and Rails forwards the sidecar's `Content-Disposition` on this
   * response and nowhere else. Prefer this over {@link download} whenever the
   * file is going to disk.
   *
   * @throws {OmsApiError} exactly as {@link download}.
   */
  async downloadFile(id: Id, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download(`/tools_downloader/jobs/${encodeURIComponent(id)}/file`, {
      ...options,
      retry: options.retry ?? false,
    });
  }

  /**
   * The unauthenticated URL of the file endpoint. Pure string building, no
   * request.
   *
   * Deliberately does NOT carry a credential, which makes it useless for
   * handing to an `<a download>` or a `<video src>`: the route needs one, and
   * an anonymous request to it is a 401. It is here so a caller can log or
   * display the address, and so the shape of the endpoint is documented
   * somewhere other than inside {@link downloadFile}.
   *
   * The web app builds a *usable* browser URL by appending its session token
   * as a `?token=` query parameter. The SDK will not do that: the transport
   * holds the token so it can put it in an `Authorization` header, and copying
   * it into a URL puts it in browser history, in the Referer, and in every
   * proxy log between here and the API. A host that genuinely needs a
   * browser-followable link should call {@link downloadFile} and hand the
   * blob to a local object URL instead.
   *
   * Remember the endpoint is ONE SHOT whichever way it is reached.
   */
  fileUrl(id: Id): string {
    return this.http.url(`/tools_downloader/jobs/${encodeURIComponent(id)}/file`);
  }
}

/** Reads the sidecar's `request_id` off a create answer. */
function readId(answer: Record<string, unknown> | null | undefined): string {
  const raw = answer?.["request_id"] ?? answer?.["id"];
  return typeof raw === "string" ? raw : "";
}

/** Stamps an id onto a sidecar payload that has none, without losing a field. */
function withId(answer: Record<string, unknown> | null | undefined, id: string): DownloaderJob {
  return { ...(answer ?? {}), id } as DownloaderJob;
}
