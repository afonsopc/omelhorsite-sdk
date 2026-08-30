/**
 * The `tools` namespace: the metered media tools.
 *
 * Every tool here shares four traits, and this file owns the types for them so
 * the seven sibling modules never redefine them:
 *
 * - it accepts an upload through Rails as `multipart/form-data`, not through
 *   the storage direct-upload path;
 * - it is asynchronous: the create call answers with a row in `"pending"` and
 *   the work happens on a sidecar;
 * - it has a daily quota, metered in seconds for the audio and video tools and
 *   in edits for jumpstyle, and smaller for an anonymous caller - each tool's
 *   own `quota()` reads it, and `oms.quotas.list()` reads all of them plus the
 *   storage ceilings in one request;
 * - an anonymous caller must pass a Turnstile token
 *   ({@link ToolCaptcha.captchaToken}, sent as `cf_turnstile_token`).
 *
 * A trap worth naming once, because it is not the one it looks like: a tool row
 * and its {@link Job} row are TWO records with two different ids, and both
 * spell a finished run `"complete"`. What differs is the set of states - a job
 * has a fifth, `"canceled"`, that no tool row can ever hold - and which of the
 * two a given tool is polled through. Compare against
 * {@link TOOL_TERMINAL_STATUSES} / {@link isToolTerminal} and against
 * `JOB_TERMINAL_STATUSES` / `isJobTerminal`, never against a literal you typed
 * from memory.
 *
 * Two tools (background removal, upscale) hand back a `job_id` and are waited
 * on through `oms.jobs`; the other five are waited on by re-reading their own
 * row. Neither case opens a loop here: both go through `pollUntilTerminal`
 * from the jobs module.
 *
 * Re-exports every sibling module so nobody has to touch this file again.
 */

import { OmsApiError, OmsError } from "../../errors";
import { type ApiClient, Resource } from "../../http";
import type {
  BaseRecord,
  OperationOptions,
  Progress,
  QuotaStatus,
  RequestOptions,
  Timestamp,
  WaitOptions,
} from "../../types";
import { JOB_STATUS, pollUntilTerminal, type JobsNamespace } from "../jobs";
import { objectStoreFetch } from "../storage/upload";
import { BackgroundRemovalNamespace } from "./backgroundRemoval";
import { CaptionsNamespace } from "./captions";
import { DownloaderNamespace } from "./downloader";
import { JumpstyleNamespace } from "./jumpstyle";
import { TranscriptionNamespace } from "./transcription";
import { UpscaleNamespace } from "./upscale";
import { SRMachineNamespace } from "./srMachine";
import { VocalSeparationNamespace } from "./vocalSeparation";

export * from "./backgroundRemoval";
export * from "./captions";
export * from "./downloader";
export * from "./jumpstyle";
export * from "./transcription";
export * from "./upscale";
export * from "./srMachine";
export * from "./vocalSeparation";

/**
 * Lifecycle of a tool row.
 *
 * Note `"complete"`, not `"completed"`: that spelling belongs to
 * {@link Job}. Captions add their own intermediate states on top.
 */
export type ToolStatus = "pending" | "processing" | "complete" | "failed";

/** Terminal states. A row in one of these will never change again. */
export const TOOL_TERMINAL_STATUSES: readonly ToolStatus[] = Object.freeze(["complete", "failed"] as const);

/**
 * Fields every tool row carries.
 *
 * All six blueprints in the family declare `status`, `error`, `finished_at`,
 * `user_id` and `ip_address` in their DEFAULT view, and every route that
 * answers with a tool row renders `:extended`, which inherits the default
 * view's fields. So those five keys are always present; four of them hold a
 * nullable column and are `null` rather than missing.
 *
 * `progress_percent` is the exception and is optional on purpose: it is an
 * `:extended`-only field on FOUR of the six - transcription, vocal separation,
 * captions and jumpstyle, the ones with a sidecar to ask - and does not exist
 * at all on upscale or background removal, whose progress lives on the {@link
 * Job} row instead. `toolProgress` reads it defensively for exactly that
 * reason.
 */
