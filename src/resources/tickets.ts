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

import { OmsError } from "../errors";
import { type ApiClient, Resource, pageModifier } from "../http";
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
import { createPage, readFileInput } from "../types";

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
   * Files to attach. The SDK turns each one into the data URI the endpoint
   * expects, so every attachment is buffered in memory.
   *
   * Backend caps: {@link TICKET_MAX_ATTACHMENTS} files,
   * {@link TICKET_MAX_ATTACHMENT_BYTES} in total, `image/*` and `video/*`
   * only - and an attachment that breaks any of them is dropped in SILENCE,
   * with the ticket still answering 201. The SDK therefore validates before
   * sending and raises rather than let a screenshot disappear.
   */
  readonly attachments?: FileInput[];
}

/** Fields that can change after a ticket exists. */
export interface UpdateTicketInput {
  readonly status?: TicketStatus;
}

/** Filters for {@link TicketsNamespace.list}. */
export interface ListTicketsParams extends PageParams {
  readonly status?: TicketStatus;
  /** Administrators only: someone else's tickets. */
  readonly userId?: Id;
}

/** Filters for {@link TicketMessagesNamespace.list}. */
export interface ListTicketMessagesParams extends PageParams {
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
    const size = resolvePageSize(params.pageSize);
    const load: PageLoader<TicketMessage> = ({ page, pageSize }) =>
      this.http.get<TicketMessage[]>("/ticket_messages", {
        ...options,
        query: messageQuery(params, page, pageSize),
      });
    const first = resolvePageNumber(params.page);
    return createPage(await load({ page: first, pageSize: size }), first, size, load);
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
    const size = resolvePageSize(params.pageSize);
    const load: PageLoader<Ticket> = ({ page, pageSize }) =>
      this.http.get<Ticket[]>("/tickets", { ...options, query: ticketQuery(params, page, pageSize) });
    const first = resolvePageNumber(params.page);
    return createPage(await load({ page: first, pageSize: size }), first, size, load);
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
   * The endpoint answers 302 towards object storage and `fetch` follows it.
   * The redirect is cross-origin, so the platform drops the `Authorization`
   * header on the way: the credential never reaches the storage host.
   *
   * Take `blobId` from {@link TicketAttachment.blob_id}; the filename and
   * content type are on the same record, which is why this hands back bare
   * bytes.
   */
  async attachment(id: TicketId, blobId: number, options: RequestOptions = {}): Promise<Blob> {
    const response = await this.http.raw("GET", `/tickets/${id}/attachment/${blobId}`, options);
    return response.blob();
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

/**
 * Turns the caller's files into the `{ data_url, filename }` entries the
 * endpoint reads, refusing anything the backend would silently drop.
 */
async function encodeAttachments(files: FileInput[]): Promise<Array<{ data_url: string; filename: string }>> {
  if (files.length > TICKET_MAX_ATTACHMENTS) {
    throw new OmsError(
      `A ticket takes at most ${TICKET_MAX_ATTACHMENTS} attachments, got ${files.length}. The backend would keep the first ${TICKET_MAX_ATTACHMENTS} and drop the rest without saying so.`,
      "invalid_request",
    );
  }

  const entries: Array<{ data_url: string; filename: string }> = [];
  let total = 0;

  for (const input of files) {
    const { blob, filename, contentType } = await readFileInput(input);
    if (!TICKET_ATTACHMENT_TYPES.some((prefix) => contentType.startsWith(prefix))) {
      throw new OmsError(
        `Attachment "${filename}" is ${contentType}; a ticket accepts image/* and video/* only.`,
        "invalid_request",
      );
    }
    total += blob.size;
    if (total > TICKET_MAX_ATTACHMENT_BYTES) {
      throw new OmsError(
        `Ticket attachments exceed ${TICKET_MAX_ATTACHMENT_BYTES} bytes in total. The backend attaches what fits and drops the rest without saying so.`,
        "invalid_request",
      );
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    entries.push({ data_url: `data:${contentType};base64,${base64(bytes)}`, filename });
  }

  return entries;
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

/**
 * Filters go through `exact_search`, not `search`.
 *
 * They share one allowlist, but `search` on a string column is a normalised
 * LIKE (lowercased, accents folded, wrapped in `%`), which for an id or a
 * status is both slower and wrong at the edges. `exact_search` is plain
 * equality.
 */
function ticketQuery(params: ListTicketsParams, page: number, pageSize: number): QueryParams {
  return {
    exact_search: { status: params.status, user_id: params.userId },
    modifiers: { order: params.order, page: pageModifier(page, pageSize) },
  };
}

function messageQuery(params: ListTicketMessagesParams, page: number, pageSize: number): QueryParams {
  return {
    exact_search: { ticket_id: params.ticketId },
    modifiers: { order: params.order, page: pageModifier(page, pageSize) },
  };
}

function resolvePageNumber(page: number | undefined): number {
  return Math.max(1, Math.trunc(page ?? 1));
}

function resolvePageSize(pageSize: number | undefined): number {
  return Math.min(500, Math.max(1, Math.trunc(pageSize ?? 100)));
}

/** Fails fast on a field the backend would truncate, reject, or drop silently. */
function assertLength(field: string, value: string, max: number): void {
  if (value.length > max) {
    throw new OmsError(`${field} is ${value.length} characters; the maximum is ${max}.`, "invalid_request");
  }
}
