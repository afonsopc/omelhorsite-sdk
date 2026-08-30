/**
 * The `social` namespace: direct messages, relationships and group chats.
 *
 * Three tables' worth of API that a chat screen needs at once, exposed as one
 * entry class with three sub-namespaces
 * ({@link SocialNamespace.messages}, `.relationships`, `.groupChats`) plus a
 * fourth hanging off the third ({@link GroupChatsNamespace.messages}). Every
 * sub-namespace is exported on its own so a host that prefers
 * `oms.messages` can mount it there instead.
 *
 * ## THIS NAMESPACE IS HALF A CHAT CLIENT. THE OTHER HALF IS THE CABLE.
 *
 * Everything here is HTTP request/response, and HTTP request/response cannot
 * deliver a message you did not ask for. A UI built on this file alone shows a
 * new message when it next polls, which is the difference between a chat app
 * and a mailbox with a refresh button.
 *
 * The live half such as it is arrives over Action Cable (`/cable`), on
 * `NotificationsChannel` - one stream per user, which this SDK does not speak.
 * Nothing in this file opens a socket, and no method here will ever resolve
 * because somebody else typed.
 *
 * And the cable carries LESS than a chat client wants. What lands is
 * `{ type: "created", notification, unread_count }`, where `notification` is a
 * `Notification` row, not a message: for a direct message its `kind` is
 * `"message_received"` and its `context` is
 * `{ sender_id, message_id, preview }` - 120 characters of text and an id. So
 * even a client that speaks the cable has to come back here for the record.
 * Relationships get `friendship_request` and `friendship_accepted` the same
 * way. **Group chats get nothing at all** - no channel, no notification row,
 * no push - and must be polled; see {@link GroupChatsNamespace}.
 *
 * So the shape a real client takes is: this namespace for history, sending,
 * editing and the conversation list; the cable as a nudge to re-fetch; and a
 * reconcile on reconnect, because a socket that was down missed messages that
 * only {@link DirectMessagesNamespace.list} and
 * {@link GroupChatMessagesNamespace.list} can fill back in. Until the SDK grows
 * a cable transport, all of that is the host's problem.
 *
 * ## IDS ARE INCONSISTENT ACROSS THE THREE FAMILIES
 *
 * `messages` and `relationships` kept auto-increment primary keys, so their
 * ids arrive as JSON NUMBERS. `group_chats`, `group_chat_members` and
 * `group_chat_messages` are `id: :string` tables, so theirs arrive as STRINGS.
 * The `sender_id` / `receiver_id` / `user_id` on all five are strings, because
 * users are. That is why {@link DirectMessage} and {@link Relationship} spell
 * their `id` out rather than extending `BaseRecord`, whose `id` is a string,
 * while {@link GroupChat} and {@link GroupChatMessage} do extend it.
 *
 * ## Reachability
 *
 * None of these routes is anonymous, and none of them declares an
 * `oauth_scope`. `Authentication#enforce_oauth_scope!` denies by default, so a
 * CLI or MCP host holding a Doorkeeper access token gets
 * `403 {"error":"insufficient_scope"}` on every method in this file whatever
 * scopes it was granted. Use a session token (`POST /sessions`) or, in the
 * browser, the session cookie.
 *
 * ## Throttling
 *
 * `Rack::Attack` has no bucket of its own for any of these paths: they all
 * land in `general/authed`, **600 requests a minute** keyed on the
 * `Authorization` header (or `general/anon`, 120/min/IP, which none of these
 * routes can reach because they all require a user). That ceiling is shared
 * with every other authenticated call the same client makes, so a chat screen
 * polling three endpoints on a two-second timer is spending 90/min of a budget
 * the rest of the app also draws on. See the per-method notes for where the
 * cost actually is.
 */

import { OmsError, OmsNetworkError } from "../errors";
import { type ApiClient, Resource, type TokenProvider } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams, ListQueryBase } from "../listing";
import type { User } from "./account";
import type { BaseRecord, FileInput, Id, NativeFile, Paginated, QueryParams, RequestOptions, Timestamp } from "../types";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, isNativeFile } from "../types";

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Primary key of a direct message. An INTEGER: `messages` is one of the tables
 * that kept an auto-increment key, so `id` and `quoted_message_id` are JSON
 * numbers while `sender_id` and `receiver_id` beside them are strings.
 */
export type MessageId = number;

/** Primary key of a relationship row. An integer, for the same reason. */
export type RelationshipId = number;

/**
 * Primary key of a group chat. A STRING - `group_chats` is an `id: :string`
 * table, unlike the two above it in this same file.
 */
export type GroupChatId = string;

/** Primary key of a membership row. A string. */
export type GroupChatMemberId = string;

/** Primary key of a group chat message. A string. */
export type GroupChatMessageId = string;

/* -------------------------------------------------------------------------- */
/* Limits the server enforces                                                 */
/* -------------------------------------------------------------------------- */

/** `Message` validates `content` at 1024 characters. Longer is a `400`. */
export const MESSAGE_CONTENT_MAX_LENGTH = 1024;

/** `GroupChatMessage` allows four thousand, not one thousand. */
export const GROUP_CHAT_MESSAGE_CONTENT_MAX_LENGTH = 4000;

/** `GroupChat.NAME_MAX`. */
export const GROUP_CHAT_NAME_MAX_LENGTH = 120;

/**
 * `ATTACHMENT_MAX_BYTES` on both message models: 25 MiB, checked in the
 * controller before anything is attached.
 *
 * IMAGES HAVE A LOWER, WORSE-BEHAVED CEILING. See
 * {@link MESSAGE_IMAGE_MAX_BYTES}.
 */
export const MESSAGE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The ceiling that actually applies to an attachment the server decides is an
 * image: `ImageProcessors::Message::MAX_SIZE`, 20 MiB.
 *
 * The two caps disagree and the gap is not harmless. The controller checks 25
 * MiB, then hands anything whose `content_type` starts with `image/` to the
 * webp recompressor, which checks 20 MiB and raises a plain `ArgumentError` -
 * not the `InvalidImage` that `ApplicationController` turns into a `400`. So a
 * 22 MiB JPEG is a **500** with a Discord error alert behind it, where a 22 MiB
 * zip is accepted.
 *
 * {@link DirectMessagesNamespace.send} refuses that band client-side when the
 * size is knowable, which is the only place the mistake is still cheap.
 */
export const MESSAGE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Pixel ceilings `ImageProcessors::Processor#reject_bomb!` applies to an image
 * attachment before any full-frame decode: 12000px on either side, and 50
 * megapixels of area. Past either one the answer is `400` with the dimensions
 * in the body, and deliberately no error alert.
 *
 * Not checkable here - the SDK does not decode images - so this is
 * documentation, not a guard.
 */
export const MESSAGE_IMAGE_MAX_DIMENSION_PX = 12_000;
/** @see MESSAGE_IMAGE_MAX_DIMENSION_PX */
export const MESSAGE_IMAGE_MAX_PIXELS = 50_000_000;

/**
 * `EDIT_WINDOW` on both message models: fifteen minutes from `created_at`,
 * after which `updatable_by?` is false and an edit is `401`.
 *
 * Measured against the SERVER's clock. {@link canEditMessage} compares against
 * the caller's, which is close enough to grey out a button and not close
 * enough to promise the edit will land.
 */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Rows `GET /group_chats/:id/messages` returns per call.
 *
 * A hard constant in `GroupChatMessagesController`, not a modifier: this
 * endpoint does not speak the list DSL and `modifiers[page]` on it is ignored.
 */
