/**
 * The `shortLinks` namespace: URL shortening plus per-link click statistics.
 *
 * This module is the reference implementation of the resource pattern. Every
 * other resource in the SDK is shaped exactly like it, and CONTRACT.md quotes
 * it verbatim. Change the pattern here and change it everywhere, or do not
 * change it at all.
 *
 * Creating a link works anonymously; listing, editing and statistics need a
 * credential. Creation is the most tightly throttled write in the whole API -
 * see {@link ShortLinksNamespace.create} before you spend one.
 *
 * There is deliberately no `get(id)` here, and its absence is the API's, not
 * an omission: the route file declares `resources :short_links, only: [:create,
 * :index, :update, :destroy]`, so `GET /short_links/:id` is not routed at all
 * and answers 404 for every id, including your own links. To read one link,
 * find it in {@link ShortLinksNamespace.list} - or by endpoint with
 * {@link ShortLinksNamespace.resolve}, which explains what that costs.
 */

import { OmsError } from "../errors";
import { Resource } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams, ListQueryBase } from "../listing";
import {
  createPage,
  type BaseRecord,
  type Id,
  type Json,
  type PageParams,
  type Paginated,
  type QueryParams,
  type RequestOptions,
  type Timestamp,
} from "../types";

/** Public host that fronts `short_links#follow`. See {@link ShortLinksNamespace.shortUrl}. */
export const SHORT_LINK_BASE_URL = "https://omelhor.site";

/**
 * Primary key of a short link.
 *
 * Short links predate the string ids the rest of the API uses: the table still
 * has an integer primary key, so the JSON carries a **number** here while the
 * `user_id` right next to it is a string. Every method accepts either form and
 * interpolates it into the path, so a caller never has to care.
 */
export type ShortLinkId = Id | number;

/** One recorded visit to a short link. */
export interface ShortLinkClick {
  readonly id: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** ISO 3166-1 alpha-2 resolved from the visitor's IP, or `null`. */
  readonly country: string | null;
  /** Browser or app name parsed from the user agent, or `null`. */
  readonly device_name: string | null;
}

/**
 * The owner of a link, rendered inline by `UserBlueprint`'s default view.
 *
 * Only the keys that view declares unconditionally are named. `UserBlueprint`
 * also renders `group`, `email`, `gender`, `last_seen_at`, `sessions_count`,
 * `deactivated_at`, `allowed_to_use_spotify` and `share_listening` behind `if:`
 * predicates that test who is ASKING, so whether they appear depends on the
 * caller's own privileges rather than on the record. That is why they are
 * reached through the index signature instead of being declared here as
 * optionals: an optional would suggest the server decides, and it does not.
 */
export interface ShortLinkOwner {
  readonly id: Id;
  readonly handle: string;
  readonly name: string;
  readonly bio: string | null;
  readonly country_code: string;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly [key: string]: Json | undefined;
}

/**
 * A short link.
 *
 * `Omit<BaseRecord, "id">` rather than a plain `extends BaseRecord`: see
 * {@link ShortLinkId} for why the identifier is a number on this one table.
 *
 * Every key below is present on every response this namespace can produce.
 * `ShortLinkBlueprint` does declare a second, narrower `:admin` view - it drops
 * `updated_at`, both associations, and adds `owner`, `click_count` and
 * `last_click_at` - but that view is only ever rendered by the admin
 * shortlinks tool under `/admin/short_links`, which is not this resource. A
 * record that arrived here has the full default shape.
 */
export interface ShortLink extends Omit<BaseRecord, "id"> {
  /** Integer primary key. See {@link ShortLinkId}. */
  readonly id: number;
  /** The destination the link redirects to. */
  readonly url: string;
  /** The path segment after the domain, e.g. `"my-talk"`. */
  readonly endpoint: string;
  /**
   * Namespace the endpoint lives under. User links have `null` or `""`; the
   * internal tools reserve `"n"` (notepads), `"c"` (chests), `"ss"` (storage
   * shares), `"qr"` (dynamic QR), `"f"` (forms) and `"t"` (link trees). That
   * is why {@link ShortLink} and `DynamicQr` are separate resources even
   * though both are rows in the same table.
   *
   * A link that reached you through {@link ShortLinksNamespace.list} always
   * holds `null` or `""`, because the listing scope is `user_managed`.
   */
  readonly namespace: string | null;
  /** Owner, or `null` for a link created anonymously. */
  readonly user_id: Id | null;
  /**
   * EVERY click ever recorded, inlined by the blueprint - not a count, not a
   * page. A link with 50 000 visits sends 50 000 objects here. Use
   * {@link ShortLinksNamespace.stats} for anything analytical and treat this
   * field as a payload hazard, not as a feature.
   *
   * Always present, and `[]` rather than `null` for a link nobody has clicked:
   * a Blueprinter association over an empty `has_many` renders an empty array.
   */
  readonly short_link_clicks: ShortLinkClick[];
  /** The owner rendered inline, or `null` for a link created anonymously. */
  readonly user: ShortLinkOwner | null;
}

