/**
 * Captions: karaoke subtitles burned into a video.
 *
 * The only tool with three steps rather than one, and they must go in order:
 *
 * 1. {@link CaptionsNamespace.create} uploads the video. The status becomes
 *    `"uploaded"` and the server reports the probed dimensions and duration.
 * 2. {@link CaptionsNamespace.transcribe} transcribes ONE window of it. The
 *    quota is charged on that window, not on the whole file. The status walks
 *    `"transcribing"` -> `"transcribed"` and the words land on the row.
 * 3. {@link CaptionsNamespace.render} burns the words in. The status walks
 *    `"rendering"` -> `"complete"` and `output_url` appears.
 *
 * Between steps the row must be idle: calling one while another is running is
 * a 409, not a queue. That is why steps 2 and 3 WAIT before they return -
 * handing back a busy row would just guarantee the caller's next call is the
 * 409. Use {@link CaptionsNamespace.get} to poll a job somebody else started.
 *
 * Limits, all enforced server-side:
 *
 * | | |
 * |---|---|
 * | file size | 250 MiB (`413`) |
 * | video length | 20 minutes (`400`) |
 * | one transcribed window | 15 minutes (`400`) |
 * | words per render | 3000, 80 characters each |
 * | daily quota, anonymous | 15 minutes of transcribed window |
 * | daily quota, signed in | 60 minutes of transcribed window |
 * | `POST` on any of the three steps | 20 a minute, shared with every other expensive tool |
 *
 * The upload itself spends no quota - only a transcribed window does - but the
 * 20-minute cap on the video exists because a render re-encodes the WHOLE file,
 * captioned part or not. So a 19-minute video with a 30-second window is a
 * cheap transcription and an expensive render, and only the first of those is
 * metered.
 *
 * Read {@link CaptionsNamespace.quota} before uploading, and again once the
 * window is known: the second check is the exact one, and the server refuses a
 * window that would cross the ceiling rather than truncating it.
 *
 * **The 250 MiB ceiling is not reachable through {@link CaptionsNamespace.create}.**
 * Any single request body over roughly 100 MB is answered 413 before the API
 * sees it, so the API also exposes a three-call chunked upload -
 * `POST /caption_jobs/uploads` opens a session and returns a signed
 * `upload_token` plus a `part_size` (32 MiB), `POST /caption_jobs/uploads/parts?offset=`
 * streams each raw part under an `X-Upload-Token` header, and
 * `POST /caption_jobs/uploads/finish` probes the assembled file and creates the
 * row. {@link CaptionsNamespace.upload} drives whichever of the two a given
 * file needs, so step 1 is one call again: under
 * {@link CAPTION_CHUNKED_THRESHOLD} it IS `create`, above it it is
 * {@link CaptionsNamespace.createChunked}, and both answer the same
 * `"uploaded"` row. Reach for `create` directly only when the file is known to
 * be small, and for the three methods under `upload` only to drive the parts
 * yourself.
 *
 * One caveat: an OAuth access token gets `403 insufficient_scope` on the three
 * chunked routes and on `fonts`; of the upload paths, only `create` is open to
 * one. A session token reaches them all.
 */

import { OmsError } from "../../errors";
import { Resource } from "../../http";
import { isNativeFile, readFileInput } from "../../types";
import type { FileInput, Id, OperationOptions, Progress, RequestOptions } from "../../types";
import { pollUntilTerminal } from "../jobs";
import {
  fetchToolArtifact,
  requireToolArtifact,
  toolCaptchaFields,
  toolProgress,
  type SecondsQuota,
  type ToolCaptcha,
  type ToolRecord,
  type ToolRunOptions,
} from "./index";

/**
 * Lifecycle of a caption job. Wider than {@link ToolStatus} because the job
 * has two distinct pieces of work.
 */
export type CaptionStatus = "uploaded" | "transcribing" | "transcribed" | "rendering" | "complete" | "failed";

/**
 * The two statuses with work in flight.
 *
 * A job in one of these refuses new work with a 409. Note this is NOT the
 * complement of "terminal": `"uploaded"` and `"transcribed"` are idle but not
 * finished, which is the whole point of a three-step tool.
 */
export const CAPTION_BUSY_STATUSES: readonly CaptionStatus[] = Object.freeze(["transcribing", "rendering"] as const);

/** True while a step is running and the job will refuse another one. */
export function isCaptionBusy(status: string): boolean {
  return (CAPTION_BUSY_STATUSES as readonly string[]).includes(status);
}

/**
 * One timed word of the transcript.
 *
 * `text`, `t0`, `t1` - NOT `word`, `start`, `end`. These are the keys the
 * render endpoint permits and the keys a transcription writes onto the row, so
 * a word object built any other way is silently dropped server-side and the
 * render fails with "No words to render".
 *
 * Timings are seconds from the START OF THE VIDEO, not from the start of the
 * transcribed window: the server shifts them onto the video clock before
 * saving, so an edited list can be sent straight back.
 */
export interface CaptionWord {
  /** The word itself. Trimmed and truncated to 80 characters server-side. */
  readonly text: string;
  /** Seconds from the video start. */
  readonly t0: number;
  /** Seconds from the video start. Must be `>= t0`. */
  readonly t1: number;
}

/**
 * An RGB triple, each channel clamped to `[0, 255]` server-side.
 *
 * The server reads the key only when the array has EXACTLY three entries; two
 * or four is dropped in silence, which costs a whole render to discover.
 */
