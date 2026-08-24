/**
 * Primitives shared by every namespace of the SDK.
 *
 * Nothing here touches the platform: no `node:*`, no `process`, no `console`.
 * Files are values (Blob / Uint8Array / ReadableStream), never paths - the core
 * has no filesystem. Turning a path into a {@link FileInput} is the CLI's job.
 */

/** Any JSON value the API can send or receive. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A JSON object. */
export type JsonObject = { [key: string]: Json };

/**
 * The fetch implementation the SDK talks through. Injected via the {@link Oms}
 * constructor so the SDK works in a Worker isolate, under a test double, or
 * behind an authenticating proxy.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Bytes handed to the SDK for upload.
 *
 * `data` is a value, never a path. `filename` is required because the API
 * derives the stored name and, for some tools, the container format from it.
 *
 * `ReadableStream` is accepted for symmetry with the platform, but note that
 * multipart form bodies have to be materialised: {@link readFileInput} buffers
 * a stream into a Blob before it can be appended to a `FormData`. For anything
 * large, prefer the storage direct-upload path, which streams straight to the
 * object store and never passes through Rails.
 */
export interface FileInput {
  /** The bytes. */
  readonly data: Blob | Uint8Array | ReadableStream<Uint8Array>;
  /** Name the server should store, e.g. `"take-3.wav"`. Required. */
  readonly filename: string;
  /** MIME type. Defaults to the Blob's own type, then `application/octet-stream`. */
  readonly contentType?: string;
  /**
   * Byte length, when known ahead of time. Lets the SDK pick an upload
   * strategy (multipart above 32 MiB) without buffering the stream first.
   */
  readonly size?: number;
}

/** Bytes handed back by the SDK: a download, a rendered video, a zip. */
export interface FileOutput {
  /** The bytes. */
  readonly data: Blob;
  /** Filename the server suggested, from `Content-Disposition` when present. */
  readonly filename: string | undefined;
  /** MIME type the server reported. */
  readonly contentType: string | undefined;
  /** Byte length of `data`. */
  readonly size: number;
}

/**
 * Normalises a {@link FileInput} into a Blob plus its metadata.
 *
 * Buffers a `ReadableStream` fully - see the note on {@link FileInput}. Uses
 * only platform APIs, so it runs in an isolate.
 */
export async function readFileInput(input: FileInput): Promise<{ blob: Blob; filename: string; contentType: string }> {
  const contentType =
    input.contentType ?? (input.data instanceof Blob && input.data.type ? input.data.type : "application/octet-stream");

  if (input.data instanceof Blob) {
    const blob = input.data.type === contentType ? input.data : new Blob([input.data], { type: contentType });
    return { blob, filename: input.filename, contentType };
  }

  if (input.data instanceof Uint8Array) {
    // Copy through an ArrayBuffer slice so a view over a larger buffer does not
    // leak its neighbours into the upload.
    const bytes = input.data.slice();
    return { blob: new Blob([bytes], { type: contentType }), filename: input.filename, contentType };
  }

  const chunks: Uint8Array[] = [];
  const reader = input.data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return { blob: new Blob(chunks as BlobPart[], { type: contentType }), filename: input.filename, contentType };
}

/**
 * Convenience constructor for a {@link FileInput}. Prefer it over an object
 * literal so the `filename`-is-required rule stays visible at the call site.
 */
export function file(
  data: Blob | Uint8Array | ReadableStream<Uint8Array>,
  filename: string,
  options: { contentType?: string; size?: number } = {},
): FileInput {
  return {
    data,
    filename,
    ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    ...(options.size === undefined ? {} : { size: options.size }),
  };
}

/**
 * Progress report for a long operation.
 *
 * `total` is `undefined` whenever the size is genuinely unknown (a stream
 * upload, a server-side render with no ETA). Do not fake it with a guess.
 */
export interface Progress {
  /** What is happening right now. */
  readonly phase: "upload" | "processing" | "download";
  /** Units done so far - bytes for transfers, arbitrary ticks for processing. */
  readonly loaded: number;
  /** Total units, when known. */
  readonly total: number | undefined;
  /** Server-reported status string, when the endpoint has one (`"pending"`, `"rendering"`). */
  readonly status?: string;
}

/** Called repeatedly while a long operation runs. Must never throw. */
export type ProgressCallback = (progress: Progress) => void;

/** Options every SDK method accepts as its last argument. */
export interface RequestOptions {
  /**
   * Caller-owned cancellation. Aborting raises an {@link OmsTimeoutError} with
   * `code === "aborted"`.
   */
  readonly signal?: AbortSignal;
  /**
   * Deadline in milliseconds for the whole call, retries included. Overrides
   * the client default. `0` disables the deadline.
   */
  readonly timeoutMs?: number;
  /** Extra request headers. Merged over the client's, under `Authorization`. */
  readonly headers?: Record<string, string>;
  /**
   * Per-call retry override. `false` disables retries entirely - pass it for
   * any non-idempotent create you would rather see fail than duplicate.
   */
  readonly retry?: RetryOptions | false;
}

/** Options for a method that both uploads and waits. */
export interface OperationOptions extends RequestOptions {
  /** Called as bytes move and as the server-side job advances. */
  readonly onProgress?: ProgressCallback;
}

/** Backoff configuration. See {@link DEFAULT_RETRY}. */
export interface RetryOptions {
  /** Total attempts including the first. `1` disables retrying. */
  readonly maxAttempts?: number;
  /** First backoff step in milliseconds; doubles each attempt. */
  readonly baseDelayMs?: number;
  /** Ceiling for a single backoff step. */
  readonly maxDelayMs?: number;
  /** Randomise each delay in `[0.5x, 1.5x]` to avoid a thundering herd. */
  readonly jitter?: boolean;
}

