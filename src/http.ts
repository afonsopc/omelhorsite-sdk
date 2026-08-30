/**
 * The transport. Every request the SDK makes goes through {@link ApiClient}.
 *
 * Isolate-safe by construction: it imports nothing, reads no environment, and
 * calls `fetch`, `AbortController`, `FormData`, `Blob` and `setTimeout` only -
 * all of which a Cloudflare Worker provides. `fetch` itself is injected, so a
 * host can wrap it (proxy, cache, test double) without patching a global.
 *
 * ## Three runtimes, and where they stop agreeing
 *
 * The same transport runs in a browser, in React Native and in Bun or a Worker
 * isolate. They agree on `fetch`, `AbortController`, `Headers`, `FormData` and
 * `setTimeout`. They do NOT agree on three things, each of which has a named
 * capability check here rather than a `try` and a shrug:
 *
 * | capability                        | browser | React Native | Worker / Bun |
 * | --------------------------------- | ------- | ------------ | ------------ |
 * | `supportsResponseStreaming()`     | yes     | **no**       | yes          |
 * | `supportsUploadProgress()` (XHR)  | yes     | yes          | **no**       |
 * | `supportsNativeFormDataFiles()`   | no      | **yes**      | no           |
 *
 * Read them at the point of use, not once at module load: a host may install a
 * polyfill after the SDK is imported, and in RN the fetch implementation is
 * swapped by libraries often enough that a cached answer goes stale.
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
  type NativeFile,
  type QueryParams,
  type QueryValue,
  type RequestOptions,
  type ResolvedRetry,
  type RetryOptions,
  isNativeFile,
  readFileInput,
  resolvePageNumber,
  resolvePageSize,
} from "./types";

/** Production API root. Override only for a local backend or a test double. */
export const DEFAULT_BASE_URL = "https://backend.omelhorsite.pt";

/**
 * What the runtime this code woke up in can actually do.
 *
 * Answered by probing the globals, never by sniffing a platform name, and
 * recomputed on every call so a polyfill installed after import is seen. See
 * the table in the module note for how the three runtimes score.
 */
export interface TransportCapabilities {
  /** `fetch` hands back a readable body that can be consumed as it arrives. */
  readonly responseStreaming: boolean;
  /** `XMLHttpRequest` is present, so byte-level upload progress is reachable. */
  readonly uploadProgress: boolean;
  /** `FormData` is React Native's, so a {@link NativeFile} can be appended. */
  readonly nativeFormDataFiles: boolean;
}

/** All three capability probes at once. */
export function transportCapabilities(): TransportCapabilities {
  return {
    responseStreaming: supportsResponseStreaming(),
    uploadProgress: supportsUploadProgress(),
    nativeFormDataFiles: supportsNativeFormDataFiles(),
  };
}

/**
 * Whether a response body can be read INCREMENTALLY on this runtime.
 *
 * This is the question a caller has to answer before it offers a token-by-token
 * UI, and it has a hard "no" on React Native. RN's `fetch` is its
 * `XMLHttpRequest` with a whatwg-fetch shim over it: the whole body is
 * accumulated by the native layer and handed over at the end, `response.body`
 * is `undefined`, and there is no `ReadableStream` in the runtime at all.
 *
 * That is not a gap to polyfill. Nothing that runs in JS can make the native
 * networking layer emit partial bodies, and the shims that claim to (RN's
 * `textStreaming` blob response type, `react-native-fetch-api`) either need
 * `XMLHttpRequest`'s `onprogress` plumbed by hand or a different fetch
 * altogether. Which is why this is a capability check and not a feature.
 *
 * ## What a caller does with the answer
 *
 * Pick a PRESENTATION, not a protocol. Both paths hit the same endpoint and
 * read the same bytes; the difference is whether they arrive in pieces:
 *
 * ```ts
 * if (supportsResponseStreaming()) {
 *   for await (const chunk of oms.http.streamText("POST", path, { body })) render(chunk);
 * } else {
 *   const whole = await oms.http.raw("POST", path, { body }).then((r) => r.text());
 *   render(whole);                       // one paint, after the server is done
 * }
 * ```
 *
 * {@link ApiClient.streamText} already contains that fork, so the usual answer
 * is to call it and use this only to decide what the UI PROMISES: a typing
 * indicator that never types is worse than a spinner that admits it is waiting.
 *
 * The typical consumer reads an SSE-shaped body (`data: {"delta": "..."}`
 * lines) off `POST /books/:id/chat`. Framing the lines is the caller's job;
 * this and `streamText` only promise decoded text in order.
 *
 * The three probes are all needed. `ReadableStream` existing does not mean
 * `fetch` produces one (a polyfilled global over RN's fetch is exactly that
 * case), `Response.prototype` having `body` does not mean it is non-null on a
 * given response - `streamText` still checks the instance - and `TextDecoder`
 * is what turns the chunks into text on the way out.
 */
