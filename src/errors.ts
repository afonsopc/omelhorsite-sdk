/**
 * Error taxonomy for the omelhorsite SDK.
 *
 * Every failure that leaves the SDK is an {@link OmsError}. Callers are meant to
 * branch on the class (or on {@link OmsApiError.status}), never on message text -
 * the backend renders human strings in several shapes and they change.
 *
 * The API answers with at least four different error body shapes, so anything
 * that reads an error body must go through {@link normalizeErrorBody}:
 *
 * - a bare JSON string:            `"Image too large"`            (ResponseHelpers)
 * - a sentence from ActiveModel:   `"Name can't be blank and ..."` (error_messages)
 * - an object with `error`:        `{"error":"rate_limited","retry_after":37}`
 * - an object of field errors:     `{"errors":{"url":["is invalid"]}}`
 * - plain text / HTML:             short-link 404 pages, proxy errors
 */

/** Machine-readable code carried by every SDK error. */
export type OmsErrorCode =
  | "api_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "quota_exceeded"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "aborted"
  | "network"
  | "unsupported"
  | "unknown";

/** Extra context attached to an error, useful for logs and for the CLI. */
export interface OmsErrorContext {
  /** HTTP method of the failing request, when there was one. */
  readonly method?: string;
  /** Absolute URL of the failing request, with the query string. */
  readonly url?: string;
  /** How many attempts were spent before giving up (1 means no retry). */
  readonly attempts?: number;
  /** The underlying failure, when this error wraps another one. */
  readonly cause?: unknown;
}

/**
 * Base class for everything the SDK throws.
 *
 * `instanceof OmsError` is the one check that is always safe; the subclasses
 * narrow the reason.
 */
export class OmsError extends Error {
  /**
   * This class's own name, as a LITERAL.
   *
   * `this.name = new.target.name` would be the obvious way to do this and it
   * is wrong here: `bun build --minify` renames the classes, so the shipped
   * `oms` binary reported `name: "A"` in its JSON error envelope while a dev
   * run reported `OmsNetworkError`. A minifier renames identifiers, never
   * string literals or property names, so a static literal survives the build.
   *
   * Every subclass shadows this, and `new.target` is the constructor that was
   * actually called, so a subclass still reports its own name without
   * repeating the assignment.
   */
  static readonly errorName: string = "OmsError";

  /** Stable machine-readable reason. Safe to switch on. */
  readonly code: OmsErrorCode;
  /** HTTP method of the failing request, when the error came from one. */
  readonly method: string | undefined;
  /** Absolute URL of the failing request, when the error came from one. */
  readonly url: string | undefined;
  /** Attempts spent before the error was raised. `1` means it was not retried. */
  readonly attempts: number | undefined;

  constructor(message: string, code: OmsErrorCode = "unknown", context: OmsErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = (new.target as typeof OmsError).errorName;
    this.code = code;
    this.method = context.method;
    this.url = context.url;
    this.attempts = context.attempts;
  }

  /**
   * Whether retrying the exact same call could plausibly succeed. The
   * {@link ApiClient} already retries what it is allowed to retry; this is for
   * callers deciding whether to surface a "try again" affordance.
   */
  get retryable(): boolean {
    return this.code === "network" || this.code === "timeout" || this.code === "server_error" || this.code === "rate_limited";
  }

  /** Plain object for logging. Never includes the token. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, method: this.method, url: this.url, attempts: this.attempts };
  }
}

/**
 * The API answered, and the answer was an error status.
 *
 * `body` is the RAW parsed body exactly as the server sent it (string, array,
 * object or `undefined`). It is deliberately untyped: read it when you know the
 * endpoint, use `message` otherwise.
 */
export class OmsApiError extends OmsError {
  static override readonly errorName: string = "OmsApiError";

  /** HTTP status code. */
  readonly status: number;
  /** Raw parsed response body. Untouched by the normalizer. */
  readonly body: unknown;
  /** Response headers, lowercased keys. Useful for `retry-after` / request ids. */
  readonly headers: Readonly<Record<string, string>>;
  /** Per-field validation messages, when the body carried any. */
  readonly fieldErrors: Readonly<Record<string, string[]>> | undefined;

  constructor(
    message: string,
    options: {
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
      code?: OmsErrorCode;
      fieldErrors?: Record<string, string[]>;
    } & OmsErrorContext,
  ) {
    super(message, options.code ?? codeForStatus(options.status), options);
    this.status = options.status;
    this.body = options.body;
    this.headers = Object.freeze({ ...(options.headers ?? {}) });
    this.fieldErrors = options.fieldErrors ? Object.freeze(options.fieldErrors) : undefined;
  }

