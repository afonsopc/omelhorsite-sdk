/**
 * The transport. Every request the SDK makes goes through {@link ApiClient}.
 *
 * Isolate-safe by construction: it imports nothing, reads no environment, and
 * calls `fetch`, `AbortController`, `FormData`, `Blob` and `setTimeout` only -
 * all of which a Cloudflare Worker provides. `fetch` itself is injected, so a
 * host can wrap it (proxy, cache, test double) without patching a global.
 */

import {
  OmsNetworkError,
  OmsTimeoutError,
  apiErrorFromResponse,
  parseRetryAfter,
  toOmsError,
} from "./errors";
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RETRY,
  type FetchLike,
  type FileInput,
  type FileOutput,
  type QueryParams,
  type QueryValue,
  type RequestOptions,
  type ResolvedRetry,
  type RetryOptions,
  readFileInput,
  resolvePageNumber,
  resolvePageSize,
} from "./types";

/** Production API root. Override only for a local backend or a test double. */
export const DEFAULT_BASE_URL = "https://backend.omelhorsite.pt";

/**
 * Supplies the bearer token for each request.
 *
 * Implementations live in `auth/tokens.ts`. The transport never stores a token
 * itself: it asks the provider on every request, so a refresh that happened
 * elsewhere is picked up without rebuilding the client.
 */
export interface TokenProvider {
  /**
   * Current access token, or `null` when the caller is anonymous. May be async
   * so an implementation can refresh an expired token before answering.
   */
  getToken(): string | null | Promise<string | null>;
  /**
   * Called once when the API answers 401 with the token this provider just
   * gave. An implementation that can refresh should do so and return `true`;
   * the transport then retries the request exactly once. Returning `false` (or
   * not implementing this) lets the {@link OmsAuthError} propagate.
   */
  onUnauthorized?(): boolean | Promise<boolean>;
}

/** Anything accepted where a token is expected. */
export type TokenLike = string | TokenProvider | (() => string | null | Promise<string | null>) | null | undefined;

/** Constructor options for {@link ApiClient}. */
export interface ApiClientOptions {
  /** API root. Defaults to {@link DEFAULT_BASE_URL}. */
  readonly baseUrl?: string;
  /** Injected fetch. Defaults to the ambient `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Where the bearer token comes from. */
  readonly tokens?: TokenProvider;
  /**
   * Authenticate with the browser's `oms_session` cookie instead of a token.
   *
   * FOR A FIRST-PARTY PAGE ONLY, and never the default. The cookie is httpOnly
   * precisely so that no JavaScript can read the session token; a page served
   * from omelhorsite.pt asks the browser to attach it, and the token itself
   * stays out of reach of any script on the page.
   *
   * That is also why this has to be asked for by name. Left off, an SDK call is
   * authenticated by the token it was handed and by nothing else, so a page
   * that embeds the SDK cannot act as whoever happens to be signed in. Turning
   * it on is a statement that this code IS the first-party app.
   *
   * Requires a same-site page: the cookie is host-only on the API host, so a
   * page anywhere else gets an unauthenticated request, not an error.
   */
  readonly sessionCookie?: boolean;
  /** Headers merged into every request, below per-call headers. */
  readonly headers?: Record<string, string>;
  /** Default deadline for one call, retries included. `0` disables it. */
  readonly timeoutMs?: number;
  /**
   * Shape of the default backoff: how many attempts, how long between them.
   *
   * It does not widen WHICH requests are eligible - that stays "safe methods,
   * plus a 429 on anything". Only a per-call `retry` can put a mutator in
   * scope. `false` turns retrying off completely, for every method and every
   * status. See the retry policy on {@link ApiClient}.
   */
  readonly retry?: RetryOptions | false;
  /**
   * Value for the `X-Oms-Client` header, e.g. `"oms-cli/0.3.1"`. The SDK does
   * not touch `User-Agent`: browsers forbid setting it and it tells us nothing
   * a dedicated header does not.
   */
  readonly clientName?: string;
}

