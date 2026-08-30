/**
 * The `tickets` namespace: support tickets and the message thread on each one.
 *
 * A ticket is `POST /tickets` with a subject plus an optional first message;
 * everything after that is a `TicketMessage` on `/ticket_messages`. Attachments
 * are data URIs on create (the backend caps them at 10 files / 10 MiB total,
 * images and video only) and are read back one blob at a time.
 *
 * This is the namespace an agent reaches for when something went wrong, so
 * `create()` is deliberately one call: subject, body and screenshots all land
 * in the same request.
 */

import { OmsError, OmsNetworkError } from "../errors";
import { type ApiClient, Resource, type TokenProvider } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../listing";
import type {
  FileInput,
  Id,
  PageLoader,
  Paginated,
  PageParams,
  QueryParams,
  RequestOptions,
  Timestamp,
} from "../types";
import { DEFAULT_PAGE_SIZE, readFileInput } from "../types";

/** Lifecycle of a ticket. */
export type TicketStatus = "open" | "closed";

/**
 * Identifier of a ticket. A NUMBER, not the opaque string every other resource
 * uses: `tickets` is one of the two tables that kept an auto-increment primary
 * key, so the API renders `id` as a JSON number here. That is why {@link Ticket}
 * does not extend `BaseRecord`.
 */
export type TicketId = number;

/** Identifier of a ticket message. A number, for the same reason as {@link TicketId}. */
export type TicketMessageId = number;

/** Longest subject the backend accepts. Anything longer is a 400. */
export const TICKET_SUBJECT_MAX_LENGTH = 200;

/** Longest message body the backend accepts. Anything longer is a 400. */
export const TICKET_MESSAGE_MAX_LENGTH = 4000;

/** Most attachments one `create` may carry. The backend keeps the first ten. */
export const TICKET_MAX_ATTACHMENTS = 10;

/** Ceiling on the decoded bytes of all attachments in one `create`. */
export const TICKET_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** MIME prefixes the backend accepts as a ticket attachment. */
export const TICKET_ATTACHMENT_TYPES = ["image/", "video/"] as const;

/**
 * Free-form context the client attaches at create time. The backend keeps only
 * these four keys and drops anything else, so do not smuggle payloads through.
 */
export interface TicketContext {
  readonly provider?: string;
  readonly error?: string;
  readonly path?: string;
  readonly source?: string;
}

/** One file hanging off a ticket, as the blueprint renders it. */
export interface TicketAttachment {
  /** Address it with {@link TicketsNamespace.attachment}. Numeric, like {@link TicketId}. */
  readonly blob_id: number;
  readonly filename: string;
  readonly content_type: string;
  readonly byte_size: number;
  /** Derived from `content_type`; never anything else today. */
  readonly kind: "image" | "video";
}

/** A support ticket. */
export interface Ticket {
  readonly id: TicketId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly user_id: Id;
  /** Bumped by every message. The listing is ordered on it, newest first. */
  readonly last_activity_at: Timestamp;
  /** Always rendered; `{}` when nothing was attached at create time. */
  readonly context: TicketContext | null;
  readonly attachments: TicketAttachment[];
  /**
   * The thread. Present on `get`, `create` and `update` (which render the
   * `:extended` view) and absent from `list`, which renders the default view.
   */
  readonly ticket_messages?: TicketMessage[];
}

/** One message in a ticket thread. */
export interface TicketMessage {
  readonly id: TicketMessageId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly ticket_id: TicketId;
  /** Always the sender's own id: the server ignores any value you send. */
  readonly sender_id: Id;
  readonly content: string;
  /** Whether the sender is a member of staff. */
  readonly sender_admin: boolean;
}

/** Arguments for opening a ticket. */
export interface CreateTicketInput {
  /** At most {@link TICKET_SUBJECT_MAX_LENGTH} characters. */
  readonly subject: string;
  /**
   * Body of the first message. Optional: a subject alone opens a ticket.
   *
   * The backend creates this message without a bang, so a body that fails
   * validation (over {@link TICKET_MESSAGE_MAX_LENGTH}) is dropped and the
   * ticket is still created. The SDK checks the length first so that never
   * happens silently.
   */
  readonly initialMessage?: string;
  readonly context?: TicketContext;
  /**
   * Files to attach, as bytes or as an already-encoded data URL. Bytes are
   * base64-encoded here, so every attachment is buffered in memory.
   *
   * Server caps: {@link TICKET_MAX_ATTACHMENTS} files,
   * {@link TICKET_MAX_ATTACHMENT_BYTES} in total, `image/*` and `video/*`
   * only. An attachment over a cap is dropped server-side with the ticket
   * still answering 201, so the SDK validates first and throws instead.
   */
  readonly attachments?: ReadonlyArray<FileInput | TicketAttachmentDataUrl>;
}