export const GROUP_CHAT_MESSAGE_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/** How the server classified an attachment, from its `content_type`. */
export type AttachmentKind = "image" | "audio" | "video" | "file";

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
 * {@link User} objects, from `association :sender` / `:receiver` on the
 * blueprint's default view. That is most of the bytes of a page of messages,
 * it is the same two records repeated a hundred times, and there is no view
 * that omits them. Budget for it on a mobile connection.
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
   * It is set by `MessagesController#index` on every row the listing matched,
   * in both directions, so it means "somebody who can see this message listed
   * it" and nothing more precise. On a message the CALLER sent, it was almost
   * certainly stamped by the caller's own listing rather than by the
   * recipient's - opening a thread marks your own outgoing messages read. A
   * "seen" tick built on this field lies.
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

/** A relationship row: one friendship or one block, between two users. */
export interface Relationship {
  /** Integer. */
  readonly id: RelationshipId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly kind: RelationshipKind;
  readonly status: RelationshipStatus;
  /** Whoever created the row. Always `Current.user` at create time. */
  readonly requester_id: Id;
  readonly accepter_id: Id;
  readonly requester: User;
  readonly accepter: User;
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

/** Newest message in a chat, as the chat record summarises it. */
export interface GroupChatLastMessage {
  readonly id: GroupChatMessageId;
  readonly sender_id: Id | null;
  readonly preview: string;
  readonly attachment_kind: AttachmentKind | null;
  readonly created_at: Timestamp;
}

/** One membership row, as the `:extended` chat view embeds it. */
export interface GroupChatMember {
  readonly id: GroupChatMemberId;
  readonly user_id: Id;
  readonly user_handle: string | null;
  readonly user_name: string | null;
  readonly role: GroupChatRole;
  readonly joined_at: Timestamp;
}

/**
 * A group chat, as the index renders it.
 *
 * Extends {@link BaseRecord}, which the two integer-keyed records in this file
 * cannot: `group_chats` is an `id: :string` table, so its key is the same
 * opaque string every other resource in the SDK uses.
 */
export interface GroupChat extends BaseRecord {
  readonly id: GroupChatId;
  readonly name: string | null;
  readonly kind: "ad_hoc";
  readonly system_managed: boolean;
  readonly context_type: string | null;
  readonly context_id: string | null;
  readonly last_message: GroupChatLastMessage | null;
}

/** The `:extended` view: {@link GroupChat} plus the roster. */
export interface GroupChatDetail extends GroupChat {
  readonly members: GroupChatMember[];
}

/** A message inside a group chat. */
export interface GroupChatMessage extends BaseRecord {
  readonly id: GroupChatMessageId;
  readonly group_chat_id: GroupChatId;
  /** Null on a system message. */
  readonly sender_id: Id | null;
  readonly sender_handle: string | null;
  readonly sender_name: string | null;
  readonly content: string | null;
  readonly attachment_kind: AttachmentKind | null;
  readonly has_attachment: boolean;
  readonly system_kind: string | null;
  readonly system_payload: Record<string, unknown>;
  readonly edited_at: Timestamp | null;
  readonly attachment_filename?: string;
  readonly attachment_byte_size?: number;
  readonly attachment_content_type?: string;
}

/** Membership role. */
export type GroupChatRole = "member" | "admin";

/** What a relationship row means. */
export type RelationshipKind = "friend" | "block";

/** Where a relationship row is in its lifecycle. */
export type RelationshipStatus = "pending" | "accepted";

/* -------------------------------------------------------------------------- */
/* Namespaces                                                                 */
/* -------------------------------------------------------------------------- */

/** The `social` namespace, reachable as `oms.social`. */
export class SocialNamespace extends Resource {
  /** One-to-one messages. */
  readonly messages: DirectMessagesNamespace;
  /** Friendships and blocks. */
  readonly relationships: RelationshipsNamespace;
  /** Many-to-many chats, their roster and their messages. */
  readonly groupChats: GroupChatsNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.messages = new DirectMessagesNamespace(http);
    this.relationships = new RelationshipsNamespace(http);
    this.groupChats = new GroupChatsNamespace(http);
  }
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
   * Redundant for a normal caller - the listing scope is already
   * `Current.user.messages`, so passing your own id narrows nothing - and it
   * cannot widen the scope to somebody else's mailbox either. The web frontend
   * sends it anyway (`Message.listWithUser` fetches the session just to fill it
   * in), which costs a `GET /sessions/mine` per conversation open for no
   * result. It is exposed here only so a caller porting that code can keep the
   * wire identical.
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
   * Required UNLESS `attachment` is present: `content` is `NOT NULL` with a
   * `presence` validation, and the only thing that saves an attachment-only
   * message is a `before_validation` hook that substitutes the literal string
   * `"No Content"`. So an attachment sent with no caption comes back with
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
   * An `image/*` attachment is NOT stored as sent: `ImageProcessors::Message`
   * re-encodes it to webp (quality 75, or 50 past 5 MiB) and renames it
   * `message_image_<timestamp>.webp`, so `attachment_filename` on the record
   * will not be the name you gave. Everything else is stored byte for byte.
   */
  readonly attachment?: FileInput | NativeFile;
  /**
   * Id of a message to quote. Any message id the server can find - it is a
   * plain `belongs_to :quoted_message, optional: true` with no validation that
   * the quoted row is in this conversation, or even visible to either party.
   * `quoted_preview` on the answer is rendered from it unconditionally, so
   * quoting a stranger's message id leaks 120 characters of it. Only ever pass
   * an id you took out of this same thread.
   */
  readonly quotedMessageId?: MessageId;
}

/**
 * One-to-one messages, reachable as `oms.social.messages`.
 *
 * ## `list()` IS NOT A READ
 *
 * `MessagesController#index` runs an `update_all(read_at: Time.current)` before
 * it serialises anything. Read {@link DirectMessagesNamespace.list} in full
 * before you call it from a poller, a prefetch, or a retry loop.
 */
