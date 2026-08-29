/**
 * Jumpstyle edits: a track plus a pile of clips, cut to the beat.
 *
 * The odd one out of the tool family in three ways. Its quota is metered in
 * finished EDITS, not seconds, so it uses {@link EditsQuota}. Its create call
 * is a multi-file form: one `track` plus a `clips[]` array. And its row has no
 * `"pending"` state at all - the controller forwards the files to the sidecar
 * inside the request and saves the row already `"processing"`, so a create that
 * returns at all has work under way.
 *
 * Limits, all enforced by the backend:
 *
 * | | |
 * |---|---|
 * | track | 30 MiB, and the MIME type must be `audio/*` |
 * | each clip | 120 MiB, and the MIME type must be `video/*` or `image/*` |
 * | whole upload | 400 MiB |
 * | clips | 20 |
 * | output length | clamped to `[10, 60]` seconds |
 * | daily quota, anonymous | 3 edits |
 * | daily quota, signed in | 15 edits |
 * | `POST /jumpstyle_jobs` | 20 a minute, shared with every other expensive tool |
 *
 * The MIME checks read the `contentType` on each {@link FileInput}, which the
 * SDK sends as the part's `Content-Type`. A file handed over with the wrong one
 * - or with none, which some hosts do for an unknown extension - is a 400 that
 * has nothing to do with the bytes.
 *
 * Read {@link JumpstyleNamespace.quota} before uploading. It is the cheapest
 * preflight in the family, because one invocation is exactly one edit: if
 * `remaining_edits` is `0`, the upload cannot succeed.
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
  type EditsQuota,
  type ToolCaptcha,
  type ToolRecord,
  type ToolRunOptions,
} from "./index";

/**
 * How busy the cut is, in the sidecar's own words.
 *
 * `chill` cuts once a phrase, `normal` is the default, `hyper` cuts on
 * subdivisions and is what the tool did before the setting existed.
 *
 * Get this wrong and nothing tells you: the controller replaces an
 * unrecognised value with `"normal"` rather than refusing it, so a plausible
 * synonym is a silent no-op that costs a whole edit to discover.
 */
export type JumpstyleDensity = "chill" | "normal" | "hyper";

/** The three the backend accepts. Anything else is silently read as `"normal"`. */
export const JUMPSTYLE_DENSITIES: readonly JumpstyleDensity[] = Object.freeze([
  "chill",
  "normal",
  "hyper",
] as const);

/**
 * Lifecycle of a jumpstyle edit.
 *
 * Narrower than {@link ToolStatus}: `JumpstyleJob::STATUSES` has only three
 * entries and `"pending"` is not one of them. The controller forwards the files
 * to the sidecar inside the create request and saves the row already
 * `"processing"`, so there is no state in which an edit exists but has not
 * started.
 */
export type JumpstyleStatus = "processing" | "complete" | "failed";

/**
 * A jumpstyle edit.
 *
 * Both routes that answer with one - `POST /jumpstyle_jobs` and
 * `GET /jumpstyle_jobs/:id` - render the `:extended` view, so every key below
 * is present on every response.
 *
 * The first four columns are nullable in the schema but written by the
 * controller on every create, so a row the API can produce always carries
 * them. `density` and `rapid_fire` are `NOT NULL` with defaults on top of that.
 */
export interface JumpstyleJob extends ToolRecord {
  readonly status: JumpstyleStatus;
  /** Uploaded track's name; `"track"` when the upload carried none. */
  readonly track_filename: string;
  /** How many clips were sent. At most 20. */
  readonly n_clips: number;
  /** Seconds of output, clamped by the server to `[10, 60]`. */
  readonly duration: number;
  /**
   * The seed that produced this cut. Reuse it to reproduce the edit - it is
   * the ONLY way to, and the server rolls a fresh one whenever it is not
   * given one.
   */
  readonly seed: number;
  /** `NOT NULL DEFAULT 'normal'`. An unrecognised request value lands here as `"normal"`. */
  readonly density: JumpstyleDensity | string;
  /** `NOT NULL DEFAULT false`. */
  readonly rapid_fire: boolean;
  /** BPM that was forced at create time, or `null` when detection was left to run. */
  readonly bpm: number | null;
  /**
   * While processing: the BPM the sidecar has detected, or `null` if it has not
   * yet. Once the row settles: whatever `bpm` holds, forced or not. So this
   * changes meaning at the moment the run ends.
   */
  readonly detected_bpm: number | null;
  /** What the sidecar is doing right now, read live. `null` unless processing. */
  readonly stage: string | null;
  /** Signed URL of the finished video once complete and attached, `null` otherwise. */
  readonly output_url: string | null;
}

/** Arguments for starting an edit. */
export interface CreateJumpstyleInput extends ToolCaptcha {
  /** The music. Must be `audio/*`. Backend cap: 30 MiB. */
  readonly track: FileInput;
  /** Footage to cut. Must be `video/*` or `image/*`. At most 20, 120 MiB each. */
  readonly clips: FileInput[];
  /**
   * Seconds of output. Clamped by the server to `[10, 60]`.
   *
   * Omitting it is NOT the same as leaving it to a server default: the
   * controller reads a missing value as `0` and then clamps, so an omitted
   * duration produces a 10-second edit. Pass one.
   */
  readonly duration?: number;
  /**
   * Reproducibility seed. Omit and the server rolls one; read it back off the
   * finished row to make the same cut again. Taken modulo 100000.
   */
  readonly seed?: number;
  /** Defaults to `"normal"`. An unknown value is silently replaced by it. */
  readonly density?: JumpstyleDensity;
  /** Cuts on every beat rather than every phrase. */
  readonly rapidFire?: boolean;
  /**
   * Forces the tempo. Pass it ONLY when detection has already failed; the
   * server clamps it to `[100, 220]`.
   */
  readonly bpm?: number;
}

