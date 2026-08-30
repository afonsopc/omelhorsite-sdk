/** Direct messages: the record, the listing and `oms.social.messages`. */

import { OmsError } from "../../errors";
import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { ListParams, ListQueryBase } from "../../listing";
import type { User } from "../account";
import type { FileInput, Id, NativeFile, Paginated, RequestOptions, Timestamp } from "../../types";
import { DEFAULT_PAGE_SIZE, isNativeFile } from "../../types";
import type { AttachmentKind } from "./types";
import { MESSAGE_ATTACHMENT_MAX_BYTES, assertPresent, attachmentSize, followAttachment, tokenOf } from "./types";

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Primary key of a direct message. An INTEGER: `messages` is one of the tables
 * that kept an auto-increment key, so `id` and `quoted_message_id` are JSON
 * numbers while `sender_id` and `receiver_id` beside them are strings.
 */
export type MessageId = number;

/* -------------------------------------------------------------------------- */
/* Limits the server enforces                                                 */
/* -------------------------------------------------------------------------- */

/** `content` of a direct message is capped at 1024 characters. Longer is a `400`. */
export const MESSAGE_CONTENT_MAX_LENGTH = 1024;

/**
 * The ceiling that actually applies to an attachment the server decides is an
 * image: 20 MiB.
 *
 * The two caps disagree and the gap is not harmless. The server checks 25
 * MiB, then hands anything whose `content_type` starts with `image/` to the
 * webp recompressor, which checks 20 MiB and fails with an error that is not
 * turned into a `400`. So a 22 MiB JPEG is a **500** with a Discord error
 * alert behind it, where a 22 MiB zip is accepted.
 *
 * {@link DirectMessagesNamespace.send} refuses that band client-side when the
 * size is knowable, which is the only place the mistake is still cheap.
 */
export const MESSAGE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Pixel ceilings the server applies to an image attachment before any
 * full-frame decode: 12000px on either side, and 50 megapixels of area. Past
 * either one the answer is `400` with the dimensions in the body, and
 * deliberately no error alert.
 *
 * Not checkable here - the SDK does not decode images - so this is
 * documentation, not a guard.
 */
export const MESSAGE_IMAGE_MAX_DIMENSION_PX = 12_000;
/** @see MESSAGE_IMAGE_MAX_DIMENSION_PX */
export const MESSAGE_IMAGE_MAX_PIXELS = 50_000_000;

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/** Preview of the message a message quotes. Truncated to 120 characters. */
export interface QuotedMessagePreview {
  readonly id: MessageId;
  readonly sender_id: Id;
  readonly content: string;
  readonly attachment_kind: AttachmentKind | null;
}

/**
 * A direct message between two users.
 *
 * Every row carries BOTH ends of the conversation as fully rendered
 * {@link User} objects. That is most of the bytes of a page of messages, it is
 * the same two records repeated a hundred times, and there is no way to ask
 * for rows without them. Budget for it on a mobile connection.
 */
export interface DirectMessage {
  /** Integer. */
  readonly id: MessageId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Never null and never empty. */
  readonly content: string;
  readonly sender_id: Id;
  readonly receiver_id: Id;
  /**
   * DO NOT READ THIS AS "THE OTHER PERSON SAW IT".
   *
   * It is set by {@link DirectMessagesNamespace.list} on every row the listing
   * matched, in both directions, so it means "somebody who can see this
   * message listed it" and nothing more precise. On a message the CALLER
   * sent, it was almost certainly stamped by the caller's own listing rather
   * than by the recipient's - opening a thread marks your own outgoing
   * messages read. A "seen" tick built on this field lies.
   *
   * On a message the caller RECEIVED it is meaningful, in the weak sense that
   * their own client fetched it at that time. It is what
   * {@link DirectMessagesNamespace.conversedUsers} counts, and the only
   * unread signal the API has.
   */
  readonly read_at: Timestamp | null;
  readonly attachment_kind: AttachmentKind | null;
  readonly quoted_message_id: MessageId | null;
  /** Null until the sender edits it. */
  readonly edited_at: Timestamp | null;
  readonly has_image: boolean;
  readonly has_attachment: boolean;
  readonly attachment_filename: string | null;
  readonly attachment_byte_size: number | null;
  readonly quoted_preview: QuotedMessagePreview | null;
  /** The full sender record, nested. */
  readonly sender: User;
  /** The full receiver record, nested. */
  readonly receiver: User;
}