/** An attachment that is already a `data:<mime>;base64,...` URL. */
export interface TicketAttachmentDataUrl {
  readonly dataUrl: string;
  readonly filename: string;
}

/** Fields that can change after a ticket exists. */
export interface UpdateTicketInput {
  readonly status?: TicketStatus;
}

/** Filter columns of `GET /tickets`, on top of {@link BASE_FILTER_COLUMNS}. */
export const TICKET_FILTER_COLUMNS = Object.freeze(["status", "user_id"] as const);

/** Filters for {@link TicketsNamespace.list}. */
export interface ListTicketsParams extends ListParams<(typeof TICKET_FILTER_COLUMNS)[number]> {
  readonly status?: TicketStatus;
  /** Administrators only: someone else's tickets. */
  readonly userId?: Id;
}

/** Filter columns of `GET /ticket_messages`, on top of {@link BASE_FILTER_COLUMNS}. */
export const TICKET_MESSAGE_FILTER_COLUMNS = Object.freeze(["ticket_id", "sender_id", "created_at"] as const);

/** Filters for {@link TicketMessagesNamespace.list}. */
export interface ListTicketMessagesParams extends ListParams<(typeof TICKET_MESSAGE_FILTER_COLUMNS)[number]> {
  readonly ticketId: TicketId;
}

/** Arguments for replying to a ticket. */
export interface CreateTicketMessageInput {
  readonly ticketId: TicketId;
  /** At most {@link TICKET_MESSAGE_MAX_LENGTH} characters. */
  readonly content: string;
}