/** Body accepted by `post`/`patch`. `undefined` sends no body at all. */
export type JsonBody = unknown;

/** One field of a multipart form. */
export type FormFieldValue = string | number | boolean | FileInput | null | undefined;

/**
 * Fields of a multipart form. An array value is appended once per entry with a
 * `[]` suffix, which is how Rails reads a list (`clips[]`).
 */
export type FormFields = Record<string, FormFieldValue | FormFieldValue[]>;

/** Options for a request that carries a query string. */
export interface GetOptions extends RequestOptions {
  readonly query?: QueryParams;
}

/**
 * HTTP client for the omelhorsite API.
 *
 * ## Retry policy
 *
 * What may be retried depends on WHY the attempt failed and on WHICH method
 * made it, because those two together decide whether a replay can duplicate
 * work the server already did:
 *
 * | outcome                              | GET / HEAD | POST / PATCH / PUT / DELETE |
 * | ------------------------------------ | ---------- | --------------------------- |
 * | `fetch` rejection (DNS, TLS, reset)  | retried    | **not** retried             |
 * | `5xx`                                | retried    | **not** retried             |
 * | `429`                                | retried    | retried                     |
 * | every other `4xx`                    | fails      | fails                       |
 *
 * The first two rows are ambiguous: a reset connection and a 502 from a proxy
 * both mean "no usable answer", never "nothing happened". A `POST` that the
 * server committed before the response was lost is indistinguishable from one
 * it never saw, so replaying it is how one `create` call becomes two records.
 * Safe methods carry no such risk, which is the whole reason the split exists.
 *
 * `429` is the exception, and it is safe on every method because of how this
 * particular backend produces one. It comes either from `Rack::Attack`, which
 * answers from middleware before the router is reached, or from a
 * `too_many_requests!` guard that every controller places BEFORE the write it
 * protects. A 429 is therefore proof the request was refused rather than
 * performed, and waiting out `Retry-After` and trying again is exactly right.
 *
 * ## Opting a mutator back in
 *
 * Pass a `retry` object AT THE CALL SITE and it applies whatever the method:
 *
 * ```ts
 * await oms.tools.downloader.create(input, { retry: {} });  // POST, retried
 * ```
 *
 * A client-wide `new Oms({ retry })` deliberately does NOT do this. It sets the
 * SHAPE of the backoff (attempts, delays, jitter) for whatever is eligible; it
 * is not a statement about any one endpoint, and "every POST in this process
 * may be replayed" is not a decision anybody makes correctly in a constructor.
 * `retry: false` still disables everything, `429` included, and stays the right
 * answer for a call whose failure mode is minting something (a short link, a
 * notepad) under a fresh random identifier on each attempt.
 *
 * This is narrower than the SDK's 0.2.0 behaviour, which retried 5xx on every
 * verb. Nothing in `resources/` relied on that: every call site that mentions
 * retry is turning it OFF.
 */
export class ApiClient {
  /** API root with no trailing slash. */
  readonly baseUrl: string;

  private readonly fetchImpl: FetchLike;
  private readonly tokens: TokenProvider | undefined;
  private readonly sessionCookie: boolean;
  private readonly baseHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retry: ResolvedRetry | false;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