/** One row of {@link DirectMessagesNamespace.conversedUsers}. */
export interface ConversedUser extends User {
  readonly last_message: {
    readonly id: MessageId;
    readonly preview: string;
    readonly from_me: boolean;
    readonly created_at: Timestamp;
  } | null;
  readonly unread_count: number;
}

/* -------------------------------------------------------------------------- */
/* Direct messages                                                            */
/* -------------------------------------------------------------------------- */

/** Filter columns of `GET /messages`. */
export const MESSAGE_FILTER_COLUMNS = Object.freeze([
  "id",
  "created_at",
  "updated_at",
  "content",
  "sender_id",
  "receiver_id",
  "read_at",
] as const);

/** `extra_options` keys of `GET /messages`. */
export const MESSAGE_EXTRA_OPTION_KEYS = Object.freeze(["user_id", "other_user_id"] as const);

/** `extra_options` of `GET /messages`. Each matches rows where the user is either end. */
export interface MessageExtraOptions {
  readonly user_id?: Id;
  readonly other_user_id?: Id;
}

/** Filters accepted by {@link DirectMessagesNamespace.list}. */
export interface ListMessagesParams
  extends ListParams<(typeof MESSAGE_FILTER_COLUMNS)[number], MessageExtraOptions> {
  /**
   * The other end of the conversation. Sent as
   * `extra_options[other_user_id]`, which the server expands to
   * `sender_id = ? OR receiver_id = ?` INSIDE the caller's own scope, so it
   * yields exactly the thread with that person.
   *
   * Pass this on every call you can. It is the only thing that keeps
   * {@link DirectMessagesNamespace.list}'s read-marking side effect from
   * covering your whole mailbox - see the method's docs.
   */
  readonly withUser?: Id;
  /**
   * `extra_options[user_id]`: rows where this user is EITHER end.
   *
   * Redundant for a normal caller - the listing scope is already the caller's
   * own messages, so passing your own id narrows nothing - and it cannot widen
   * the scope to somebody else's mailbox either. It is exposed only so a
   * caller porting existing code can keep the wire identical.
   */
  readonly userId?: Id;
  /** `search[content]`: partial, case- and accent-insensitive. */
  readonly contentContains?: string;
  /** `exact_search[sender_id]`. */
  readonly senderId?: Id;
  /** `exact_search[receiver_id]`. */
  readonly receiverId?: Id;
  /**
   * `exact_search[read_at]` set to the null sentinel, i.e. `read_at IS NULL`.
   *
   * Reading unread messages is what MARKS them read, so this filter is
   * self-consuming: the same call that returns them empties the set it
   * matched. Use {@link DirectMessagesNamespace.conversedUsers} for a badge
   * count that survives being looked at.
   */
  readonly unreadOnly?: boolean;
}

/** Body of {@link DirectMessagesNamespace.send}. */
export interface SendMessageInput {
  /** Recipient. A user id string, never a handle. */
  readonly receiverId: Id;
  /**
   * Up to {@link MESSAGE_CONTENT_MAX_LENGTH} characters.
   *
   * Required UNLESS `attachment` is present: an attachment-only message has
   * the literal string `"No Content"` substituted for its missing caption. So
   * an attachment sent with no caption comes back with
   * `content: "No Content"`, in English, unlocalised, and every client has to
   * special-case that string when rendering. Send a caption if you have one.
   */
  readonly content?: string;
  /**
   * One file, up to {@link MESSAGE_ATTACHMENT_MAX_BYTES} - or
   * {@link MESSAGE_IMAGE_MAX_BYTES} if the server decides it is an image.
   *
   * A React Native pick (`{ uri, name, type }`) may be passed straight through;
   * the transport appends it verbatim to RN's `FormData` and refuses loudly on
   * any other runtime, where it would silently upload as `"[object Object]"`.
   *
   * An `image/*` attachment is NOT stored as sent: the server re-encodes it to
   * webp (quality 75, or 50 past 5 MiB) and renames it
   * `message_image_<timestamp>.webp`, so `attachment_filename` on the record
   * will not be the name you gave. Everything else is stored byte for byte.
   */
  readonly attachment?: FileInput | NativeFile;
  /**
   * Id of a message to quote. Any message id the server can find - there is
   * no check that the quoted row is in this conversation, or even visible to
   * either party. `quoted_preview` on the answer is rendered from it
   * unconditionally, so quoting a stranger's message id leaks 120 characters
   * of it. Only ever pass an id you took out of this same thread.
   */
  readonly quotedMessageId?: MessageId;
}