export function supportsResponseStreaming(): boolean {
  if (typeof ReadableStream !== "function") return false;
  if (typeof TextDecoder !== "function") return false;
  if (typeof Response !== "function") return false;
  const proto = Response.prototype as object | undefined;
  if (!proto) return false;
  // `body` is an accessor on the prototype in every runtime that has it, and
  // absent entirely in RN's shim. `in` sees the accessor without invoking it.
  return "body" in proto;
}

/**
 * Whether `XMLHttpRequest` is available, which is the only route to byte-level
 * UPLOAD progress on any runtime.
 *
 * True in a browser and in React Native (RN's networking is XHR underneath and
 * `xhr.upload.onprogress` fires there); false in a Worker-class isolate and in
 * Bun's server runtime. See {@link Progress} for the whole argument and
 * `UploadManagerOptions.fetch` for the recipe - this only reports whether that
 * recipe can be used here, so a UI can decide between a real bar and a
 * per-file tick.
 *
 * The SDK never uses XHR itself. It cannot: the core has to load in an isolate.
 */
export function supportsUploadProgress(): boolean {
  const xhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  return typeof xhr === "function";
}

/**
 * Whether this runtime's `FormData` accepts a {@link NativeFile} descriptor.
 *
 * React Native's `FormData` is not the web one. `append(name, value)` stores
 * the value as it is, and `getParts()` later reads `value.uri`, `value.name`
 * and `value.type` off it to build a file part that the native layer streams
 * from disk. The web `FormData` instead coerces any non-`Blob` to a string, so
 * the same object silently becomes the literal text `"[object Object]"` in a
 * text field - a 200 response and an upload that never happened.
 *
 * Detected by the presence of `getParts` on the prototype, with
 * `navigator.product === "ReactNative"` as the second opinion. Not by a
 * `Platform.OS` import, which would drag `react-native` into a package that has
 * to load in a Worker.
 */
export function supportsNativeFormDataFiles(): boolean {
  const product = (globalThis as { navigator?: { product?: unknown } }).navigator?.product;
  if (product === "ReactNative") return true;
  if (typeof FormData !== "function") return false;
  const proto = FormData.prototype as unknown as { getParts?: unknown };
  return typeof proto?.getParts === "function";
}

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
  /**
   * Default deadline for ONE ATTEMPT, not for the whole call. `0` disables it.
   *
   * Each attempt gets a fresh one, so a call that retries can take up to
   * `maxAttempts` times this plus the backoff. It also stops at the response
   * headers rather than at the last byte, which is what lets `raw()` and
   * `streamText()` hold a body open for longer. See {@link RequestOptions.timeoutMs}.
   */
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

/**
 * One field of a multipart form.
 *
 * {@link NativeFile} is here so that a React Native caller can pass the object
 * its picker returned straight through - `form.image = picked` - without
 * wrapping it. It is appended verbatim on RN and rejected loudly elsewhere; see
 * {@link buildFormData}.
 */