export type CaptionRgb = readonly [number, number, number] | readonly number[];

/**
 * Look of the burned-in captions.
 *
 * Open bag, because the renderer gains options without an SDK release and
 * unknown keys are dropped server-side rather than rejected. The named keys are
 * the ones the server permits today; anything else - a font name, a hex
 * colour - is accepted by the request and then thrown away, which is worth
 * knowing before spending a render on it.
 *
 * Every numeric key is CLAMPED, not validated: a value outside the range comes
 * back as the nearest end of it rather than as a 400.
 */
export interface CaptionStyle {
  /**
   * A font KEY from {@link CaptionsNamespace.fonts}, never a path: the
   * renderer resolves the key against its installed faces, so a caller cannot
   * point it at a file. Must match `/\A[a-z0-9_-]{1,40}\z/`; anything else is
   * dropped and the renderer uses its own default.
   */
  readonly font?: string;
  /** Font size as a fraction of the video height. Clamped to `[0.03, 0.09]`. */
  readonly fontscale?: number;
  /**
   * Outline thickness as a fraction of the font size. Clamped to `[0, 0.3]`,
   * and `0` is a legitimate choice meaning no outline at all - which is why
   * the server reads this key whenever it is PRESENT rather than when it is
   * truthy, unlike every other numeric key here.
   */
  readonly stroke_factor?: number;
  /** Vertical placement, `0` top to `1` bottom. Clamped to `[0.3, 0.9]`. */
  readonly pos?: number;
  /** Words on screen at once. Clamped to `[1, 6]`. */
  readonly max_words?: number;
  /** Seconds of silence that starts a new caption chunk. Clamped to `[0.1, 1.0]`. */
  readonly gap?: number;
  /** x264 quality, lower is better and bigger. Clamped to `[16, 30]`. */
  readonly crf?: number;
  /** x264 speed. Anything outside these three is ignored. */
  readonly preset?: "veryfast" | "medium" | "slow";
  /**
   * Colour of the word currently being sung, as `[r, g, b]`, each clamped to
   * `[0, 255]`. Named after its default rather than after its job. Ignored
   * unless the array has exactly three entries.
   */
  readonly yellow?: CaptionRgb;
  /** Colour of the words that are not highlighted. Same three-entry rule. */
  readonly white?: CaptionRgb;
  /** Colour of the outline. Same three-entry rule. */
  readonly stroke?: CaptionRgb;
  readonly [key: string]: unknown;
}

/**
 * A caption job.
 *
 * Every route that answers with one - create, the chunked upload's finish
 * call, show, transcribe and render - answers the same shape, so every key
 * below is present on every response.
 *
 * `width`, `height`, `fps`, `duration` and `transcribed_seconds` are always
 * real numbers: `0` until the probe fills them in.
 */
export interface CaptionJob extends ToolRecord {
  readonly status: CaptionStatus;
  /** Original upload name. The server substitutes `"video.mp4"` for a blank
   * one, so this is never empty in practice. */
  readonly filename: string;
  /** Pixels. `0` means "not probed yet", not unknown. */
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Seconds of video, probed at upload. */
  readonly duration: number;
  /** Language of the last transcribe call, `"auto"` included. `null` before the first. */
  readonly language: string | null;
  /** The transcribed window, seconds from the video start. `null` before the first transcribe. */
  readonly window_start: number | null;
  readonly window_end: number | null;
  /**
   * Seconds charged against the quota so far, accumulated across every window
   * transcribed on this job.
   */
  readonly transcribed_seconds: number;
  /**
   * Timed words, from `"transcribed"` onwards.
   *
   * `null` and not `[]` when there are none, and the key is present either
   * way.
   */
  readonly words: CaptionWord[] | null;
  /** What the renderer is doing right now, read live. `null` unless the
   * status is `"rendering"`. */
  readonly render_stage: string | null;
  /** Signed URL of the finished video once complete and attached, `null` otherwise. */
  readonly output_url: string | null;
}

/** Arguments for uploading a video. */
export interface CreateCaptionJobInput extends ToolCaptcha {
  /** The video. Sent as the `video` form field. Caps: 250 MiB, 20 minutes. */
  readonly video: FileInput;
}

/** Arguments for transcribing a window. */
export interface TranscribeCaptionInput {
  /** Seconds from the video start. */
  readonly start: number;
  /** Seconds from the video start. Must exceed `start` and be at most 15 minutes past it. */
  readonly end: number;
  /** ISO language, or `"auto"`. Defaults to `"auto"`. */
  readonly language?: string;
}

/** Arguments for rendering. */
export interface RenderCaptionInput {
  /**
   * Words to burn in. Omit to use the words already on the row; pass an edited
   * array to fix what the transcription misheard. Cap: 3000 words, 80
   * characters each.
   *
   * Omitting costs one extra `GET`: the render endpoint has no fallback of its
   * own and refuses a request with no word list, so the SDK reads the row and
   * sends its words back. See {@link CaptionsNamespace.render}.
   */
  readonly words?: CaptionWord[];
  readonly style?: CaptionStyle;
}

/**
 * Renders a caption job as a {@link Progress}, render stage included.
 *
 * Same liberty as the vocal separator takes with the queue position: the
 * render stage is folded into `status` - `"rendering (encoding)"` - because
 * `status` is the only part of a {@link Progress} a host renders as text, and a
 * whole-file re-encode is long enough that "rendering" alone tells a person
 * nothing.
 */
