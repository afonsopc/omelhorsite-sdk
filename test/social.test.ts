/**
 * `bun test` coverage for the `social` namespace.
 *
 * Everything asserted here is a backend behaviour that fails SILENTLY when the
 * client gets it wrong, which is the bar for being worth a test:
 *
 * - `GET /messages` runs an `update_all(read_at: ...)` over the UNBOUNDED
 *   matched scope before it renders. A listing whose `extra_options` are
 *   missing does not error - it marks the caller's entire mailbox read. So the
 *   test that matters is which filter went out on the wire, not what came back;
 * - the messages and relationships indexes declare no default order, so a
 *   paged walk without `modifiers[order]` repeats and drops rows in Postgres,
 *   with a `200` on every page;
 * - `exact_search[read_at]` has to carry the backspace null sentinel to mean
 *   `IS NULL`. An empty string matches nothing and answers `200` with `[]`;
 * - a 22 MiB image attachment passes the controller's 25 MiB check and then
 *   dies inside the webp recompressor as a `500`. A 22 MiB zip is accepted.
 *   Only the content type separates the two;
 * - `after_id` on the group chat message index FAILS OPEN: an id the chat does
 *   not contain is dropped and the server answers with the first page from the
 *   beginning. A walker that trusts it loops forever appending duplicates;
 * - query brackets must go out percent-encoded, or iOS re-encodes the whole
 *   query and the filter matches nothing.
 *
 * The reference points are the Rails source (`MessagesController`,
 * `RelationshipsController`, `GroupChatsController`,
 * `GroupChatMessagesController`, and the four models behind them), not a guess.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { OmsError } from "../src/errors";
import { file } from "../src/types";
import {
  DirectMessagesNamespace,
  GROUP_CHAT_MESSAGE_PAGE_SIZE,
  GroupChatsNamespace,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_CONTENT_MAX_LENGTH,
  MESSAGE_EDIT_WINDOW_MS,
  MESSAGE_IMAGE_MAX_BYTES,
  RelationshipsNamespace,
  SocialNamespace,
  canEditMessage,
  counterpart,
  isBlock,
  isFriendship,
  isPendingRequest,
  isSystemMessage,
  type DirectMessage,
  type GroupChat,
  type GroupChatMessage,
  type Relationship,
} from "../src/resources/social";
import type { User } from "../src/resources/account";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly url: URL;
  /** Raw query string, BEFORE any decoding, so sentinel encoding is visible. */
  readonly search: string;
  readonly body: unknown;
}

interface Harness {
  readonly social: SocialNamespace;
  readonly messages: DirectMessagesNamespace;
  readonly relationships: RelationshipsNamespace;
  readonly groupChats: GroupChatsNamespace;
  readonly calls: Call[];
}

/**
 * Mounts the namespace on a fetch that records what it was asked to send.
 *
 * One response argument is reused for every call; several are consumed in
 * order and the last one repeats, which is what a paging walk needs.
 */
function harness(...responses: Array<{ body?: unknown; status?: number }>): Harness {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ method: init?.method ?? "GET", url, search: url.search, body: init?.body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const status = next?.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next?.body ?? null), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl as unknown as typeof fetch,
    tokens: { getToken: () => "session-token" },
    retry: false,
  });
  const social = new SocialNamespace(http);
  return {
    social,
    messages: social.messages,
    relationships: social.relationships,
    groupChats: social.groupChats,
    calls,
  };
}

/** The same harness in cookie mode, which is the browser's shape. */
function cookieHarness(...responses: Array<{ body?: unknown; status?: number }>): Harness {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ method: init?.method ?? "GET", url, search: url.search, body: init?.body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const status = next?.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next?.body ?? null), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl as unknown as typeof fetch,
    sessionCookie: true,
    retry: false,
  });
  const social = new SocialNamespace(http);
  return {
    social,
    messages: social.messages,
    relationships: social.relationships,
    groupChats: social.groupChats,
    calls,
  };
}