export type FormFieldValue = string | number | boolean | FileInput | NativeFile | null | undefined;

/**
 * Fields of a multipart form. An array value is appended once per entry with a
 * `[]` suffix (`clips[]`), which is how the API reads a list.
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
 * `429` is the exception, and it is safe on every method because this API only
 * ever answers one BEFORE performing the request: a rate-limited request is
 * refused, never carried out. A 429 is therefore proof the request was refused
 * rather than performed, and waiting out `Retry-After` and trying again is
 * exactly right.
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
 * verb.
 *
 * ## Rate limits and wall clock
 *
 * A retried `429` obeys `Retry-After`, this API sets it from a one-minute
 * window, and `timeoutMs` bounds ONE attempt rather than the call. A
 * rate-limited call can therefore take minutes of wall clock. A UI with a
 * person watching it may rather show "slow down" at once than sit on a hidden
 * sleep: pass a `signal` it can abort, turn retrying off per call with
 * `retry: false`, or cap it at the client with
 * `new Oms({ retry: { maxAttempts: 2 } })` - one extra attempt, safe methods
 * only.
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
   * endpoint that takes a multipart upload (the tools). Storage uploads
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
   *
   * `response.body` is NOT a promise this method can make: React Native has no
   * `ReadableStream` and leaves it undefined, so any code reaching for
   * `.body.getReader()` here works in a browser and in Bun and throws on a
   * phone. Test with {@link supportsResponseStreaming} first, or use
   * {@link ApiClient.streamText}, which contains that fork already.
   */
  async raw(method: string, path: string, options: GetOptions & { body?: BodyInit } = {}): Promise<Response> {
    return this.send(method, path, {
      ...options,
      body: options.body,
      parse: false,
    });
  }

  /**
   * Reads a response body as text, in pieces where the runtime allows it and in
   * one piece where it does not.
   *
   * This is the primitive a streaming endpoint is built on. It promises exactly
   * two things - decoded text, in order, with nothing lost - and deliberately
   * promises nothing about chunk boundaries, because they are not the same on
   * the three runtimes:
   *
   * - browser and Bun: one yield per network chunk, as it lands;
   * - React Native: ONE yield, containing everything, after the server has
   *   finished. `fetch` there cannot do better - see
   *   {@link supportsResponseStreaming} - and pretending otherwise by slicing
   *   the finished body into fake chunks would only make a UI claim to be live.
   *
   * So a caller must not assume a chunk is a frame, a line, or a whole
   * anything: a `data:` line can arrive split across two chunks, and on RN a
   * hundred of them arrive as one string. Buffer, then split on your own
   * delimiter. The book chat endpoint, for instance, answers SSE `data:` lines
   * carrying `{ delta, done, error }`; framing them belongs to the caller, not
   * here.
   *
   * ## The silence limit
   *
   * A server can answer `200` and then say nothing for minutes, and
   * `await reader.read()` has no deadline of its own. `timeoutMs` does not
   * help: it is disposed once the headers arrive (it has to be, or no stream
   * could outlive it). `silenceTimeoutMs` bounds the gap BETWEEN chunks instead
   * and raises {@link OmsTimeoutError} when nothing arrives for that long. It
   * has to sit well clear of a cold model's first token; 45s is the default.
   *
   * Pass `0` to disable it, and mean it: an unbounded read is a spinner with no
   * way out. It does not apply on the buffered path, where the single `text()`
   * read is covered by the caller's `signal`.
   *
   * The body is always released: the reader is cancelled on every exit,
   * including an abandoned `for await` (a `break` runs the generator's
   * `finally`). An abandoned reader holds the connection open.
   *
   * @example
   * ```ts
   * let buffer = "";
   * for await (const chunk of oms.http.streamText("POST", `/books/${id}/chat`, { body })) {
   *   buffer += chunk;
   *   // ... pull whole lines out of `buffer`, leave the partial one behind
   * }
   * ```
   */
  async *streamText(
    method: string,
    path: string,
    options: GetOptions & { body?: JsonBody; silenceTimeoutMs?: number } = {},
  ): AsyncGenerator<string, void, undefined> {
    const response = await this.send(method, path, { ...options, body: options.body, parse: false });

    const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
    if (!supportsResponseStreaming() || !body) {
      // React Native, or a runtime that answered without a readable body (a
      // cache hit, a test double). The bytes are all here already.
      const whole = await response.text();
      if (whole.length > 0) yield whole;
      return;
    }

    const silenceMs = options.silenceTimeoutMs ?? DEFAULT_STREAM_SILENCE_MS;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await readWithSilenceLimit(reader, silenceMs, options.signal);
        if (done) break;
        if (!value) continue;
        // `stream: true` keeps a multi-byte character split across two network
        // chunks from decoding as two replacement characters.
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) yield text;
      }
      const tail = decoder.decode();
      if (tail.length > 0) yield tail;
    } finally {
      void Promise.resolve(reader.cancel()).catch(() => {
        // The connection is going away regardless.
      });
    }
  }

  /**
   * `GET` that reads the whole response as a {@link FileOutput}, taking the
   * filename from `Content-Disposition` when the server sent one.
   *
   * Reads the body into memory in every runtime, React Native included, where
   * `Response#blob()` needs RN's `BlobModule` and produces a Blob whose bytes
   * live on the native side. For a large media file on a phone that is the
   * wrong tool: ask for a signed URL and hand it to the player or to a native
   * downloader instead of pulling it through JavaScript.
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
      // 429 needs no `replayable`: this API only ever answers one before
      // performing the request, so the request provably did not happen. A 5xx
      // carries no such promise.
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
 * The API's null sentinel: a single backspace character, `U+0008`.
 *
 * A query string has no way to say `null`. `?parent_id=` is the empty string,
 * `?parent_id=null` is the four-letter word "null", and omitting the key
 * entirely says something else again. So the API picked a character no real
 * value ever contains and decodes it back to null on arrival, inside every
 * filter bucket and in the handful of body fields that accept it.
 *
 * Where that null lands is what makes it worth having: `exact_search[parent_id]`
 * set to the sentinel becomes `WHERE parent_id IS NULL` - the only way to ask
 * for the storage root nodes, for a comment with no parent, for anything
 * unassigned.
 *
 * Exported because it is part of the wire format, not because you should need
 * it: {@link encodeQuery} writes it for you whenever a query value is `null`.
 */
