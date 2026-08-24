/**
 * Transcription: speech to text, with SRT and VTT subtitle output.
 *
 * Runs on the `transcriber` service, which is the ONLY place whisper lives in
 * this project. No other sidecar embeds it, and no client should call whisper
 * directly; that rule is deliberate and predates this SDK.
 *
 * The quota is metered in seconds of audio, so it is charged on the file's
 * duration at create time, not on how long the run takes. A file whose
 * duration alone exceeds the daily ceiling is a 400, not a 429: it can never
 * fit, no matter how long you wait.
 *
 * Limits, all enforced by the backend:
 *
 * | | |
 * |---|---|
 * | file size | 250 MiB (`413`) |
 * | daily quota, anonymous | 15 minutes of audio |
 * | daily quota, signed in | 60 minutes of audio |
 * | `POST /transcriptions` | 20 a minute, shared with every other expensive tool |
 *
 * The daily quota is per user when signed in and per IP when not, and an
 * account can be given a bigger one - or none at all, in which case
 * {@link SecondsQuota.unlimited} is `true` and the numbers mean nothing. Read
 * {@link TranscriptionNamespace.quota} before uploading; it is cheap, it works
 * anonymously, and it is the difference between a refusal and 250 MiB spent on
 * a 429.
 *
 * The 20-a-minute throttle is shared across background removal, upscale,
 * transcription, vocal separation, captions, jumpstyle and the downloader, and
 * it is keyed on the credential when there is one and on the IP when there is
 * not. It answers 429 with a `Retry-After`, which the transport honours, so a
 * caller that hits it waits rather than failing - unless it passed
 * `retry: false`, which {@link TranscriptionNamespace.create} does by default.
 */

import { Resource } from "../../http";
import type { FileInput, Id, RequestOptions } from "../../types";
import { pollUntilTerminal } from "../jobs";
import {
  fetchToolArtifact,
  isToolTerminal,
  requireToolArtifact,
  toolCaptchaFields,
  toolProgress,
  type SecondsQuota,
  type ToolCaptcha,
  type ToolModel,
  type ToolRecord,
  type ToolRunOptions,
} from "./index";

/** A transcription run. */
export interface Transcription extends ToolRecord {
  readonly model_id: string;
  /** Audio duration charged against the quota. */
  readonly duration_seconds: number;
  /** Language that was requested, or `null` when it was auto-detected. */
  readonly language?: string | null;
  /** Language the model actually detected. */
  readonly detected_language?: string | null;
  readonly has_original?: boolean;
  /** The transcript. Only shipped once the status is `"complete"`. */
  readonly text?: string | null;
  /** SubRip subtitles, once complete. */
  readonly srt_url?: string | null;
  /** WebVTT subtitles, once complete. */
  readonly vtt_url?: string | null;
}

/** Arguments for starting a transcription. */
export interface CreateTranscriptionInput extends ToolCaptcha {
  /** The audio. Sent as the `audio` form field. Backend cap: 250 MiB. */
  readonly audio: FileInput;
  /** Model to use. Omit for the one flagged `default` in {@link TranscriptionNamespace.models}. */
  readonly modelId?: string;
  /** ISO language hint. Omit to let the model detect it. */
  readonly language?: string;
}

/** Which subtitle format {@link TranscriptionNamespace.subtitles} should fetch. */
export type SubtitleFormat = "srt" | "vtt";

/** The `transcription` tool, reachable as `oms.tools.transcription`. */
export class TranscriptionNamespace extends Resource {
  /**
   * `GET /transcriptions/models` - the selectable models.
   *
   * The controller answers `{ models: [...] }`; this unwraps it, because a
   * one-key envelope is not information a caller should have to know about.
   * Exactly one entry carries `default: true`, and that is the model the
   * server picks when {@link CreateTranscriptionInput.modelId} is omitted.
   *
   * `translation_key` is an i18n key, not a display name. The SDK does not
   * translate; render the id if you have no catalogue.
   */
  async models(options: RequestOptions = {}): Promise<ToolModel[]> {
    const answer = await this.http.get<{ models?: ToolModel[] }>("/transcriptions/models", options);
    return answer?.models ?? [];
  }

  /**
   * `GET /transcriptions/quota` - seconds spent and left today.
   *
   * Cheap and anonymous-safe. Call it before a long file rather than
   * discovering the ceiling through a 429 after the upload.
   *
   * `limit_seconds` and `remaining_seconds` are `null` exactly when
   * `unlimited` is `true`; `used_seconds` is always a real number. The window
   * is a calendar day, so "remaining" is not a rate - it does not tick back up
   * until midnight.
   */
  async quota(options: RequestOptions = {}): Promise<SecondsQuota> {
    return this.http.get<SecondsQuota>("/transcriptions/quota", options);
  }