export function captionProgress(record: CaptionJob): Progress {
  const base = toolProgress(record);
  const stage = record.render_stage;
  if (typeof stage !== "string" || stage.length === 0) return base;
  return { ...base, status: `${record.status} (${stage})` };
}

// ---------------------------------------------------------------------------
// The chunked upload
//
// The other half of step 1, and the reason it has to exist: any request body
// over roughly 100 MB is answered 413 before the API sees it, with a message
// that never mentions captions. A single `POST /caption_jobs` therefore cannot
// carry the 250 MiB the server is willing to accept, so the same upload is
// also reachable as three calls:
//
//   POST /caption_jobs/uploads               -> { upload_token, part_size, part_count }
//   POST /caption_jobs/uploads/parts?offset= -> { received }, raw bytes, N times
//   POST /caption_jobs/uploads/finish        -> the CaptionJob row
//
// No upload state lives on the server between them. The (job_id, size,
// filename) triple travels inside the signed `upload_token` the caller carries
// from call to call, which is also why a torn run is resumable for as long as
// the token lives - see CAPTION_UPLOAD_TOKEN_TTL_MS.
//
// ## How this differs from the storage tier's multipart, deliberately
//
// `storage/upload.ts` drives a multipart upload with the same 32 MiB part, and
// the two are NOT the same protocol. Four differences decide the code here:
//
//  - these parts go to the API, not to a presigned object-store URL. They ride
//    the client's own transport, so the credential, the retry policy, the 429
//    `Retry-After` handling and the per-attempt deadline all apply as usual,
//    and there is no "must not carry an Authorization header" rule to respect;
//  - a part is addressed by BYTE OFFSET, not by a part number, and the server
//    writes it at that offset. Re-sending one is the same bytes in the same
//    place, so this is the rare `POST` that is genuinely safe to replay -
//    which is why {@link CaptionsNamespace.uploadPart} opts INTO the
//    transport's retry rather than out of it, and why the parts can go in
//    parallel and out of order;
//  - there is no per-part ETag to collect and nothing to assemble by hand. The
//    `finish` call carries the token and nothing else;
//  - nothing is checksummed. The storage tier's direct tier binds a base64 MD5
//    into the presigned signature; here the server simply keeps what arrived
//    and the only integrity check is `finish` probing the assembled file, which
//    answers 400 "Could not read video" when it does not decode.
//
// What the two DO share is the 32 MiB part and the rule that comes with it:
// never send a part longer than the size the server named. The server rejects
// an over-long part with a 400 whose whole text is "Invalid part".
//
// There is also no rate gate here, unlike the storage driver's
// `StorageRateGate`. Only the session-opening call is throttled as an
// expensive tool (20 a minute); the parts and the finish fall under the plain
// ceiling, and the largest file the server accepts is eight parts.
// ---------------------------------------------------------------------------

/**
 * Largest file the server will accept, chunked or not: 250 MiB exactly.
 *
 * Not checked client-side on purpose - the server owns the number, and the
 * chunked path finds out in one cheap round trip because
 * {@link CaptionsNamespace.startUpload} is given the size before a single byte
 * moves.
 */
export const CAPTION_MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

/**
 * Where {@link CaptionsNamespace.upload} stops using one `POST` and starts
 * using the three-call path: 64 MiB.
 *
 * This is a CLIENT-SIDE choice, not a protocol constant. The ~100 MB ceiling
 * is on the whole request, and a `multipart/form-data` envelope rides on top
 * of the file's own bytes, so the switch sits well under the cap rather than
 * at it. Below it a single request is one round trip and one probe; above it
 * a single request is a 413 that says nothing useful.
 *
 * Override it per call with {@link UploadCaptionVideoInput.chunkedThreshold} -
 * for instance `0`, to exercise the chunked path on a small file.
 */
export const CAPTION_CHUNKED_THRESHOLD = 64 * 1024 * 1024;

/**
 * Part size, 32 MiB. The same number as the storage tier's, by coincidence
 * rather than by sharing.
 *
 * It is BOTH the size the server reports in the session and the ceiling the
 * server validates each part against. See {@link resolveCaptionPartSize} for
 * what that means when the two disagree.
 */
export const CAPTION_PART_SIZE = 32 * 1024 * 1024;

/**
 * Parts in flight at once by default.
 *
 * Three. A single sequential stream leaves a home connection idle between
 * round trips; three fills it without holding an unfair share of the API,
 * since these bytes pass THROUGH the API on their way to storage, unlike a
 * storage upload.
 */
export const CAPTION_UPLOAD_CONCURRENCY = 3;

/**
 * How long an upload session stays usable: six hours.
 *
 * The window for a resume. Past it the token verifies as expired and every
 * call answers 400 "Invalid or expired upload session", parts already sent
 * included - there is no way to re-mint a token for a half-uploaded file,
 * because the new session would carry a new job id.
 */
export const CAPTION_UPLOAD_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * What `POST /caption_jobs/uploads` answers.
 *
 * `upload_token` is a CREDENTIAL: a signed `(job_id, size, filename)` triple,
 * and the only thing standing between a stranger and writing bytes into this
 * job. It is not a job id and there is no job yet - the row is created by
 * `finish`, out of the id sealed inside the token - so it cannot be handed to
 * {@link CaptionsNamespace.get} and there is nothing to poll until then.
 */