export class DirectMessagesNamespace extends Resource {
  /**
   * `GET /messages` - the caller's messages, sent and received, as one listing.
   *
   * ## This GET writes. Three ways it will surprise you.
   *
   * The controller marks the matched rows read before rendering, and it does
   * so on the UNBOUNDED scope: `listing_scope.search(...).exact_search(...)
   * .extra_options(...).update_all(read_at: Time.current)`. The page modifier
   * is deliberately not in that chain, because marking only the first page
   * would leave older messages showing unread. The consequences:
   *
   * 1. **An unfiltered `list()` marks your ENTIRE mailbox read**, every
   *    conversation, in one `UPDATE`. There is no read-only variant. Always
   *    pass {@link ListMessagesParams.withUser}.
   * 2. **It also stamps `read_at` on messages YOU sent.** The listing scope is
   *    `sent_messages.or(received_messages)`, and `update_all` does not know
   *    the difference. So opening a thread sets `read_at` on your own outgoing
   *    messages, and any UI that renders "seen" from `read_at` on the sender's
   *    side is reading your own visit back to you as the recipient's. Treat
   *    `read_at` on a message whose `sender_id` is yours as meaningless.
   * 3. **`updated_at` does NOT move**, because `update_all` skips callbacks.
   *    The index's `ETag` is computed from the relation's count and its maximum
   *    `updated_at`, so a conditional GET can answer `304` while `read_at`
   *    underneath has changed. The SDK never sends `If-None-Match`, so this
   *    only bites a host that added its own caching layer.
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
   * `search_params` is `id, created_at, updated_at, content, sender_id,
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
   * newest message is an attachment. It is always a string, never `null`,
   * despite what the web frontend's type says.
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
   * Scoped to `Current.user.messages`, so a message between two other people is
   * `404 "Resource not found"` rather than `403`. Does NOT mark anything read,
   * which makes it the safe way to re-read a single row.
   *
   * The `:extended` view is empty on `MessageBlueprint`, so this returns
   * exactly the same fields as a row from {@link list}.
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
   * `Message#creatable_by?` is `receiver.blockeds.exclude?(user)`, so a `401
   * "You are not authorized to create this resource"` is how a block is
   * announced - after the request, never before it, because the block that
   * stops you is invisible to you: `Relationship`'s default scope hides rows
   * where you are the `accepter` of a `block`. You cannot look up whether you
   * are blocked; you can only be refused.
   *
   * The test is one-directional. If YOU blocked THEM, nothing here stops you
   * from messaging them, and the message is delivered.
   *
   * ## Transport
   *
   * Sent as JSON when there is no attachment and as `multipart/form-data` when
   * there is - the same route accepts both, and multipart is what makes a file
   * possible at all. In multipart the numeric `quoted_message_id` goes out as
   * text and Rails casts it back; that is normal and not a precision risk at
   * these magnitudes.
   *
   * The field is named `attachment`. The controller still accepts a legacy
   * `image` field and funnels it to the same blob, but nothing new should send
   * it.
   *
   * ## What is refused here rather than by the server
   *
   * An image between {@link MESSAGE_IMAGE_MAX_BYTES} and
   * {@link MESSAGE_ATTACHMENT_MAX_BYTES} passes the controller's cap and then
   * dies inside the webp recompressor with a bare `ArgumentError`, which is a
   * **500** with an error alert behind it rather than a `400`. This method
   * throws before sending when the size is knowable. It stays silent when it is
   * not - a `ReadableStream` with no declared `size`, or a picker that reported
   * none - because buffering a file just to measure it would be worse than the
   * server's answer.
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
   * Allowed only while `Message#updatable_by?` holds: you are the sender AND
   * the message is younger than {@link MESSAGE_EDIT_WINDOW_MS}. Past the
   * window the answer is `401`, not `403` and not `422`. Use
   * {@link canEditMessage} to grey the button out, and still handle the `401`:
   * the window is measured on the server's clock.
   *
   * A successful edit stamps `edited_at`, which every client renders as an
   * "edited" marker. Setting the same content back still stamps it - the
   * controller's `before_update` only checks `content_changed?`, so a no-op
   * PATCH with an identical string does NOT mark it edited, but any different
   * string does, including whitespace.
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
   * There is a legacy twin at `/messages/:id/image` that the web frontend still
   * links to from cached bundles and push deep-links. It resolves to the same
   * blob for image messages and is not worth calling from new code.
   */
  async attachmentUrl(id: MessageId): Promise<string> {
    const token = await tokenOf(this.http);
    const path = `/messages/${encodeURIComponent(String(id))}/attachment`;
    return this.http.url(path, token === null ? undefined : { token });
  }
}

/* -------------------------------------------------------------------------- */
/* Relationships                                                              */
/* -------------------------------------------------------------------------- */

/** Filter columns of `GET /relationships`, on top of {@link BASE_FILTER_COLUMNS}. */
export const RELATIONSHIP_FILTER_COLUMNS = Object.freeze(["requester_id", "accepter_id"] as const);

/** `extra_options` keys of `GET /relationships`. */
export const RELATIONSHIP_EXTRA_OPTION_KEYS = Object.freeze(["user_id"] as const);

/** `extra_options` of `GET /relationships`. `user_id` matches rows where the user is either end. */
export interface RelationshipExtraOptions {
  readonly user_id?: Id;
}

/** Filters accepted by {@link RelationshipsNamespace.list}. */
export interface ListRelationshipsParams
  extends ListParams<(typeof RELATIONSHIP_FILTER_COLUMNS)[number], RelationshipExtraOptions> {
  /**
   * `extra_options[user_id]`: rows where this user is either end.
   *
   * Worth passing your own id even though it narrows nothing. The filter is
   * what makes `QueryExtraOptions::Relationships` run at all, and running it is
   * what applies its `INCLUDES = [:requester, :accepter]`. Without it the
   * blueprint renders a full nested {@link User} for both ends of every row out
   * of an unprepared query - two extra `SELECT`s per relationship.
   */
  readonly userId?: Id;
  /** `exact_search[requester_id]`: rows this user created. */
  readonly requesterId?: Id;
  /** `exact_search[accepter_id]`: rows aimed at this user. */
  readonly accepterId?: Id;
}

/** Body of {@link RelationshipsNamespace.create}. */
export interface CreateRelationshipInput {
  /** The other user. */
  readonly userId: Id;
  /** `"friend"` for a request, `"block"` for a block. */
  readonly kind: RelationshipKind;
}

/**
 * Friendships and blocks, reachable as `oms.social.relationships`.
 *
 * ## The state machine is TWO columns, not one
 *
 * There is no single `status` enum with a `blocked` member, however the UIs
 * present it. A row carries `kind` (`friend` | `block`) and `status`
 * (`pending` | `accepted`), and only three of the four combinations exist:
 *
 * | kind     | status     | what it is                                     |
 * | -------- | ---------- | ---------------------------------------------- |
 * | `friend` | `pending`  | a friend request, awaiting the accepter         |
 * | `friend` | `accepted` | a friendship                                    |
 * | `block`  | `accepted` | the requester has blocked the accepter          |
 *
 * `block` + `pending` is unreachable: a `before_create` forces a block to
 * `accepted` at birth, which also means a block's status can never be edited
 * afterwards (see the transition rules below). Blocking is asymmetric and
 * direction matters - `requester_id` blocked `accepter_id`, never the reverse.
 *
 * ## Transitions the server will accept
 *
 * `PATCH` may write `status` and nothing else. `Relationship#before_update`
 * aborts any change whose PREVIOUS value was `accepted`, so:
 *
 * - `pending -> accepted` is the one real transition, and it is what
 *   {@link accept} does;
 * - `pending -> pending` is a no-op that answers `200`, because nothing
 *   changed and the guard only fires on a change;
 * - `accepted -> pending` is refused, `400 "Status cannot be changed"`;
 * - `accepted -> accepted` is a no-op `200`, same reason as above;
 * - anything outside `pending` / `accepted` is refused by the inclusion
 *   validation, `400 "Status is not included in the list"`.
 *
 * There is no un-accept, no un-block and no "decline" verb. Ending ANY
 * relationship - rejecting a request, unfriending, unblocking - is
 * {@link delete} on the row. That is one method for three intentions, and the
 * server cannot tell them apart either.
 *
 * ## EITHER PARTY CAN ACCEPT. INCLUDING THE ONE WHO ASKED.
 *
 * `Relationship#updatable_by?` is `accepter == user || requester == user`, and
 * nothing narrows it for the `pending -> accepted` transition. So the sender of
 * a friend request can `PATCH` their own request to `accepted` and become the
 * recipient's friend without the recipient doing anything.
 *
 * That is a real hole, not a subtlety of this SDK, and it is load-bearing
 * because friendship gates real things elsewhere in the API - a `friends`
 * playlist becomes visible, the friends listening feed starts carrying that
 * user's playback. Do not build a UI that offers the requester an accept
 * button, and do not treat `status: "accepted"` as proof of consent from the
 * accepter.
 *
 * ## A block you receive is INVISIBLE to you
 *
 * `Relationship` has `default_scope { where.not(accepter: Current.user, kind:
 * "block") }`, which is applied to listings AND to lookups by id. You can see
 * blocks you made; you cannot see, list, count or delete a block someone made
 * against you. Its only observable effect is that
 * {@link DirectMessagesNamespace.send} answers `401`.
 *
 * ## Realtime
 *
 * Both interesting events reach the other party as `NotificationsChannel`
 * pushes rather than as anything on this namespace: `friendship_request`
 * (`{ asker_id, asker_handle }`) when a `friend`/`pending` row is created, and
 * `friendship_accepted` (`{ accepter_id, accepter_handle }`) when it flips.
 * Neither carries the relationship row, so a client still has to
 * {@link list} after the nudge. `block`, `delete` and every failed transition
 * are silent.
 */