export interface ToolRecord extends BaseRecord {
  readonly status: ToolStatus | string;
  /** Failure message, set once the status is `"failed"`. `null` otherwise. */
  readonly error: string | null;
  /** Set when the run reached a terminal state; `null` before that. */
  readonly finished_at: Timestamp | null;
  /** The owner, or `null` for an anonymous run. */
  readonly user_id: string | null;
  /**
   * The address an anonymous run was started from, and `null` for a run with
   * an owner - the controllers write one or the other, never both, and the
   * models validate that at least one is set.
   *
   * It is also the credential for an anonymous run: `accessible_by?` matches
   * this against the reader's own address, which is why picking up an
   * anonymous run from a different network is a 401.
   */
  readonly ip_address: string | null;
  /**
   * Percentage the sidecar reports while running, `null` when idle or done -
   * and absent entirely on upscale and background removal, which have no such
   * field. See the note on this interface.
   */
  readonly progress_percent?: number | null;
}

/**
 * Handle for polling an enqueued run.
 *
 * Both keys come back from the two tools that enqueue through the generic job
 * table (upscale, background removal), and BOTH are always present on their
 * create response: the controllers merge them onto the rendered row
 * unconditionally. `watch_token` is nullable rather than absent, because
 * `signed_id` is called on a tracking row that may not have been found.
 *
 * The token is what lets an anonymous caller poll `GET /jobs/:id`. The other
 * five tools are polled by reading their own row and answer neither key, which
 * is why this is a separate interface mixed into their `Created` types rather
 * than part of {@link ToolRecord}.
 */
export interface ToolJobHandle {
  readonly job_id: string;
  /**
   * Signed and scoped to this one job, and expiring with the tool's retention
   * window. Required when anonymous.
   *
   * `null` when the tracking row could not be read back after enqueue, which
   * leaves an anonymous caller with no way to poll at all - the job id alone
   * is a 404 without a credential.
   */
  readonly watch_token: string | null;
}

/** Mixed into every create input: the anonymous caller's captcha. */
export interface ToolCaptcha {
  /**
   * Cloudflare Turnstile token, sent as `cf_turnstile_token`. Required when
   * there is no credential; ignored when there is one.
   */
  readonly captchaToken?: string;
}

/** A daily quota metered in seconds of media. */
export interface SecondsQuota extends QuotaStatus {
  readonly used_seconds: number;
  /** `null` when the account is unlimited. */
  readonly limit_seconds: number | null;
  /** `null` when the account is unlimited. */
  readonly remaining_seconds: number | null;
}

/** A daily quota metered in finished edits. */
export interface EditsQuota extends QuotaStatus {
  readonly used_edits: number;
  readonly limit_edits: number | null;
  readonly remaining_edits: number | null;
}

/** One selectable model of a tool. */
export interface ToolModel {
  readonly id: string;
  /** i18n key for the display name. The SDK does not translate. */
  readonly translation_key?: string;
  /** True on the model the server picks when none is named. */
  readonly default?: boolean;
}

// ---------------------------------------------------------------------------
// The shared body of a tool module
//
// Every one of the seven modules needs the same five things, so they live here
// once as plain functions. They are FUNCTIONS and not a base class on purpose:
// `tools/index.ts` imports each namespace and each namespace imports these
// back, and a `class X extends Base` from a partially-evaluated module is a
// TDZ crash at import time, while a function declaration is hoisted and a call
// from inside a method body happens long after every module has evaluated.
// ---------------------------------------------------------------------------