    const injected = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof injected !== "function") {
      throw new OmsNetworkError(
        "No fetch implementation available. Pass one to the Oms constructor: new Oms({ fetch }).",
      );
    }
    // Unbind from the client so a host `fetch` that checks its receiver still works.
    this.fetchImpl = (input, init) => injected(input, init);

    if (options.sessionCookie && options.tokens) {
      throw new TypeError(
        "Pass either `sessionCookie` or a token, not both: two credentials on one request means the server decides which identity wins, and the caller cannot tell which one it got.",
      );
    }
    this.tokens = options.tokens;
    this.sessionCookie = options.sessionCookie ?? false;
    this.baseHeaders = { ...(options.headers ?? {}) };
    if (options.clientName) this.baseHeaders["X-Oms-Client"] = options.clientName;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retry = options.retry === false ? false : resolveRetry(options.retry);
  }

  /** `GET`, parsed as JSON. */
  get<T>(path: string, options: GetOptions = {}): Promise<T> {
    return this.requestJson<T>("GET", path, { ...options, body: undefined });
  }

  /** `POST` with a JSON body, parsed as JSON. */
  post<T>(path: string, body?: JsonBody, options: GetOptions = {}): Promise<T> {
    return this.requestJson<T>("POST", path, { ...options, body });
  }

  /** `PATCH` with a JSON body, parsed as JSON. */
  patch<T>(path: string, body?: JsonBody, options: GetOptions = {}): Promise<T> {
    return this.requestJson<T>("PATCH", path, { ...options, body });
  }

  /** `PUT` with a JSON body, parsed as JSON. */
  put<T>(path: string, body?: JsonBody, options: GetOptions = {}): Promise<T> {
    return this.requestJson<T>("PUT", path, { ...options, body });
  }

  /**
   * `DELETE`, parsed as JSON. The API answers `204 No Content` for most
   * destroys, which arrives here as `undefined`; type such calls as
   * `delete<void>(...)`.
   */
  delete<T>(path: string, options: GetOptions = {}): Promise<T> {
    return this.requestJson<T>("DELETE", path, { ...options, body: undefined });
  }

  /**
   * `POST` a `multipart/form-data` body, parsed as JSON. Use this for every
   * endpoint that takes an upload through Rails (the tools). Storage uploads
   * do NOT go through here - they are presigned and go straight to the object
   * store; see `resources/storage/upload.ts`.
   *
   * A {@link FileInput} carrying a `ReadableStream` is buffered into memory
   * before it can be appended, because `FormData` has no streaming entry.
   */
  async postForm<T>(path: string, fields: FormFields, options: GetOptions = {}): Promise<T> {
    const form = await buildFormData(fields);
    // Content-Type is deliberately not set: the runtime must add the boundary.
    return this.requestJson<T>("POST", path, { ...options, body: form, isFormData: true });
  }

  /**
   * Escape hatch: performs the request and hands back the raw `Response`
   * without reading it, so a caller can stream (`response.body`) a zip, a
   * media file or an SSE endpoint. Retry and auth still apply.
   *
   * The caller owns the body and must consume or cancel it.
   */
  async raw(method: string, path: string, options: GetOptions & { body?: BodyInit } = {}): Promise<Response> {
    return this.send(method, path, {
      ...options,
      body: options.body,
      parse: false,
    });
  }

  /**
   * `GET` that reads the whole response as a {@link FileOutput}, taking the
   * filename from `Content-Disposition` when the server sent one.
   */
  async download(path: string, options: GetOptions = {}): Promise<FileOutput> {
    const response = await this.raw("GET", path, options);
    const blob = await response.blob();
    return {
      data: blob,
      filename: filenameFromDisposition(response.headers.get("content-disposition")),
      contentType: response.headers.get("content-type") ?? undefined,
      size: blob.size,
    };
  }

  /** Absolute URL for a path, with the query string applied. */
  url(path: string, query?: QueryParams): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const encoded = query ? encodeQuery(query) : "";
    return `${this.baseUrl}${suffix}${encoded ? `?${encoded}` : ""}`;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    options: GetOptions & { body?: JsonBody | FormData; isFormData?: boolean },
  ): Promise<T> {
    const response = await this.send(method, path, { ...options, parse: true });
    return (await readJson(response)) as T;
  }

  /** Performs the request, applying auth, deadline and the retry policy. */
  private async send(
    method: string,
    path: string,
    options: GetOptions & { body?: unknown; isFormData?: boolean; parse: boolean },
  ): Promise<Response> {
    const url = this.url(path, options.query);
    const retry = options.retry === false ? false : options.retry ? resolveRetry(options.retry) : this.retry;
    const maxAttempts = retry === false ? 1 : Math.max(1, retry.maxAttempts);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    // May this attempt be repeated after an outcome that might ALREADY have
    // changed something server side (a torn connection, a 5xx)? Only if the
    // method changes nothing, or if the caller asked for retries on this
    // specific call and thereby accepted the duplicate. A client-wide default
    // does not count: see the retry policy on the class.
    const replayable = isSafeMethod(method) || (options.retry !== undefined && options.retry !== false);

    let refreshed = false;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const deadline = createDeadline(timeoutMs, options.signal);

      let response: Response;
      try {
        response = await this.fetchImpl(url, await this.buildInit(method, options, deadline.signal));
      } catch (thrown) {
        deadline.dispose();
        const failure = classifyFetchFailure(thrown, { method, url, attempts: attempt, timeoutMs, options });
        // A rejected fetch says the ANSWER was lost, not that the request was.
        // The server may well have run it, so only a replayable method tries
        // again; everything else surfaces the network error and lets the caller
        // decide whether a duplicate is acceptable.
        if (failure instanceof OmsNetworkError && attempt < maxAttempts && retry !== false && replayable) {
          await sleep(backoffDelay(attempt, retry), options.signal);
          continue;
        }
        throw failure;
      }
      deadline.dispose();

      if (response.ok) return response;

      // A 401 gets exactly one chance to be a stale token rather than a wrong one.
      if (response.status === 401 && !refreshed && this.tokens?.onUnauthorized) {
        refreshed = true;
        const recovered = await this.tokens.onUnauthorized();
        if (recovered) {
          await discard(response);
          continue;
        }
      }

      const headers = headerRecord(response.headers);
      // 429 needs no `replayable`: this API only ever produces one from
      // Rack::Attack (middleware, before the router) or from a
      // `too_many_requests!` guard placed ahead of the write, so the request
      // provably did not happen. A 5xx carries no such promise.
      const shouldRetry =
        retry !== false &&
        attempt < maxAttempts &&
        (response.status === 429 || (response.status >= 500 && replayable));

      if (!shouldRetry) {
        const body = await readErrorBody(response);
        throw apiErrorFromResponse(response.status, body, { method, url, attempts: attempt, headers });
      }

      // Retry-After is authoritative when the server sent one; otherwise back off.
      const wait = response.status === 429 ? parseRetryAfter(headers["retry-after"]) : undefined;
      await discard(response);
      await sleep(wait ?? backoffDelay(attempt, retry), options.signal);
    }
  }

  private async buildInit(
    method: string,
    options: GetOptions & { body?: unknown; isFormData?: boolean },
    signal: AbortSignal,
  ): Promise<RequestInit> {
    const headers: Record<string, string> = { Accept: "application/json", ...this.baseHeaders, ...(options.headers ?? {}) };

    const token = await this.resolveToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let body: BodyInit | undefined;
    if (options.isFormData || options.body instanceof FormData) {
      body = options.body as FormData;
      // The runtime must set Content-Type so the multipart boundary matches.
      delete headers["Content-Type"];
      delete headers["content-type"];
    } else if (options.body !== undefined) {
      if (typeof options.body === "string" || options.body instanceof Blob || options.body instanceof Uint8Array) {
        body = options.body as BodyInit;
      } else {
        body = JSON.stringify(options.body);
        headers["Content-Type"] = "application/json";
      }
    }

    return {
      method,
      headers,
      signal,
      ...(body === undefined ? {} : { body }),
      // "omit" unless the caller asked for the cookie by name. Cookies belong to
      // the browser session, not to an SDK call: authenticated by the token it
      // was given and nothing else, a page embedding the SDK cannot act as
      // whoever is signed in. `sessionCookie` is the first-party app saying it
      // is the exception. See ApiClientOptions.sessionCookie.
      credentials: this.sessionCookie ? "include" : "omit",
      redirect: "follow",
    };
  }

  private async resolveToken(): Promise<string | null> {
    if (!this.tokens) return null;
    try {
      return (await this.tokens.getToken()) ?? null;
    } catch (thrown) {
      throw toOmsError(thrown);
    }
  }
}

