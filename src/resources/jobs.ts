/**
 * The `jobs` namespace: the one place a background job is polled.
 *
 * Every asynchronous tool (upscale, background removal, transcription, vocal
 * separation, captions, jumpstyle) enqueues a job and hands back a `job_id`
 * plus, for an anonymous caller, a `watch_token`. That token grants read access
 * to exactly one job and is the reason `GET /jobs/:id` is reachable without a
 * credential.
 *
 * Every tool namespace that returns a job delegates its `wait()` to
 * {@link JobsNamespace.wait}, so the polling policy lives here once. Do not
 * write a second polling loop inside a tool module.
 *
 * Only two tools enqueue through the generic `jobs` table - background removal
 * and upscale. The other five are polled by re-reading their own row, which is
 * still not a reason to write a loop there: {@link pollUntilTerminal} is the
 * same engine with a different `poll` function, and that is what those modules
 * call.
 *
 * The loop is deliberately dumb and bounded:
 *
 * - the first poll happens immediately, with no initial pause;
 * - each pause is {@link POLL_BACKOFF_FACTOR} times the last, capped at
 *   {@link MAX_POLL_INTERVAL_MS}, so a five-second job costs a handful of
 *   requests and a ninety-minute one does not cost eleven thousand;
 * - there is no jitter. A poll loop is one client watching one job; the place a
 *   herd actually forms is a 429, and `Retry-After` is honoured by the
 *   transport, which is where that belongs;
 * - `waitTimeoutMs` is the caller's deadline and has NO default. A job that the
 *   server never terminalises would otherwise hang an isolate forever, so pass
 *   one - or a `signal` - whenever the caller is not a person watching a
 *   terminal.
 *
 * Three outcomes, and they are different types on purpose:
 *
 * | What happened | How it arrives |
 * |---|---|
 * | The work finished, well or badly | resolves with a {@link Job}; read `status` |
 * | The client gave up first | throws {@link OmsTimeoutError} with `code: "timeout"` |
 * | The caller aborted | throws {@link OmsTimeoutError} with `code: "aborted"` |
 *
 * A job that ends `"failed"` is an ANSWER, not a transport error: the request
 * cycle worked perfectly and the work did not. Only the caller knows whether
 * that deserves an exception.
 */

import { OmsTimeoutError } from "../errors";
import { Resource, pageModifier, sleep } from "../http";
import { createPage } from "../types";
import type {
  BaseRecord,
  Id,
  Json,
  JobStatus,
  Paginated,
  PageParams,
  Progress,
  QueryValue,
  RequestOptions,
  Timestamp,
  WaitOptions,
} from "../types";

/**
 * The five status strings, spelled the way the backend spells them.
 *
 * `complete`, not `completed`. `canceled`, one L. Reach for this object instead
 * of typing the literal: a loop that waits for `"completed"` waits forever.
 */
export const JOB_STATUS = Object.freeze({
  pending: "pending",
  processing: "processing",
  complete: "complete",
  failed: "failed",
  canceled: "canceled",
} as const);

/**
 * Statuses a job never leaves.
 *
 * Note `canceled` is here and has no equivalent on a tool row: a job can be
 * cancelled out from under a tool whose own row is still `"pending"`.
 */
export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = Object.freeze([
  JOB_STATUS.complete,
  JOB_STATUS.failed,
  JOB_STATUS.canceled,
] as const);