function user(id: string, handle = id): User {
  return {
    id,
    handle,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as User;
}

function message(overrides: Partial<DirectMessage> = {}): DirectMessage {
  return {
    id: 11,
    created_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
    content: "ola",
    sender_id: "me",
    receiver_id: "them",
    read_at: null,
    attachment_kind: null,
    quoted_message_id: null,
    edited_at: null,
    has_image: false,
    has_attachment: false,
    attachment_filename: null,
    attachment_byte_size: null,
    quoted_preview: null,
    sender: user("me"),
    receiver: user("them"),
    ...overrides,
  };
}

function relationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    kind: "friend",
    status: "accepted",
    requester_id: "me",
    accepter_id: "them",
    requester: user("me"),
    accepter: user("them"),
    ...overrides,
  };
}

function groupMessage(overrides: Partial<GroupChatMessage> = {}): GroupChatMessage {
  return {
    id: "gcm-1",
    created_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
    group_chat_id: "gc-1",
    sender_id: "me",
    sender_handle: "me",
    sender_name: "Me",
    content: "ola",
    attachment_kind: null,
    has_attachment: false,
    system_kind: null,
    system_payload: {},
    edited_at: null,
    ...overrides,
  };
}

function chat(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: "gc-1",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
    name: "A malta",
    kind: "ad_hoc",
    system_managed: false,
    context_type: null,
    context_id: null,
    last_message: null,
    ...overrides,
  };
}

/** A page of `n` distinct group messages, ids prefixed so pages do not collide. */
function groupPage(prefix: string, n: number): GroupChatMessage[] {
  return Array.from({ length: n }, (_, i) => groupMessage({ id: `${prefix}-${i}` }));
}

describe("messages.list", () => {
  test("always sends an order and an explicit page, because the index has neither", async () => {
    const { messages, calls } = harness({ body: [message()] });

    await messages.list();

    const query = calls[0]!.url.searchParams;
    // No default order server-side: an offset walk over an unordered relation
    // repeats rows on one page and drops them from the next, with a 200 each time.
    expect(query.get("modifiers[order]")).toBe("created_at:desc");
    // With no page at all the server forces 1:500 and never says so.
    expect(query.get("modifiers[page]")).toBe("1:100");
  });

  test("scopes the read-marking UPDATE by putting the counterpart in extra_options", async () => {
    const { messages, calls } = harness({ body: [message()] });

    await messages.conversation("them");

    const query = calls[0]!.url.searchParams;
    // This is not a display filter. MessagesController#index runs
    // `update_all(read_at: Time.current)` over exactly this scope BEFORE
    // rendering, so the filter is what stops one open thread from marking the
    // caller's whole mailbox read.
    expect(query.get("extra_options[other_user_id]")).toBe("them");
    expect(calls[0]!.url.pathname).toBe("/messages");
  });

  test("does not send extra_options[user_id] unless it was asked for", async () => {
    const { messages, calls } = harness({ body: [] });

    await messages.conversation("them");

    // The web frontend fetches the session on every conversation open purely to
    // fill this in, and it narrows nothing: the listing scope is already
    // Current.user.messages.
    expect(calls[0]!.url.searchParams.has("extra_options[user_id]")).toBe(false);
  });

  test("unreadOnly goes out as the backspace null sentinel, percent-encoded", async () => {
    const { messages, calls } = harness({ body: [] });

    await messages.list({ unreadOnly: true });

    // %08 is U+0008, which CrudActions decodes back to nil, which exact_search
    // turns into `WHERE read_at IS NULL`. An empty string would match nothing
    // and still answer 200.
    expect(calls[0]!.search).toContain("exact_search%5Bread_at%5D=%08");
    expect(calls[0]!.url.searchParams.get("exact_search[read_at]")).toBe("\b");
  });

  test("sends brackets percent-encoded, which iOS needs", async () => {
    const { messages, calls } = harness({ body: [] });

    await messages.list({ contentContains: "boa noite" });

    expect(calls[0]!.search).toContain("search%5Bcontent%5D=");
    expect(calls[0]!.search).not.toContain("search[content]=");
  });

  test("pages forward with the same order and size", async () => {
    const { messages, calls } = harness(
      { body: Array.from({ length: 2 }, () => message()) },
      { body: [message({ id: 99 })] },
    );

    const first = await messages.list({ pageSize: 2, withUser: "them" });
    const second = await first.next();

    expect(first.hasMore).toBe(true);
    expect(second?.items).toHaveLength(1);
    expect(calls[1]!.url.searchParams.get("modifiers[page]")).toBe("2:2");
    expect(calls[1]!.url.searchParams.get("modifiers[order]")).toBe("created_at:desc");
    expect(calls[1]!.url.searchParams.get("extra_options[other_user_id]")).toBe("them");
  });
});

