/** The per-user notification inbox. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../listing";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../types";

/** Filter columns of `GET /notifications`, on top of {@link BASE_FILTER_COLUMNS}. `read` and `kind` are not filterable. */
export const NOTIFICATION_FILTER_COLUMNS = Object.freeze(["user_id"] as const);

/** Filters for {@link NotificationsNamespace.list}. */
export type ListNotificationsParams = ListParams<(typeof NOTIFICATION_FILTER_COLUMNS)[number]>;

/** Primary key of a notification. An INTEGER. */
export type NotificationId = number;

/**
 * The `kind` strings the backend emits today.
 *
 * NOT a closed set and not validated anywhere - `Notification` only requires
 * `kind` to be present, so a new feature can add one without a migration. The
 * union is here so the kinds you handle autocomplete; keep a default branch
 * for the ones you do not, and never let an unknown kind break the inbox.
 *
 * Each kind implies a different {@link Notification.context} shape, which is
 * why `context` is typed as an open record rather than a discriminated union:
 * the backend guarantees a JSON object and nothing about its keys.
 */
export type NotificationKind =
  | "friendship_request"
  | "friendship_accepted"
  | "user_followed"
  | "message_received"
  | "fs_grant_received"
  | "jam_invite"
  | "vocal_separation_done"
  | "vocal_separation_failed"
  | (string & {});

/**
 * One notification in a user's inbox.
 *
 * Unlike most of this file it IS a full record, so it carries `id`,
 * `created_at` and `updated_at`. The `:extended` view adds
 * nothing, so a notification arriving over the cable and one arriving over
 * HTTP have the same fields.
 */
export interface Notification {
  /** An integer, and a JSON number, not a string. */
  readonly id: NotificationId;
  /** What happened. See {@link NotificationKind}. */
  readonly kind: NotificationKind;
  /**
   * Free-form JSON payload, whose keys depend entirely on `kind` - these are
   * the i18n interpolation values the client renders the sentence with.
   *
   * Never `null` (the column is `NOT NULL DEFAULT '{}'`), and never large: the
   * emitter runs user-supplied text through a 120-character preview before
   * storing it, so a message-received notification carries a truncated
   * snippet, not the message.
   *
   * One shape is documented outside the code and worth having here:
   * `jam_invite` carries `{ jam_id, host_id, host_handle, inviter_id,
   * inviter_handle }`. The rest you learn by reading a row.
   */
  readonly context: Record<string, unknown>;
  /** Whether it has been marked read. See {@link NotificationsNamespace.markAllRead}. */
  readonly read: boolean;
  /** Owner. Always the caller: the scope is `user.notifications`. A STRING. */
  readonly user_id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/**
 * The `notifications` namespace: the per-user inbox.
 *
 * ## This covers the HTTP half only
 *
 * Notifications are pushed in real time over ActionCable, on the per-user
 * `NotificationsChannel` stream, and that is where a live inbox gets its
 * updates from: the channel transmits `{type: "unread_count", unread_count}`
 * on subscribe, `{type: "created", notification, unread_count}` when one
 * arrives, and `{type: "unread_count", unread_count}` again whenever the read
 * state or the row count changes. The SDK does not open that socket and does
 * not wrap it - it has no cable client - so these methods are the polling
 * fallback and the write path, not the way to keep a badge live. A host with a
 * socket should subscribe and use {@link unreadCount} only for the first
 * paint.
 *
 * ## You cannot mark ONE notification read
 *
 * `PATCH /notifications/:id` is routed, and it cannot succeed for anybody: it
 * answers `401 "You are not authorized to update this resource"` on every
 * call - for the owner, for an admin, for everyone. The SDK therefore exposes
 * no `markRead(id)`: there is nothing honest to put behind it. Mark the whole
 * inbox with {@link markAllRead}, or remove the row with {@link dismiss}.
 *
 * There is also no `GET /notifications/:id`: the resource is declared
 * `only: [:index, :update, :destroy]`, so a single fetch by id is a routing
 * 404. Read one out of {@link list}.
 *
 * Everything here needs a session and rides the general 600/min ceiling.
 */
export class NotificationsNamespace extends Resource {
  /**
   * `GET /notifications` - the caller's inbox, one page at a time.
   *
   * Scoped to the caller by `viewable_by` (`user.notifications`), so there is
   * no way to read anybody else's and the `user_id` filter below is redundant.
   *
   * **The filterable columns are almost none.** The controller declares
   * `search_params :user_id`, which the DSL merges with the three defaults, so
   * the complete allowlist is `id`, `created_at`, `updated_at` and `user_id`.
   * `read` and `kind` are NOT on it, and filters fail closed: asking for
   * `exact_search: { read: false }` - the obvious way to fetch the unread ones -
   * is `400 "Unknown exact_search filter: read"`, not an unfiltered list.
   * Fetch a page and filter client-side, or read {@link unreadCount} for the
   * badge.
   *
   * No default ordering is declared, so rows come back in whatever order
   * Postgres chooses. Pass `order: "created_at:desc"` for an inbox; there is
   * an index on `(user_id, created_at)` behind it.
   *
   * Sends an `ETag`, so an unchanged page answers `304` and costs nothing -
   * except with `random: true`, which disables the check.
   */
  async list(params: ListNotificationsParams = {}, options: RequestOptions = {}): Promise<Paginated<Notification>> {
    return paginate(params, 100, (at) =>
      this.http.get<Notification[]>("/notifications", { ...options, query: listQuery(params, at) }),
    );
  }

  /**
   * `GET /notifications/unread_count` - how many unread notifications the
   * caller has. Unwraps the `{"count": n}` the server sends.
   *
   * One indexed `COUNT` behind a partial index (`WHERE read = false`), so it is
   * cheap - but it is still a request per call, and the cable already pushes
   * this number on subscribe and on every change. Poll it only where there is
   * no socket.
   */
  async unreadCount(options: RequestOptions = {}): Promise<number> {
    const body = await this.http.get<{ count: number }>("/notifications/unread_count", options);
    return body.count;
  }

  /**
   * `POST /notifications/read_all` - marks every unread notification read.
   *
   * Returns how many rows changed, which is the unread count from an instant
   * ago; calling it twice returns `0` the second time. `200`, not `201` - it
   * creates nothing.
   *
   * Runs as a single `update_all`, so no model callback fires and the per-row
   * broadcast is skipped; the controller pushes the new count over the cable
   * by hand afterwards, which is why every device still updates.
   *
   * Idempotent, so a retry is harmless. It is not enabled by default (the
   * transport does not replay a `POST`); pass `retry: {}` if you want one.
   */
  async markAllRead(options: RequestOptions = {}): Promise<number> {
    const body = await this.http.post<{ count: number }>("/notifications/read_all", undefined, options);
    return body.count;
  }

  /**
   * `DELETE /notifications/:id` - removes one notification. `204`, no body.
   *
   * This is the closest thing to "mark as read" the API has: the row is gone,
   * so the unread count drops and the new count is pushed over the cable.
   *
   * Owner only - `viewable_by` scopes the lookup to the caller, so somebody
   * else's id is `404 "Resource not found"` rather than a 401.
   */
  async dismiss(id: NotificationId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/notifications/${encodeURIComponent(String(id))}`, options);
  }
}