/** One day of the click histogram. */
export interface ShortLinkDailyClicks {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly count: number;
}

/** Clicks grouped by the visitor's country. */
export interface ShortLinkCountryClicks {
  /** ISO 3166-1 alpha-2 as it was stored at click time. */
  readonly country: string;
  readonly count: number;
}

/** Clicks grouped by the visitor's browser or app. */
export interface ShortLinkDeviceClicks {
  readonly device_name: string;
  readonly count: number;
}

/**
 * `GET /short_links/:id/stats`, and the identical body
 * `GET /dynamic_qrs/:id/stats` returns.
 *
 * Five keys, always all five. There is no referrer breakdown and no unique
 * visitor count: the backend stores neither.
 */
export interface ShortLinkStats {
  readonly total_clicks: number;
  /** Timestamp of the most recent click, or `null` when there has never been one. */
  readonly last_click_at: Timestamp | null;
  /**
   * Exactly 30 entries, oldest first, ending today. Days with no clicks are
   * present with `count: 0`, so the series is safe to plot without gap
   * filling. The window is FIXED server-side; there is no way to ask for
   * another one.
   */
  readonly clicks_daily: ShortLinkDailyClicks[];
  /** Top 10 countries by clicks, descending. Rows with no country are excluded. */
  readonly top_countries: ShortLinkCountryClicks[];
  /** Top 5 devices by clicks, descending. Rows with no device are excluded. */
  readonly top_devices: ShortLinkDeviceClicks[];
}

/** Arguments for creating a short link. */
export interface CreateShortLinkInput {
  /**
   * Absolute destination URL. Must be `http` or `https` and must parse against
   * `URI::DEFAULT_PARSER`; anything else is a 400, not a silent rewrite.
   */
  readonly url: string;
  /**
   * Requested endpoint. Omit it and the server mints a random alphanumeric one
   * (4 characters, growing until it finds a free one). A taken endpoint comes
   * back as a 400, never as a silent rename.
   *
   * Anonymous callers may pick an endpoint too - the server only generates one
   * when the field is blank.
   */
  readonly endpoint?: string;
}

/** Fields that can change after a link exists. */
export interface UpdateShortLinkInput {
  readonly url?: string;
  readonly endpoint?: string;
}

/** Filter columns of `GET /short_links`, on top of {@link BASE_FILTER_COLUMNS}. */
export const SHORT_LINK_FILTER_COLUMNS = Object.freeze(["user_id"] as const);

/** Filters for {@link ShortLinksNamespace.list}. */
export interface ListShortLinksParams extends ListParams<(typeof SHORT_LINK_FILTER_COLUMNS)[number]> {
  /**
   * Narrow to one owner, sent as `exact_search[user_id]`.
   *
   * The listing is already scoped to the caller server-side, so this can only
   * ever narrow your own links to yourself or to nothing. It exists because
   * the web app sends it; there is no admin escape hatch here.
   */
  readonly userId?: Id;
}

/** How many pages {@link ShortLinksNamespace.resolve} will walk before giving up. */
const RESOLVE_MAX_PAGES = 20;

/** Page size {@link ShortLinksNamespace.resolve} walks with. Server maximum. */
const RESOLVE_PAGE_SIZE = 500;