/** Fully-resolved backoff configuration. */
export interface ResolvedRetry {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
}

/** Defaults applied when a caller says nothing about retrying. */
export const DEFAULT_RETRY: ResolvedRetry = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 20_000,
  jitter: true,
});

/**
 * Query parameters. Nested objects and arrays are encoded the way Rails reads
 * them (`search[status]=open`, `ids[]=1&ids[]=2`) - see `encodeQuery` in
 * `http.ts`. `undefined` and `null` values are dropped, not sent as empty.
 */
export type QueryValue = string | number | boolean | null | undefined | QueryValue[] | { [key: string]: QueryValue };

/** A bag of query parameters. */
export type QueryParams = Record<string, QueryValue>;

/**
 * Paging arguments accepted by every `list()` method.
 *
 * The backend pages with a single `modifiers[page]=<number>:<size>` string and
 * caps `size` at 500. It does NOT return a total count, which is why
 * {@link Paginated} has `hasMore` and no `total`.
 */
export interface PageParams {
  /** 1-based page number. Defaults to 1. */
  readonly page?: number;
  /** Items per page. Server maximum is 500. */
  readonly pageSize?: number;
  /** `"column:asc"` or `"column:desc"`, passed through as `modifiers[order]`. */
  readonly order?: string;
}

/**
 * One page of a listing.
 *
 * There is no `total`: the API answers index requests with a bare JSON array
 * and no count, so a total would be a lie. `hasMore` is inferred from the page
 * having come back full, which means the last page can report `hasMore: true`
 * once and then yield an empty page. Iterate with {@link collect} or
 * {@link pages} rather than trusting `hasMore` as an exact count.
 */
export interface Paginated<T> {
  /** The items on this page. */
  readonly items: T[];
  /** 1-based number of this page. */
  readonly page: number;
  /** Page size that was requested. */
  readonly pageSize: number;
  /** True when this page came back full, so another page may exist. */
  readonly hasMore: boolean;
  /** Fetches the following page, or resolves to `null` when there is none. */
  next(): Promise<Paginated<T> | null>;
}

/** Loads one page. Given to {@link createPage} by a resource's `list()`. */
export type PageLoader<T> = (params: Required<Pick<PageParams, "page" | "pageSize">>) => Promise<T[]>;

/**
 * Builds a {@link Paginated} from the raw array the API returned plus the
 * loader that can fetch the next page. Resource modules use this instead of
 * hand-rolling the shape.
 */
export function createPage<T>(items: T[], page: number, pageSize: number, load: PageLoader<T>): Paginated<T> {
  const hasMore = items.length >= pageSize && pageSize > 0;
  return {
    items,
    page,
    pageSize,
    hasMore,
    async next(): Promise<Paginated<T> | null> {
      if (!hasMore) return null;
      const nextPage = page + 1;
      const nextItems = await load({ page: nextPage, pageSize });
      if (nextItems.length === 0) return null;
      return createPage(nextItems, nextPage, pageSize, load);
    },
  };
}

/** Walks every page of a listing, yielding one page at a time. */
export async function* pages<T>(first: Paginated<T>): AsyncGenerator<Paginated<T>, void, undefined> {
  let current: Paginated<T> | null = first;
  while (current !== null) {
    yield current;
    current = await current.next();
  }
}

/**
 * Walks every page and returns every item.
 *
 * @param limit Stop once this many items are collected. Always pass one when
 *   the listing could be unbounded; the caller, not the server, owns the cap.
 */
export async function collect<T>(first: Paginated<T>, limit = Number.POSITIVE_INFINITY): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages(first)) {
    for (const item of page.items) {
      out.push(item);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Identifier of a record. The API uses opaque random strings, not integers, so
 * never do arithmetic on one and never assume it sorts by creation.
 */
export type Id = string;

/** ISO-8601 timestamp string, as the API sends it. */
export type Timestamp = string;

/** Fields present on essentially every record the API returns. */
export interface BaseRecord {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/**
 * A daily quota answer. Every metered tool exposes one, but the unit differs
 * (seconds for audio, edits for jumpstyle), so the concrete resource narrows
 * this with its own interface.
 */
export interface QuotaStatus {
  /** Whether the caller was recognised. Anonymous callers get a smaller quota. */
  readonly authenticated: boolean;
  /** `true` when the account has no ceiling; the numeric fields are then meaningless. */
  readonly unlimited: boolean;
}

/**
 * How a long-running server-side job reports itself.
 *
 * These are the five strings `Job::STATUSES` holds, spelled exactly as the
 * backend spells them: `"complete"` and `"canceled"`, not `"completed"` and
 * `"cancelled"`. Compare against `JOB_STATUS` / `isJobTerminal` from the jobs
 * namespace rather than against a literal you typed from memory - a wait loop
 * that tests for `"completed"` never ends.
 */
export type JobStatus = "pending" | "processing" | "complete" | "failed" | "canceled";

/** Options for the SDK helpers that poll a job to completion. */
export interface WaitOptions extends RequestOptions {
  /** Called on each poll with the job's current state. */
  readonly onProgress?: ProgressCallback;
  /** Milliseconds between polls. Defaults to a bounded, backing-off interval. */
  readonly pollIntervalMs?: number;
  /** Give up after this long. Distinct from `timeoutMs`, which bounds one HTTP call. */
  readonly waitTimeoutMs?: number;
}
