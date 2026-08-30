/** Group chats: the chat, its roster and its messages, as `oms.social.groupChats`. */

import { OmsError } from "../../errors";
import { Resource } from "../../http";
import type { BaseRecord, FileInput, Id, NativeFile, RequestOptions, Timestamp } from "../../types";
import type { AttachmentKind } from "./types";
import { MESSAGE_ATTACHMENT_MAX_BYTES } from "./types";
import { assertPresent } from "../../internal/helpers";
import { attachmentSize, followAttachment, tokenOf } from "../../internal/attachments";

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Primary key of a group chat. A STRING - `group_chats` is an `id: :string`
 * table, unlike `messages` and `relationships`.
 */
export type GroupChatId = string;

/** Primary key of a membership row. A string. */
export type GroupChatMemberId = string;

/** Primary key of a group chat message. A string. */
export type GroupChatMessageId = string;

/* -------------------------------------------------------------------------- */
/* Limits the server enforces                                                 */
/* -------------------------------------------------------------------------- */

/** `GroupChatMessage` allows four thousand, not one thousand. */
export const GROUP_CHAT_MESSAGE_CONTENT_MAX_LENGTH = 4000;

/** Length cap of a group chat's name. */
export const GROUP_CHAT_NAME_MAX_LENGTH = 120;

/**
 * Rows `GET /group_chats/:id/messages` returns per call.
 *
 * A hard constant, not a modifier: this endpoint does not speak the list DSL
 * and `modifiers[page]` on it is ignored.
 */
export const GROUP_CHAT_MESSAGE_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

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
 * Extends {@link BaseRecord}, which the integer-keyed direct message and
 * relationship records cannot: `group_chats` is an `id: :string` table, so its
 * key is the same opaque string every other resource in the SDK uses.
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
   * real user are DROPPED IN SILENCE: the call still answers `201`, and the
   * only way to know a member is missing is to count `members` on the answer.
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
 * Unlike {@link DirectMessage} and {@link Relationship}.
 *
 * ## Only one `kind` exists
 *
 * `kind` is always `"ad_hoc"`. `system_managed`, `context_type` and
 * `context_id` are there for a future subsystem; nothing writes them today.
 *
 * ## Errors here have a different SHAPE from the rest of the API
 *
 * A `404` or a `401` from these routes carries the JSON body `null` rather
 * than the bare error string the rest of the API sends. Branch on the status,
 * not on the body.
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
   * genuinely has no paging: `modifiers[page]`, `search[...]` and the `ETag`
   * are all absent and the whole list comes back on every call. That is fine
   * while a user has tens of chats and is a cliff if one ever has thousands.
   *
   * `updated_at` is the sort key and it is touched by a new message, by a
   * rename, and by nothing else - a deleted message does not move a chat back
   * down the list.
   *
   * Each chat carries a `last_message` summary, computed for the whole page in
   * one window-function query. That summary is what makes this endpoint usable
   * as a poll for "did anything change anywhere": compare `last_message.id`
   * per chat instead of listing every conversation.
   *
   * Members are NOT included. Use {@link get} for the roster.
   *
   * A site administrator sees every chat on the instance here, not just their
   * own.
   */
  async list(options: RequestOptions = {}): Promise<GroupChat[]> {
    return this.http.get<GroupChat[]>("/group_chats", options);
  }

  /**
   * `GET /group_chats/:id` - one chat with its member roster.
   *
   * The `:extended` view, which is everything {@link list} returns PLUS
   * `members`. Each member row carries `user_handle` and `user_name`
   * denormalised, so rendering a roster needs no further requests.
   *
   * Not a member? `404 "Resource not found"` - the id is not distinguishable
   * from one that does not exist, which is the right answer.
   *
   * Note that this is one of the few places in this namespace whose 404 body
   * is the usual string rather than `null`.
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
   * whitespace-only string - all three collapse to `null`, so there is no way
   * to set a blank name and no error telling you it was dropped. A nameless
   * chat is legal and every client has to fall back to listing the members.
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
   * A chat whose roster is empty after the removal is destroyed on the spot,
   * messages included. So the last person to leave takes the entire history
   * with them, for everyone, with no confirmation and no way back. There is no
   * `DELETE /group_chats/:id` - emptying the roster is the only way a chat is
   * ever deleted, and it is easy to trigger by accident on a two-person chat.
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
   * no `modifiers`, no `ETag`; the page size is a constant and
   * `modifiers[page]` is ignored rather than rejected. The only knob is
   * `after_id`, and it has two sharp edges.
   *
   * ## `afterId` FAILS OPEN
   *
   * The server looks the anchor up in the chat and applies the filter only
   * when it finds one. An id it cannot find - a message that was deleted, an
   * id from a different chat, a typo - does not produce an error. The cursor
   * is silently DROPPED and you get the first 100 messages of the chat from
   * the very beginning.
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
   * itself - but only when it HAS an attachment: those three fields are ABSENT
   * rather than `null` on a message without one. Test `has_attachment`, not
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

/** A system message: rendered as a centred pill, never editable or deletable. */
export function isSystemMessage(message: GroupChatMessage): boolean {
  return message.system_kind !== null && message.system_kind !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

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
