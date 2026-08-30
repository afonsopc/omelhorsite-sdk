/**
 * Primitives shared by every namespace of the SDK.
 *
 * Nothing here touches the platform: no `node:*`, no `process`, no `console`.
 * Files are normally values (Blob / Uint8Array / ReadableStream), never paths -
 * the core has no filesystem, and turning a path into a {@link FileInput} is the
 * host's job.
 *
 * React Native is the one exception, and it is the platform's exception rather
 * than a relaxation of ours: a file the user picked there is a
 * {@link NativeFile} descriptor `{ uri, name, type }` whose bytes live behind a
 * `file://` / `content://` / `ph://` URI that only the RN runtime can resolve.
 * It is still not a path the SDK reads - the SDK never reads it. It is handed
 * back to RN's own `FormData`, which resolves it natively while building the
 * multipart body. See {@link FileInput} and {@link NativeFile}.
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
 * A file picked on React Native, exactly as the platform hands it over.
 *
 * This is the shape `expo-file-system`'s picker returns, and it is a
 * DESCRIPTOR, not bytes: the
 * URI is a `file://`, `content://` or `ph://` handle into the device, and
 * nothing in JavaScript can turn it into a `Blob` without a native module.
 *
 * The SDK therefore never reads it. It appends the object VERBATIM to a
 * `FormData`, because RN's `FormData` is not the web one: `getParts()` sees an
 * entry whose value is an object with a `uri` and emits a file part from it,
 * and the native networking layer streams the file off disk while building the
 * multipart body. Handing RN a `Blob` instead is the thing that does not work -
 * on Android it silently uploads an empty or truncated part.
 *
 * The three fields are exactly the three RN reads. `size` is carried because
 * pickers report it and the SDK's own ceilings want it, and it is harmless:
 * RN spreads the object into the part and ignores what it does not know.
 *
 * ## Where it works, and where it does not
 *
 * - `postForm` / any multipart endpoint: yes, on RN. On a web or Bun runtime
 *   the same object is REJECTED with a `TypeError` rather than stringified into
 *   `"[object Object]"`, which is what a plain `FormData.append` would do to it.
 *   See `supportsNativeFormDataFiles` in `http.ts`.
 * - Storage direct upload (`resources/storage/upload.ts`): NO. That path
 *   `PUT`s the bytes to a presigned URL and MD5s them first, and neither is
 *   possible without reading the file. On RN, read it into bytes first (Expo's
 *   `File#bytes()`), or use a native uploader. {@link readFileInput} throws a
 *   message saying so rather than failing at the object store.
 */
export interface NativeFile {
  /** Platform handle to the bytes: `file://`, `content://`, `ph://`. */
  readonly uri: string;
  /** Filename the server should store. RN sends it as the part's `filename`. */
  readonly name: string;
  /**
   * MIME type. Pickers report `""` for some `content://` URIs; fall back to a
   * per-kind constant before it gets here, as the server infers the container
   * format from the part's content type for several of the tools.
   */
  readonly type?: string;
  /** Byte length when the picker reported one. Ignored by RN, used by the SDK. */
  readonly size?: number;
}

/**
 * True when `value` is a {@link NativeFile} descriptor.
 *
 * The test is `uri` and `name` both being strings, which no other form value
 * satisfies: a {@link FileInput} carries `data` + `filename`, and everything
 * else in a form bag is a primitive. Deliberately tolerant of a missing `type`,
 * because a `content://` pick on Android genuinely arrives without one and
 * refusing it would lose the upload over a field RN treats as optional.
 */
export function isNativeFile(value: unknown): value is NativeFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { uri?: unknown; name?: unknown; type?: unknown };
  if (typeof candidate.uri !== "string" || candidate.uri.length === 0) return false;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return false;
  return candidate.type === undefined || typeof candidate.type === "string";
}