export const NULL_SENTINEL = "\b";

/**
 * Encodes query parameters the way the API parses them.
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
 *   that in a URL, so it goes out as {@link NULL_SENTINEL} and the server
 *   turns it back into null.
 *
 * Encoding `null` as "drop the key" is the dangerous direction. The filter
 * simply vanishes and the endpoint answers with the UNFILTERED set: a request
 * for the root of somebody's drive comes back as their entire tree. For the
 * same reason the API answers `400` to a filter key it does not recognise
 * rather than quietly widening the query.
 *
 * The sentinel is written at every depth, even though the server only decodes
 * it one level inside a filter bucket (`search`, `exact_search`, `modifiers`,
 * `extra_options`). Anywhere else it stays the literal character and matches no
 * row - an empty result, which is the safe way to be wrong. Compare that with
 * dropping the key, which is an over-broad result nobody notices.
 *
 * ## Dates
 *
 * A `Date` is sent as its ISO-8601 string, which is what the server's date
 * filters parse. An unparseable value is silently treated as absent, which
 * drops that side of the range. Bodies need no equivalent branch, because
 * `JSON.stringify` already calls `Date.prototype.toJSON` and emits the same
 * string.
 *
 * ## The brackets are percent-encoded, and that is load-bearing
 *
 * `search[title]` goes out as `search%5Btitle%5D`, never as raw `[` and `]`.
 * Both parse identically on the server, so this looks like the kind of noise
 * someone tidies away on a quiet afternoon. It is not, and the reason is iOS.
 *
 * `[` and `]` are not legal in a URI query (RFC 3986 reserves them for the host
 * component). Every browser tolerates them; Apple's URL stack does not. Give
 * `NSURL`/`URLComponents` a string with a raw bracket in the query and it
 * re-percent-encodes THE WHOLE QUERY to make it valid - including the `%` signs
 * of anything already encoded. `search[title]=Caf%C3%A9` comes back out as
 * `search%5Btitle%5D=Caf%25C3%25A9`, and the server dutifully searches for the
 * literal text `Caf%C3%A9`, which matches nothing. The failure is a silent
 * empty list on one platform, which is the most expensive kind to find.
 *
 * `encodeURIComponent` handles this by encoding brackets already; the point of
 * writing it down is that nothing here may "simplify" the encoder into
 * `encodeURI`, a template literal, or a hand-built `key[sub]=value`, all of
 * which emit raw brackets. `test/react-native.test.ts` pins it.
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
 * idempotent is not the same as harmless to replay HERE. A `DELETE` answers
 * `404` the second time, so one retried after a torn connection reports "not
 * found" for a row it deleted perfectly well - a success turned into an error
 * the caller then acts on.
 */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when {@link SAFE_METHODS} contains `method`, case-insensitively. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Builds the `modifiers[page]` string the API expects (`"2:100"`).
 *
 * Both halves go through `resolvePageSize` / `resolvePageNumber`, which is the
 * same pair `createPage` uses. That is the point: the size on the wire and the
 * size `Paginated.pageSize` reports have to be one number, or a caller who asks
 * for 1200 gets the server's 500 rows measured against their own 1200 and is
 * told `hasMore: false` while 700 rows sit behind it.
 *
 * @throws {TypeError} for a page size that is not a finite number of at least
 *   1. `"1:NaN"` on the wire reads as size `0` on the server, which then skips
 *   pagination altogether and returns the entire table.
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
 * only ever feeds a create here, and an absent field is read as null on the
 * server - already the value a sentinel would decode to, so writing one would
 * add a step that changes nothing. In a query the absent key means "no filter",
 * which is a different answer entirely.
 *
 * The one thing this cannot express is clearing a column through a multipart
 * UPDATE, where absent means "leave it alone". No endpoint takes one - the SDK
 * sends multipart to the tools and to `POST /books` only - and if one appears,
 * pass {@link NULL_SENTINEL} as the field value explicitly.
 *
 * ## React Native files
 *
 * A {@link NativeFile} - the `{ uri, name, type }` a picker returns - is
 * appended VERBATIM, as the object it is. That is the whole trick: RN's
 * `FormData` keeps the value untouched and its `getParts()` turns an entry with
 * a `uri` into a file part that the native layer streams off disk. Converting
 * it to anything first is what breaks it.
 *
 * On a runtime whose `FormData` is the web one, the same object would be
 * coerced to the string `"[object Object]"` and uploaded as a text field: a
 * 200, a stored record, and no file. So it throws there instead
 * ({@link supportsNativeFormDataFiles}), and for the same reason any other
 * unrecognised object throws rather than being stringified - a descriptor that
 * lost its `name` in transit is a typo, not a form value.
 */