/** True once this status can never change again. */
export function isJobTerminal(status: string): boolean {
  return (JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** A background job. */
export interface Job extends BaseRecord {
  readonly status: JobStatus;
  /**
   * Feature-level kind of the run. Today the backend only ever writes
   * `"omsvs"` (vocal separation) or `"unknown"`, which is the column default
   * every generic enqueue gets - including the upscale and background-removal
   * proxies. It is NOT the worker's class name.
   */
  readonly job_type: string;
  /** Enqueue-time arguments, when the enqueuer wrote any. Shape depends on `job_type`. */
  readonly payload?: Json;
  /** Set when a worker claimed the job. */
  readonly started_at?: Timestamp | null;
  readonly finished_at?: Timestamp | null;
  /**
   * Percentage, an integer in `[0, 100]`. The column is `NOT NULL DEFAULT 0`,
   * so it is a real number from the moment the row exists and 0 means "not
   * started", never "unknown".
   */
  readonly progress?: number | null;
  /** Failure message, set once `status === "failed"` (or a cancellation reason). */
  readonly error?: string | null;
  /** Worker-specific payload; shape depends on `job_type`. */
  readonly result?: Json;
  /** Who enqueued it. `null` for a job with no owner, e.g. an anonymous tool run. */
  readonly creator_id?: Id | null;
  /** Which worker claimed it. */
  readonly worker_id?: string | null;
}

/**
 * How to address a job.
 *
 * An authenticated caller needs only the id. An anonymous one must also present
 * the `watchToken` the tool handed back at enqueue time.
 */
export interface JobRef {
  readonly id: Id;
  /** Signed token scoped to this one job. Required when anonymous. */
  readonly watchToken?: string;
}

/** Filters for {@link JobsNamespace.list}. */
export interface ListJobsParams extends PageParams {
  readonly status?: JobStatus | JobStatus[];
  readonly jobType?: string | string[];
}

/** Pause before the second poll, in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Ceiling for one pause, in milliseconds. */
export const MAX_POLL_INTERVAL_MS = 15_000;

/** Each pause is this many times the last one, until the ceiling. */
export const POLL_BACKOFF_FACTOR = 1.5;

/**
 * Everything {@link pollUntilTerminal} needs to watch something finish.
 *
 * Generic over the record because the seven tools are polled two different
 * ways - two through `GET /jobs/:id`, five through their own `show` - and only
 * `poll` and `terminal` differ between them. Nothing else about the loop does,
 * which is exactly why there is one loop.
 */
export interface PollUntilTerminalOptions<T> extends WaitOptions {
  /**
   * Reads the current state. Called once immediately, then again after every
   * pause. It is handed the request-shaped half of these options (signal,
   * per-request timeout, headers, retry), never the wait-shaped half.
   */
  readonly poll: (options: RequestOptions) => Promise<T>;
  /** True once `state` can never change again. */
  readonly terminal: (state: T) => boolean;
  /**
   * Maps a state onto a {@link Progress} for `onProgress`. Its `status` is also
   * what the timeout message quotes, so a run that gave up says what it was
   * last doing.
   */
  readonly progress?: (state: T) => Progress;
  /** What is being waited on, for the timeout message: `"job 3f2a"`. */
  readonly label?: string;
}

/**
 * Polls until `terminal` says so, then returns the final state.
 *
 * This is THE polling loop of the SDK. A resource module supplies `poll` and
 * `terminal`; it does not supply a `while`.
 *
 * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapsed,
 *   `code: "aborted"` when the caller's signal fired.
 * @throws {OmsApiError} whatever `poll` throws - a 404 once a finished job's
 *   24-hour retention expires, a 401 for an anonymous caller with no watch
 *   token. A polling loop is not the place to swallow those.
 */
export async function pollUntilTerminal<T>(options: PollUntilTerminalOptions<T>): Promise<T> {
  const iterator = watchUntilTerminal(options);
  for (;;) {
    const step = await iterator.next();
    if (step.done === true) return step.value;
  }
}

/**
 * Same loop as {@link pollUntilTerminal}, but yields every state it observes -
 * including the terminal one, which is also the generator's return value.
 *
 * For a host that would rather render each step than take a callback. Breaking
 * out of the `for await` stops the loop; nothing is left running.
 */
export async function* watchUntilTerminal<T>(
  options: PollUntilTerminalOptions<T>,
): AsyncGenerator<T, T, undefined> {
  const label = options.label ?? "the job";
  const request = requestPartOf(options);
  const waitTimeoutMs = options.waitTimeoutMs;
  const deadline = waitTimeoutMs !== undefined && waitTimeoutMs > 0 ? Date.now() + waitTimeoutMs : undefined;

  let interval = Math.max(1, Math.trunc(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  let last: Progress | undefined;

  throwIfAborted(options.signal, label);

  for (;;) {
    const state = await options.poll(request);

    last = options.progress?.(state);
    if (last !== undefined) options.onProgress?.(last);

    yield state;
    if (options.terminal(state)) return state;

    // Checked here rather than only inside the sleep so a signal that fired
    // during the request itself is not paid for with another whole interval.
    throwIfAborted(options.signal, label);

    const now = Date.now();
    if (deadline !== undefined && now >= deadline) {
      throw gaveUp(label, waitTimeoutMs ?? 0, last);
    }

    // The last pause is trimmed to land exactly on the deadline, which buys one
    // final poll instead of overshooting and reporting a timeout for a job that
    // finished a millisecond earlier.
    const pause = deadline === undefined ? interval : Math.min(interval, deadline - now);
    try {
      await sleep(pause, options.signal);
    } catch (thrown) {
      throw thrown instanceof OmsTimeoutError ? aborted(label, thrown) : thrown;
    }

    interval = Math.min(MAX_POLL_INTERVAL_MS, Math.round(interval * POLL_BACKOFF_FACTOR));
  }
}

/** The `jobs` namespace, reachable as `oms.jobs`. */
export class JobsNamespace extends Resource {
  /**
   * `GET /jobs` - your jobs. Requires a credential; a watch token cannot list.
   *
   * An admin sees every job, a signed-in user sees the ones they created, and
   * an anonymous caller sees an empty page - never a 401, because the scope is
   * empty rather than forbidden.
   *
   * @throws {OmsApiError} 400 naming the key when a filter is not on the
   *   controller's allowlist (`id`, `job_type`, `status`, `created_at`,
   *   `updated_at`, `finished_at`).
   */
  async list(params: ListJobsParams = {}, options: RequestOptions = {}): Promise<Paginated<Job>> {
    const pageSize = params.pageSize ?? 100;

    const search: Record<string, QueryValue> = {};
    if (params.status !== undefined) search["status"] = asFilter(params.status);
    if (params.jobType !== undefined) search["job_type"] = asFilter(params.jobType);

    const load = async (page: { page: number; pageSize: number }): Promise<Job[]> =>
      (await this.http.get<Job[]>("/jobs", {
        ...options,
        query: {
          ...(Object.keys(search).length > 0 ? { search } : {}),
          modifiers: {
            page: pageModifier(page.page, page.pageSize),
            ...(params.order === undefined ? {} : { order: params.order }),
          },
        },
        headers: noRevalidate(options.headers),
      })) ?? [];

    const first = params.page ?? 1;
    return createPage(await load({ page: first, pageSize }), first, pageSize, load);
  }

  /**
   * `GET /jobs/:id` - one poll, no waiting.
   *
   * A `watchToken` is sent as `?watch_token=`, which is the only way an
   * anonymous caller reaches a job. The server checks the signature resolves to
   * the job named in the path, so the token cannot be pointed at another id.
   *
   * @throws {OmsApiError} 404 when the job is gone, which for a finished job
   *   also happens once its retention window expires. A wrong, expired or
   *   missing watch token is the same 404, not a 401: the controller never says
   *   whether the id exists.
   */
  async get(ref: JobRef | Id, options: RequestOptions = {}): Promise<Job> {
    const { id, watchToken } = jobRef(ref);
    return this.http.get<Job>(`/jobs/${encodeURIComponent(id)}`, {
      ...options,
      ...(watchToken === undefined ? {} : { query: { watch_token: watchToken } }),
    });
  }

  /**
   * Polls until the job reaches a terminal state, then returns it.
   *
   * The polling policy belongs here, not in the callers: start at
   * `pollIntervalMs`, back off towards a ceiling, stop at `waitTimeoutMs`, and
   * abort immediately if the caller's `signal` fires. `onProgress` is called on
   * every poll so a host can drive a spinner.
   *
   * Resolves for `"complete"`, `"failed"` AND `"canceled"` - a job that ended
   * badly is an answer, not a transport error. Check `job.status` before
   * reading `job.result`.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses
   *   first, `code: "aborted"` when the caller's signal fires.
   */
  async wait(ref: JobRef | Id, options: WaitOptions = {}): Promise<Job> {
    return pollUntilTerminal(this.pollPlan(ref, options));
  }

  /**
   * Yields the job's state on every poll until it finishes, for a host that
   * wants to render each step rather than take a callback.
   *
   * The terminal state is both the last value yielded and the generator's
   * return value, so neither `for await` nor a manual `next()` loop can miss
   * it.
   */
  watch(ref: JobRef | Id, options: WaitOptions = {}): AsyncGenerator<Job, Job, undefined> {
    return watchUntilTerminal(this.pollPlan(ref, options));
  }

  /** The one description of "watching a job", shared by `wait` and `watch`. */
  private pollPlan(ref: JobRef | Id, options: WaitOptions): PollUntilTerminalOptions<Job> {
    const { id } = jobRef(ref);
    return {
      ...options,
      label: `job ${id}`,
      poll: (request) => this.get(ref, request),
      terminal: (job) => isJobTerminal(job.status),
      progress: jobProgress,
    };
  }
}

/** Normalises the two ways a job can be addressed into the object form. */
export function jobRef(ref: JobRef | Id): JobRef {
  return typeof ref === "string" ? { id: ref } : ref;
}

/**
 * Renders a job as a {@link Progress}.
 *
 * `total` is 100 rather than `undefined` because `progress` is a percentage the
 * server always has: the column is `NOT NULL DEFAULT 0`, so there is no
 * "unknown" to be honest about.
 */
export function jobProgress(job: Job): Progress {
  return {
    phase: "processing",
    loaded: typeof job.progress === "number" ? job.progress : 0,
    total: 100,
    status: job.status,
  };
}

/** Splits a {@link WaitOptions} into the half a single HTTP call understands. */
function requestPartOf(options: WaitOptions): RequestOptions {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  };
}

/** One filter value, as either a scalar or the array form Rails reads. */
function asFilter(value: string | readonly string[]): QueryValue {
  return Array.isArray(value) ? [...value] : (value as string);
}

/**
 * Asks the runtime not to revalidate from its own cache.
 *
 * `GET /jobs` is conditional-GET aware and answers 304 to a matching
 * `If-None-Match`. A browser revalidating behind our back would get that 304,
 * and the transport - which treats anything outside 2xx as a failure - would
 * raise on a body that was simply not resent.
 */
function noRevalidate(headers: Record<string, string> | undefined): Record<string, string> {
  return { "Cache-Control": "no-cache", ...(headers ?? {}) };
}

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted !== true) return;
  throw new OmsTimeoutError(`Stopped waiting for ${label}: the caller aborted.`, { aborted: true });
}

/** Re-labels the transport's bare abort so the message names what was abandoned. */
function aborted(label: string, cause: OmsTimeoutError): OmsTimeoutError {
  return new OmsTimeoutError(`Stopped waiting for ${label}: the caller aborted.`, { aborted: true, cause });
}

/**
 * The client-side deadline, which says nothing about the server: the work is
 * still running and can still be picked up by id later.
 */
function gaveUp(label: string, timeoutMs: number, last: Progress | undefined): OmsTimeoutError {
  const seen = last?.status === undefined ? "" : ` It was last seen "${last.status}".`;
  return new OmsTimeoutError(
    `Gave up waiting for ${label} after ${timeoutMs}ms.${seen} ` +
      `The server is still working on it - poll it later with get(), the run was not cancelled.`,
    { timeoutMs },
  );
}