  /**
   * `POST /transcriptions` - uploads the audio and enqueues the run.
   *
   * Answers with the row in `"pending"`. There is no `job_id` here: this tool
   * is polled by re-reading its own row with {@link get}, which is what
   * {@link run} does.
   *
   * NOT retried by default, unlike most of the SDK. The transport's policy
   * replays a `POST` that died with a 502, and here that would re-upload up to
   * 250 MiB and start a second run - charged twice against the daily quota.
   * Pass `retry: {}` to opt back in.
   *
   * `modelId` and `language` are omitted from the form when absent rather than
   * sent empty, so the server applies its own defaults.
   *
   * @throws {OmsQuotaError} 429 when the daily seconds are spent, or when the
   *   20-a-minute expensive-tools throttle fires. Only the throttle sets
   *   `Retry-After`, so `retryAfterMs` being `undefined` means the wait is
   *   until midnight, not seconds.
   * @throws {OmsApiError} 413 when the file is over 250 MiB. 400 when the file
   *   is missing, undecodable, names an unknown model, or is longer on its own
   *   than the whole daily quota.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   */
  async create(input: CreateTranscriptionInput, options: RequestOptions = {}): Promise<Transcription> {
    return this.http.postForm<Transcription>(
      "/transcriptions",
      {
        audio: input.audio,
        ...(input.modelId === undefined ? {} : { model_id: input.modelId }),
        ...(input.language === undefined ? {} : { language: input.language }),
        ...toolCaptchaFields(input),
      },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `GET /transcriptions/:id` - one poll. Carries `progress_percent` while
   * processing and the text once complete.
   *
   * `text`, `srt_url` and `vtt_url` are `null` until the status is
   * `"complete"` - deliberately, so that polling a long run does not drag the
   * whole transcript across the wire every few seconds.
   *
   * Ownership is the caller's session, or - for an anonymous run - the IP the
   * run was started from.
   *
   * @throws {OmsApiError} 404 once the 24-hour retention sweep has taken it.
   * @throws {OmsAuthError} 401 when the run belongs to someone else, which
   *   includes an anonymous run being read from a different address.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<Transcription> {
    return this.http.get<Transcription>(`/transcriptions/${encodeURIComponent(id)}`, options);
  }

  /**
   * Uploads, waits, and returns the finished row with its text.
   *
   * There is no `job_id` for this tool, so the wait is {@link get} on a loop -
   * but the loop itself is `pollUntilTerminal` from the jobs module, the same
   * one every other tool uses. Nothing here opens a second one.
   *
   * Resolves with a `"failed"` row rather than throwing when the work failed:
   * the request cycle worked, the work did not, and only the caller knows
   * whether that is an exception. Check `status` before reading `text`.
   *
   * Pass `waitTimeoutMs` (or a `signal`) to bound the wait; there is no default
   * deadline, because a two-hour file is a legitimate run.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the run: pick it
   *   up later with {@link get}.
   */
  async run(input: CreateTranscriptionInput, options: ToolRunOptions = {}): Promise<Transcription> {
    const created = await this.create(input, options);
    options.onProgress?.(toolProgress(created));

    return pollUntilTerminal<Transcription>({
      ...options,
      label: "the transcription",
      poll: (request) => this.get(created.id, request),
      terminal: (record) => isToolTerminal(record.status),
      progress: toolProgress,
    });
  }

  /**
   * Downloads the subtitles of a finished run.
   *
   * Two calls: one to read the row for the format's URL, one to fetch the
   * signed URL itself with NO credential attached. Hand a row you already hold
   * to {@link subtitleUrl} plus `fetchToolArtifact` if you would rather not pay
   * for the first.
   *
   * For the plain transcript there is nothing to download: it rides on the row
   * as {@link Transcription.text} once the run completes.
   *
   * @throws {OmsError} `conflict` when the run has not finished,
   *   `invalid_request` when it failed, `not_found` when the artefact is gone -
   *   which after 24 hours means the retention sweep took it.
   */
  async subtitles(id: Id, format: SubtitleFormat, options: RequestOptions = {}): Promise<Blob> {
    const record = await this.get(id, options);
    return fetchToolArtifact(this.http, this.subtitleUrl(record, format), options);
  }

  /**
   * The signed URL of one subtitle format, from a row you already hold.
   *
   * Good for handing to a player or a browser instead of moving the bytes. It
   * is a credential: anyone holding it can read the subtitles.
   *
   * @throws {OmsError} explaining which of the three reasons there is no URL.
   */
  subtitleUrl(record: Transcription, format: SubtitleFormat): string {
    return requireToolArtifact(
      record,
      format === "srt" ? record.srt_url : record.vtt_url,
      `${format.toUpperCase()} subtitles`,
    );
  }
}