export async function buildFormData(fields: FormFields): Promise<FormData> {
  const form = new FormData();

  const append = async (key: string, value: FormFieldValue): Promise<void> => {
    if (value === undefined || value === null) return;
    if (isNativeFile(value)) {
      appendNativeFile(form, key, value);
      return;
    }
    if (isFileInput(value)) {
      if (isNativeFile(value.data)) {
        // Wrapped only to rename it: `filename` and `contentType` are what the
        // caller asked the server to store, so they win over the descriptor's.
        // An empty `type` is treated as absent, which is how a `content://`
        // pick arrives on Android.
        const contentType = value.contentType || value.data.type || undefined;
        appendNativeFile(form, key, {
          uri: value.data.uri,
          name: value.filename,
          ...(contentType === undefined ? {} : { type: contentType }),
        });
        return;
      }
      const { blob, filename } = await readFileInput(value);
      form.append(key, blob, filename);
      return;
    }
    if (typeof value === "object") {
      throw new TypeError(
        `Form field "${key}" is an object the SDK does not recognise as a file. A React Native pick needs a ` +
          "string `uri` and a string `name`; anything else must be a FileInput ({ data, filename }) or a " +
          "primitive. Left alone it would go out as the literal text \"[object Object]\".",
      );
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

/**
 * Puts a React Native file descriptor into a `FormData` untouched.
 *
 * The cast is the point rather than an escape: the DOM typings say a value is a
 * `string` or a `Blob`, and on RN it is neither. Guarded by
 * {@link supportsNativeFormDataFiles} so the cast can only reach a `FormData`
 * that knows what to do with it - everywhere else the object would be
 * stringified into a field and the upload would vanish with a 200 on it.
 */
function appendNativeFile(form: FormData, key: string, native: NativeFile): void {
  if (!supportsNativeFormDataFiles()) {
    throw new TypeError(
      `Form field "${key}" is a React Native file descriptor (${native.uri}), but this runtime's FormData is ` +
        "the web one and would upload it as the text \"[object Object]\". Only React Native can resolve a " +
        "file:// or content:// URI. On any other runtime, read the bytes first and pass " +
        "{ data: <Blob | Uint8Array>, filename }.",
    );
  }
  (form as unknown as { append(name: string, value: unknown): void }).append(key, native);
}

/**
 * Narrows an unknown form value to a {@link FileInput}.
 *
 * A {@link NativeFile} in `data` counts: it is a legitimate `FileInput` on RN,
 * it just cannot be turned into bytes. Callers that need bytes should test with
 * `isNativeFile(input.data)` rather than trusting this, or let
 * `readFileInput` throw the message that explains the way out.
 */
export function isFileInput(value: unknown): value is FileInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { data?: unknown; filename?: unknown };
  if (typeof candidate.filename !== "string") return false;
  return (
    candidate.data instanceof Blob ||
    candidate.data instanceof Uint8Array ||
    isNativeFile(candidate.data) ||
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
 * How long {@link ApiClient.streamText} will wait for the NEXT chunk before it
 * gives up: 45 seconds.
 *
 * It is a silence limit, not a total: a stream that keeps producing runs as
 * long as it likes. The value has to clear a cold model's first token (the
 * weights are paged in before anything is generated) while still being shorter
 * than a user's patience. The proxy usually drops a silent stream first; this
 * is the backstop for when nothing else closes the connection.
 */
export const DEFAULT_STREAM_SILENCE_MS = 45_000;

/**
 * One `reader.read()`, bounded by a silence limit and by the caller's signal.
 *
 * `read()` has no timeout of its own and never rejects on its own when the
 * server simply stops writing, which is how a stalled server turns into a
 * spinner that never ends. The race gives it one.
 *
 * The timer is always cleared, including on the winning read, or a long stream
 * would leave one pending handle per chunk.
 */
async function readWithSilenceLimit(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  silenceMs: number,
  signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (silenceMs <= 0 && !signal) return reader.read();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const interrupted = new Promise<never>((_, reject) => {
    if (signal) {
      if (signal.aborted) {
        reject(new OmsTimeoutError("Aborted by caller", { aborted: true }));
        return;
      }
      onAbort = (): void => reject(new OmsTimeoutError("Aborted by caller", { aborted: true }));
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (silenceMs > 0) {
      timer = setTimeout(() => {
        reject(
          new OmsTimeoutError(
            `The response stream went quiet for ${silenceMs}ms. The server accepted the request and then stopped ` +
              "producing, which is not something the connection reports on its own.",
            { timeoutMs: silenceMs },
          ),
        );
      }, silenceMs);
    }
  });

  try {
    return await Promise.race([reader.read(), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
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