export interface CaptionUploadSession {
  /** Signed session token. Goes in the `X-Upload-Token` header on both later calls. */
  readonly upload_token: string;
  /** Bytes per part, and the ceiling the server validates each part against. */
  readonly part_size: number;
  /** `ceil(size / part_size)`, so a caller can size a progress bar before slicing. */
  readonly part_count: number;
}

/** Arguments for opening a chunked upload session. */
export interface StartCaptionUploadInput extends ToolCaptcha {
  /**
   * EXACT byte length of the file.
   *
   * Not an estimate and not a ceiling: the number is sealed into the token and
   * every part is checked against it, so a declared size below the real one
   * makes the last part fail with 400 "Part exceeds declared size", and a
   * declared size above it leaves the server waiting for bytes that never
   * come and `finish` probing a truncated file.
   */
  readonly size: number;
  /** Stored name. Trimmed to 255 characters, and `"video.mp4"` when blank. */
  readonly filename?: string;
}

/**
 * Arguments for {@link CaptionsNamespace.upload} and
 * {@link CaptionsNamespace.createChunked}.
 */
export interface UploadCaptionVideoInput extends ToolCaptcha {
  /**
   * The video.
   *
   * For the chunked path this has to be sliceable, which means real bytes: a
   * `Blob`/`File` on the web or in Bun, a `Uint8Array` anywhere. A React
   * Native `{ uri, name, type }` descriptor is NOT sliceable - see the note on
   * {@link CaptionsNamespace.createChunked}.
   */
  readonly video: FileInput;
  /** Overrides {@link CAPTION_CHUNKED_THRESHOLD} for this call only. */
  readonly chunkedThreshold?: number;
  /** Overrides {@link CAPTION_UPLOAD_CONCURRENCY} for this call only. */
  readonly concurrency?: number;
  /**
   * Continues an upload that was cut off, rather than starting a new one.
   *
   * Present or not, this is what decides the path: a resume always goes
   * chunked, whatever the file's size and threshold say. The session is only
   * good for {@link CAPTION_UPLOAD_TOKEN_TTL_MS} from when it was minted.
   */
  readonly resume?: CaptionUploadResume;
}

/** A chunked upload picked up where it stopped. */
export interface CaptionUploadResume {
  /**
   * The session from the interrupted attempt, or just its `upload_token`.
   *
   * Keep the whole session where you can. A bare token has no `part_size`, so
   * the driver slices with {@link CAPTION_PART_SIZE} instead - which is the
   * server's own number today, and therefore the same offsets, but it stops
   * being true the day the server changes it.
   */
  readonly session: CaptionUploadSession | string;
  /**
   * Byte offsets already accepted, so their bytes are not sent twice.
   *
   * Offsets, not part numbers, and they must be multiples of the session's
   * `part_size` - they are the same numbers the driver sliced with, which is
   * what {@link UploadCaptionOptions.onPart} reports. Anything else is simply
   * not in the list of offsets to skip and its part is sent again, which costs
   * bandwidth and breaks nothing.
   *
   * Omit it to re-send every part. That is always correct, just slower: a part
   * is written at its own offset, so sending it twice is idempotent.
   */
  readonly uploaded?: readonly number[];
}

/**
 * Options for the two driving methods: everything a request takes, plus the
 * two callbacks that make a 250 MiB upload watchable.
 */
export interface UploadCaptionOptions extends OperationOptions {
  /**
   * Called after each part the server has ACCEPTED, with the offset it was
   * written at and its length.
   *
   * The point of it is resuming: collect these offsets, and hand them back as
   * {@link CaptionUploadResume.uploaded} if the run is cut off.
   */
  readonly onPart?: (offset: number, length: number) => void;
}

/**
 * Byte length of a video about to be uploaded, or `undefined` when it cannot be
 * known without reading it.
 *
 * `undefined` has exactly two causes, and both matter: a `ReadableStream`,
 * which has no length until it is drained, and a React Native picker that
 * reported no `size` for a `content://` URI. Neither can be sized cheaply, so
 * {@link CaptionsNamespace.upload} sends them down the single-request path and
 * lets the server judge - which is the right guess for a phone pick and the
 * wrong one for a 200 MiB stream, so pass `video.size` when you know it.
 */
export function captionUploadSize(video: FileInput): number | undefined {
  if (typeof video.size === "number" && Number.isFinite(video.size) && video.size >= 0) return video.size;
  if (video.data instanceof Blob) return video.data.size;
  if (video.data instanceof Uint8Array) return video.data.byteLength;
  if (isNativeFile(video.data) && typeof video.data.size === "number" && Number.isFinite(video.data.size)) {
    return video.data.size;
  }
  return undefined;
}

/**
 * The size to slice parts with, from what the session reported.
 *
 * Follows the storage driver's rule - slice with the number the SERVER named,
 * never with the SDK's copy of it - but with a ceiling the storage tier does
 * not need, because the two ends of this protocol read the number from
 * different places: the session reports a `part_size`, while each part is
 * validated against the server's own constant. They are the same today and
 * can only disagree mid-deploy, and the disagreement is one-sided: honouring
 * a larger reported size would make every part a 400 "Invalid part", while
 * capping at the size this SDK knows the validator uses only sends smaller
 * parts, which is always legal. So the reported number wins downwards and
 * loses upwards.
 *
 * A missing, zero or nonsense `part_size` falls back to
 * {@link CAPTION_PART_SIZE}.
 */