/**
 * Options for a tool's `run()`: the upload half and the waiting half at once.
 *
 * `onProgress` fires as bytes move and again on every poll. `waitTimeoutMs` and
 * `pollIntervalMs` are passed straight through to the jobs module's loop, which
 * is the only loop involved.
 *
 * Note what `timeoutMs` does NOT mean here: it bounds one HTTP call, not the
 * run. A ninety-minute separation with `timeoutMs: 60_000` is fine - each poll
 * is a second-long request. Use `waitTimeoutMs` (or a `signal`) to bound the
 * run itself.
 */
export interface ToolRunOptions extends OperationOptions, WaitOptions {}

/** True once a tool row can never change again. */
export function isToolTerminal(status: string): boolean {
  return (TOOL_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Renders a tool row as a {@link Progress}.
 *
 * `total` is `undefined` while `progress_percent` is null, which is most of a
 * run's life: the backend only fills it in while the sidecar is actually
 * working, and inventing a denominator would be a lie a spinner then renders.
 */
export function toolProgress(record: ToolRecord): Progress {
  const percent = record.progress_percent;
  const known = typeof percent === "number";
  return {
    phase: "processing",
    loaded: known ? percent : 0,
    total: known ? 100 : undefined,
    status: record.status,
  };
}

/**
 * The captcha form field, or nothing.
 *
 * Sent as `cf_turnstile_token`, and only when the caller supplied one: an empty
 * string is not the same as an absent key to the Turnstile verifier.
 */
export function toolCaptchaFields(input: ToolCaptcha): Record<string, string> {
  return input.captchaToken === undefined || input.captchaToken.length === 0
    ? {}
    : { cf_turnstile_token: input.captchaToken };
}

/**
 * Picks an artefact URL off a finished row, or explains why there is not one.
 *
 * A tool row carries its outputs as URLs that are null until the run completes,
 * so "no URL" has three different causes and a caller deserves to be told which
 * one. Never returns an empty string.
 *
 * @param what Name of the artefact for the message: `"result"`, `"vocals"`.
 * @throws {OmsError} `invalid_request` when the run failed, `conflict` when it
 *   has not finished yet, `not_found` when it finished without one - which
 *   after 24 hours means the retention sweep took it.
 */
export function requireToolArtifact(record: ToolRecord, url: string | null | undefined, what: string): string {
  if (typeof url === "string" && url.length > 0) return url;

  if (record.status === "failed") {
    throw new OmsError(
      `The run failed, so there is no ${what} to download: ${record.error ?? "the server gave no reason"}.`,
      "invalid_request",
    );
  }
  if (!isToolTerminal(record.status)) {
    throw new OmsError(
      `The run is still "${record.status}", so the ${what} is not ready. Wait for it with run(), or poll get().`,
      "conflict",
    );
  }
  throw new OmsError(
    `The run is complete but carries no ${what}. Artefacts are swept 24 hours after a run finishes.`,
    "not_found",
  );
}

/**
 * Fetches an artefact URL and buffers it.
 *
 * Sent on the injected transport with NO `Authorization` header, deliberately
 * and for the same reason `storage.download` does it: these URLs are signed
 * ActiveStorage links that redirect to the object store, and the store rejects
 * a request that arrives with two authentication schemes. The signature in the
 * URL is the credential.
 *
 * Buffers the whole artefact, because every one of them is a file a caller is
 * about to write somewhere. Only the caller's `signal` is honoured - the
 * transport's retry and per-request deadline do not apply to a bare `fetch`.
 *
 * @throws {OmsApiError} carrying the store's status when the URL has expired or
 *   the artefact has been swept.
 */
export async function fetchToolArtifact(http: ApiClient, url: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await objectStoreFetch(http)(url, {
    method: "GET",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    credentials: "omit",
    redirect: "follow",
  });
  if (!response.ok) {
    throw new OmsApiError(
      `Could not download the artefact (${response.status}). Artefacts are swept 24 hours after a run finishes.`,
      { status: response.status, method: "GET", url, attempts: 1 },
    );
  }
  return response.blob();
}

/**
 * Waits for a run that enqueued through the generic `jobs` table, then reads
 * the tool's own row back.
 *
 * Only background removal and upscale take this path - they are the two tools
 * whose create call answers with a `job_id` and a `watch_token`. The job row is
 * what carries progress and what an anonymous caller is allowed to read; the
 * TOOL row is the typed answer, and it is written first (the worker marks the
 * run complete or failed inside `perform`, and the job is settled around it),
 * so re-reading after the job settles never races.
 *
 * When the server gave no `job_id` - no tracking row was minted - this falls
 * back to polling the tool's own row, which is what the other five tools do
 * anyway. Either way there is exactly one loop, and it lives in the jobs
 * module.
 *
 * @param reread Reads the tool row. Called after the job settles.
 * @param label What to call this in a timeout message: `"the upscale"`.
 * @throws {OmsError} `server_error` when the job ended without completing AND
 *   left the tool row untouched - a cancelled or crashed worker. A run that
 *   genuinely failed comes back as a row with `status: "failed"`, because that
 *   is an answer.
 */
export async function awaitToolJob<T extends ToolRecord>(
  jobs: JobsNamespace,
  created: T & ToolJobHandle,
  reread: (options: RequestOptions) => Promise<T>,
  options: ToolRunOptions,
  label: string,
): Promise<T> {
  options.onProgress?.(toolProgress(created));

  if (typeof created.job_id !== "string" || created.job_id.length === 0) {
    return pollUntilTerminal<T>({
      ...options,
      label,
      poll: reread,
      terminal: (record) => isToolTerminal(record.status),
      progress: toolProgress,
    });
  }

  // `watch_token` is null - not undefined - when the tracking row could not be
  // read back, so the guard tests for a usable string rather than for
  // presence. Handing `null` through as a `watch_token=` query parameter would
  // turn an authenticated poll that would have worked into a 404.
  const watchToken = created.watch_token;
  const job = await jobs.wait(
    {
      id: created.job_id,
      ...(typeof watchToken === "string" && watchToken.length > 0 ? { watchToken } : {}),
    },
    options,
  );

  const record = await reread(options);
  if (job.status !== JOB_STATUS.complete && !isToolTerminal(record.status)) {
    throw new OmsError(
      `The worker for ${label} ended "${job.status}" without finishing the run` +
        `${job.error ? `: ${job.error}` : "."} The run is still "${record.status}"; start it again.`,
      "server_error",
    );
  }
  return record;
}

/** The `tools` namespace, reachable as `oms.tools`. */
export class ToolsNamespace extends Resource {
  /** Cuts the subject out of an image. */
  readonly backgroundRemoval: BackgroundRemovalNamespace;
  /** Enlarges an image without the mush. */
  readonly upscale: UpscaleNamespace;
  /** Speech to text, with SRT and VTT output. */
  readonly transcription: TranscriptionNamespace;
  /** Splits a track into vocals and instrumental. */
  readonly vocalSeparation: VocalSeparationNamespace;
  /** Karaoke captions burned into a video. */
  readonly captions: CaptionsNamespace;
  /** Beat-synced clip edits over a track. */
  readonly jumpstyle: JumpstyleNamespace;
  /** Fetches media from a public URL. */
  readonly downloader: DownloaderNamespace;
  /** Fetch, convert and package a track. Administrators only. */
  readonly srMachine: SRMachineNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.backgroundRemoval = new BackgroundRemovalNamespace(http);
    this.upscale = new UpscaleNamespace(http);
    this.transcription = new TranscriptionNamespace(http);
    this.vocalSeparation = new VocalSeparationNamespace(http);
    this.captions = new CaptionsNamespace(http);
    this.jumpstyle = new JumpstyleNamespace(http);
    this.downloader = new DownloaderNamespace(http);
    this.srMachine = new SRMachineNamespace(http);
  }
}
