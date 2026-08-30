/** `oms.admin.shortLinks` - every public short link and its traffic. Administrators only. */

import { Resource } from "../../http";
import type { Id, QueryParams, RequestOptions, Timestamp } from "../../types";
import type { AdminDailyCount } from "./types";

/** Compact owner object on an admin short link row. `null` for an anonymous link. */
export interface AdminShortLinkOwner {
  readonly id: Id;
  readonly name: string;
  readonly handle: string;
}

/**
 * A short link as the admin tool sees it.
 *
 * This is NOT the shape the ordinary `shortLinks` namespace returns. The
 * differences are load-bearing:
 *
 * - there is **no `updated_at`**, uniquely on this surface;
 * - there is **no `short_link_clicks` array**. The ordinary shape inlines EVERY
 *   click ever recorded, which is a payload hazard on a busy link; here it is
 *   replaced by the two aggregates below;
 * - the full user record is replaced by the compact {@link AdminShortLinkOwner}.
 */
export interface AdminShortLink {
  /**
   * Primary key, and an **integer**: `short_links` kept a bigint primary key
   * while the `user_id` next to it is a string.
   */
  readonly id: number;
  readonly url: string;
  readonly endpoint: string;
  /**
   * Always `null` or `""` on this surface: the listing, the drilldown and the
   * delete are all scoped to non-namespaced links so that private chest,
   * notepad and storage-share URLs never surface here.
   * {@link AdminShortLinksNamespace.namespaces} is the one exception and it
   * only returns counts.
   */
  readonly namespace: string | null;
  /** Owner id, or `null` for a link created anonymously. */
  readonly user_id: Id | null;
  readonly owner: AdminShortLinkOwner | null;
  readonly created_at: Timestamp;
  /** Total clicks. Computed per page in one grouped query, not per row. */
  readonly click_count: number;
  readonly last_click_at: Timestamp | null;
}

/** Filters for {@link AdminShortLinksNamespace.list}. */
export interface ListAdminShortLinksParams {
  /**
   * `"auth"` for links with an owner, `"anon"` for links without one. Any other
   * value, including omitting it, means both.
   */
  readonly owner?: "auth" | "anon" | "all";
  /**
   * Case-insensitive substring matched against the endpoint OR the destination
   * URL.
   *
   * **A plain top-level string, not the `search[column]` bucket the rest of
   * this API uses.** The server reads `search` as a plain string here, so
   * sending a bucket would be read as a hash and match nothing.
   */
  readonly search?: string;
}

/**
 * A page of {@link AdminShortLinksNamespace.list}.
 *
 * Not a {@link Paginated}, because there is nothing to page through: see
 * {@link AdminShortLinkPage.limit}.
 */
export interface AdminShortLinkPage {
  /** At most {@link AdminShortLinkPage.limit} rows, newest first. */
  readonly items: AdminShortLink[];
  /** How many links match the filter in total. Frequently larger than `items.length`. */
  readonly total: number;
  /**
   * The hard server-side cap, currently 100.
   *
   * **There is no pagination on this endpoint and no way to reach row 101.**
   * When `total > limit` the rest is simply unreachable through this route; the
   * only way to find a specific link beyond the cap is to narrow
   * {@link ListAdminShortLinksParams.search} until it fits.
   */
  readonly limit: number;
}

/** What {@link AdminShortLinksNamespace.stats} answers with. */
export interface AdminShortLinkStats {
  /** Non-namespaced links only, like everything else on this surface. */
  readonly total_links: number;
  readonly total_clicks: number;
  readonly clicks_last_24h: number;
  readonly clicks_last_7d: number;
  readonly zero_click_count: number;
  /** Already a percentage, `0` to `100`, one decimal. Not a fraction. */
  readonly zero_click_percent: number;
  /** Rounded to two decimals. `0` when there are no links. */
  readonly avg_clicks_per_link: number;
  readonly creations_daily: AdminDailyCount[];
  readonly clicks_daily: AdminDailyCount[];
}

/** One row of {@link AdminShortLinksNamespace.namespaces}. */
export interface AdminShortLinkNamespaceCount {
  /**
   * `null` for user links, or one of the reserved tool namespaces: `"n"`
   * notepads, `"c"` chests, `"ss"` storage shares, `"qr"` dynamic QR, `"f"`
   * forms, `"t"` link trees.
   */
  readonly namespace: string | null;
  readonly count: number;
}

/** Clicks grouped by country, on the admin drilldown. */
export interface AdminShortLinkCountryCount {
  /** ISO 3166-1 alpha-2 as stored at click time. */
  readonly country: string;
  readonly count: number;
}