export function resolveCaptionPartSize(reported: number | undefined): number {
  if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return CAPTION_PART_SIZE;
  return Math.min(Math.trunc(reported), CAPTION_PART_SIZE);
}

/** Pulls the token out of a session or accepts a bare one. */
function captionUploadToken(session: CaptionUploadSession | string): string {
  const token = typeof session === "string" ? session : session?.upload_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new OmsError(
      "No upload token. Open a session with startUpload() first, and pass what it answered - " +
        "the token is the only thing identifying the upload, since the job row does not exist until finish.",
      "invalid_request",
    );
  }
  return token;
}

/**
 * Runs `worker` over the offsets with at most `limit` in flight.
 *
 * A local copy of the storage driver's pool rather than a shared one: it is
 * nine lines, and the alternative is a cross-module import between two
 * protocols that have no reason to move together.
 */
async function runCaptionParts(
  offsets: readonly number[],
  limit: number,
  worker: (offset: number) => Promise<void>,
): Promise<void> {
  if (offsets.length === 0) return;
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, offsets.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= offsets.length) return;
      await worker(offsets[index] as number);
    }
  });
  await Promise.all(lanes);
}

/** The `captions` tool, reachable as `oms.tools.captions`. */
export class CaptionsNamespace extends Resource {
  /**
   * `GET /caption_jobs/quota` - seconds of transcription spent and left today.
   *
   * Cheap and anonymous-safe. Counts seconds of transcribed WINDOW, not
   * seconds of uploaded video: a job that was uploaded and never transcribed
   * has spent nothing. `limit_seconds` and `remaining_seconds` are `null`
   * exactly when `unlimited` is `true`.
   *
   * Worth reading twice - once before the upload, so 250 MiB is not spent on a
   * budget that is already gone, and once when the window is known, because
   * that check is exact and the server refuses a window that would cross the
   * ceiling rather than truncating it.
   */
  async quota(options: RequestOptions = {}): Promise<SecondsQuota> {
    return this.http.get<SecondsQuota>("/caption_jobs/quota", options);
  }

  /**
   * `GET /caption_jobs/fonts` - the font KEYS the renderer has, for
   * {@link CaptionStyle.font}.
   *
   * Plain strings, not objects and not display names: they are the keys the
   * renderer resolves against its installed faces, which is the whole reason
   * a caller cannot pass a path.
   *
   * The endpoint answers `{ fonts: [...] }`; this unwraps it. It also NEVER
   * fails: a renderer that is down or slow is answered as an empty list with
   * a 200, so `[]` means "could not ask right now" just as much as it means
   * "no fonts", and the two are not distinguishable. Do not treat an empty
   * answer as a reason to refuse a render - omitting `font` lets the renderer
   * use its own default.
   *
   * Cached server-side for ten minutes, so polling it buys nothing.
   */
  async fonts(options: RequestOptions = {}): Promise<string[]> {
    const answer = await this.http.get<{ fonts?: string[] }>("/caption_jobs/fonts", options);
    return answer?.fonts ?? [];
  }