/**
 * Base class for every resource namespace.
 *
 * Resource modules extend this instead of writing their own constructor, so
 * every namespace is built the same way and `client.ts` can instantiate them
 * uniformly.
 */
export abstract class Resource {
  protected readonly http: ApiClient;

  constructor(http: ApiClient) {
    this.http = http;
  }
}

/**
 * The backend's null sentinel: a single backspace character, `U+0008`.
 *
 * A query string has no way to say `null`. `?parent_id=` is the empty string,
 * `?parent_id=null` is the four-letter word "null", and omitting the key
 * entirely says something else again. So the API picked a character no real
 * value ever contains and decodes it back to `nil` on arrival:
 * `CrudActions#define_option_param_getter` runs
 * `value.transform_values! { |v| v == "\b" ? nil : v }` over every filter
 * bucket, and `GroupChatsController`, `GroupChatMessagesController` and
 * `BookServices::Creator` each repeat the same test on the fields they read by
 * hand.
 *
 * Where that `nil` lands is what makes it worth having. `Searchable.exact_search`
 * is `where(params)`, so `exact_search[parent_id]` set to the sentinel becomes
 * `WHERE parent_id IS NULL` - the only way to ask for the storage root nodes,
 * for a comment with no parent, for anything unassigned.
 *
 * Exported because it is part of the wire format, not because you should need
 * it: {@link encodeQuery} writes it for you whenever a query value is `null`.
 */