  override get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), status: this.status, body: this.body, fieldErrors: this.fieldErrors };
  }
}

/**
 * 401 or 403: the credential is missing, expired, or not allowed to do this.
 *
 * The CLI turns this into "run `oms auth login`"; the MCP server turns it into
 * a device-flow prompt.
 */
export class OmsAuthError extends OmsApiError {
  static override readonly errorName: string = "OmsAuthError";

  /** True for 401 (no/blown credential), false for 403 (credential is fine, act is not). */
  get authenticationRequired(): boolean {
    return this.status === 401;
  }
}

/**
 * 429, or a documented daily-quota rejection.
 *
 * Two different producers land here and they do not look alike:
 * rack-attack answers `{"error":"rate_limited","retry_after":37}` with a
 * `Retry-After` header, while a controller quota gate answers a bare string
 * such as `"Daily edit quota reached (5/day)"` with no header at all. Read
 * {@link retryAfterMs}; it is `undefined` in the second case.
 */
export class OmsQuotaError extends OmsApiError {
  static override readonly errorName: string = "OmsQuotaError";

  /** Milliseconds to wait before retrying, when the server said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: {
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
      code?: OmsErrorCode;
      retryAfterMs?: number;
    } & OmsErrorContext,
  ) {
    super(message, { ...options, code: options.code ?? "rate_limited" });
    this.retryAfterMs = options.retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

/**
 * The request did not finish inside its deadline, or the caller's
 * `AbortSignal` fired.
 *
 * `code` is `"timeout"` for a deadline the SDK enforced and `"aborted"` when
 * the caller's own signal aborted; check it before reporting a fault.
 */
export class OmsTimeoutError extends OmsError {
  static override readonly errorName: string = "OmsTimeoutError";

  /** The deadline that expired, in milliseconds, when there was one. */
  readonly timeoutMs: number | undefined;

  constructor(message: string, options: { timeoutMs?: number; aborted?: boolean } & OmsErrorContext = {}) {
    super(message, options.aborted ? "aborted" : "timeout", options);
    this.timeoutMs = options.timeoutMs;
  }

  override get retryable(): boolean {
    return this.code === "timeout";
  }
}

/**
 * `fetch` itself rejected: DNS, TLS, connection reset, offline. No HTTP status
 * exists because no response was ever received, so a retry is always safe for
 * a read and usually safe for a write that never left the machine.
 */
export class OmsNetworkError extends OmsError {
  static override readonly errorName: string = "OmsNetworkError";

  constructor(message: string, context: OmsErrorContext = {}) {
    super(message, "network", context);
  }
}

/** Maps an HTTP status onto the coarse machine code. */
export function codeForStatus(status: number): OmsErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_request";
  return "api_error";
}

/** Result of running an arbitrary error body through {@link normalizeErrorBody}. */
export interface NormalizedError {
  /** A single human sentence. Never empty. */
  readonly message: string;
  /** A code the server named itself (`{"error":"rate_limited"}`), if any. */
  readonly serverCode: string | undefined;
  /** Per-field messages, when the body was shaped like ActiveModel errors. */
  readonly fieldErrors: Record<string, string[]> | undefined;
}

/**
 * Turns any error body the backend can produce into one sentence plus whatever
 * structure was recoverable. This is the ONLY place that guesses at body
 * shapes; resource modules must not re-implement it.
 *
 * Handles, in order: `undefined`/`null`, string (including a JSON-encoded
 * string), array of anything, `{error}`, `{errors}` as array or as a field map,
 * `{message}`, `{detail}`, `{title}`, and finally an opaque object (stringified
 * and truncated).
 *
 * @param body Raw parsed body. Pass exactly what the transport read.
 * @param fallback Sentence to use when nothing readable could be found.
 */
export function normalizeErrorBody(body: unknown, fallback = "Request failed"): NormalizedError {
  const message = flattenMessage(body);
  return {
    message: message && message.trim().length > 0 ? truncate(message.trim(), 600) : fallback,
    serverCode: readServerCode(body),
    fieldErrors: readFieldErrors(body),
  };
}