describe("messages.conversedUsers", () => {
  test("is one bare request with no modifiers - it is not a listing", async () => {
    const { messages, calls } = harness({
      body: [{ ...user("them"), last_message: null, unread_count: 3 }],
    });

    const rows = await messages.conversedUsers();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/messages/conversed_users");
    expect(calls[0]!.search).toBe("");
    expect(rows[0]!.unread_count).toBe(3);
  });
});

describe("messages.send", () => {
  test("sends JSON when there is no attachment", async () => {
    const { messages, calls } = harness({ body: message(), status: 201 });

    await messages.send({ receiverId: "them", content: "ola" });

    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ receiver_id: "them", content: "ola" });
  });

  test("sends multipart under the field name `attachment`, never the legacy `image`", async () => {
    const { messages, calls } = harness({ body: message(), status: 201 });

    await messages.send({
      receiverId: "them",
      content: "olha isto",
      attachment: file(new Blob(["x"], { type: "image/png" }), "cover.png"),
    });

    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("attachment")).toBeInstanceOf(Blob);
    expect(form.get("image")).toBeNull();
    expect(form.get("receiver_id")).toBe("them");
  });

  test("refuses an image in the 20-25 MiB band, which the server answers with a 500", async () => {
    const { messages, calls } = harness({ body: message(), status: 201 });
    const bytes = MESSAGE_IMAGE_MAX_BYTES + 1024;

    const attempt = messages.send({
      receiverId: "them",
      attachment: { data: new Blob([]), filename: "huge.jpg", contentType: "image/jpeg", size: bytes },
    });

    await expect(attempt).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("accepts a NON-image of the same size, because only the image path has the lower cap", async () => {
    const { messages, calls } = harness({ body: message(), status: 201 });
    const bytes = MESSAGE_IMAGE_MAX_BYTES + 1024;

    await messages.send({
      receiverId: "them",
      attachment: { data: new Blob([]), filename: "dump.zip", contentType: "application/zip", size: bytes },
    });

    expect(calls).toHaveLength(1);
    expect(bytes).toBeLessThan(MESSAGE_ATTACHMENT_MAX_BYTES);
  });

  test("refuses a message with neither content nor attachment", async () => {
    const { messages, calls } = harness({ body: message(), status: 201 });

    await expect(messages.send({ receiverId: "them" })).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("refuses content past the 1024-character validation", async () => {
    const { messages, calls } = harness({ body: message(), status: 201 });

    const attempt = messages.send({
      receiverId: "them",
      content: "a".repeat(MESSAGE_CONTENT_MAX_LENGTH + 1),
    });

    await expect(attempt).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("refuses a blank receiver rather than letting Rails answer for it", async () => {
    const { messages, calls } = harness({ body: message(), status: 201 });

    await expect(messages.send({ receiverId: "  ", content: "ola" })).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });
});

describe("messages.edit / delete / attachment", () => {
  test("edit patches content and nothing else", async () => {
    const { messages, calls } = harness({ body: message({ edited_at: "2026-08-29T10:05:00.000Z" }) });

    await messages.edit(11, "corrigido");

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe("/messages/11");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ content: "corrigido" });
  });

  test("delete survives the empty 204 body", async () => {
    const { messages, calls } = harness({ status: 204 });

    await expect(messages.delete(11)).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/messages/11");
  });

  test("attachmentUrl carries the token in token mode", async () => {
    const { messages } = harness({ body: null });

    const url = new URL(await messages.attachmentUrl(11));

    expect(url.pathname).toBe("/messages/11/attachment");
    expect(url.searchParams.get("token")).toBe("session-token");
  });

  test("attachmentUrl carries NO credential in cookie mode, where the browser adds it", async () => {
    const { messages } = cookieHarness({ body: null });

    const url = new URL(await messages.attachmentUrl(11));

    expect(url.pathname).toBe("/messages/11/attachment");
    expect(url.search).toBe("");
  });
});

describe("relationships.list", () => {
  test("never sends a kind or status filter, which would be a 400", async () => {
    const { relationships, calls } = harness({ body: [relationship()] });

    await relationships.list({ userId: "me" });

    const search = calls[0]!.search;
    // search_params is requester_id, accepter_id, id, created_at, updated_at.
    // An unrecognised key does not get dropped: it is
    // 400 "Unknown search filter: kind".
    expect(search).not.toContain("kind");
    expect(search).not.toContain("status");
    expect(calls[0]!.url.searchParams.get("extra_options[user_id]")).toBe("me");
    expect(calls[0]!.url.searchParams.get("modifiers[order]")).toBe("created_at:desc");
  });

  test("friends takes the other side of every accepted friend row, once each", async () => {
    const { relationships } = harness({
      body: [
        relationship({ id: 1, requester_id: "me", accepter_id: "a", accepter: user("a") }),
        relationship({ id: 2, requester_id: "b", accepter_id: "me", requester: user("b") }),
        // Pending: not a friend yet.
        relationship({ id: 3, status: "pending", requester_id: "me", accepter_id: "c", accepter: user("c") }),
        // A block is not a friendship however accepted its status looks.
        relationship({ id: 4, kind: "block", requester_id: "me", accepter_id: "d", accepter: user("d") }),
      ],
    });

    const friends = await relationships.friends("me");

    expect(friends.map((f) => f.id)).toEqual(["a", "b"]);
  });

  test("blocked returns only blocks the caller MADE", async () => {
    const { relationships } = harness({
      body: [
        relationship({ id: 4, kind: "block", requester_id: "me", accepter_id: "d", accepter: user("d") }),
        // A block someone made against the caller cannot actually reach a
        // listing - the model's default scope hides it - but the filter must
        // not claim it as the caller's own if one ever did.
        relationship({ id: 5, kind: "block", requester_id: "e", accepter_id: "me", requester: user("e") }),
      ],
    });

    const blocked = await relationships.blocked("me");

    expect(blocked.map((u) => u.id)).toEqual(["d"]);
  });

  test("incoming and outgoing requests are told apart by which end the caller is", async () => {
    const rows = [
      relationship({ id: 6, status: "pending", requester_id: "x", accepter_id: "me" }),
      relationship({ id: 7, status: "pending", requester_id: "me", accepter_id: "y" }),
    ];
    const incoming = await harness({ body: rows }).relationships.incomingRequests("me");
    const outgoing = await harness({ body: rows }).relationships.outgoingRequests("me");

    expect(incoming.map((r) => r.id)).toEqual([6]);
    expect(outgoing.map((r) => r.id)).toEqual([7]);
  });

  test("all() stops walking at its limit instead of following pages forever", async () => {
    const page = Array.from({ length: 500 }, (_, i) => relationship({ id: i }));
    const { relationships, calls } = harness({ body: page });

    const rows = await relationships.all({ userId: "me" }, 700);

    expect(rows).toHaveLength(700);
    expect(calls).toHaveLength(2);
  });
});

describe("relationships writes", () => {
  test("request and block differ only by kind, and never send a status", async () => {
    const { relationships, calls } = harness({ body: relationship(), status: 201 });

    await relationships.request("them");
    await relationships.block("them");

    expect(JSON.parse(calls[0]!.body as string)).toEqual({ accepter_id: "them", kind: "friend" });
    // status is not in create_params: a friend starts pending from the column
    // default, a block is forced to accepted by a before_create.
    expect(JSON.parse(calls[1]!.body as string)).toEqual({ accepter_id: "them", kind: "block" });
  });

  test("accept patches status, the only writable column", async () => {
    const { relationships, calls } = harness({ body: relationship() });

    await relationships.accept(1);

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe("/relationships/1");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ status: "accepted" });
  });

  test("delete is the only ending, and it answers 204", async () => {
    const { relationships, calls } = harness({ status: 204 });

    await expect(relationships.delete(1)).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/relationships/1");
  });
});