/** The `jumpstyle` tool, reachable as `oms.tools.jumpstyle`. */
export class JumpstyleNamespace extends Resource {
  /**
   * `GET /jumpstyle_jobs/quota` - edits spent and left today.
   *
   * Cheap and anonymous-safe. The only quota in the family counted in whole
   * units, which makes the preflight exact: one call to {@link create} spends
   * exactly one edit, so `remaining_edits === 0` means the next upload fails.
   *
   * `limit_edits` and `remaining_edits` are `null` exactly when `unlimited` is
   * `true`. A failed edit does not count against the day.
   */
  async quota(options: RequestOptions = {}): Promise<EditsQuota> {
    return this.http.get<EditsQuota>("/jumpstyle_jobs/quota", options);
  }

  /**
   * `POST /jumpstyle_jobs` - uploads the track and the clips, enqueues the cut.
   *
   * The clips go up as a `clips[]` array, which is how Rails reads a list; the
   * transport appends the suffix itself, so pass a plain array.
   *
   * The files are forwarded to the sidecar INSIDE this request, which is why it
   * is the slowest create in the family - up to 400 MiB moves twice before it
   * answers - and why the row comes back already `"processing"` rather than
   * `"pending"`. If the sidecar refuses, the row is destroyed rather than left
   * dangling, so a failure here leaves nothing to clean up.
   *
   * NOT retried by default: replaying this `POST` after a 502 re-uploads the
   * whole pile and spends a second edit. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsQuotaError} 429 when the daily edits are spent. The message is
   *   a bare string with no `Retry-After`, so `retryAfterMs` is `undefined` -
   *   the wait is until midnight. The expensive-tools throttle, also a 429,
   *   DOES set it.
   * @throws {OmsApiError} 413 when a file or the total is over a cap, 400 for a
   *   wrong MIME type, no clips, or more than 20 of them, 503 when the edit
   *   sidecar is down.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   */
  async create(input: CreateJumpstyleInput, options: RequestOptions = {}): Promise<JumpstyleJob> {
    return this.http.postForm<JumpstyleJob>(
      "/jumpstyle_jobs",
      {
        track: input.track,
        clips: [...input.clips],
        ...(input.duration === undefined ? {} : { duration: input.duration }),
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.density === undefined ? {} : { density: input.density }),
        ...(input.rapidFire === undefined ? {} : { rapid_fire: input.rapidFire }),
        ...(input.bpm === undefined ? {} : { bpm: input.bpm }),
        ...toolCaptchaFields(input),
      },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `GET /jumpstyle_jobs/:id` - one poll, carrying `stage` and
   * `progress_percent` while the sidecar works.
   *
   * Both are read live off the sidecar and are `null` the moment the row
   * settles - at which point `detected_bpm` stops being the sidecar's guess
   * and becomes whatever was saved on the row.
   *
   * @throws {OmsApiError} 404 once the 24-hour retention sweep has taken it.
   * @throws {OmsAuthError} 401 when the job belongs to someone else, which
   *   includes an anonymous job being read from a different address.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<JumpstyleJob> {
    return this.http.get<JumpstyleJob>(`/jumpstyle_jobs/${encodeURIComponent(id)}`, options);
  }

  /**
   * Uploads, waits, and returns the finished row.
   *
   * The wait is {@link get} on a loop, driven by `pollUntilTerminal` from the
   * jobs module - the same loop every other tool uses.
   *
   * Resolves with a `"failed"` row rather than throwing when the work failed.
   * Pass `waitTimeoutMs` (or a `signal`) to bound the wait; there is no default
   * deadline.
   *
   * Read {@link JumpstyleJob.seed} off the row that comes back: it is the only
   * way to reproduce a cut you liked, and the server rolls a fresh one every
   * time it is not given one.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the run: pick it
   *   up later with {@link get}.
   */
  async run(input: CreateJumpstyleInput, options: ToolRunOptions = {}): Promise<JumpstyleJob> {
    const created = await this.create(input, options);
    options.onProgress?.(toolProgress(created));

    return pollUntilTerminal<JumpstyleJob>({
      ...options,
      label: "the jumpstyle edit",
      poll: (request) => this.get(created.id, request),
      terminal: (record) => isToolTerminal(record.status),
      progress: toolProgress,
    });
  }

  /**
   * `DELETE /jumpstyle_jobs/:id`.
   *
   * @throws {OmsApiError} 404 when it is already gone.
   * @throws {OmsAuthError} 401 when the job belongs to someone else.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<{ deleted?: Id }>(`/jumpstyle_jobs/${encodeURIComponent(id)}`, options);
  }

  /**
   * Downloads the finished video.
   *
   * Two calls: one to read the row for its `output_url`, one to fetch the
   * signed URL itself with NO credential attached. Hand a row you already hold
   * to {@link outputUrl} plus `fetchToolArtifact` if you would rather not pay
   * for the first.
   *
   * @throws {OmsError} `conflict` when the edit has not finished,
   *   `invalid_request` when it failed, `not_found` when the artefact is gone.
   */
  async download(id: Id, options: RequestOptions = {}): Promise<Blob> {
    const record = await this.get(id, options);
    return fetchToolArtifact(this.http, this.outputUrl(record), options);
  }

  /**
   * The signed URL of the finished video, from a row you already hold.
   *
   * It is a credential: anyone holding it can watch the video.
   *
   * @throws {OmsError} explaining which of the three reasons there is no URL.
   */
  outputUrl(record: JumpstyleJob): string {
    return requireToolArtifact(record, record.output_url, "rendered video");
  }
}