/** Depth-limited flattening of whatever shape the body has into one sentence. */
function flattenMessage(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const parts = value.map((entry) => flattenMessage(entry, depth + 1)).filter((part) => part.length > 0);
    return parts.join("; ");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Preferred keys first, in the order the backend actually uses them.
    for (const key of ["error", "message", "detail", "title", "errors", "error_message"]) {
      if (!(key in record)) continue;
      const flattened = flattenMessage(record[key], depth + 1);
      if (flattened.length > 0) return flattened;
    }
    // ActiveModel-shaped map: { url: ["is invalid"], name: ["can't be blank"] }
    const pairs = Object.entries(record)
      .map(([key, entry]) => {
        const flattened = flattenMessage(entry, depth + 1);
        return flattened.length > 0 ? `${key}: ${flattened}` : "";
      })
      .filter((pair) => pair.length > 0);
    return pairs.join("; ");
  }

  return "";
}

/** Pulls a machine code out of `{"error":"rate_limited"}`-style bodies. */
function readServerCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["code", "error_code"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  // `error` doubles as both a sentence and a slug; treat it as a slug only when
  // it looks like one (no spaces, snake_case).
  const error = record["error"];
  if (typeof error === "string" && /^[a-z][a-z0-9_]*$/.test(error)) return error;
  return undefined;
}

/** Recovers a field -> messages map when the body carried one. */
function readFieldErrors(body: unknown): Record<string, string[]> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const source = record["errors"] ?? record["field_errors"] ?? record["fieldErrors"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;

  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const messages = Array.isArray(value)
      ? value.map((entry) => flattenMessage(entry, 1)).filter((entry) => entry.length > 0)
      : [flattenMessage(value, 1)].filter((entry) => entry.length > 0);
    if (messages.length > 0) out[key] = messages;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Reads a `Retry-After` header. RFC 9110 allows both delay-seconds and an
 * HTTP-date; rack-attack sends seconds, but a proxy in front may not.
 *
 * @returns Milliseconds to wait, or `undefined` when the header is absent or junk.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * Builds the right {@link OmsApiError} subclass for a response the SDK already
 * read. The transport calls this; resource modules never do.
 *
 * @param status HTTP status code.
 * @param body Raw parsed body, exactly as read.
 * @param context Method, URL, attempt count and response headers.
 */
export function apiErrorFromResponse(
  status: number,
  body: unknown,
  context: OmsErrorContext & { headers?: Record<string, string> } = {},
): OmsApiError {
  const headers = context.headers ?? {};
  const normalized = normalizeErrorBody(body, defaultMessageForStatus(status));
  const base = {
    status,
    body,
    headers,
    method: context.method,
    url: context.url,
    attempts: context.attempts,
    cause: context.cause,
  };

  if (status === 401 || status === 403) {
    return new OmsAuthError(normalized.message, { ...base, fieldErrors: normalized.fieldErrors });
  }

  if (status === 429 || normalized.serverCode === "rate_limited" || normalized.serverCode === "quota_exceeded") {
    const retryAfterMs =
      parseRetryAfter(headers["retry-after"]) ?? secondsFromBody(body, "retry_after") ?? undefined;
    return new OmsQuotaError(normalized.message, {
      ...base,
      code: normalized.serverCode === "quota_exceeded" ? "quota_exceeded" : "rate_limited",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  return new OmsApiError(normalized.message, { ...base, fieldErrors: normalized.fieldErrors });
}

/** Reads `{ retry_after: 37 }` (seconds) out of a body and returns milliseconds. */
function secondsFromBody(body: unknown, key: string): number | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value === "string" && /^\d+$/.test(value)) return Math.max(0, Number.parseInt(value, 10) * 1000);
  return undefined;
}

function defaultMessageForStatus(status: number): string {
  if (status === 401) return "Not authenticated";
  if (status === 403) return "Not authorized";
  if (status === 404) return "Not found";
  if (status === 409) return "Conflict";
  if (status === 413) return "Payload too large";
  if (status === 429) return "Rate limited";
  if (status >= 500) return `Server error (${status})`;
  return `Request failed (${status})`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Wraps an unknown thrown value as an {@link OmsError} without losing it.
 * Anything already an OmsError is returned untouched.
 */
export function toOmsError(thrown: unknown, context: OmsErrorContext = {}): OmsError {
  if (thrown instanceof OmsError) return thrown;
  if (thrown instanceof Error) {
    return new OmsError(thrown.message || "Unknown error", "unknown", { ...context, cause: thrown });
  }
  return new OmsError(typeof thrown === "string" ? thrown : "Unknown error", "unknown", { ...context, cause: thrown });
}