export const NULL_SENTINEL = "\b";

/**
 * Encodes query parameters the way Rails parses them.
 *
 * - `{ page: 2 }`                     -> `page=2`
 * - `{ ids: ["a", "b"] }`             -> `ids%5B%5D=a&ids%5B%5D=b`
 * - `{ search: { status: "open" } }`  -> `search%5Bstatus%5D=open`
 * - `{ since: new Date(...) }`        -> `since=2026-08-29T09%3A00%3A00.000Z`
 * - `{ parent_id: null }`             -> `parent_id=%08`, the null sentinel
 * - `undefined` values are dropped entirely.
 *
 * ## Why `null` and `undefined` are not the same thing here
 *
 * They are the two answers to two different questions, and a query string can
 * only express one of them without help:
 *
 * - `undefined` means "I am not filtering on this column". Dropping the key is
 *   the correct encoding.
 * - `null` means "filter where this column IS NULL". There is no literal for
 *   that in a URL, so it goes out as {@link NULL_SENTINEL} and the backend
 *   turns it back into `nil`.
 *
 * Encoding `null` as "drop the key" - which this function used to do - is the
 * dangerous direction. The filter simply vanishes and `Searchable.exact_search`
 * returns early (`return self unless params.present?`), so the endpoint answers
 * with the UNFILTERED set: a request for the root of somebody's drive comes
 * back as their entire tree. That failure has bitten this API before, from the
 * other end, and is why `CrudActions#reject_unknown_filter_keys!` now 400s on a
 * key it does not recognise rather than quietly widening the query.
 *
 * The sentinel is written at every depth, even though the server only decodes
 * it one level inside a filter bucket (`search`, `exact_search`, `modifiers`,
 * `extra_options`). Anywhere else it stays the literal character and matches no
 * row - an empty result, which is the safe way to be wrong. Compare that with
 * dropping the key, which is an over-broad result nobody notices.
 *
 * ## Dates
 *
 * A `Date` reaches `typeof value === "object"` like anything else, and
 * `Object.entries(new Date())` is `[]`, so before this branch existed a date
 * filter did not merely arrive malformed - the key disappeared and the listing
 * came back unfiltered. ISO-8601 is what the server reads:
 * `QuerySearcher#date_search` runs `String#to_date_safe` (`Date.parse`) over
 * the value and turns an unparseable one into `nil`, which silently drops that
 * side of the range. Bodies need no equivalent branch, because `JSON.stringify`
 * already calls `Date.prototype.toJSON` and emits the same string.
 *
 * @throws {TypeError} for an invalid `Date`. `toISOString()` would throw a bare
 *   `RangeError` from deep inside the transport; failing loudly at the boundary
 *   beats sending `Invalid Date` and getting an unfiltered page back.
 */