describe("groupChats", () => {
  test("list is one unpaged request - the endpoint has no modifiers at all", async () => {
    const { groupChats, calls } = harness({ body: [chat()] });

    const chats = await groupChats.list();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.search).toBe("");
    expect(chats[0]!.kind).toBe("ad_hoc");
  });

  test("create always sends member_ids, even when empty", async () => {
    const { groupChats, calls } = harness({ body: { ...chat(), members: [] }, status: 201 });

    await groupChats.create({ name: "A malta" });

    expect(JSON.parse(calls[0]!.body as string)).toEqual({ name: "A malta", member_ids: [] });
  });

  test("create refuses a blank name here rather than spending a 400", async () => {
    const { groupChats, calls } = harness({ body: null, status: 201 });

    await expect(groupChats.create({ name: "   " })).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("rename can clear the name with an explicit null", async () => {
    const { groupChats, calls } = harness({ body: { ...chat(), name: null, members: [] } });

    await groupChats.rename("gc-1", null);

    expect(calls[0]!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ name: null });
  });

  test("addMember posts user_id and answers 200, not 201", async () => {
    const { groupChats, calls } = harness({ body: { ...chat(), members: [] }, status: 200 });

    await groupChats.addMember("gc-1", "them");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/group_chats/gc-1/members");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ user_id: "them" });
  });

  test("leave is removeMember with the caller's own id, url-encoded", async () => {
    const { groupChats, calls } = harness({ status: 204 });

    await groupChats.leave("gc-1", "user/with slash");

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/group_chats/gc-1/members/user%2Fwith%20slash");
  });
});

