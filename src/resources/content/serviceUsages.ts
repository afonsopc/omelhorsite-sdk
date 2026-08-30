/** Per-user service visit counters. */

import { Resource } from "../../http";
import type { RequestOptions } from "../../types";

/**
 * The twelve service ids the counter accepts. A closed set: anything else is
 * `400 "Unknown service_id"`.
 */
export const SERVICE_USAGE_IDS = [
  "storage",
  "tools",
  "games",
  "music",
  "movies",
  "ai",
  "account",
  "tickets",
  "messages",
  "blogs",
  "status",
  "administration",
] as const;

/** One of {@link SERVICE_USAGE_IDS}. */
export type ServiceUsageId = (typeof SERVICE_USAGE_IDS)[number];

/**
 * A per-user visit counter.
 *
 * Note what is NOT here: no `id`, no `user_id`, no timestamps. Both routes
 * answer a bare `{ service_id, count }`, so this is one of the very few
 * payloads in the API that is not a record.
 */
export interface ServiceUsage {
  readonly service_id: ServiceUsageId;
  /** Lifetime visit count for this user and service. Monotonic, never reset. */
  readonly count: number;
}

/**
 * The `service_usages` namespace: which parts of the site a user opens, so the
 * home screen can put their favourites first.
 *
 * Both routes need a session - there is no `allow_unauthenticated_access` on
 * this controller - and both are pure bookkeeping. The music app calls
 * {@link record} with `"music"` on launch, fire and forget.
 */
export class ServiceUsagesNamespace extends Resource {
  /**
   * `POST /service_usages` - increments the caller's counter for one service.
   *
   * Answers **`200`, not `201`**, even on the very first call that creates the
   * row: the controller uses `ok!` rather than `created!`, so this is one of
   * the handful of creates in the API that breaks the 201 convention. The body
   * is the updated `{ service_id, count }`.
   *
   * ## Not idempotent, and it can page somebody
   *
   * Every call does `count += 1` and stamps `last_visited_at`, so a retry
   * inflates the number. That is why the transport's default of never
   * replaying a `POST` is the right default here: do not pass `retry: {}`.
   *
   * It can also fire a Discord `service_opened` alert - on the first ever
   * visit, and again whenever more than an hour has passed since the last one.
   * A client that calls this on every route change inside an app is fine (the
   * hour gap suppresses the alert), but a client that calls it from a
   * background poller is a pager, not telemetry.
   *
   * Fire and forget: nothing in a UI should wait on this, and nothing should
   * fail because it failed.
   *
   * @throws {OmsApiError} 400 `"Unknown service_id"` for anything outside
   *   {@link SERVICE_USAGE_IDS}; 401 without a session.
   */
  async record(serviceId: ServiceUsageId, options: RequestOptions = {}): Promise<ServiceUsage> {
    return this.http.post<ServiceUsage>("/service_usages", { service_id: serviceId }, options);
  }

  /**
   * `GET /service_usages/top` - the caller's most-used services, busiest
   * first, tie-broken by most recently visited.
   *
   * Not the list DSL: `limit` is the only parameter, it is clamped to
   * `1..10` (silently - asking for 50 returns 10), and it defaults to 3. There
   * is no paging and no way to read the full set.
   *
   * Only services the caller has actually opened appear, so a fresh account
   * gets an empty array rather than every id with a zero.
   */
  async top(input: { readonly limit?: number } = {}, options: RequestOptions = {}): Promise<ServiceUsage[]> {
    return this.http.get<ServiceUsage[]>("/service_usages/top", {
      ...options,
      ...(input.limit === undefined ? {} : { query: { limit: input.limit } }),
    });
  }
}