  /**
   * `POST /caption_jobs` - step 1. Uploads the video and probes it.
   *
   * Answers with the row in `"uploaded"`, carrying the probed `width`,
   * `height`, `fps` and `duration`. Nothing is running yet, so this call does
   * not wait.
   *
   * NOT retried by default: replaying this `POST` after a 502 re-uploads up to
   * 250 MiB and leaves an orphan job behind. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 413 over 250 MiB, 400 over 20 minutes or when the
   *   file cannot be read, 503 when the captions service is unavailable - in
   *   which case no job is left behind.
   * @throws {OmsQuotaError} 429 from the expensive-tools throttle. The upload
   *   itself spends no daily quota.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   */
  async create(input: CreateCaptionJobInput, options: RequestOptions = {}): Promise<CaptionJob> {
    return this.http.postForm<CaptionJob>(
      "/caption_jobs",
      { video: input.video, ...toolCaptchaFields(input) },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `GET /caption_jobs/:id` - one poll.
   *
   * Carries `progress_percent` while transcribing or rendering, `render_stage`
   * while rendering, `words` from `"transcribed"` onwards and `output_url`
   * once `"complete"`.
   *
   * @throws {OmsApiError} 404 once the 24-hour retention sweep has taken it.
   * @throws {OmsAuthError} 401 when the job belongs to someone else, which
   *   includes an anonymous job being read from a different address.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<CaptionJob> {
    return this.http.get<CaptionJob>(`/caption_jobs/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /caption_jobs/:id/transcribe` - step 2, on one window.
   *
   * WAITS: the request only moves the row to `"transcribing"`, and this
   * resolves once it has settled on `"transcribed"` or `"failed"`. Returning
   * the busy row instead would hand the caller something whose only use is to
   * cause a 409 on the next call.
   *
   * Windows accumulate. Transcribing a second window replaces `words` with the
   * new window's words and ADDS its seconds to `transcribed_seconds`, so
   * re-transcribing costs quota every time and does not give you both windows.
   *
   * `language` defaults to `"auto"` server-side. Detection is good enough that
   * a hint is worth passing only when it has already got it wrong.
   *
   * Resolves with a `"failed"` row rather than throwing when the transcription
   * itself failed - including the common case of a window with no speech in
   * it, which fails rather than returning an empty word list.
   *
   * @throws {OmsApiError} 409 when the job is already busy, 400 for a window
   *   that is inverted, past the end of the video, longer than 15 minutes, or
   *   longer than the whole daily quota.
   * @throws {OmsQuotaError} 429 when this window would cross the daily ceiling,
   *   or from the expensive-tools throttle.
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the step: the
   *   quota is spent either way and the words still land on the row.
   */
  async transcribe(id: Id, input: TranscribeCaptionInput, options: ToolRunOptions = {}): Promise<CaptionJob> {
    const started = await this.http.post<CaptionJob>(
      `/caption_jobs/${encodeURIComponent(id)}/transcribe`,
      {
        start: input.start,
        end: input.end,
        ...(input.language === undefined ? {} : { language: input.language }),
      },
      { ...options, retry: options.retry ?? false },
    );
    return this.settle(id, started, options, "the transcription");
  }

  /**
   * `POST /caption_jobs/:id/render` - step 3.
   *
   * WAITS, like {@link transcribe}, and for the same reason.
   *
   * Omitting `words` costs an extra `GET`. The endpoint has no fallback of its
   * own - it refuses a request whose word list is missing or empty, even for a
   * job whose row is full of words - so the SDK reads the row and sends those
   * back. That is the documented behaviour of `RenderCaptionInput.words`, and
   * it is cheaper to pay one `GET` here than to make every caller learn it.
   *
   * A render re-encodes the whole video, so this is the slow step: a
   * twenty-minute file is minutes of x264 regardless of how short the
   * captioned part is.
   *
   * Resolves with a `"failed"` row rather than throwing when the render failed.
   *
   * @throws {OmsError} `conflict` when there are no words to render at all -
   *   raised here, before the request, so the message says "transcribe first"
   *   rather than repeating the server's phrasing of it.
   * @throws {OmsApiError} 409 when the job is already busy, 400 for a word
   *   whose timings fall outside the video or for more than 3000 of them.
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the render.
   */
  async render(id: Id, input: RenderCaptionInput = {}, options: ToolRunOptions = {}): Promise<CaptionJob> {
    const words = input.words ?? (await this.get(id, options)).words ?? [];
    if (words.length === 0) {
      throw new OmsError(
        `Caption job ${id} has no words to render. Transcribe a window first with transcribe(), ` +
          `or pass an edited list as \`words\`.`,
        "conflict",
      );
    }

    const started = await this.http.post<CaptionJob>(
      `/caption_jobs/${encodeURIComponent(id)}/render`,
      {
        words,
        ...(input.style === undefined ? {} : { style: input.style }),
      },
      { ...options, retry: options.retry ?? false },
    );
    return this.settle(id, started, options, "the render");
  }

  /**
   * `DELETE /caption_jobs/:id` - drops the job and its uploaded video.
   *
   * Worth calling on a job you have finished with; otherwise the video is
   * kept until the 24-hour sweep.
   *
   * @throws {OmsApiError} 404 when it is already gone.
   * @throws {OmsAuthError} 401 when the job belongs to someone else.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<{ deleted?: Id }>(`/caption_jobs/${encodeURIComponent(id)}`, options);
  }

  /**
   * Downloads the rendered video of a finished job.
   *
   * Two calls: one to read the row for its `output_url`, one to fetch the
   * signed URL itself with NO credential attached. Hand a row you already hold
   * to {@link outputUrl} plus `fetchToolArtifact` if you would rather not pay
   * for the first.
   *
   * @throws {OmsError} `conflict` when the job has not been rendered yet -
   *   which includes a job that is merely `"transcribed"`, `invalid_request`
   *   when the render failed, `not_found` when the artefact is gone.
   */
  async download(id: Id, options: RequestOptions = {}): Promise<Blob> {
    const record = await this.get(id, options);
    return fetchToolArtifact(this.http, this.outputUrl(record), options);
  }

  /**
   * The signed URL of the rendered video, from a row you already hold.
   *
   * It is a credential: anyone holding it can watch the video.
   *
   * @throws {OmsError} explaining which of the three reasons there is no URL.
   */
  outputUrl(record: CaptionJob): string {
    return requireToolArtifact(record, record.output_url, "rendered video");
  }

  /**
   * Step 1 for any video, picking the path by size. Prefer this over
   * {@link create} unless you control what the caller can hand you.
   *
   * Under {@link CAPTION_CHUNKED_THRESHOLD} it is exactly {@link create}: one
   * `POST`, one probe, one round trip. At or above it, it is
   * {@link createChunked}. The answer is the same `"uploaded"` row either way,
   * because `finish` and `create` answer the same shape - so the caller's
   * step 2 does not need to know which path ran.
   *
   * The size comes from {@link captionUploadSize}, which cannot always find
   * one: a `ReadableStream` and some React Native picks have no length until
   * they are read. Those go down the single-request path, which is right for a
   * phone pick and wrong for a large stream, so pass `video.size` whenever you
   * know it rather than letting a 413 teach you.
   *
   * `onProgress` is honest about which path ran and reports COMPLETED
   * transfers, never bytes handed to the runtime - the whole file as one tick
   * on the direct path, one tick per 32 MiB part on the chunked one. `fetch`
   * has no upload-progress event in any of the three runtimes this SDK targets;
   * see the module note in `storage/upload.ts` for why neither XHR nor a
   * counting stream body is the answer inside the core.
   *
   * Rate limit: the direct path and the chunked path's opening call both count
   * against the expensive-tools bucket, 20 a minute shared with every other
   * tool. The parts and the finish do not.
   */
  async upload(input: UploadCaptionVideoInput, options: UploadCaptionOptions = {}): Promise<CaptionJob> {
    if (input.resume !== undefined) return this.createChunked(input, options);

    const size = captionUploadSize(input.video);
    const threshold = input.chunkedThreshold ?? CAPTION_CHUNKED_THRESHOLD;
    if (size !== undefined && size > threshold) return this.createChunked(input, options);

    const { onProgress, onPart: _onPart, ...request } = options;
    onProgress?.({ phase: "upload", loaded: 0, total: size });
    const job = await this.create(input, request);
    // One tick, after the fact, for the same reason the storage driver's direct
    // tier fires exactly once: the bytes are gone and acknowledged, and any
    // number reported before that would be a guess.
    onProgress?.({ phase: "upload", loaded: size ?? 0, total: size });
    return job;
  }

  /**
   * Step 1 in three calls, for a video too big for one request.
   *
   * Opens a session, sends the parts (three at a time by default, in whatever
   * order the pool finishes them), then finishes - and `finish` is what probes
   * the assembled file and creates the row, so this resolves with the same
   * `"uploaded"` row {@link create} would have answered.
   *
   * Nothing is cleaned up on failure and nothing needs to be: the server
   * discards the parts itself when `finish` rejects the file, and a run
   * abandoned before `finish` leaves no job behind. There is no way to abort
   * a session, so an abandoned upload is simply abandoned.
   *
   * **React Native cannot take this path.** The bytes have to be sliced, and a
   * picked `{ uri, name, type }` is a handle into the device that only a native
   * module can open - so this throws for one rather than uploading an empty
   * file with a 200 on it. What works on a phone is {@link create} (the
   * transport hands the descriptor to RN's own `FormData` verbatim and the
   * platform streams it off disk), which caps out at the ~100 MB request
   * limit. Past that the only ways through are reading the file into a
   * `Uint8Array` first -
   * Expo's `new File(uri).bytes()`, which means the whole video in the JS heap,
   * so it is not a plan for 250 MiB - or shrinking the video on the device.
   *
   * Resuming: pass {@link CaptionUploadResume} with the earlier session and the
   * offsets {@link UploadCaptionOptions.onPart} reported. Skipping is only an
   * optimisation, because a part is written at its own offset and re-sending it
   * is idempotent; the session itself expires after
   * {@link CAPTION_UPLOAD_TOKEN_TTL_MS}.
   *
   * @throws {OmsError} `invalid_request` for a React Native descriptor, or for
   *   an empty file - which the server would answer as "Invalid size", after a
   *   round trip that had nothing to carry.
   * @throws {OmsApiError} 413 over 250 MiB, raised by the opening call before
   *   any bytes move; 400 from `finish` when the assembled file does not decode
   *   or runs past 20 minutes; 400 "Invalid or expired upload session" once the
   *   token is six hours old.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or
   *   bad. It is checked when the session is opened, not when the bytes land,
   *   so a bad token costs one round trip rather than the whole upload.
   */
  async createChunked(input: UploadCaptionVideoInput, options: UploadCaptionOptions = {}): Promise<CaptionJob> {
    if (isNativeFile(input.video.data)) {
      throw new OmsError(
        `Cannot chunk-upload "${input.video.filename}": it is a React Native file descriptor ` +
          `(${input.video.data.uri}), and the chunked path has to slice the bytes. Use create() for a file ` +
          "under the ~100 MB request cap, or read the video into a Uint8Array first " +
          "(Expo: `new File(uri).bytes()`) and pass that.",
        "invalid_request",
      );
    }

    const { onProgress, onPart, ...request } = options;
    const { blob } = await readFileInput(input.video);
    const total = blob.size;
    if (total === 0) {
      throw new OmsError(
        `Cannot upload "${input.video.filename}": it is empty. The server answers "Invalid size" to a ` +
          "zero-byte session, so there is nothing to be gained by asking it.",
        "invalid_request",
      );
    }

    const session =
      input.resume === undefined
        ? await this.startUpload(
            { size: total, filename: input.video.filename, ...(input.captchaToken === undefined ? {} : { captchaToken: input.captchaToken }) },
            request,
          )
        : input.resume.session;

    const partSize = resolveCaptionPartSize(typeof session === "string" ? undefined : session.part_size);
    const offsets: number[] = [];
    for (let at = 0; at < total; at += partSize) offsets.push(at);

    const done = new Set<number>(input.resume?.uploaded ?? []);
    const pending = offsets.filter((offset) => !done.has(offset));

    // Bytes a resume is not going to send again still count as landed, or the
    // bar would restart at zero on the attempt that finishes the upload.
    let loaded = 0;
    for (const offset of offsets) if (done.has(offset)) loaded += Math.min(partSize, total - offset);
    onProgress?.({ phase: "upload", loaded, total });

    const concurrency = Math.max(1, Math.trunc(input.concurrency ?? CAPTION_UPLOAD_CONCURRENCY));
    await runCaptionParts(pending, concurrency, async (offset) => {
      const chunk = blob.slice(offset, Math.min(offset + partSize, total));
      await this.uploadPart(session, offset, chunk, request);
      onPart?.(offset, chunk.size);
      // Safe to accumulate from inside the pool: the lanes interleave only at
      // an await, so no two of these ever run at the same time.
      loaded += chunk.size;
      onProgress?.({ phase: "upload", loaded, total });
    });

    return this.finishUpload(session, request);
  }

  /**
   * `POST /caption_jobs/uploads` - opens a chunked upload session.
   *
   * Public so a caller can drive the three calls itself, which is the supported
   * way to get byte-level progress: wrap XHR (or a native uploader) around
   * {@link uploadPart}'s job and keep the session and the finish from here.
   *
   * Three things happen here and nowhere else in the flow: the captcha is
   * verified, the 250 MiB ceiling is checked against the DECLARED size, and the
   * job id is minted - early, but the job itself does not exist until the file
   * is whole. So a session is not a job: {@link get} has nothing to find until
   * {@link finishUpload} returns.
   *
   * NOT retried by default. A replay opens a SECOND session under a second job
   * id and hands back a second token, and the first is then orphaned with no
   * way to abort it.
   *
   * Rate limit: 20 a minute, shared with every other expensive tool - the same
   * bucket `POST /caption_jobs` counts against, since this is its twin.
   *
   * @throws {OmsApiError} 413 when `size` is over 250 MiB, 400 when it is not
   *   positive, 503 when the captions service is unavailable.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   * @throws {OmsQuotaError} 429 from the expensive-tools throttle. No daily
   *   quota is spent by an upload - only a transcribed window is metered.
   */
  async startUpload(input: StartCaptionUploadInput, options: RequestOptions = {}): Promise<CaptionUploadSession> {
    return this.http.post<CaptionUploadSession>(
      "/caption_jobs/uploads",
      {
        size: input.size,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...toolCaptchaFields(input),
      },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `POST /caption_jobs/uploads/parts?offset=` - one part, as raw bytes.
   *
   * The body is the part itself, `application/octet-stream`, with no envelope:
   * not a form field, not base64, not JSON.
   *
   * RETRIED BY DEFAULT, which no other writing method in this SDK is. The
   * server writes the part at the offset the query names, so a replay is the
   * same bytes in the same place: there is no record to duplicate and no
   * position to lose. Pass `retry: false` to opt out. For the same reason the
   * parts may go in any order and in parallel, and a part sent twice is not an
   * error.
   *
   * `part` must not be longer than the session's `part_size` (see
   * {@link resolveCaptionPartSize}) and `offset + part.length` must not run
   * past the size declared when the session was opened. Both are 400s whose
   * text does not distinguish them from each other.
   *
   * @param session The session from {@link startUpload}, or its token.
   * @param offset Byte offset of this part in the whole file, from `0`.
   * @returns The byte count the server acknowledged, from `{ received }`.
   * @throws {OmsApiError} 400 for an over-long part, an offset past the
   *   declared size, or a token that has expired (six hours); 503 when the
   *   captions service is unavailable.
   */
  async uploadPart(
    session: CaptionUploadSession | string,
    offset: number,
    part: Blob | Uint8Array,
    options: RequestOptions = {},
  ): Promise<number> {
    const body = part instanceof Blob ? part : new Blob([part as BlobPart]);
    const answer = await this.http.post<{ received?: number }>("/caption_jobs/uploads/parts", body, {
      ...options,
      query: { offset },
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Upload-Token": captionUploadToken(session),
        ...(options.headers ?? {}),
      },
      retry: options.retry ?? {},
    });
    return typeof answer?.received === "number" ? answer.received : 0;
  }

  /**
   * `POST /caption_jobs/uploads/finish` - assembles, probes and creates the row.
   *
   * This is where a chunked upload becomes a job: the parts are joined and
   * probed, and only then is a `CaptionJob` created, with the id that was
   * sealed into the token at the start. The answer is the same shape
   * {@link create} returns, in `"uploaded"`.
   *
   * It is also where a bad upload is caught. A file that does not decode, or
   * one over 20 minutes, is a 400 - and the server discards the parts before
   * answering, so there is nothing to clean up and nothing to retry.
   *
   * NOT retried by default. The row is created with a fixed id, so a replay
   * that lands after a lost answer fails on the id already existing and reports
   * a 400 for an upload that worked.
   *
   * @throws {OmsApiError} 400 when the assembled file cannot be read or runs
   *   past 20 minutes, 400 "Invalid or expired upload session" for a token that
   *   is over six hours old, 503 when the captions service is unavailable.
   */
  async finishUpload(session: CaptionUploadSession | string, options: RequestOptions = {}): Promise<CaptionJob> {
    return this.http.post<CaptionJob>(
      "/caption_jobs/uploads/finish",
      {},
      {
        ...options,
        headers: { "X-Upload-Token": captionUploadToken(session), ...(options.headers ?? {}) },
        retry: options.retry ?? false,
      },
    );
  }

  /**
   * Waits for a started step to settle, reusing the one polling loop.
   *
   * `terminal` here is "not busy" rather than "finished": step 2 settles on
   * `"transcribed"`, which is idle and very much not the end of the job.
   */
  private async settle(
    id: Id,
    started: CaptionJob,
    options: ToolRunOptions,
    label: string,
  ): Promise<CaptionJob> {
    options.onProgress?.(captionProgress(started));
    if (!isCaptionBusy(started.status)) return started;

    return pollUntilTerminal<CaptionJob>({
      ...options,
      label,
      poll: (request) => this.get(id, request),
      terminal: (record) => !isCaptionBusy(record.status),
      progress: captionProgress,
    });
  }
}
