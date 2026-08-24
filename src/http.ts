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
  /** Headers merged into every request, below per-call headers. */
  readonly headers?: Record<string, string>;
  /** Default deadline for one call, retries included. `0` disables it. */
  readonly timeoutMs?: number;
  /** Default backoff policy, or `false` to never retry. */
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
 * Retry policy, deliberately narrow:
 * - a `fetch` rejection (DNS, TLS, reset) is retried;
 * - `5xx` is retried;
 * - `429` is retried, waiting exactly what `Retry-After` asked for;
 * - every other `4xx` fails immediately, on any method.
 *
 * The policy applies to all verbs, `POST` included. That is the documented
 * behaviour, and it means a `POST` that the server processed before dying with
 * a 502 can be replayed. Pass `retry: false` on any create where a duplicate
 * is worse than a failure.
 */
export class ApiClient {
  /** API root with no trailing slash. */
  readonly baseUrl: string;

  private readonly fetchImpl: FetchLike;
  private readonly tokens: TokenProvider | undefined;
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

    this.tokens = options.tokens;
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
        if (failure instanceof OmsNetworkError && attempt < maxAttempts && retry !== false) {
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
      const shouldRetry =
        retry !== false &&
        attempt < maxAttempts &&
        (response.status >= 500 || response.status === 429);

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
      // Cookies belong to the browser session, not to an SDK call: an SDK
      // request must be authenticated by the token it was given and nothing
      // else, or a page embedding the SDK would act as the logged-in user.
      credentials: "omit",
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
 * Encodes query parameters the way Rails parses them.
 *
 * - `{ page: 2 }`                     -> `page=2`
 * - `{ ids: ["a", "b"] }`             -> `ids%5B%5D=a&ids%5B%5D=b`
 * - `{ search: { status: "open" } }`  -> `search%5Bstatus%5D=open`
 * - `undefined` / `null` values are dropped, never sent as an empty string.
 */
export function encodeQuery(params: QueryParams): string {
  const parts: string[] = [];
  const push = (key: string, value: QueryValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) push(`${key}[]`, entry);
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
 * Builds the `modifiers[page]` string the backend expects (`"2:100"`).
 * Page size is clamped to the server maximum so a caller cannot silently ask
 * for more and get 500 back without knowing.
 */
export function pageModifier(page = 1, pageSize = 100): string {
  const number = Math.max(1, Math.trunc(page));
  const size = Math.min(500, Math.max(1, Math.trunc(pageSize)));
  return `${number}:${size}`;
}

/** Turns a {@link FormFields} bag into a `FormData`, buffering any streams. */
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