/**
 * Bytes handed to the SDK for upload.
 *
 * `data` is a value, never a path - with the one platform exception,
 * {@link NativeFile}, which is a descriptor RN resolves for us and which only
 * works on a multipart endpoint. `filename` is required because the API derives
 * the stored name and, for some tools, the container format from it.
 *
 * `ReadableStream` is accepted for symmetry with the platform, but note that
 * multipart form bodies have to be materialised: {@link readFileInput} buffers
 * a stream into a Blob before it can be appended to a `FormData`. For anything
 * large, prefer the storage direct-upload path, which streams straight to the
 * object store.
 *
 * On React Native there is no need to wrap a picked file in one of these at
 * all: pass the picked `{ uri, name, type }` object straight into the form bag
 * and the transport appends it verbatim. Wrapping it is for the case where the
 * name the server should store differs from the name on the device, in which
 * case `filename` wins and is what RN sends as the part's filename.
 */
export interface FileInput {
  /** The bytes, or a {@link NativeFile} descriptor on React Native. */
  readonly data: Blob | Uint8Array | ReadableStream<Uint8Array> | NativeFile;
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
 *
 * @throws {TypeError} for a {@link NativeFile}. There is no honest Blob to
 *   return: the bytes are behind a device URI that only the RN runtime can
 *   open, and returning an empty Blob would upload an empty file with a 200 on
 *   it. Multipart endpoints never reach here - `buildFormData` appends a native
 *   descriptor verbatim instead - so the throw belongs to the byte-hungry
 *   callers (the storage direct-upload driver, which must also MD5 the body),
 *   and it names the way out rather than just refusing.
 */
export async function readFileInput(input: FileInput): Promise<{ blob: Blob; filename: string; contentType: string }> {
  if (isNativeFile(input.data)) {
    throw new TypeError(
      `Cannot read the bytes of "${input.filename}": it is a React Native file descriptor (${input.data.uri}), ` +
        "and only the RN runtime can resolve that URI. Multipart endpoints (postForm) take it as it is; " +
        "this path needs real bytes, so read the file first (Expo: `new File(uri).bytes()`) and pass the " +
        "Uint8Array, or upload it with a native uploader.",
    );
  }

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
 *
 * A {@link NativeFile} is accepted and needs this only when the server should
 * store a different name than the device used; otherwise pass the picked object
 * straight into the form bag. When wrapped, `filename` and `contentType` are
 * what go on the wire - the descriptor's own `name` and `type` are overridden.
 */
export function file(
  data: Blob | Uint8Array | ReadableStream<Uint8Array> | NativeFile,
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
 *
 * ## What `phase: "upload"` can and cannot promise
 *
 * It ticks once per COMPLETED transfer, never per byte, and that is a property
 * of `fetch` rather than a decision this SDK is free to revisit. No `fetch` -
 * browser, React Native or Worker - exposes request-body progress. XHR is the
 * only API that has ever reported bytes as they leave.
 *
 * There is therefore ONE mechanism in this SDK, not two: `resources/storage/upload.ts`
 * ticks per finished transfer (one per 32 MiB part on the multipart tier, one
 * per file on the direct tier), and a host that wants byte-level granularity
 * hands an XHR-backed {@link FetchLike} to `UploadManagerOptions.fetch` and
 * keeps the rest of the driver. That escape hatch is documented there with a
 * working recipe, and it is available in exactly the runtimes that have XHR:
 *
 * - browser: yes, `xhr.upload.onprogress`;
 * - React Native: yes. RN's own `fetch` is a thin layer over its `XMLHttpRequest`,
 *   and `xhr.upload.onprogress` fires there for both `Blob` and
 *   {@link NativeFile} parts - it is the same event `expo-file-system`'s
 *   uploader surfaces;
 * - Worker isolate: no. There is no XHR, so per-transfer ticks are the ceiling.
 *
 * `supportsUploadProgress()` in `http.ts` answers that question at runtime so a
 * caller can hide a byte-accurate bar rather than let it sit at 0% and jump.
 *
 * The thing not to do is count bytes as they are handed to the runtime: a
 * stream request body reports what was buffered, not what was acknowledged,
 * which is the lie that parks a bar at 100% for a minute. It also breaks the
 * presigned PUTs outright - see the module note in `storage/upload.ts`.
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
   * Deadline in milliseconds for ONE ATTEMPT. Overrides the client default.
   * `0` disables it.
   *
   * Not the deadline for the whole call: the transport starts a fresh one per
   * attempt, so a call that retries can take up to `maxAttempts` times this
   * plus the backoff between them (and a `429` waits out `Retry-After`, which
   * this API sets from a one-minute window). To bound the wall clock, pass a
   * {@link RequestOptions.signal} you abort yourself, or `retry: false`.
   *
   * The deadline covers getting a response, not draining it: it is disposed as
   * soon as the headers arrive, which is what lets `raw()` and `streamText()`
   * hold a stream open for longer than `timeoutMs`. A stream needs its own
   * silence limit instead - `streamText` has one.
   */
  readonly timeoutMs?: number;
  /** Extra request headers. Merged over the client's, under `Authorization`. */
  readonly headers?: Record<string, string>;
  /**
   * Per-call retry override, and the ONLY way to put a mutating request in
   * scope for a retry.
   *
   * By default only safe methods are replayed after an ambiguous failure (a
   * torn connection, a 5xx); a `POST` is not, because a replay after a lost
   * answer is how one create becomes two records. Passing an object here -
   * `{}` is enough, it inherits {@link DEFAULT_RETRY} - says you have looked at
   * this specific endpoint and decided a duplicate is acceptable.
   *
   * `false` disables retrying completely, `429` included. Pass it for a call
   * that mints something under a fresh random identifier per attempt (a short
   * link, a notepad, a chest): a retry there does not duplicate the answer, it
   * leaves an orphan behind and hands you the wrong one.
   *
   * See the retry policy documented on `ApiClient`.
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
 * One value in a query string.
 *
 * Nested objects and arrays are encoded the way the API reads them
 * (`search[status]=open`, `ids[]=1&ids[]=2`). Three values do NOT encode
 * literally, and `encodeQuery` in `http.ts` carries the full argument:
 *
 * - `undefined` is dropped. It means "I am not filtering on this column".
 * - `null` is sent as the API's `\b` null sentinel and is read as SQL `NULL`.
 *   It means "filter where this column IS NULL". The two are not
 *   interchangeable, and getting them the wrong way round is the difference
 *   between one folder and somebody's entire tree.
 * - a `Date` is sent as its ISO-8601 string, which is the only shape the date
 *   filters parse.
 */
export type QueryValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | QueryValue[]
  | { [key: string]: QueryValue };

/** A bag of query parameters. */
export type QueryParams = Record<string, QueryValue>;

/**
 * Hard ceiling the API applies to a page size.
 *
 * The server clamps silently, so asking for 1200 returns 500 rows and no
 * indication that a ceiling was hit. The SDK
 * therefore clamps to the same number BEFORE the request, so that the size it
 * reports back in {@link Paginated.pageSize} is the size the rows were actually
 * counted against. See {@link resolvePageSize}.
 */
export const MAX_PAGE_SIZE = 500;

/**
 * Page size the SDK asks for when the caller says nothing.
 *
 * Deliberately below {@link MAX_PAGE_SIZE}: a `list()` is usually the first
 * screen of something, and 500 rows of expanded records is a slow first paint.
 * Note this is NOT the server's own default - a request with no page modifier
 * at all gets 500 - but the SDK always sends one.
 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Normalises a requested page size into the one the server will actually use.
 *
 * Two different failures are handled differently on purpose:
 *
 * - **above the ceiling** is clamped, not rejected. The request still succeeds
 *   and paging still reaches every row, so failing it would break a working
 *   call for nothing. What must not happen is the caller being told it got the
 *   size it asked for: that is how `pageSize: 1200` yielded 500 items and
 *   `hasMore: false`, dropping 700 rows without a word.
 * - **not a usable size at all** (`NaN`, `Infinity`, zero, negative) throws.
 *   There is nothing sensible to clamp such a value to, and it is not merely
 *   wrong on the client: `pageModifier` would put `"1:NaN"` on the wire, the
 *   server reads that as size `0`, skips pagination, and the endpoint answers
 *   with the WHOLE table. A typo would turn a listing into an unbounded scan.
 *
 * @throws {TypeError} when `pageSize` is not a finite number of at least 1.
 */
export function resolvePageSize(pageSize: number = DEFAULT_PAGE_SIZE): number {
  if (!Number.isFinite(pageSize) || Math.trunc(pageSize) < 1) {
    throw new TypeError(
      `pageSize must be a finite number of at least 1, got ${String(pageSize)}. ` +
        "A page size the server cannot parse disables its pagination entirely and returns the full table.",
    );
  }
  return Math.min(MAX_PAGE_SIZE, Math.trunc(pageSize));
}

/**
 * Normalises a requested page number. Pages are 1-based on the server
 * (`offset = (number - 1) * size`), so page `0` is page 1 - and a
 * {@link Paginated} that reported `page: 0` would fetch page 1 twice.
 *
 * @throws {TypeError} when `page` is not a finite number.
 */
export function resolvePageNumber(page: number = 1): number {
  if (!Number.isFinite(page)) {
    throw new TypeError(`page must be a finite number, got ${String(page)}.`);
  }
  return Math.max(1, Math.trunc(page));
}

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
  /**
   * Items per page. Defaults to {@link DEFAULT_PAGE_SIZE}.
   *
   * {@link MAX_PAGE_SIZE} is the ceiling and it is enforced on both sides: ask
   * for more and you get the ceiling, with {@link Paginated.pageSize} reporting
   * the size you actually got rather than the one you asked for. To read more
   * than 500 rows, page through them - `collect` and `pages` do it for you.
   *
   * A size the server could not parse is NOT clamped, it throws: `0`, a
   * negative, `NaN` and `Infinity` all raise a `TypeError` before the request
   * is built. This is deliberate and it is not defensive tidiness. `"1:NaN"`
   * on the wire is read as size zero and disables pagination, so the endpoint
   * answers with the WHOLE table: one typo turns a listing into an unbounded
   * scan. Failing at the call site is the only place that mistake is still
   * cheap.
   *
   * Narrower than 0.2.0, which clamped `0` to 1 and let `NaN` through onto
   * the wire. See {@link resolvePageSize}.
   */
  readonly pageSize?: number;
  /**
   * `"column:asc"` or `"column:desc"`, sent as `modifiers[order]`. `null` sends
   * none at all, not even a resource's default, which is what a caller relying
   * on the server's own base order wants.
   */
  readonly order?: string | null;
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
  /**
   * The page size the server actually applied, which is NOT necessarily the
   * one that was requested: it is clamped to {@link MAX_PAGE_SIZE}. Read this
   * rather than the number you passed in - they differ exactly when the
   * difference matters.
   */
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
 *
 * @throws {TypeError} when `pageSize` is not a finite number of at least 1, or
 *   `page` is not finite. Both go through {@link resolvePageSize} /
 *   {@link resolvePageNumber}, which reject rather than clamp - see
 *   {@link PageParams.pageSize} for why an unparseable size is dangerous
 *   enough to be worth a throw.
 */
export function createPage<T>(items: T[], page: number, pageSize: number, load: PageLoader<T>): Paginated<T> {
  // The EFFECTIVE size decides everything, because it is what the server
  // counted the rows against. Comparing `items.length` to a requested 1200
  // when the server capped the query at 500 makes a full page look like a
  // short one: `hasMore` says false, `next()` returns null, and the 700 rows
  // behind it are lost with no error anywhere. Both sides of the comparison
  // now come through resolvePageSize, so they cannot drift apart.
  const size = resolvePageSize(pageSize);
  const number = resolvePageNumber(page);
  const hasMore = items.length >= size;
  return {
    items,
    page: number,
    pageSize: size,
    hasMore,
    async next(): Promise<Paginated<T> | null> {
      if (!hasMore) return null;
      const nextPage = number + 1;
      const nextItems = await load({ page: nextPage, pageSize: size });
      if (nextItems.length === 0) return null;
      return createPage(nextItems, nextPage, size, load);
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
 * These are the five strings the API uses, spelled exactly as it spells
 * them: `"complete"` and `"canceled"`, not `"completed"` and
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
