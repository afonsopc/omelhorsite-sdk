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
 * Limits, all enforced by the backend:
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
 * Cloudflare rejects any request body over 100 MB with a 413 of its own before
 * Rails ever sees it, so the backend also exposes a three-call chunked upload -
 * `POST /caption_jobs/uploads` opens a session and returns a signed
 * `upload_token` plus a `part_size` (32 MiB), `POST /caption_jobs/uploads/parts?offset=`
 * streams each raw part under an `X-Upload-Token` header, and
 * `POST /caption_jobs/uploads/finish` probes the assembled file and creates the
 * row. THAT path is not implemented in this SDK yet: a video above roughly
 * 64 MiB has to go through it, and `create` will answer 413 for one. The web
 * tool already switches at 64 MiB, so this is the one gap that blocks it from
 * dropping its own HTTP layer for captions.
 */

import { OmsError } from "../../errors";
import { Resource } from "../../http";
import type { FileInput, Id, Progress, RequestOptions } from "../../types";
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
 * The two statuses with a sidecar call in flight.
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
 * render endpoint permits and the keys the transcriber writes onto the row, so
 * a word object built any other way is silently dropped server-side and the
 * render fails with "No words to render".
 *
 * Timings are seconds from the START OF THE VIDEO, not from the start of the
 * transcribed window: the backend shifts them onto the video clock before
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
 * The controller reads the key only when the array has EXACTLY three entries;
 * two or four is dropped in silence, which costs a whole render to discover.
 */
export type CaptionRgb = readonly [number, number, number] | readonly number[];

/**
 * Look of the burned-in captions.
 *
 * Open bag, because the renderer gains options without an SDK release and
 * unknown keys are dropped server-side rather than rejected. The named keys are
 * the ones the controller's allow-list actually permits today; anything else -
 * a font name, a hex colour - is accepted by the request and then thrown away,
 * which is worth knowing before spending a render on it.
 *
 * Every numeric key is CLAMPED, not validated: a value outside the range comes
 * back as the nearest end of it rather than as a 400.
 */
export interface CaptionStyle {
  /**
   * A font KEY from {@link CaptionsNamespace.fonts}, never a path: the sidecar
   * resolves the key against the faces installed in its image, so a caller
   * cannot point the renderer at a file. Must match `/\A[a-z0-9_-]{1,40}\z/`;
   * anything else is dropped and the renderer uses its own default.
   */
  readonly font?: string;
  /** Font size as a fraction of the video height. Clamped to `[0.03, 0.09]`. */
  readonly fontscale?: number;
  /**
   * Outline thickness as a fraction of the font size. Clamped to `[0, 0.3]`,
   * and `0` is a legitimate choice meaning no outline at all - which is why
   * the controller reads this key whenever it is PRESENT rather than when it
   * is truthy, unlike every other numeric key here.
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
 * call, show, transcribe and render - renders the `:extended` view, so every
 * key below is present on every response.
 *
 * Five of the columns are `NOT NULL` with a numeric default, so `width`,
 * `height`, `fps`, `duration` and `transcribed_seconds` are always real
 * numbers. On a row whose upload has only just been probed they are the probed
 * values; the sidecar's precise metadata overwrites them a moment later.
 */
export interface CaptionJob extends ToolRecord {
  readonly status: CaptionStatus;
  /** Original upload name. The controller substitutes `"video.mp4"` for a
   * blank one, so this is never empty in practice. */
  readonly filename: string;
  /** Pixels. `NOT NULL DEFAULT 0`, so `0` means "not probed yet", not unknown. */
  readonly width: number;
  readonly height: number;
  /** `NOT NULL DEFAULT 0.0`. */
  readonly fps: number;
  /** Seconds of video, probed at upload. `NOT NULL DEFAULT 0.0`. */
  readonly duration: number;
  /** Language of the last transcribe call, `"auto"` included. `null` before the first. */
  readonly language: string | null;
  /** The transcribed window, seconds from the video start. `null` before the first transcribe. */
  readonly window_start: number | null;
  readonly window_end: number | null;
  /**
   * Seconds charged against the quota so far, accumulated across every window
   * transcribed on this job. `NOT NULL DEFAULT 0`.
   */
  readonly transcribed_seconds: number;
  /**
   * Timed words, from `"transcribed"` onwards.
   *
   * `null` and not `[]` when there are none: the column is `NOT NULL DEFAULT
   * '[]'`, but the blueprint renders `words.presence`, and `[].presence` is
   * `nil` in Ruby. So an empty list arrives as `null`, and the key is present
   * either way.
   */
  readonly words: CaptionWord[] | null;
  /** What the renderer is doing right now, read live off the sidecar. `null`
   * unless the status is `"rendering"`. */
  readonly render_stage: string | null;
  /** Signed URL of the finished video once complete and attached, `null` otherwise. */
  readonly output_url: string | null;
}

/** Arguments for uploading a video. */
export interface CreateCaptionJobInput extends ToolCaptcha {
  /** The video. Sent as the `video` form field. Backend caps: 250 MiB, 20 minutes. */
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
   * array to fix what the model misheard. Backend cap: 3000 words, 80
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
 * sidecar's stage is folded into `status` - `"rendering (encoding)"` - because
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
   * sidecar resolves against the faces installed in its image, which is the
   * whole reason a caller cannot pass a path.
   *
   * The controller answers `{ fonts: [...] }`; this unwraps it. It also
   * NEVER fails: a sidecar that is down or slow is caught and answered as an
   * empty list with a 200, so `[]` means "could not ask right now" just as
   * much as it means "no fonts", and the two are not distinguishable. Do not
   * treat an empty answer as a reason to refuse a render - omitting `font`
   * lets the renderer use its own default.
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
   * The bytes go to the captions sidecar, which keeps the file; Rails stores
   * only the row and, at the end, the rendered output. That is also why a
   * caption job cannot be resumed after the sidecar's volume is wiped: the row
   * survives and the video does not, and step 2 then fails.
   *
   * Answers with the row in `"uploaded"`, carrying the probed `width`,
   * `height`, `fps` and `duration`. Nothing is running yet, so this call does
   * not wait.
   *
   * NOT retried by default: replaying this `POST` after a 502 re-uploads up to
   * 250 MiB and leaves an orphan job behind. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 413 over 250 MiB, 400 over 20 minutes or when the
   *   file cannot be read, 503 when the captions sidecar is down - in which
   *   case the row is destroyed rather than left dangling.
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
   * `language` defaults to `"auto"` server-side. Whisper detects well enough
   * that a hint is worth passing only when it has already got it wrong.
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
   * `POST /caption_jobs/:id/render` - step 3. Named `render` here even though
   * the route is `start_render`, because `render` clashes with Rails' own
   * method and that is the backend's problem, not the SDK's.
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
   * `DELETE /caption_jobs/:id` - drops the row and the sidecar's copy.
   *
   * Best effort on the sidecar's side: the row goes either way. Worth calling
   * on a job you have finished with, because the uploaded video sits on the
   * sidecar's disk until the 24-hour sweep otherwise.
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