export function encodeQuery(params: QueryParams): string {
  const parts: string[] = [];
  const push = (key: string, value: QueryValue): void => {
    if (value === undefined) return;
    if (value === null) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(NULL_SENTINEL)}`);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) push(`${key}[]`, entry);
      return;
    }
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new TypeError(`Query parameter "${key}" is an invalid Date. Check what produced it before sending it.`);
      }
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value.toISOString())}`);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) push(`${key}[${childKey}]`, childValue);
      return;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };

  for (const [key, value] of Object.entries(params)) push(key, value);
  return parts.join("&");
}

/**
 * Methods whose replay cannot duplicate work, so a lost answer may simply be
 * asked for again.
 *
 * `PUT` and `DELETE` are idempotent by RFC 9110 and are still absent, because
 * idempotent is not the same as harmless to replay HERE. Rails' `destroy` is
 * behind a `find_by` that answers `404` the second time, so a `DELETE` retried
 * after a torn connection reports "not found" for a row it deleted perfectly
 * well - a success turned into an error the caller then acts on.
 */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when {@link SAFE_METHODS} contains `method`, case-insensitively. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Builds the `modifiers[page]` string the backend expects (`"2:100"`).
 *
 * Both halves go through `resolvePageSize` / `resolvePageNumber`, which is the
 * same pair `createPage` uses. That is the point: the size on the wire and the
 * size `Paginated.pageSize` reports have to be one number, or a caller who asks
 * for 1200 gets the server's 500 rows measured against their own 1200 and is
 * told `hasMore: false` while 700 rows sit behind it.
 *
 * @throws {TypeError} for a page size that is not a finite number of at least
 *   1. `"1:NaN"` on the wire reads as size `0` in
 *   `QueryModifier#apply_pagination`, which skips `limit`/`offset` altogether
 *   and returns the entire table.
 */
export function pageModifier(page = 1, pageSize: number = DEFAULT_PAGE_SIZE): string {
  return `${resolvePageNumber(page)}:${resolvePageSize(pageSize)}`;
}

/**
 * Turns a {@link FormFields} bag into a `FormData`, buffering any streams.
 *
 * `null` and `undefined` fields are OMITTED, which is the opposite of what
 * {@link encodeQuery} does with `null` and is right for the same reason it is
 * right there: what the receiver reads from an absent field. A multipart body
 * only ever feeds a create here, and an absent field means `params[:x]` is
 * `nil` - already the value a sentinel would decode to, so writing one would
 * add a step that changes nothing. In a query the absent key means "no filter",
 * which is a different answer entirely.
 *
 * The one thing this cannot express is clearing a column through a multipart
 * UPDATE, where absent means "leave it alone". No endpoint takes one - the SDK
 * sends multipart to the tools and to `POST /books` only - and if one appears,
 * pass {@link NULL_SENTINEL} as the field value explicitly.
 */