/** The message thread of a ticket, reachable as `oms.tickets.messages`. */
export class TicketMessagesNamespace extends Resource {
  /**
   * `GET /ticket_messages?exact_search[ticket_id]=...` - the thread, oldest
   * first.
   *
   * A thread you can already see whole through {@link TicketsNamespace.get}
   * does not need this; reach for it when a thread is long enough to page.
   */
  async list(params: ListTicketMessagesParams, options: RequestOptions = {}): Promise<Paginated<TicketMessage>> {
    const base = { exactSearch: { ticket_id: params.ticketId } };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<TicketMessage[]>("/ticket_messages", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `POST /ticket_messages` - replies to a ticket.
   *
   * The sender is always the caller: `sender_id` cannot be forged. A closed
   * ticket refuses replies with 401, so reopen it first.
   *
   * Not retried by default: a replayed reply would post the message twice.
   */
  async create(input: CreateTicketMessageInput, options: RequestOptions = {}): Promise<TicketMessage> {
    assertLength("content", input.content, TICKET_MESSAGE_MAX_LENGTH);
    return this.http.post<TicketMessage>(
      "/ticket_messages",
      { ticket_id: input.ticketId, content: input.content },
      { retry: false, ...options },
    );
  }

  /**
   * `DELETE /ticket_messages/:id`. Administrators only; the author of a
   * message cannot take it back.
   */
  async delete(id: TicketMessageId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/ticket_messages/${id}`, options);
  }
}

/** The `tickets` namespace, reachable as `oms.tickets`. */
export class TicketsNamespace extends Resource {
  /** The message thread of a ticket. */
  readonly messages: TicketMessagesNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.messages = new TicketMessagesNamespace(http);
  }

  /**
   * `GET /tickets` - your tickets, most recently active first. An
   * administrator sees everyone's and can narrow with `userId`.
   *
   * The rows carry no `ticket_messages`: the listing renders the default
   * view. Call {@link get} for the thread.
   */
  async list(params: ListTicketsParams = {}, options: RequestOptions = {}): Promise<Paginated<Ticket>> {
    const base = { exactSearch: { status: params.status, user_id: params.userId } };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<Ticket[]>("/tickets", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /** `GET /tickets/:id` - the ticket with its whole message thread. */
  async get(id: TicketId, options: RequestOptions = {}): Promise<Ticket> {
    return this.http.get<Ticket>(`/tickets/${id}`, options);
  }

  /**
   * `POST /tickets` - opens a ticket, with its first message and its
   * screenshots, in ONE request.
   *
   * ```ts
   * await oms.tickets.create({
   *   subject: "Upload fails at 90%",
   *   initialMessage: "Every file over 2 GB stops at the same point.",
   *   context: { source: "cli", path: "/tools/storage" },
   *   attachments: [file(png, "screenshot.png")],
   * });
   * ```
   *
   * Attachments are encoded as data URIs here, so they are buffered whole;
   * see {@link CreateTicketInput.attachments} for the caps the SDK enforces
   * before sending.
   *
   * Not retried by default: a replayed create would open a second ticket.
   */
  async create(input: CreateTicketInput, options: RequestOptions = {}): Promise<Ticket> {
    assertLength("subject", input.subject, TICKET_SUBJECT_MAX_LENGTH);
    if (input.initialMessage !== undefined) {
      assertLength("initialMessage", input.initialMessage, TICKET_MESSAGE_MAX_LENGTH);
    }

    const body: Record<string, unknown> = { subject: input.subject };
    if (input.initialMessage !== undefined) body["initial_message"] = input.initialMessage;
    if (input.context !== undefined) body["context"] = pickContext(input.context);
    if (input.attachments?.length) body["attachments"] = await encodeAttachments(input.attachments);

    return this.http.post<Ticket>("/tickets", body, { retry: false, ...options });
  }

  /**
   * `PATCH /tickets/:id` - today the only mutable field is `status`.
   *
   * Anything else in the body is dropped in silence and still answers 200
   * with the untouched record, so read the returned ticket rather than
   * inferring success from the status code.
   */
  async update(id: TicketId, input: UpdateTicketInput, options: RequestOptions = {}): Promise<Ticket> {
    return this.http.patch<Ticket>(`/tickets/${id}`, { status: input.status }, options);
  }

  /** Convenience over {@link update} with `status: "closed"`. */
  async close(id: TicketId, options: RequestOptions = {}): Promise<Ticket> {
    return this.update(id, { status: "closed" }, options);
  }

  /**
   * Convenience over {@link update} with `status: "open"`. A closed ticket
   * refuses new messages, so reopen before replying.
   */
  async reopen(id: TicketId, options: RequestOptions = {}): Promise<Ticket> {
    return this.update(id, { status: "open" }, options);
  }

  /**
   * `DELETE /tickets/:id`. Administrators only: the owner of a ticket can
   * close it but not destroy it, and gets 401 if they try.
   */
  async delete(id: TicketId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/tickets/${id}`, options);
  }

  /**
   * `GET /tickets/:id/attachment/:blob_id` - one attachment's bytes.
   *
   * Unlike `account.picture` and `chests.entries.download`, this one CANNOT be
   * asked for anonymously. The action resolves the ticket through
   * `Ticket.viewable_by(Current.user)` and declares `oauth_scope
   * "tickets:write"`, so a request with no credential is a 404 on someone
   * else's ticket and a 401 on your own. The credential has to ride the first
   * hop, which is exactly what makes this awkward.
   *
   * The awkward part. Rails answers `302` to `minio.omelhorsite.pt` and `fetch`
   * follows it. Two different things then happen depending on how the client
   * was built:
   *
   * - **token mode** (`credentials: "omit"`). The Fetch standard strips
   *   `Authorization` on a cross-origin redirect, so the store gets a clean
   *   presigned request. The hop also swaps the origin for an opaque one, so
   *   MinIO sees `Origin: null` and answers `Access-Control-Allow-Origin: *` -
   *   which an uncredentialed request accepts. This works, in a browser and
   *   out of one.
   * - **cookie mode** (`sessionCookie: true`, the production web app). Same
   *   `Origin: null`, same `*` back, but now the request carries credentials,
   *   and wildcard plus credentials is illegal in CORS regardless of
   *   `Access-Control-Allow-Credentials`. The browser rejects the response and
   *   `fetch` rejects with an opaque "Failed to fetch".
   *
   * And it cannot be repaired the way the other two were, because the obvious
   * repair does not exist in a browser: `redirect: "manual"` there yields an
   * OPAQUE-REDIRECT response - status 0, empty header list - so `Location` is
   * unreadable and the second hop cannot be re-issued without credentials.
   * `redirect: "error"` and `XMLHttpRequest` are no better. Reading `Location`
   * works only off-browser, where nothing was broken to begin with. The other
   * two endpoints escape by needing no credential at all; this one has no such
   * escape, and the backend exposes no `..._url` companion route the way
   * `fs_nodes` does with `data_url`.
   *
   * So in a browser in cookie mode, use {@link attachmentUrl} and let the
   * platform fetch the bytes - an `<img>`, a `<video>`, an `<a download>` make
   * no-cors requests and follow the redirect with no CORS check at all. This
   * method stays for every other context, and turns the browser failure into an
   * error that says so instead of an unexplained network fault.
   *
   * Take `blobId` from {@link TicketAttachment.blob_id}; the filename and
   * content type are on the same record, which is why this hands back bare
   * bytes.
   *
   * @throws {OmsError} `unsupported` when the redirect was blocked by CORS,
   *   naming {@link attachmentUrl} as the way through.
   * @throws {OmsApiError} 404 when the blob is not on that ticket, or the
   *   ticket is not yours.
   */
  async attachment(id: TicketId, blobId: number, options: RequestOptions = {}): Promise<Blob> {
    const path = attachmentPath(id, blobId);
    try {
      const response = await this.http.raw("GET", path, options);
      return await response.blob();
    } catch (thrown) {
      // A CORS rejection reaches us as a bare `fetch` rejection, indistinguishable
      // from a real network fault, and the transport has already retried it three
      // times by now. Only the client's shape tells the two apart.
      if (thrown instanceof OmsNetworkError && (await tokenOf(this.http)) === null) {
        throw new OmsError(
          "The ticket attachment redirect could not be followed. In a browser, a client built with " +
            "`sessionCookie: true` sends credentials, the 302 to object storage arrives there with " +
            "`Origin: null`, and the store answers a wildcard `Access-Control-Allow-Origin` - which CORS " +
            "forbids for a credentialed request. Use `oms.tickets.attachmentUrl(id, blobId)` and put the URL " +
            "in an <img>, a <video> or an <a download> instead: those follow the redirect with no CORS check.",
          "unsupported",
          { method: "GET", url: this.http.url(path), cause: thrown },
        );
      }
      throw thrown;
    }
  }

  /**
   * Absolute URL for one attachment, for an `<img>`, an `<a download>` or a new
   * tab. In a browser in cookie mode this is the ONLY way to get at the bytes;
   * see {@link attachment} for why.
   *
   * Asynchronous, unlike `account.pictureUrl` and
   * `chests.entries.downloadUrl`, and the difference is not an accident: those
   * two routes are anonymous, this one is not, so a credential has to be
   * resolved before the URL means anything. Resolving it may involve a token
   * refresh, which is why it cannot be a getter.
   *
   * How the URL authenticates depends on the client, matching what the backend
   * accepts (`Session.candidate_tokens` reads the `Authorization` header, then
   * `?token=`, then the `oms_session` cookie):
   *
   * - **cookie mode**: no credential in the URL. The browser attaches the
   *   `oms_session` cookie itself. It is host-only on the API host and
   *   `SameSite=Lax`, so this works from a page on `omelhorsite.pt` or another
   *   host under it, and from nowhere else. Do not add `crossorigin` to the
   *   element: it turns a no-cors load into a CORS one and re-creates the exact
   *   failure this method exists to avoid.
   * - **token mode**: the token is appended as `?token=`. Rails accepts a query
   *   credential on API routes precisely because a native client has no cookie
   *   jar and an `<img>` cannot carry a header.
   *
   * THE TOKEN-MODE URL CONTAINS A LIVE CREDENTIAL. It goes into the DOM, into
   * the server access log, and into anything that records URLs. Build it at the
   * moment of use, never store it, never log it, and never put it somewhere
   * another person can read - anyone holding it holds the session until it is
   * revoked. When the URL is destined for something outside your own page,
   * fetch the bytes with {@link attachment} and hand over a `blob:` URL
   * instead.
   *
   * ```tsx
   * const src = await oms.tickets.attachmentUrl(ticket.id, file.blob_id);
   * <img src={src} alt={file.filename} />
   * ```
   */
  async attachmentUrl(id: TicketId, blobId: number): Promise<string> {
    const token = await tokenOf(this.http);
    return this.http.url(attachmentPath(id, blobId), token === null ? undefined : { token });
  }
}

/** The one place the attachment route is spelled. */
function attachmentPath(id: TicketId, blobId: number): string {
  return `/tickets/${id}/attachment/${blobId}`;
}

/**
 * The bearer token the transport would send, or `null` when there is none -
 * which for a working client means it is in cookie mode.
 *
 * Read off `ApiClient` through a defensive probe, the same way
 * `objectStoreFetch` reads `fetchImpl`, and for the same reason: the provider
 * is private, `http.ts` is shared, and neither of these two needs is worth
 * growing the transport a new public member for. A probe that finds nothing
 * degrades to `null`, which is the safe answer in both places it is used - a
 * URL with no credential rather than a wrong one, and the CORS explanation
 * rather than a swallowed error.
 *
 * `getToken` may refresh, so this awaits it, and a provider that throws is
 * treated as "no token" rather than allowed to mask the caller's actual
 * failure.
 */
async function tokenOf(http: ApiClient): Promise<string | null> {
  const provider = (http as unknown as { tokens?: TokenProvider }).tokens;
  if (provider === undefined || typeof provider.getToken !== "function") return null;
  try {
    return (await provider.getToken()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Encodes a file as a `data:<mime>;base64,<...>` URI.
 *
 * Exported because several endpoints take images as data URIs rather than as
 * uploads (ticket attachments, a link tree avatar, a form theme's background),
 * and the alternative is every caller writing this loop again.
 *
 * Buffers the whole file: a data URI has no streaming form. Base64 also costs
 * a third more bytes than the original, which matters against the caps.
 */
export async function dataUrlFromFile(input: FileInput): Promise<string> {
  const { blob, contentType } = await readFileInput(input);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${contentType};base64,${base64(bytes)}`;
}

/** Base64 of a byte array, using only `btoa`, which an isolate provides. */
function base64(bytes: Uint8Array): string {
  // Built in chunks: `String.fromCharCode(...bytes)` on a multi-megabyte
  // attachment overflows the argument stack of every runtime.
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Turns the caller's attachments into `{ data_url, filename }` entries, refusing anything the server would drop. */
async function encodeAttachments(
  files: ReadonlyArray<FileInput | TicketAttachmentDataUrl>,
): Promise<Array<{ data_url: string; filename: string }>> {
  if (files.length > TICKET_MAX_ATTACHMENTS) {
    throw new OmsError(
      `A ticket takes at most ${TICKET_MAX_ATTACHMENTS} attachments, got ${files.length}; the server keeps the first ${TICKET_MAX_ATTACHMENTS} and drops the rest silently.`,
      "invalid_request",
    );
  }

  const entries: Array<{ data_url: string; filename: string }> = [];
  let total = 0;

  for (const input of files) {
    const { dataUrl, filename, contentType, size } = await encodeAttachment(input);
    if (!TICKET_ATTACHMENT_TYPES.some((prefix) => contentType.startsWith(prefix))) {
      throw new OmsError(
        `Attachment "${filename}" is ${contentType}; a ticket accepts image/* and video/* only.`,
        "invalid_request",
      );
    }
    total += size;
    if (total > TICKET_MAX_ATTACHMENT_BYTES) {
      throw new OmsError(
        `Ticket attachments exceed ${TICKET_MAX_ATTACHMENT_BYTES} bytes in total; the server attaches what fits and drops the rest silently.`,
        "invalid_request",
      );
    }
    entries.push({ data_url: dataUrl, filename });
  }

  return entries;
}

const DATA_URL = /^data:([^;,]+)(;[^,]*)?,(.*)$/s;

async function encodeAttachment(
  input: FileInput | TicketAttachmentDataUrl,
): Promise<{ dataUrl: string; filename: string; contentType: string; size: number }> {
  if ("dataUrl" in input) {
    const match = DATA_URL.exec(input.dataUrl);
    if (!match) {
      throw new OmsError(`Attachment "${input.filename}" is not a data URL.`, "invalid_request");
    }
    const payload = match[3] ?? "";
    const base64Encoded = (match[2] ?? "").split(";").includes("base64");
    const size = base64Encoded
      ? Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0)
      : decodeURIComponent(payload).length;
    return { dataUrl: input.dataUrl, filename: input.filename, contentType: match[1] ?? "", size };
  }
  const { blob, filename, contentType } = await readFileInput(input);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { dataUrl: `data:${contentType};base64,${base64(bytes)}`, filename, contentType, size: blob.size };
}

/** Keeps only the four context keys the backend stores. */
function pickContext(context: TicketContext): TicketContext {
  const out: Record<string, string> = {};
  for (const key of ["provider", "error", "path", "source"] as const) {
    const value = context[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}


/** Fails fast on a field the backend would truncate, reject, or drop silently. */
function assertLength(field: string, value: string, max: number): void {
  if (value.length > max) {
    throw new OmsError(`${field} is ${value.length} characters; the maximum is ${max}.`, "invalid_request");
  }
}