/** Clicks grouped by browser or app, on the admin drilldown. */
export interface AdminShortLinkDeviceCount {
  readonly device_name: string;
  readonly count: number;
}

/**
 * What {@link AdminShortLinksNamespace.get} answers with.
 *
 * Note what is NOT here: no `total_clicks` and no `last_click_at` at the top
 * level. The drilldown leaves the totals out because the same two numbers are
 * already on `link`. Read them from there.
 */
export interface AdminShortLinkDetail {
  readonly link: AdminShortLink;
  readonly clicks_daily: AdminDailyCount[];
  /** Top 10 countries by clicks, descending. Rows with no country are excluded. */
  readonly top_countries: AdminShortLinkCountryCount[];
  /** Top 5 devices by clicks, descending. Rows with no device are excluded. */
  readonly top_devices: AdminShortLinkDeviceCount[];
}

/**
 * `oms.admin.shortLinks` - **administrators only**. Every public short link and
 * its traffic.
 *
 * The unprivileged half is `oms.shortLinks`, which only ever shows the caller's
 * own links. This one shows everybody's, anonymous ones included, which is the
 * point: an anonymous short link has no owner to report it.
 *
 * **Scoped to non-namespaced links throughout.** Links minted by the internal
 * tools (notepads, chests, storage shares, dynamic QR, forms, link trees) carry
 * a namespace and are excluded from {@link list}, {@link get}, {@link stats}
 * and {@link destroy}, so an admin panel cannot accidentally surface a private
 * chest URL. {@link namespaces} is the deliberate exception and returns nothing
 * but counts.
 */
export class AdminShortLinksNamespace extends Resource {
  /**
   * `GET /admin/short_links` - the newest 100 matching links.
   *
   * Read {@link AdminShortLinkPage.limit} before building a table on this: the
   * cap is hard and there is no page parameter.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(
    params: ListAdminShortLinksParams = {},
    options: RequestOptions = {},
  ): Promise<AdminShortLinkPage> {
    const query: QueryParams = {
      ...(params.owner === undefined ? {} : { owner: params.owner }),
      ...(params.search === undefined ? {} : { search: params.search }),
    };
    const body = await this.http.get<Partial<AdminShortLinkPage>>("/admin/short_links", {
      ...options,
      ...(Object.keys(query).length === 0 ? {} : { query }),
    });
    return { items: body?.items ?? [], total: body?.total ?? 0, limit: body?.limit ?? 100 };
  }

  /**
   * `GET /admin/short_links/stats` - server-wide totals and two 30 day series.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async stats(options: RequestOptions = {}): Promise<AdminShortLinkStats> {
    return this.http.get<AdminShortLinkStats>("/admin/short_links/stats", options);
  }

  /**
   * `GET /admin/short_links/namespaces` - how many links each namespace holds.
   *
   * The ONE call on this surface that looks past the non-namespaced scope, and
   * even so it only ever returns counts, never a row. User links come first
   * (`namespace: null`), then the reserved namespaces alphabetically.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async namespaces(options: RequestOptions = {}): Promise<AdminShortLinkNamespaceCount[]> {
    const body = await this.http.get<{ namespaces?: AdminShortLinkNamespaceCount[] }>(
      "/admin/short_links/namespaces",
      options,
    );
    return body?.namespaces ?? [];
  }

  /**
   * `GET /admin/short_links/:id` - one link with its traffic breakdown.
   *
   * @throws {OmsApiError} 404 `{ "error": "not_found" }` - which is also the
   *   answer for a link that exists but carries a namespace, since those are
   *   out of scope here.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async get(id: number | string, options: RequestOptions = {}): Promise<AdminShortLinkDetail> {
    return this.http.get<AdminShortLinkDetail>(
      `/admin/short_links/${encodeURIComponent(String(id))}`,
      options,
    );
  }

  /**
   * `DELETE /admin/short_links/:id` - deletes anybody's short link.
   *
   * Answers `200` with `{ id }`, not `204`. The clicks go with it.
   *
   * The link stops resolving immediately and there is no undo: the endpoint
   * becomes free again and somebody else can claim it, which is worth
   * remembering before deleting something that was printed or posted.
   *
   * @throws {OmsApiError} 404 `not_found`, namespaced links included.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async destroy(id: number | string, options: RequestOptions = {}): Promise<{ readonly id: number }> {
    return this.http.delete<{ readonly id: number }>(
      `/admin/short_links/${encodeURIComponent(String(id))}`,
      options,
    );
  }
}