export class RelationshipsNamespace extends Resource {
  /**
   * `GET /relationships` - every relationship the caller is part of, in either
   * direction, minus the blocks aimed at them.
   *
   * ## `kind` AND `status` ARE NOT FILTERABLE
   *
   * `search_params` on this controller is `requester_id, accepter_id` plus the
   * inherited `id, created_at, updated_at`. `kind` and `status` are absent, and
   * an unknown filter key does not get dropped - it is `400 "Unknown search
   * filter: kind"`. So "list my friends" is not a query the API can answer:
   * fetch the rows and filter here. {@link friends}, {@link incomingRequests},
   * {@link outgoingRequests} and {@link blocked} do exactly that.
   *
   * This is the single most surprising thing about the endpoint, and it is why
   * both the web frontend and the mobile app pull the whole set and filter in
   * JavaScript rather than because nobody thought of it.
   *
   * ## Paging
   *
   * The SDK sends an explicit `modifiers[page]` and an explicit
   * `created_at:desc` order, for the usual reason: with no page the server
   * silently forces `1:500`, and offset paging over an unordered query can
   * repeat and skip rows. `listRelationships()` in the mobile app sends
   * neither, so it truncates at 500 rows without saying so - a real ceiling for
   * an account with a long history, since blocks and dead requests count
   * towards it.
   *
   * Indexes carry an `ETag`, so a conditional GET can come back `304`; the SDK
   * does not send `If-None-Match` of its own.
   */
  async list(
    params: ListRelationshipsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<Relationship>> {
    const base: ListQueryBase = {
      order: "created_at:desc",
      exactSearch: { requester_id: params.requesterId, accepter_id: params.accepterId },
      extraOptions: { user_id: params.userId },
    };
    return paginate(params, DEFAULT_PAGE_SIZE, (at) =>
      this.http.get<Relationship[]>("/relationships", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * Every relationship row, paged out in full and filtered in memory.
   *
   * The building block under {@link friends} and its siblings, exported
   * because "fetch them all, then filter" is the only shape this endpoint
   * supports and every client ends up writing it.
   *
   * `limit` caps how many rows are pulled, so a pathological account cannot
   * turn one call into an unbounded walk. It defaults to 2000, which is four
   * requests at the server's maximum page size.
   */
  async all(
    params: ListRelationshipsParams = {},
    limit = 2000,
    options: RequestOptions = {},
  ): Promise<Relationship[]> {
    const rows: Relationship[] = [];
    let page = await this.list({ ...params, pageSize: MAX_PAGE_SIZE }, options);
    for (;;) {
      rows.push(...page.items);
      // Checked BEFORE asking for the next page, so a caller who wanted 700
      // rows spends two requests rather than three.
      if (rows.length >= limit) break;
      const next: Paginated<Relationship> | null = await page.next();
      if (next === null) break;
      page = next;
    }
    return rows.slice(0, limit);
  }

  /**
   * The caller's accepted friends, as {@link User} records rather than as
   * relationship rows.
   *
   * `selfId` is required and is NOT fetched for you: knowing which end of the
   * row is "the other person" needs the caller's own id, and this namespace
   * refuses to spend a `GET /sessions/mine` on every call to find it. Take it
   * from `oms.account.me()` once and keep it.
   *
   * A friend appears exactly once even though the row could be in either
   * direction. The result is derived from the same nested `requester` /
   * `accepter` objects the listing already carries, so this costs no extra
   * request beyond the paging {@link all} does.
   */
  async friends(selfId: Id, options: RequestOptions = {}): Promise<User[]> {
    const rows = await this.all({ userId: selfId }, 2000, options);
    const seen = new Set<Id>();
    const out: User[] = [];
    for (const row of rows) {
      if (row.kind !== "friend" || row.status !== "accepted") continue;
      const other = counterpart(row, selfId);
      if (other === undefined || seen.has(other.id)) continue;
      seen.add(other.id);
      out.push(other);
    }
    return out;
  }

  /**
   * Friend requests waiting for the caller to answer: `friend` + `pending`
   * rows where the caller is the ACCEPTER.
   *
   * These are the ones {@link accept} is meant for. Answer with {@link accept}
   * or refuse with {@link delete}; there is no third verb.
   *
   * This walks the listing itself, as do {@link friends}, {@link blocked} and
   * {@link outgoingRequests}, because the server cannot filter on `kind` or
   * `status`. A screen that wants more than one of them should call
   * {@link all} ONCE and sort the rows with {@link isFriendship},
   * {@link isPendingRequest} and {@link isBlock} rather than paying for the
   * same walk four times.
   */
  async incomingRequests(selfId: Id, options: RequestOptions = {}): Promise<Relationship[]> {
    const rows = await this.all({ userId: selfId }, 2000, options);
    return rows.filter((r) => r.kind === "friend" && r.status === "pending" && r.accepter_id === selfId);
  }

  /**
   * Friend requests the caller sent and nobody has answered: `friend` +
   * `pending` rows where the caller is the REQUESTER.
   *
   * {@link delete} on one of these is a cancel. {@link accept} on one of these
   * works too, and should not - see the class docs.
   */
  async outgoingRequests(selfId: Id, options: RequestOptions = {}): Promise<Relationship[]> {
    const rows = await this.all({ userId: selfId }, 2000, options);
    return rows.filter((r) => r.kind === "friend" && r.status === "pending" && r.requester_id === selfId);
  }

  /**
   * Users the caller has blocked.
   *
   * Only blocks the caller MADE. A block made against the caller is hidden by
   * the model's default scope and cannot be enumerated by any means; see the
   * class docs.
   */
  async blocked(selfId: Id, options: RequestOptions = {}): Promise<User[]> {
    const rows = await this.all({ userId: selfId }, 2000, options);
    return rows
      .filter((r) => r.kind === "block" && r.requester_id === selfId)
      .map((r) => r.accepter)
      .filter((u): u is User => u !== undefined && u !== null);
  }

  /**
   * `POST /relationships` - creates a row. `201` with the record.
   *
   * `requester_id` is forced to the authenticated user and `status` is not
   * writable: a `friend` starts `pending` from the column default, a `block` is
   * flipped to `accepted` by a `before_create`. Prefer {@link request} and
   * {@link block}, which say which of the two you meant.
   *
   * @throws {OmsApiError} `400 "Cannot create relationship with yourself"`,
   *   or `400 "A relationship of this kind already exists between these
   *   users"` when a `friend` row already exists in either direction.
   */
  async create(input: CreateRelationshipInput, options: RequestOptions = {}): Promise<Relationship> {
    assertPresent("userId", input.userId);
    return this.http.post<Relationship>(
      "/relationships",
      { accepter_id: input.userId, kind: input.kind },
      options,
    );
  }

  /**
   * Sends a friend request: `create({ kind: "friend" })`.
   *
   * At most one `friend` row may exist between two users in either direction,
   * and the uniqueness check runs UNSCOPED - it sees rows the default scope
   * hides from you. So a second request answers `400 "A relationship of this
   * kind already exists between these users"`, and so does requesting someone
   * who has already requested you (accept theirs instead) and, less obviously,
   * requesting someone who has blocked you: their block row counts as an
   * existing relationship. That last case is the only signal the API gives that
   * a block against you exists, and it is indistinguishable from a duplicate
   * request.
   *
   * The accepter gets a `friendship_request` notification over the cable.
   */
  async request(userId: Id, options: RequestOptions = {}): Promise<Relationship> {
    return this.create({ userId, kind: "friend" }, options);
  }

  /**
   * Blocks a user: `create({ kind: "block" })`.
   *
   * Three things happen server-side that no other call does:
   *
   * 1. the row is born `accepted`, so its status is immediately frozen;
   * 2. `destroy_existing_for_block` DELETES every existing relationship
   *    between the two of you first - an accepted friendship is gone, not
   *    suspended, and unblocking later does not bring it back;
   * 3. that deletion is skipped when a block already exists between you in
   *    EITHER direction, which also means **blocking is not idempotent**: a
   *    second call creates a SECOND block row rather than answering with the
   *    first, because the uniqueness validation deliberately exempts blocks.
   *    Check {@link blocked} before calling, and unblock all the rows you find.
   *
   * The effect on the other user is exactly one thing: their
   * {@link DirectMessagesNamespace.send} to you starts answering `401`. It does
   * not stop you messaging them, it does not hide either profile, and it does
   * not remove either of you from the other's
   * {@link DirectMessagesNamespace.conversedUsers}, which is built from message
   * history rather than from relationships.
   *
   * The blocked user is not notified.
   */
  async block(userId: Id, options: RequestOptions = {}): Promise<Relationship> {
    return this.create({ userId, kind: "block" }, options);
  }

  /**
   * `PATCH /relationships/:id` with `status: "accepted"` - accepts a pending
   * friend request. `200` with the updated record.
   *
   * Only ever call this on a row from {@link incomingRequests}. The server will
   * happily accept one of your OWN outgoing requests, which is a hole, not a
   * feature; see the class docs.
   *
   * The requester gets a `friendship_accepted` notification.
   *
   * @throws {OmsApiError} `400 "Status cannot be changed"` when the row was
   *   already `accepted` and something is trying to move it back; `401` when
   *   the caller is neither end of the row; `404 "Resource not found"` when the
   *   id is not visible to the caller - which includes a block made against
   *   them.
   */
  async accept(id: RelationshipId, options: RequestOptions = {}): Promise<Relationship> {
    return this.http.patch<Relationship>(
      `/relationships/${encodeURIComponent(String(id))}`,
      { status: "accepted" },
      options,
    );
  }

  /**
   * `DELETE /relationships/:id` - `204`, empty body.
   *
   * The one verb for every ending: rejecting an incoming request, cancelling an
   * outgoing one, unfriending, and unblocking. Either party may call it, and
   * the row is gone for both - there is no soft state and no history.
   *
   * Unblocking does NOT restore the friendship the block destroyed on its way
   * in. That row was deleted, not archived.
   *
   * Nobody is notified, so the other side finds out by noticing the row is no
   * longer in their listing.
   *
   * `GET /relationships/:id` does not exist - the route is
   * `only: [:create, :index, :destroy, :update]`, with no `show`. The web
   * frontend's `Relationship.get` calls it anyway and can only ever have got a
   * routing error back. Read a single row out of {@link list} instead.
   */
  async delete(id: RelationshipId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/relationships/${encodeURIComponent(String(id))}`, options);
  }
}

/* -------------------------------------------------------------------------- */
/* Group chats                                                                */
/* -------------------------------------------------------------------------- */

/** Body of {@link GroupChatsNamespace.create}. */
export interface CreateGroupChatInput {
  /**
   * Required, up to {@link GROUP_CHAT_NAME_MAX_LENGTH}. Blank, whitespace-only
   * and the null sentinel are all rejected with `400 "Name is required"`.
   */
  readonly name: string;
  /**
   * Everyone else to put in the chat, by user id.
   *
   * De-duplicated, stripped of blanks, and the caller's own id is removed - the
   * creator is added separately, as the chat's `admin`. Ids that do not name a
   * real user are DROPPED IN SILENCE: `User.where(id: member_ids)` simply
   * matches fewer rows, the call still answers `201`, and the only way to know
   * a member is missing is to count `members` on the answer.
   *
   * There is no friendship check and no invitation step. Anyone can be put into
   * a chat by anyone, and finds out by seeing it in their listing.
   */
  readonly memberIds?: readonly Id[];
}

/** Body of {@link GroupChatMessagesNamespace.send}. */
export interface SendGroupChatMessageInput {
  /**
   * Up to {@link GROUP_CHAT_MESSAGE_CONTENT_MAX_LENGTH} - four thousand
   * characters here, against one thousand for a direct message.
   *
   * Optional when `attachment` is present, and genuinely optional: unlike
   * {@link SendMessageInput.content}, nothing substitutes a placeholder, so an
   * attachment-only message comes back with `content: null`.
   */
  readonly content?: string;
  /**
   * One file, up to {@link MESSAGE_ATTACHMENT_MAX_BYTES}.
   *
   * Stored byte for byte. There is no webp recompression here and no
   * pixel-bomb check either, which is the opposite of what
   * {@link DirectMessagesNamespace.send} does with an image, so the 20 MiB
   * image ceiling does NOT apply and `attachment_content_type` on the answer is
   * whatever you uploaded.
   */
  readonly attachment?: FileInput | NativeFile;
}

/** Cursor for {@link GroupChatMessagesNamespace.list}. */
export interface ListGroupChatMessagesParams {
  /**
   * Return messages created strictly AFTER this one. Sent as `after_id`.
   *
   * Read {@link GroupChatMessagesNamespace.list} before using it: this cursor
   * fails open, and the failure looks like a working request.
   */
  readonly afterId?: GroupChatMessageId;
}

/**
 * Many-to-many chats, reachable as `oms.social.groupChats`.
 *
 * ## THERE IS NO REALTIME HERE AT ALL
 *
 * Direct messages at least push a `message_received` notification over the
 * cable. Group chats push NOTHING: no channel streams them, no `Notification`
 * row is written when a message lands, and the only thing a new group message
 * triggers server-side is a Discord alert for the operators. A group chat UI
 * has to poll {@link GroupChatMessagesNamespace.list} with an `after_id`
 * cursor, and there is no endpoint that will tell it which chats changed
 * without listing them.
 *
 * The cheapest honest loop is {@link GroupChatsNamespace.list} on a slow timer
 * for the chat list (it carries `last_message` per chat, so one request covers
 * every conversation) and
 * {@link GroupChatMessagesNamespace.list} with `afterId` on a fast timer for
 * the chat that is open. Both are on the general 600/min ceiling shared with
 * the rest of the app.
 *
 * ## Every id in this family is a STRING
 *
 * Unlike {@link DirectMessage} and {@link Relationship} two sections up.
 *
 * ## Only one `kind` exists
 *
 * `GroupChat::KINDS` is `["ad_hoc"]` and the controller hardcodes it on
 * create, so `kind` is always `"ad_hoc"`. `system_managed`, `context_type` and
 * `context_id` are there for a future subsystem that hangs its own chats off
 * the model; nothing writes them today. The web frontend types the kind as
 * `"site"`, which is a value the backend has never emitted.
 *
 * ## Errors here have a different SHAPE from the rest of the API
 *
 * `GroupChatsController` raises `not_found!` and `unauthorized!` with no
 * argument, so those answers carry the JSON body `null` rather than the bare
 * error string every CRUD controller sends. Branch on the status, not on the
 * body.
 */
export class GroupChatsNamespace extends Resource {
  /** Messages inside a chat. */
  readonly messages: GroupChatMessagesNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.messages = new GroupChatMessagesNamespace(http);
  }

  /**
   * `GET /group_chats` - every chat the caller is a member of, most recently
   * touched first.
   *
   * Returns a bare array and not a {@link Paginated}, because the endpoint
   * genuinely has no paging: it is a hand-written action, not a CRUD index, so
   * `modifiers[page]`, `search[...]` and the `ETag` are all absent and the
   * whole list comes back on every call. That is fine while a user has tens of
   * chats and is a cliff if one ever has thousands.
   *
   * `updated_at` is the sort key and it is touched by a new message
   * (`chat.touch` in the message controller), by a rename, and by nothing else
   * - a deleted message does not move a chat back down the list.
   *
   * Each chat carries a `last_message` summary, computed for the whole page in
   * one window-function query. That summary is what makes this endpoint usable
   * as a poll for "did anything change anywhere": compare `last_message.id`
   * per chat instead of listing every conversation.
   *
   * Members are NOT included - this is the default blueprint view. Use
   * {@link get} for the roster.
   *
   * A site administrator sees every chat on the instance here, not just their
   * own; `GroupChat.viewable_by` returns `all` for an admin.
   */
  async list(options: RequestOptions = {}): Promise<GroupChat[]> {
    return this.http.get<GroupChat[]>("/group_chats", options);
  }

  /**
   * `GET /group_chats/:id` - one chat with its member roster.
   *
   * The `:extended` view, which is the default view PLUS `members`; every
   * blueprint view here inherits the base fields rather than narrowing them.
   * Each member row carries `user_handle` and `user_name` denormalised, so
   * rendering a roster needs no further requests.
   *
   * Not a member? `404 "Resource not found"` - the id is not distinguishable
   * from one that does not exist, which is the right answer.
   *
   * Note that this route reaches the generic CRUD `show`, so it is one of the
   * few places in this file whose 404 body is the usual string rather than
   * `null`.
   */
  async get(id: GroupChatId, options: RequestOptions = {}): Promise<GroupChatDetail> {
    return this.http.get<GroupChatDetail>(`/group_chats/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /group_chats` - creates a chat and its roster in one transaction.
   * `201` with the `:extended` view.
   *
   * The caller becomes the chat's `admin`; everyone in
   * {@link CreateGroupChatInput.memberIds} becomes a `member`. There is no way
   * to create a chat you are not in, and no way to hand out a second admin
   * afterwards - `role` is not writable through any route in this namespace, so
   * the creator is the only administrator the chat will ever have. If they
   * leave, the chat keeps working for everybody but can never be renamed and
   * can never take another member.
   *
   * Not retried: a replay after a lost response creates a second chat.
   *
   * @throws {OmsError} `invalid_request` when the name is blank here.
   * @throws {OmsApiError} `400 "Name is required"` when the server judges it
   *   blank.
   */
  async create(input: CreateGroupChatInput, options: RequestOptions = {}): Promise<GroupChatDetail> {
    assertPresent("name", input.name);
    return this.http.post<GroupChatDetail>(
      "/group_chats",
      { name: input.name, member_ids: [...(input.memberIds ?? [])] },
      options,
    );
  }

  /**
   * `PATCH /group_chats/:id` - renames the chat. `200` with the `:extended`
   * view.
   *
   * The name is the ONLY writable field: `kind`, `system_managed` and the
   * context pair are ignored if sent.
   *
   * Passing `null` clears the name, and so does passing `""` or any
   * whitespace-only string - the controller's `clean_string` collapses all
   * three to `nil` and the column is nullable, so there is no way to set a
   * blank name and no error telling you it was dropped. A nameless chat is
   * legal and every client has to fall back to listing the members.
   *
   * Restricted to the chat's admin (its creator) or a site administrator.
   * Anyone else gets `401` with a `null` body.
   */
  async rename(id: GroupChatId, name: string | null, options: RequestOptions = {}): Promise<GroupChatDetail> {
    if (name !== null && name.length > GROUP_CHAT_NAME_MAX_LENGTH) {
      throw new OmsError(
        `name is ${name.length} characters; GroupChat validates it at ${GROUP_CHAT_NAME_MAX_LENGTH}.`,
        "invalid_request",
      );
    }
    return this.http.patch<GroupChatDetail>(`/group_chats/${encodeURIComponent(id)}`, { name }, options);
  }

  /**
   * `POST /group_chats/:id/members` - adds one user. `200` (NOT `201`) with the
   * `:extended` view.
   *
   * Idempotent by design: a user who is already a member is not re-added and
   * the current chat comes back unchanged, so this is safe to retry and safe to
   * call from a UI that is not sure of its own state.
   *
   * Admin-only, and the new member joins as a plain `member` - there is no way
   * to promote anyone.
   *
   * A `user_id` that names nobody is `400 "user_id is required"`, which is the
   * same message an absent `user_id` gets and is therefore not a useful
   * diagnostic.
   */
  async addMember(id: GroupChatId, userId: Id, options: RequestOptions = {}): Promise<GroupChatDetail> {
    assertPresent("userId", userId);
    return this.http.post<GroupChatDetail>(
      `/group_chats/${encodeURIComponent(id)}/members`,
      { user_id: userId },
      options,
    );
  }

  /**
   * `DELETE /group_chats/:id/members/:user_id` - `204`, empty body.
   *
   * Two callers are allowed and they mean different things: the chat's admin
   * removing somebody, and any member removing THEMSELVES, which is how you
   * leave. {@link leave} is the same call under a name that says so.
   *
   * ## Removing the last member DESTROYS THE CHAT
   *
   * `chat.destroy! if chat.members.empty?` runs immediately after the removal,
   * and `GroupChat has_many :messages, dependent: :destroy`. So the last person
   * to leave takes the entire history with them, for everyone, with no
   * confirmation and no way back. There is no `DELETE /group_chats/:id` -
   * emptying the roster is the only way a chat is ever deleted, and it is easy
   * to trigger by accident on a two-person chat.
   *
   * ## An admin can strand a chat
   *
   * The admin leaving is permitted and promotes nobody. The chat survives with
   * members and no administrator: nobody can rename it and nobody can add
   * anyone ever again. Warn before letting the creator leave a chat that still
   * has people in it.
   *
   * Removing someone who is not a member is a `204` with no effect, not a 404.
   */
  async removeMember(id: GroupChatId, userId: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(
      `/group_chats/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      options,
    );
  }

  /**
   * Leaves a chat: {@link removeMember} with the caller's own id.
   *
   * `selfId` is passed rather than looked up, for the same reason
   * {@link RelationshipsNamespace.friends} takes one - the SDK will not spend a
   * session round trip on every call to learn who it is.
   *
   * If you are the last member this DESTROYS the chat and every message in it.
   * If you are the admin it leaves the chat permanently unadministered. Both
   * are described on {@link removeMember} and both are worth a confirmation
   * dialog.
   */
  async leave(id: GroupChatId, selfId: Id, options: RequestOptions = {}): Promise<void> {
    await this.removeMember(id, selfId, options);
  }
}

/**
 * Messages inside a group chat, reachable as
 * `oms.social.groupChats.messages`.
 *
 * Every route is nested under the chat, and every one of them resolves the
 * chat first: a caller who is not a member gets `404` on the CHAT before the
 * message id is even looked at, so there is no way to probe for message ids.
 */
export class GroupChatMessagesNamespace extends Resource {
  /**
   * `GET /group_chats/:id/messages` - up to
   * {@link GROUP_CHAT_MESSAGE_PAGE_SIZE} messages, OLDEST FIRST.
   *
   * This endpoint does not speak the list DSL. No `search`, no `exact_search`,
   * no `modifiers`, no `ETag`; the page size is a constant in the controller
   * and `modifiers[page]` is ignored rather than rejected. The only knob is
   * `after_id`, and it has two sharp edges.
   *
   * ## `afterId` FAILS OPEN
   *
   * The controller looks the anchor up with `chat.messages.find_by(id: after)`
   * and then applies the filter only `if anchor`. An id it cannot find - a
   * message that was deleted, an id from a different chat, a typo - does not
   * produce an error. The cursor is silently DROPPED and you get the first 100
   * messages of the chat from the very beginning.
   *
   * A client that pages by remembering the last id it saw, and whose last id
   * gets deleted, therefore restarts at the top and appends the same 100
   * messages forever. Guard it: if the first row you get back is one you have
   * already seen, your cursor is gone, not your data.
   *
   * ## `afterId` SKIPS TIES
   *
   * The filter is `created_at > anchor.created_at`, on the timestamp alone
   * rather than on `(created_at, id)`. Two messages written in the same
   * microsecond - which is how a burst of system messages arrives - and
   * anchoring on the first one drops the second permanently from a forward
   * walk.
   *
   * ## THERE IS NO BACKWARD CURSOR
   *
   * `before_id` does not exist. The only entry point into a chat's history is
   * its beginning, and the only direction is forward. Opening a 5000-message
   * chat at the newest message costs 50 sequential requests, and there is no
   * way to fetch the tail directly. For the common "what is new" case, keep the
   * newest id you have seen and poll with it; for a first open, either walk
   * with {@link all} or accept that you are showing the top of the chat.
   *
   * System messages (`system_kind` set, `sender_id` null) are in the same
   * stream and are meant to render as centred pills rather than as messages.
   * {@link isSystemMessage} tests for them.
   */
  async list(
    chatId: GroupChatId,
    params: ListGroupChatMessagesParams = {},
    options: RequestOptions = {},
  ): Promise<GroupChatMessage[]> {
    return this.http.get<GroupChatMessage[]>(`/group_chats/${encodeURIComponent(chatId)}/messages`, {
      ...options,
      ...(params.afterId === undefined ? {} : { query: { after_id: params.afterId } }),
    });
  }

  /**
   * Walks a chat's history forward from the beginning and returns it in one
   * array, oldest first.
   *
   * One request per {@link GROUP_CHAT_MESSAGE_PAGE_SIZE} messages, which is the
   * only shape the endpoint allows. `limit` caps the walk at 1000 messages (ten
   * requests) by default so a long chat cannot quietly spend a large share of
   * the 600/min ceiling; raise it deliberately.
   *
   * Stops early on a short page, and also stops if the server hands back a page
   * whose first row it has already seen - that is the fail-open cursor
   * described on {@link list}, and continuing would loop forever.
   */
  async all(chatId: GroupChatId, limit = 1000, options: RequestOptions = {}): Promise<GroupChatMessage[]> {
    const out: GroupChatMessage[] = [];
    const seen = new Set<GroupChatMessageId>();
    let afterId: GroupChatMessageId | undefined;

    while (out.length < limit) {
      const page: GroupChatMessage[] = await this.list(chatId, { afterId }, options);
      if (page.length === 0) break;
      // The cursor was dropped and the server restarted at the top.
      if (seen.has(page[0]!.id)) break;
      for (const message of page) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        out.push(message);
      }
      if (page.length < GROUP_CHAT_MESSAGE_PAGE_SIZE) break;
      afterId = page[page.length - 1]!.id;
    }

    return out.slice(0, limit);
  }

  /**
   * `POST /group_chats/:id/messages` - sends one message. `201` with the
   * record.
   *
   * Content, an attachment, or both; a message with neither is `400 "Message
   * must have content or an attachment"`. The sender is always the
   * authenticated user, and non-members never get this far - the chat lookup
   * answers `404` first.
   *
   * Sending TOUCHES the chat, which is what moves it to the top of
   * {@link GroupChatsNamespace.list}. Nothing else in this namespace does, so a
   * chat whose only recent activity was a rename or a deletion sorts by its own
   * `updated_at` rather than by its newest message.
   *
   * Sent as JSON with no attachment and as `multipart/form-data` with one.
   *
   * Nobody is notified. See the {@link GroupChatsNamespace} docs: there is no
   * cable channel, no notification row, and no push for group chat messages, so
   * the only way anyone learns about this is by polling.
   *
   * Not retried: a replay after a lost response posts the message twice.
   *
   * @throws {OmsError} `invalid_request` when neither content nor attachment is
   *   given, or content is over the cap.
   */
  async send(
    chatId: GroupChatId,
    input: SendGroupChatMessageInput,
    options: RequestOptions = {},
  ): Promise<GroupChatMessage> {
    const content = input.content ?? "";
    if (content.trim().length === 0 && input.attachment === undefined) {
      throw new OmsError(
        "A group chat message needs content or an attachment; the server would answer 400.",
        "invalid_request",
      );
    }
    if (content.length > GROUP_CHAT_MESSAGE_CONTENT_MAX_LENGTH) {
      throw new OmsError(
        `content is ${content.length} characters; GroupChatMessage validates it at ` +
          `${GROUP_CHAT_MESSAGE_CONTENT_MAX_LENGTH}.`,
        "invalid_request",
      );
    }

    const path = `/group_chats/${encodeURIComponent(chatId)}/messages`;
    if (input.attachment === undefined) {
      return this.http.post<GroupChatMessage>(path, { content }, options);
    }
    assertGroupAttachmentSize("attachment", input.attachment);
    return this.http.postForm<GroupChatMessage>(
      path,
      // Omitted rather than sent empty: there is no "No Content" substitution
      // here, and an empty string would be stored as an empty caption.
      { ...(content.length === 0 ? {} : { content }), attachment: input.attachment },
      options,
    );
  }

  /**
   * `PATCH /group_chats/:id/messages/:id` - rewrites the content. `200`.
   *
   * Content only, and it must be non-blank: an empty edit is `400 "Content
   * required"` rather than a way to clear the text. An attachment cannot be
   * changed or removed.
   *
   * Allowed for the sender within {@link MESSAGE_EDIT_WINDOW_MS} of
   * `created_at`, and for a site administrator with no window at all. A system
   * message is never editable by anybody. Past the window: `401`.
   *
   * `edited_at` is stamped only when the content actually differs, so
   * re-sending the same string is a genuine no-op rather than a way to mark a
   * message edited.
   *
   * Does NOT touch the chat, so an edit does not reorder
   * {@link GroupChatsNamespace.list}.
   */
  async edit(
    chatId: GroupChatId,
    messageId: GroupChatMessageId,
    content: string,
    options: RequestOptions = {},
  ): Promise<GroupChatMessage> {
    if (content.trim().length === 0) {
      throw new OmsError(
        'An empty edit is refused with 400 "Content required"; delete the message instead.',
        "invalid_request",
      );
    }
    if (content.length > GROUP_CHAT_MESSAGE_CONTENT_MAX_LENGTH) {
      throw new OmsError(
        `content is ${content.length} characters; GroupChatMessage validates it at ` +
          `${GROUP_CHAT_MESSAGE_CONTENT_MAX_LENGTH}.`,
        "invalid_request",
      );
    }
    return this.http.patch<GroupChatMessage>(
      `/group_chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      { content },
      options,
    );
  }

  /**
   * `DELETE /group_chats/:id/messages/:id` - `204`, empty body.
   *
   * The sender may delete at ANY time - unlike editing, destroying has no
   * fifteen-minute window - and so may a site administrator. A system message
   * cannot be deleted by anyone. The row and its blob go for everybody.
   *
   * Deleting does not touch the chat, so {@link GroupChatsNamespace.list} keeps
   * its old ordering, and it invalidates any `afterId` cursor pointing at the
   * deleted message: the next {@link list} call with that cursor silently
   * restarts at the top of the chat. See {@link list}.
   */
  async delete(
    chatId: GroupChatId,
    messageId: GroupChatMessageId,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.http.delete<void>(
      `/group_chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      options,
    );
  }

  /**
   * `GET /group_chats/:id/messages/:id/attachment` - the bytes of the attached
   * file.
   *
   * A `302` to a presigned object-store URL, which `fetch` follows on its own
   * everywhere except a browser in cookie mode; see
   * {@link DirectMessagesNamespace.attachment} for why, and use
   * {@link attachmentUrl} there.
   *
   * Filename, byte size and content type are on the {@link GroupChatMessage}
   * itself - but only when it HAS an attachment: the blueprint declares those
   * three fields with an `if:` guard, so they are ABSENT rather than `null` on
   * a message without one. Test `has_attachment`, not
   * `attachment_filename !== null`.
   *
   * @throws {OmsError} `unsupported` when the redirect was blocked by CORS.
   * @throws {OmsApiError} `404` with a `null` body when the chat is not the
   *   caller's or the message is not in it; `404 "No attachment"` when it
   *   carries none.
   */
  async attachment(
    chatId: GroupChatId,
    messageId: GroupChatMessageId,
    options: RequestOptions = {},
  ): Promise<Blob> {
    const path = `/group_chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/attachment`;
    return followAttachment(this.http, path, "group chat", options);
  }

  /**
   * Absolute URL for a group chat attachment, for an `<img>`, an
   * `<a download>` or a new tab.
   *
   * Same rules as {@link DirectMessagesNamespace.attachmentUrl}: no credential
   * in cookie mode, `?token=` in token mode, and THE TOKEN-MODE URL IS A LIVE
   * CREDENTIAL - build it at the moment of use and never store, log or share
   * it.
   *
   * The web frontend's `groupChatAttachmentUrl` builds the same path with no
   * credential at all, which works in the browser (the cookie rides along) and
   * silently 401s anywhere else.
   */
  async attachmentUrl(chatId: GroupChatId, messageId: GroupChatMessageId): Promise<string> {
    const token = await tokenOf(this.http);
    const path = `/group_chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/attachment`;
    return this.http.url(path, token === null ? undefined : { token });
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The user at the other end of a relationship row, given the caller's own id.
 *
 * A relationship is stored with a direction (`requester` asked, `accepter` was
 * asked) that a friends list does not care about, so every client writes this
 * function. It is here once instead.
 *
 * Returns `undefined` when `selfId` is neither end of the row, and when the
 * nested user object is missing - which the API does not currently do, but the
 * mobile app's own type marks both associations optional, so it is treated as
 * possible rather than asserted away.
 */
export function counterpart(relationship: Relationship, selfId: Id): User | undefined {
  if (relationship.requester_id === selfId) return relationship.accepter ?? undefined;
  if (relationship.accepter_id === selfId) return relationship.requester ?? undefined;
  return undefined;
}

/** `kind === "friend" && status === "accepted"`. */
export function isFriendship(relationship: Relationship): boolean {
  return relationship.kind === "friend" && relationship.status === "accepted";
}

/** An unanswered friend request, in either direction. */
export function isPendingRequest(relationship: Relationship): boolean {
  return relationship.kind === "friend" && relationship.status === "pending";
}

/**
 * A block the CALLER made. There is no such thing as a visible block against
 * the caller - see {@link RelationshipsNamespace}.
 */
export function isBlock(relationship: Relationship): boolean {
  return relationship.kind === "block";
}

/** A system message: rendered as a centred pill, never editable or deletable. */
export function isSystemMessage(message: GroupChatMessage): boolean {
  return message.system_kind !== null && message.system_kind !== undefined;
}

/**
 * Whether a message is still inside its edit window, for greying out a button.
 *
 * Measured against the CALLER's clock, and the server measures against its own,
 * so this is an approximation that gets less honest the further the two drift.
 * Always handle the `401` as well; do not treat `true` here as a promise that
 * the edit will land, and do not treat `false` as a reason to skip the call if
 * the user insists.
 *
 * Takes `now` so the function stays pure and the module stays isolate-safe -
 * no `Date.now()` at module scope, and a caller can pass a server-derived
 * clock if it has one.
 */
export function canEditMessage(
  message: { created_at: Timestamp },
  now: number = new Date().getTime(),
): boolean {
  const created = new Date(message.created_at).getTime();
  if (Number.isNaN(created)) return false;
  return now - created <= MESSAGE_EDIT_WINDOW_MS;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Fails fast on a value the server would answer for with a framework error. */
function assertPresent(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OmsError(`${field} is required and cannot be blank.`, "invalid_request");
  }
}

/**
 * Byte length of an attachment, when it is knowable without reading anything.
 *
 * Deliberately `undefined` rather than zero for a `ReadableStream` with no
 * declared `size` and for a picker that reported none: buffering a file just to
 * measure it would cost more than the server's 400.
 */
function attachmentSize(file: FileInput | NativeFile): number | undefined {
  if (isNativeFile(file)) return file.size;
  if (typeof file.size === "number") return file.size;
  const data = file.data;
  if (isNativeFile(data)) return data.size;
  if (typeof Blob === "function" && data instanceof Blob) return data.size;
  if (data instanceof Uint8Array) return data.byteLength;
  return undefined;
}

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
 * Two ceilings, because the controller and the image processor disagree: 25 MiB
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

/**
 * Refuses a group chat attachment the server would refuse.
 *
 * One ceiling here, not two: group chat images are stored as sent, so the webp
 * recompressor and its lower limit never come into it.
 */
function assertGroupAttachmentSize(field: string, file: FileInput | NativeFile): void {
  const size = attachmentSize(file);
  if (size !== undefined && size > MESSAGE_ATTACHMENT_MAX_BYTES) {
    throw new OmsError(
      `${field} is ${size} bytes; the server accepts at most ${MESSAGE_ATTACHMENT_MAX_BYTES}.`,
      "invalid_request",
    );
  }
}

/**
 * Follows an attachment redirect and turns the browser-in-cookie-mode CORS
 * failure into an error that explains itself.
 *
 * The redirect to object storage arrives with `Origin: null` on a credentialed
 * request and the store answers a wildcard `Access-Control-Allow-Origin`, which
 * CORS forbids. That reaches us as a bare `fetch` rejection, indistinguishable
 * from a real network fault and already retried three times by the transport.
 * Only the client's SHAPE tells the two apart: no bearer token means cookie
 * mode, which means a browser.
 */
async function followAttachment(
  http: ApiClient,
  path: string,
  what: string,
  options: RequestOptions,
): Promise<Blob> {
  try {
    const response = await http.raw("GET", path, options);
    return await response.blob();
  } catch (thrown) {
    if (thrown instanceof OmsNetworkError && (await tokenOf(http)) === null) {
      throw new OmsError(
        `The ${what} attachment redirect could not be followed. In a browser, a client built with ` +
          "`sessionCookie: true` sends credentials, the 302 to object storage arrives there with " +
          "`Origin: null`, and the store answers a wildcard `Access-Control-Allow-Origin` - which CORS " +
          "forbids for a credentialed request. Use the matching `attachmentUrl(...)` and put the URL in an " +
          "<img>, a <video> or an <a download> instead: those follow the redirect with no CORS check.",
        "unsupported",
        { method: "GET", url: http.url(path), cause: thrown },
      );
    }
    throw thrown;
  }
}

/**
 * The bearer token the transport would send, or `null` when there is none -
 * which for a working client means it is in cookie mode.
 *
 * Read off `ApiClient` through a defensive probe, the same way `tickets.ts`
 * does and for the same reason: the provider is private, `http.ts` is shared,
 * and neither of these two needs is worth growing the transport a new public
 * member for. A probe that finds nothing degrades to `null`, which is the safe
 * answer in both places it is used - a URL with no credential rather than a
 * wrong one, and the CORS explanation rather than a swallowed error.
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