/** The `shortLinks` namespace, reachable as `oms.shortLinks`. */
export class ShortLinksNamespace extends Resource {
  /**
   * `GET /short_links` - the links you own, newest first.
   *
   * Only user-managed links are listed: anything in a system namespace
   * (notepads, chests, dynamic QR, forms, link trees) is filtered out server
   * side, so a dynamic QR will never show up here. Use `oms.dynamicQrs.list()`
   * for those.
   *
   * The endpoint has NO default ordering of its own, which would make paging
   * non-deterministic, so the SDK always sends one (`created_at:desc` unless
   * you override `order`).
   *
   * Beware {@link ShortLink.short_link_clicks}: every row carries its full
   * click history. A page of 500 busy links is a very large response.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   */
  async list(params: ListShortLinksParams = {}, options: RequestOptions = {}): Promise<Paginated<ShortLink>> {
    const base: ListQueryBase = { order: "created_at:desc", exactSearch: { user_id: params.userId } };
    return paginate(params, 100, (at) =>
      this.http.get<ShortLink[] | undefined>("/short_links", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `POST /short_links` - shortens a URL.
   *
   * **Rate limit, read this before you spend one:** rack-attack allows
   * **10 creations per hour per IP** (`short_links_create/ip`), and the rule
   * is keyed by IP for EVERYONE - being signed in does not buy you a bigger
   * budget. The 11th call in an hour answers `429` with a `Retry-After` header
   * measured in whatever is left of that hour, which arrives here as an
   * {@link OmsQuotaError} with `retryAfterMs` set. An agent that shortens URLs
   * in a loop will burn the whole hour's budget in about a second, so batch the
   * decision, not the calls.
   *
   * Retries are disabled by default for exactly two reasons: a replayed `POST`
   * after a 502 mints a SECOND link, and the transport's 429 handling honours
   * `Retry-After` literally, which here means sleeping for up to an hour inside
   * one call. Pass `retry` explicitly if you want either behaviour back.
   *
   * Works anonymously, in which case the link has no owner and cannot be
   * listed, edited or measured afterwards - the endpoint string is the only
   * handle you will ever have on it. Capture the response.
   *
   * @throws {OmsQuotaError} 429 once the hourly budget is spent.
   * @throws {OmsApiError} 400 when `endpoint` is taken or `url` is not an
   *   `http`/`https` URL. The body is a plain sentence, so read `message`.
   */
  async create(input: CreateShortLinkInput, options: RequestOptions = {}): Promise<ShortLink> {
    return this.http.post<ShortLink>(
      "/short_links",
      {
        url: input.url,
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /short_links/:id` - repoints a link or renames its endpoint.
   *
   * Renaming frees the old endpoint immediately, and every printed or shared
   * copy of it stops working. There is no redirect from the old name.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   * @throws {OmsApiError} 404 when the link is not yours, 400 on a taken
   *   endpoint or an invalid URL.
   */
  async update(id: ShortLinkId, input: UpdateShortLinkInput, options: RequestOptions = {}): Promise<ShortLink> {
    return this.http.patch<ShortLink>(`/short_links/${encodeURIComponent(String(id))}`, { ...input }, options);
  }

  /**
   * `DELETE /short_links/:id`. The endpoint becomes free again immediately and
   * the recorded clicks go with it.
   *
   * @throws {OmsApiError} 404 when the link is not yours.
   */
  async delete(id: ShortLinkId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/short_links/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `GET /short_links/:id/stats` - totals plus a fixed 30-day daily histogram.
   *
   * The window is not configurable: the backend always buckets the last 30
   * days. For anything else, read {@link ShortLink.short_link_clicks} off the
   * record and bucket it yourself - at the cost noted on that field.
   *
   * @throws {OmsAuthError} 401 when anonymous (checked before the lookup, so an
   *   anonymous caller cannot probe which ids exist).
   * @throws {OmsApiError} 404 when the link is not yours.
   */
  async stats(id: ShortLinkId, options: RequestOptions = {}): Promise<ShortLinkStats> {
    return this.http.get<ShortLinkStats>(`/short_links/${encodeURIComponent(String(id))}/stats`, options);
  }

  /**
   * Finds one of YOUR links by its endpoint, without counting a click.
   *
   * The public `follow` route records a visit before it redirects, so using it
   * to read a destination would quietly corrupt the owner's statistics. The
   * API offers no read-by-endpoint, and `search[endpoint]` is not on the
   * allowlist (an unknown filter key is a 400, not a wider result), so the only
   * honest implementation is to page through your own listing and match
   * locally. That has three consequences worth knowing:
   *
   * - it needs a credential, and it only ever finds links you own;
   * - it cannot see a system-namespace endpoint (`qr/...`, `n/...`), because
   *   the listing filters those out;
   * - it costs one request per {@link RESOLVE_PAGE_SIZE} links you own, and
   *   gives up after {@link RESOLVE_MAX_PAGES} pages.
   *
   * @throws {OmsError} with `code === "not_found"` when no owned link carries
   *   that endpoint. Nothing was requested by id, so this is not an HTTP 404.
   */
  async resolve(endpoint: string, options: RequestOptions = {}): Promise<ShortLink> {
    for (let page = 1; page <= RESOLVE_MAX_PAGES; page += 1) {
      const items = await this.fetchPage({ page, pageSize: RESOLVE_PAGE_SIZE, order: "created_at:desc" }, options);
      const hit = items.find((link) => link.endpoint === endpoint);
      if (hit) return hit;
      if (items.length < RESOLVE_PAGE_SIZE) break;
    }

    throw new OmsError(
      `No short link of yours has the endpoint "${endpoint}".`,
      "not_found",
      { method: "GET", url: this.http.url("/short_links") },
    );
  }

  /**
   * The public URL a link is served from. Pure string building, no request.
   *
   * The API hands back an `endpoint`, never the address people actually click,
   * so this fills the gap - including for the system namespaces, whose links
   * live one segment deeper.
   */
  shortUrl(link: Pick<ShortLink, "endpoint" | "namespace">): string {
    return link.namespace
      ? `${SHORT_LINK_BASE_URL}/${link.namespace}/${link.endpoint}`
      : `${SHORT_LINK_BASE_URL}/${link.endpoint}`;
  }

  /** One page of the listing. Shared by {@link list} and {@link resolve}. */
  private async fetchPage(
    at: { page: number; pageSize: number; order: string; userId?: Id },
    options: RequestOptions,
  ): Promise<ShortLink[]> {
    const query = listQuery({}, at, { order: at.order, exactSearch: { user_id: at.userId } });
    const items = await this.http.get<ShortLink[] | undefined>("/short_links", { ...options, query });
    return items ?? [];
  }
}