describe("groupChats.messages", () => {
  test("list sends after_id and nothing else - no page, no order, no filters", async () => {
    const { groupChats, calls } = harness({ body: [groupMessage()] });

    await groupChats.messages.list("gc-1", { afterId: "gcm-1" });

    expect(calls[0]!.url.pathname).toBe("/group_chats/gc-1/messages");
    expect(calls[0]!.url.searchParams.get("after_id")).toBe("gcm-1");
    expect(calls[0]!.url.searchParams.has("modifiers[page]")).toBe(false);
  });

  test("all() walks forward, one request per full page, and stops on a short one", async () => {
    const { groupChats, calls } = harness(
      { body: groupPage("a", GROUP_CHAT_MESSAGE_PAGE_SIZE) },
      { body: groupPage("b", 3) },
    );

    const history = await groupChats.messages.all("gc-1");

    expect(history).toHaveLength(GROUP_CHAT_MESSAGE_PAGE_SIZE + 3);
    expect(calls).toHaveLength(2);
    // The cursor is the last id of the previous page.
    expect(calls[1]!.url.searchParams.get("after_id")).toBe(`a-${GROUP_CHAT_MESSAGE_PAGE_SIZE - 1}`);
  });

  test("all() breaks the infinite loop when the server silently drops the cursor", async () => {
    // The controller applies `after_id` only `if anchor`, so an id it cannot
    // find in the chat - a deleted message, say - is DISCARDED and the answer
    // is the first page from the very beginning, with a 200 on it. A walker
    // that trusts the cursor re-appends the same page forever.
    const page = groupPage("a", GROUP_CHAT_MESSAGE_PAGE_SIZE);
    const { groupChats, calls } = harness({ body: page });

    const history = await groupChats.messages.all("gc-1", 10_000);

    expect(history).toHaveLength(GROUP_CHAT_MESSAGE_PAGE_SIZE);
    expect(calls).toHaveLength(2);
  });

  test("all() honours its own limit", async () => {
    const { groupChats } = harness(
      { body: groupPage("a", GROUP_CHAT_MESSAGE_PAGE_SIZE) },
      { body: groupPage("b", GROUP_CHAT_MESSAGE_PAGE_SIZE) },
      { body: groupPage("c", GROUP_CHAT_MESSAGE_PAGE_SIZE) },
    );

    const history = await groupChats.messages.all("gc-1", 150);

    expect(history).toHaveLength(150);
  });

  test("send omits content entirely for an attachment-only message", async () => {
    const { groupChats, calls } = harness({ body: groupMessage({ content: null }), status: 201 });

    await groupChats.messages.send("gc-1", {
      attachment: file(new Blob(["x"], { type: "image/png" }), "foto.png"),
    });

    const form = calls[0]!.body as FormData;
    // Unlike a direct message, nothing here substitutes "No Content", so an
    // empty string would be stored as an empty caption.
    expect(form.get("content")).toBeNull();
    expect(form.get("attachment")).toBeInstanceOf(Blob);
  });

  test("send refuses a message with neither content nor attachment", async () => {
    const { groupChats, calls } = harness({ body: null, status: 201 });

    await expect(groupChats.messages.send("gc-1", { content: "   " })).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("send accepts a 22 MiB image here, where the direct-message path refuses one", async () => {
    const { groupChats, calls } = harness({ body: groupMessage(), status: 201 });

    await groupChats.messages.send("gc-1", {
      attachment: {
        data: new Blob([]),
        filename: "huge.jpg",
        contentType: "image/jpeg",
        size: MESSAGE_IMAGE_MAX_BYTES + 1024,
      },
    });

    // No webp recompression on this route, so the 20 MiB processor cap does
    // not apply and only the controller's 25 MiB check does.
    expect(calls).toHaveLength(1);
  });

  test("edit refuses a blank body, which the server answers with 400 Content required", async () => {
    const { groupChats, calls } = harness({ body: groupMessage(), status: 200 });

    await expect(groupChats.messages.edit("gc-1", "gcm-1", "  ")).rejects.toBeInstanceOf(OmsError);
    expect(calls).toHaveLength(0);
  });

  test("delete hits the nested path and answers 204", async () => {
    const { groupChats, calls } = harness({ status: 204 });

    await expect(groupChats.messages.delete("gc-1", "gcm-1")).resolves.toBeUndefined();
    expect(calls[0]!.url.pathname).toBe("/group_chats/gc-1/messages/gcm-1");
  });

  test("attachmentUrl nests both ids and carries the token", async () => {
    const { groupChats } = harness({ body: null });

    const url = new URL(await groupChats.messages.attachmentUrl("gc-1", "gcm-1"));

    expect(url.pathname).toBe("/group_chats/gc-1/messages/gcm-1/attachment");
    expect(url.searchParams.get("token")).toBe("session-token");
  });
});

describe("pure helpers", () => {
  test("counterpart works from either end and gives up rather than guessing", () => {
    const row = relationship({ requester_id: "me", accepter_id: "them" });

    expect(counterpart(row, "me")?.id).toBe("them");
    expect(counterpart(row, "them")?.id).toBe("me");
    expect(counterpart(row, "stranger")).toBeUndefined();
  });

  test("the two-column state machine is read as two columns", () => {
    const friendship = relationship({ kind: "friend", status: "accepted" });
    const pending = relationship({ kind: "friend", status: "pending" });
    // A block is born `accepted`. Reading `status` alone would call it a friend.
    const block = relationship({ kind: "block", status: "accepted" });

    expect(isFriendship(friendship)).toBe(true);
    expect(isFriendship(block)).toBe(false);
    expect(isPendingRequest(pending)).toBe(true);
    expect(isBlock(block)).toBe(true);
  });

  test("a system message is the ones with system_kind set, not the ones with no sender", () => {
    expect(isSystemMessage(groupMessage({ system_kind: "member_joined", sender_id: null }))).toBe(true);
    expect(isSystemMessage(groupMessage())).toBe(false);
  });

  test("canEditMessage takes its clock as an argument so the module stays pure", () => {
    const created = Date.parse("2026-08-29T10:00:00.000Z");
    const fresh = { created_at: "2026-08-29T10:00:00.000Z" };

    expect(canEditMessage(fresh, created + MESSAGE_EDIT_WINDOW_MS - 1)).toBe(true);
    expect(canEditMessage(fresh, created + MESSAGE_EDIT_WINDOW_MS + 1)).toBe(false);
    expect(canEditMessage({ created_at: "not a date" }, created)).toBe(false);
  });
});
