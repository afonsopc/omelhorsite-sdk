/** Relationships: friendships and blocks, and `oms.social.relationships`. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams, ListQueryBase } from "../../listing";
import type { User } from "../account";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../types";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../types";
import { assertPresent } from "../../internal/helpers";

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/** Primary key of a relationship row. An integer, for the same reason. */
export type RelationshipId = number;

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/** A relationship row: one friendship or one block, between two users. */
export interface Relationship {
  /** Integer. */
  readonly id: RelationshipId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly kind: RelationshipKind;
  readonly status: RelationshipStatus;
  /** Whoever created the row. Always the authenticated user at create time. */
  readonly requester_id: Id;
  readonly accepter_id: Id;
  readonly requester: User;
  readonly accepter: User;
}

/** What a relationship row means. */
export type RelationshipKind = "friend" | "block";

/** Where a relationship row is in its lifecycle. */
export type RelationshipStatus = "pending" | "accepted";

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
   * what makes the server preload both ends of every row. Without it the
   * nested {@link User} for both ends of every row is rendered out of an
   * unprepared query - two extra `SELECT`s per relationship.
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
 * `block` + `pending` is unreachable: a block is forced to `accepted` at
 * birth, which also means a block's status can never be edited afterwards
 * (see the transition rules below). Blocking is asymmetric and direction
 * matters - `requester_id` blocked `accepter_id`, never the reverse.
 *
 * ## Transitions the server will accept
 *
 * `PATCH` may write `status` and nothing else. Any change whose PREVIOUS value
 * was `accepted` is aborted, so:
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
 * Either end of the row may `PATCH` it, and nothing narrows that for the
 * `pending -> accepted` transition. So the sender of a friend request can
 * `PATCH` their own request to `accepted` and become the recipient's friend
 * without the recipient doing anything.
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
 * A block aimed at you is hidden from listings AND from lookups by id. You
 * can see blocks you made; you cannot see, list, count or delete a block
 * someone made against you. Its only observable effect is that
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
   * The filter columns are `requester_id, accepter_id` plus `id, created_at,
   * updated_at`. `kind` and `status` are absent, and an unknown filter key
   * does not get dropped - it is `400 "Unknown search filter: kind"`. So "list
   * my friends" is not a query the API can answer: fetch the rows and filter
   * here. {@link friends}, {@link incomingRequests}, {@link outgoingRequests}
   * and {@link blocked} do exactly that.
   *
   * This is the single most surprising thing about the endpoint.
   *
   * ## Paging
   *
   * The SDK sends an explicit `modifiers[page]` and an explicit
   * `created_at:desc` order, for the usual reason: with no page the server
   * silently forces `1:500`, and offset paging over an unordered query can
   * repeat and skip rows. A client that sends neither truncates at 500 rows
   * without saying so - a real ceiling for an account with a long history,
   * since blocks and dead requests count towards it.
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
   * Only blocks the caller MADE. A block made against the caller is hidden
   * and cannot be enumerated by any means; see the class docs.
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
   * writable: a `friend` starts `pending`, a `block` is born `accepted`.
   * Prefer {@link request} and {@link block}, which say which of the two you
   * meant.
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
   * 2. every existing relationship between the two of you is DELETED first -
   *    an accepted friendship is gone, not suspended, and unblocking later
   *    does not bring it back;
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
   * `GET /relationships/:id` does not exist. Read a single row out of
   * {@link list} instead.
   */
  async delete(id: RelationshipId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/relationships/${encodeURIComponent(String(id))}`, options);
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
 * nested user object is missing - which the API does not currently do, but is
 * treated as possible rather than asserted away.
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