export async function buildFormData(fields: FormFields): Promise<FormData> {
  const form = new FormData();

  const append = async (key: string, value: FormFieldValue): Promise<void> => {
    if (value === undefined || value === null) return;
    if (isFileInput(value)) {
      const { blob, filename } = await readFileInput(value);
      form.append(key, blob, filename);
      return;
    }
    form.append(key, String(value));
  };

  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const entry of value) await append(`${key}[]`, entry);
    } else {
      await append(key, value);
    }
  }

  return form;
}

/** Narrows an unknown form value to a {@link FileInput}. */
export function isFileInput(value: unknown): value is FileInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { data?: unknown; filename?: unknown };
  if (typeof candidate.filename !== "string") return false;
  return (
    candidate.data instanceof Blob ||
    candidate.data instanceof Uint8Array ||
    (typeof ReadableStream !== "undefined" && candidate.data instanceof ReadableStream)
  );
}

/** Fills in whatever a partial {@link RetryOptions} left out. */
export function resolveRetry(options: RetryOptions | undefined): ResolvedRetry {
  return {
    maxAttempts: options?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    baseDelayMs: options?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    jitter: options?.jitter ?? DEFAULT_RETRY.jitter,
  };
}

/** Exponential backoff for `attempt` (1-based), with optional jitter. */
export function backoffDelay(attempt: number, retry: ResolvedRetry): number {
  const raw = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  if (!retry.jitter) return raw;
  return Math.round(raw * (0.5 + Math.random()));
}

/**
 * Waits, but wakes early and rejects if the caller's signal aborts. Uses only
 * `setTimeout`, which a Worker isolate provides.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OmsTimeoutError("Aborted by caller", { aborted: true }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OmsTimeoutError("Aborted by caller", { aborted: true }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Combines a deadline with the caller's signal into one signal.
 *
 * Written by hand rather than with `AbortSignal.any` + `AbortSignal.timeout`
 * so the SDK runs on any runtime that has plain `AbortController`.
 */
export function createDeadline(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { signal: AbortSignal; dispose(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let expired = false;

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          expired = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    timedOut(): boolean {
      return expired;
    },
  };
}

/** Response headers as a plain object with lowercased keys. */
export function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Reads a successful response.
 *
 * `204` and an empty body both come back as `undefined`. A non-JSON body is
 * returned as text, because a handful of endpoints answer `text/plain`.
 */
export async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reads an error response without ever throwing on a malformed body. */
export async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await readJson(response);
  } catch {
    return undefined;
  }
}

/** Drains a response we are about to discard, so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Nothing to do: the body is going away regardless.
  }
}

/** Decides whether a `fetch` rejection was an abort, a deadline, or a network fault. */
function classifyFetchFailure(
  thrown: unknown,
  context: { method: string; url: string; attempts: number; timeoutMs: number; options: RequestOptions },
): Error {
  const aborted = isAbortError(thrown);
  if (aborted && context.options.signal?.aborted) {
    return new OmsTimeoutError("Request aborted by caller", {
      aborted: true,
      method: context.method,
      url: context.url,
      attempts: context.attempts,
      cause: thrown,
    });
  }
  if (aborted) {
    return new OmsTimeoutError(`Request timed out after ${context.timeoutMs}ms`, {
      timeoutMs: context.timeoutMs,
      method: context.method,
      url: context.url,
      attempts: context.attempts,
      cause: thrown,
    });
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return new OmsNetworkError(`Network request failed: ${message}`, {
    method: context.method,
    url: context.url,
    attempts: context.attempts,
    cause: thrown,
  });
}

function isAbortError(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null) return false;
  const candidate = thrown as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.name === "TimeoutError" || candidate.code === 20;
}

/**
 * Pulls the filename out of a `Content-Disposition` header, preferring the
 * RFC 5987 `filename*` form when both are present.
 */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;

  const extended = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i.exec(header);
  if (extended?.[3]) {
    try {
      return decodeURIComponent(extended[3].trim());
    } catch {
      return extended[3].trim();
    }
  }

  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];

  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare?.[1]) return bare[1].trim();

  return undefined;
}