/**
 * One-to-one messages, reachable as `oms.social.messages`.
 *
 * ## `list()` IS NOT A READ
 *
 * {@link DirectMessagesNamespace.list} marks every matched row read before it
 * serialises anything. Read it in full before you call it from a poller, a
 * prefetch, or a retry loop.
 */
export class DirectMessagesNamespace extends Resource {
  /**
   * `GET /messages` - the caller's messages, sent and received, as one listing.
   *
   * ## This GET writes. Three ways it will surprise you.
   *
   * The server marks the matched rows read before rendering, and it does so
   * on the UNBOUNDED scope: every filter applies, and the page modifier
   * deliberately does not, because marking only the first page would leave
   * older messages showing unread. The consequences:
   *
   * 1. **An unfiltered `list()` marks your ENTIRE mailbox read**, every
   *    conversation, in one `UPDATE`. There is no read-only variant. Always
   *    pass {@link ListMessagesParams.withUser}.
   * 2. **It also stamps `read_at` on messages YOU sent.** The listing covers
   *    sent and received alike, and the read-marking does not know the
   *    difference. So opening a thread sets `read_at` on your own outgoing
   *    messages, and any UI that renders "seen" from `read_at` on the sender's
   *    side is reading your own visit back to you as the recipient's. Treat
   *    `read_at` on a message whose `sender_id` is yours as meaningless.
   * 3. **`updated_at` does NOT move.** The index's `ETag` is computed from the
   *    relation's count and its maximum `updated_at`, so a conditional GET can
   *    answer `304` while `read_at` underneath has changed. The SDK never
   *    sends `If-None-Match`, so this only bites a host that added its own
   *    caching layer.
   *
   * Retrying is safe in the sense that the second `UPDATE` writes the same
   * rows again; it is not safe in the sense that the damage is already done on
   * attempt one.
   *
   * ## Ordering and paging
   *
   * The server declares no default order. Offset pagination over an unordered
   * query in Postgres may repeat a row on one page and drop it from the next,
   * so the SDK always sends one: `created_at:desc` unless you pass `order`.
   * Newest first is what a chat view wants, since it opens at the bottom.
   *
   * With no page modifier at all the server would force `1:500`; the SDK sends
   * an explicit page so {@link Paginated.pageSize} matches what the rows were
   * counted against.
   *
   * ## Filters that do not exist
   *
   * The filter columns are `id, created_at, updated_at, content, sender_id,
   * receiver_id, read_at`, and unknown keys FAIL CLOSED with `400 "Unknown
   * search filter: ..."` rather than being dropped. So there is no filter for
   * `attachment_kind`, none for `edited_at`, and no way to ask for "messages
   * since X" other than `search[created_at]`, which is a partial string match
   * on the rendered timestamp and is not a range query. Fetch and filter here.
   *
   * Costs one request against the general authenticated ceiling (600/min).
   */
  async list(params: ListMessagesParams = {}, options: RequestOptions = {}): Promise<Paginated<DirectMessage>> {
    const base: ListQueryBase = {
      order: "created_at:desc",
      search: { content: params.contentContains },
      exactSearch: {
        sender_id: params.senderId,
        receiver_id: params.receiverId,
        ...(params.unreadOnly === true ? { read_at: null } : {}),
      },
      extraOptions: { user_id: params.userId, other_user_id: params.withUser },
    };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<DirectMessage[]>("/messages", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * One conversation, newest first. `list()` with
   * {@link ListMessagesParams.withUser} already filled in.
   *
   * This is the call a chat screen should make, and the reason it exists as its
   * own method is the read-marking described on {@link list}: scoping the
   * listing is what scopes the `UPDATE`. Opening a thread marks that thread
   * read, which is what a user expects. Calling `list()` bare does not.
   */
  async conversation(
    userId: Id,
    params: Omit<ListMessagesParams, "withUser"> = {},
    options: RequestOptions = {},
  ): Promise<Paginated<DirectMessage>> {
    return this.list({ ...params, withUser: userId }, options);
  }

  /**
   * `GET /messages/conversed_users` - one row per person the caller has ever
   * exchanged a message with, newest conversation first, each carrying the
   * latest message either way and the caller's unread count from that sender.
   *
   * This is the inbox list, and it is the ONLY endpoint here that reports
   * unread counts without destroying them: it does not mark anything read.
   * Poll this one, not {@link list}.
   *
   * Not paginated and not filterable - it is a bespoke action, not a listing,
   * so it carries no `ETag` and ignores every modifier. The whole set comes
   * back on every call, and the cost is bounded by how many people you have
   * talked to rather than by how many messages there are: one `DISTINCT ON`
   * for the latest message per counterpart, one grouped `COUNT` for the unread
   * numbers, and only that bounded set is hydrated.
   *
   * `last_message.preview` is 120 characters of content, or a bracketed
   * placeholder (`"[image]"`, `"[audio]"`, `"[video]"`, `"[file]"`) when the
   * newest message is an attachment. It is always a string, never `null`.
   *
   * A user you have messaged appears here even if one of you has since blocked
   * the other; the rows are built from message history, not from
   * {@link Relationship}. Cross-reference
   * {@link RelationshipsNamespace.list} if the UI needs to hide those.
   */
  async conversedUsers(options: RequestOptions = {}): Promise<ConversedUser[]> {
    return this.http.get<ConversedUser[]>("/messages/conversed_users", options);
  }

  /**
   * `GET /messages/:id` - one message, by id.
   *
   * Scoped to the caller's own messages, so a message between two other people
   * is `404 "Resource not found"` rather than `403`. Does NOT mark anything
   * read, which makes it the safe way to re-read a single row.
   *
   * Returns exactly the same fields as a row from {@link list}.
   */
  async get(id: MessageId, options: RequestOptions = {}): Promise<DirectMessage> {
    return this.http.get<DirectMessage>(`/messages/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `POST /messages` - sends one message. `201` with the created record.
   *
   * The sender is always the authenticated user; there is no way to say
   * otherwise and `sender_id` in the body is ignored.
   *
   * ## What "the recipient blocked me" looks like
   *
   * A `401 "You are not authorized to create this resource"` is how a block is
   * announced - after the request, never before it, because the block that
   * stops you is invisible to you: rows where you are the `accepter` of a
   * `block` are hidden from you. You cannot look up whether you are blocked;
   * you can only be refused.
   *
   * The test is one-directional. If YOU blocked THEM, nothing here stops you
   * from messaging them, and the message is delivered.
   *
   * ## Transport
   *
   * Sent as JSON when there is no attachment and as `multipart/form-data` when
   * there is - the same route accepts both, and multipart is what makes a file
   * possible at all. In multipart the numeric `quoted_message_id` goes out as
   * text and the server casts it back; that is normal and not a precision risk
   * at these magnitudes.
   *
   * The field is named `attachment`. A legacy `image` field is still accepted
   * and funnelled to the same blob, but nothing new should send it.
   *
   * ## What is refused here rather than by the server
   *
   * An image between {@link MESSAGE_IMAGE_MAX_BYTES} and
   * {@link MESSAGE_ATTACHMENT_MAX_BYTES} passes the general cap and then dies
   * inside the webp recompressor, which is a **500** with an error alert behind
   * it rather than a `400`. This method throws before sending when the size is
   * knowable. It stays silent when it is not - a `ReadableStream` with no
   * declared `size`, or a picker that reported none - because buffering a file
   * just to measure it would be worse than the server's answer.
   *
   * NOT retried: this is a `POST`, and a replay after a lost response sends the
   * message twice.
   *
   * @throws {OmsError} `invalid_request` when neither content nor an
   *   attachment is present, when content is over the length cap, or when a
   *   knowably-oversized image would 500.
   * @throws {OmsApiError} `401` when the recipient has blocked the caller,
   *   `400` when the recipient does not exist or the content is empty.
   */
  async send(input: SendMessageInput, options: RequestOptions = {}): Promise<DirectMessage> {
    assertPresent("receiverId", input.receiverId);
    const content = input.content ?? "";
    if (content.length === 0 && input.attachment === undefined) {
      throw new OmsError(
        "A message needs content or an attachment: `content` is NOT NULL with a presence validation, and the " +
          "server would answer 400.",
        "invalid_request",
      );
    }
    if (content.length > MESSAGE_CONTENT_MAX_LENGTH) {
      throw new OmsError(
        `content is ${content.length} characters; Message validates it at ${MESSAGE_CONTENT_MAX_LENGTH}.`,
        "invalid_request",
      );
    }

    if (input.attachment === undefined) {
      return this.http.post<DirectMessage>(
        "/messages",
        {
          receiver_id: input.receiverId,
          content,
          ...(input.quotedMessageId === undefined ? {} : { quoted_message_id: input.quotedMessageId }),
        },
        options,
      );
    }

    assertAttachmentSize("attachment", input.attachment);
    return this.http.postForm<DirectMessage>(
      "/messages",
      {
        receiver_id: input.receiverId,
        // Sent even when empty: the server substitutes "No Content" for a
        // blank caption, and an omitted field reaches the same hook anyway.
        content,
        attachment: input.attachment,
        ...(input.quotedMessageId === undefined ? {} : { quoted_message_id: input.quotedMessageId }),
      },
      options,
    );
  }

  /**
   * `PATCH /messages/:id` - rewrites the content of a message you sent.
   *
   * `content` is the only writable field. An attachment cannot be added,
   * replaced or removed after the fact, and `receiver_id` is fixed.
   *
   * Allowed only while you are the sender AND the message is younger than
   * {@link MESSAGE_EDIT_WINDOW_MS}. Past the window the answer is `401`, not
   * `403` and not `422`. Use {@link canEditMessage} to grey the button out,
   * and still handle the `401`: the window is measured on the server's clock.
   *
   * A successful edit stamps `edited_at`, which every client renders as an
   * "edited" marker. It is stamped only when the content actually changes: a
   * no-op PATCH with an identical string does NOT mark it edited, but any
   * different string does, including whitespace.
   *
   * There is no cable broadcast for an edit. The other side sees the new text
   * whenever it next fetches, and never learns that it changed.
   */
  async edit(id: MessageId, content: string, options: RequestOptions = {}): Promise<DirectMessage> {
    if (content.length > MESSAGE_CONTENT_MAX_LENGTH) {
      throw new OmsError(
        `content is ${content.length} characters; Message validates it at ${MESSAGE_CONTENT_MAX_LENGTH}.`,
        "invalid_request",
      );
    }
    return this.http.patch<DirectMessage>(`/messages/${encodeURIComponent(String(id))}`, { content }, options);
  }

  /**
   * `DELETE /messages/:id` - `204`, empty body.
   *
   * The sender may delete at any time; there is no edit window on destroy and
   * the receiver cannot delete a message they were sent. The row and its blob
   * go for both parties at once, so this is "unsend", not "hide from my copy".
   *
   * A message that another message quotes can still be deleted. The quoting
   * row keeps its `quoted_preview` - the snapshot was serialised at render
   * time from the association, so once the quoted row is gone the preview
   * becomes `null` on the next fetch and the quote silently empties.
   *
   * Not retried, like every write. A `DELETE` replayed after a torn connection
   * would answer `404` for a row it deleted perfectly well.
   */
  async delete(id: MessageId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/messages/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `GET /messages/:id/attachment` - the bytes of the attached file.
   *
   * The route answers `302` to a presigned object-store URL, and `fetch`
   * follows that redirect on its own. Which means this method works everywhere
   * EXCEPT a browser in cookie mode: the request carries credentials, the
   * redirected request arrives at the store with `Origin: null`, and the store
   * answers a wildcard `Access-Control-Allow-Origin`, which CORS forbids for a
   * credentialed request. There, use {@link attachmentUrl} and let an `<img>`,
   * a `<video>` or an `<a download>` follow the redirect with no CORS check.
   *
   * Filename, byte size and kind are already on the {@link DirectMessage},
   * which is why this hands back bare bytes.
   *
   * @throws {OmsError} `unsupported` when the redirect was blocked by CORS.
   * @throws {OmsApiError} `404 "Message not found"` when the message is not
   *   yours, `404 "No attachment"` when it carries none.
   */
  async attachment(id: MessageId, options: RequestOptions = {}): Promise<Blob> {
    const path = `/messages/${encodeURIComponent(String(id))}/attachment`;
    return followAttachment(this.http, path, "message", options);
  }

  /**
   * Absolute URL for a message attachment, for an `<img>`, an `<a download>` or
   * a new tab. In a browser in cookie mode this is the only way to reach the
   * bytes; see {@link attachment}.
   *
   * Asynchronous because the credential has to be resolved first, and resolving
   * it may involve a token refresh.
   *
   * - **cookie mode**: no credential in the URL; the browser attaches the
   *   host-only `oms_session` cookie itself. Do not put `crossorigin` on the
   *   element - that turns a no-cors load into a CORS one and re-creates the
   *   failure this method exists to avoid.
   * - **token mode**: the token is appended as `?token=`, which is what a
   *   native client needs because an `<img>` cannot carry a header.
   *
   * THE TOKEN-MODE URL CONTAINS A LIVE CREDENTIAL. Build it at the moment of
   * use, never store it, never log it, and never hand it to anything outside
   * your own page - fetch the bytes with {@link attachment} and pass a `blob:`
   * URL instead.
   *
   * There is a legacy twin at `/messages/:id/image`. It resolves to the same
   * blob for image messages and is not worth calling from new code.
   */
  async attachmentUrl(id: MessageId): Promise<string> {
    const token = await tokenOf(this.http);
    const path = `/messages/${encodeURIComponent(String(id))}/attachment`;
    return this.http.url(path, token === null ? undefined : { token });
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Declared content type of an attachment, when there is one. */
function attachmentContentType(file: FileInput | NativeFile): string | undefined {
  if (isNativeFile(file)) return file.type;
  if (file.contentType !== undefined && file.contentType !== "") return file.contentType;
  const data = file.data;
  if (isNativeFile(data)) return data.type;
  if (typeof Blob === "function" && data instanceof Blob && data.type !== "") return data.type;
  return undefined;
}

/**
 * Refuses a direct-message attachment the server would mishandle.
 *
 * Two ceilings, because the general cap and the image cap disagree: 25 MiB
 * for anything, 20 MiB for an image. The image band between them is the one
 * that matters, because there the server answers `500` and fires an error alert
 * rather than answering `400`.
 */
function assertAttachmentSize(field: string, file: FileInput | NativeFile): void {
  const size = attachmentSize(file);
  if (size === undefined) return;
  if (size > MESSAGE_ATTACHMENT_MAX_BYTES) {
    throw new OmsError(
      `${field} is ${size} bytes; the server accepts at most ${MESSAGE_ATTACHMENT_MAX_BYTES}.`,
      "invalid_request",
    );
  }
  const type = attachmentContentType(file);
  if (type !== undefined && type.startsWith("image/") && size > MESSAGE_IMAGE_MAX_BYTES) {
    throw new OmsError(
      `${field} is a ${size}-byte image. The controller's cap is ${MESSAGE_ATTACHMENT_MAX_BYTES}, but ` +
        `ImageProcessors::Message refuses anything over ${MESSAGE_IMAGE_MAX_BYTES} with an error that reaches ` +
        "the client as a 500 rather than a 400. Resize or recompress it first.",
      "invalid_request",
    );
  }
}
