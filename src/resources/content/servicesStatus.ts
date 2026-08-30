/** The public status page: live probes and the uptime report. */

import { Resource } from "../../http";
import type { RequestOptions, Timestamp } from "../../types";

/** The three services `GET /services_status` actually probes. */
export const EXTERNAL_SERVICE_SLUGS = ["vocal_separator", "ai", "yt_dlp"] as const;

/**
 * The eight services that live inside the Rails process and are therefore
 * "up" whenever the healthcheck job runs at all. They appear in
 * {@link ServicesStatusNamespace.uptime} and NOT in
 * {@link ServicesStatusNamespace.current}.
 */
export const INTERNAL_SERVICE_SLUGS = [
  "accounts",
  "notifications",
  "storage",
  "socials",
  "short_links",
  "ip_lookup",
  "jokes",
  "space_invaders",
] as const;

/** Every slug the uptime report covers. */
export const ALL_SERVICE_SLUGS = [...INTERNAL_SERVICE_SLUGS, ...EXTERNAL_SERVICE_SLUGS] as const;

/** A service slug. Open, because the registry is a constant somebody will extend. */
export type ServiceSlug = (typeof ALL_SERVICE_SLUGS)[number] | (string & {});

/** Live health of one external service. */
export interface ServiceHealth {
  /** `true` when the probe got a 2xx from the service's `/health`. */
  readonly ok: boolean;
  /**
   * A STRING, and not the HTTP status you might expect from the name.
   *
   * It is `"OK"` when the probe succeeded, and otherwise the failure's
   * identity: either a Ruby exception class (`"Errno::ECONNREFUSED"`,
   * `"Net::OpenTimeout"`, `"SocketError"`), or `"HTTP<code>"` for a
   * non-success response (`"HTTP503"`), or `"MissingURL"` when the service has
   * no URL configured. Show it, do not parse it - the set is whatever Ruby
   * happens to raise.
   */
  readonly status: string;
}

/**
 * The live status map: one entry per external slug, and nothing else.
 *
 * Keyed by {@link EXTERNAL_SERVICE_SLUGS} only - the internal services do not
 * appear, because there is nothing to ping.
 */
export type ServicesStatusMap = Record<string, ServiceHealth>;

/** One day of a service's history in the uptime report. */
export interface UptimeDay {
  /** `YYYY-MM-DD`, in the SERVER's timezone - the bucket is `DATE(created_at)`. */
  readonly date: string;
  /**
   * - `"up"` - every ping that day succeeded;
   * - `"degraded"` - some succeeded and some did not;
   * - `"down"` - every ping failed;
   * - `"unknown"` - no pings at all that day (the future half of today, days
   *   before the service existed, and any window where the healthcheck job was
   *   not running).
   */
  readonly status: "up" | "degraded" | "down" | "unknown";
  /** Successful pings that day. Roughly 1440 on a fully healthy day. */
  readonly up: number;
  /** Failed pings that day. */
  readonly down: number;
}

/** One service's 90-day history. */
export interface UptimeService {
  readonly slug: ServiceSlug;
  /**
   * Exactly 90 entries, oldest first, with no gaps: a day with no data is
   * present with `status: "unknown"` and zero counts rather than missing.
   * Index 89 is today, and today is partial.
   */
  readonly days: UptimeDay[];
  /**
   * Successful pings over total pings across the whole window, as a
   * percentage rounded to two decimals. `null` when the service has no pings
   * at all in the window - a brand new slug, or a long outage of the
   * healthcheck job itself. Do not render `null` as `0%`.
   */
  readonly uptime_pct: number | null;
}

/** A note appended to an incident as it progressed. */
export interface IncidentUpdate {
  /**
   * Free text. Auto-opened incidents post `"investigating"` and `"resolved"`;
   * a hand-written one can say anything.
   */
  readonly status: string;
  readonly body: string | null;
  readonly created_at: Timestamp;
}

/** A public incident on the status page. */
export interface Incident {
  /** An INTEGER. */
  readonly id: number;
  /** Auto-opened incidents are titled `"<slug> indisponível"`, in Portuguese. */
  readonly title: string;
  readonly body: string | null;
  /** Auto-opened ones are always `"major"`. */
  readonly severity: "minor" | "major" | "critical";
  readonly started_at: Timestamp;
  /** `null` while the incident is open. */
  readonly resolved_at: Timestamp | null;
  /** Affected slugs. Can be empty, and can name a slug not in the registry. */
  readonly services: ServiceSlug[];
  /** Oldest first. */
  readonly updates: IncidentUpdate[];
}

/** The whole uptime report. */
export interface UptimeReport {
  /** First day of the window, `YYYY-MM-DD`. 89 days before `to`. */
  readonly from: string;
  /** Today, `YYYY-MM-DD`. */
  readonly to: string;
  /** One entry per slug in {@link ALL_SERVICE_SLUGS}, in registry order. */
  readonly services: UptimeService[];
  /** The 20 most recent PUBLIC incidents, newest first. Private ones are omitted. */
  readonly incidents: Incident[];
}

/** Seconds of server-side caching on {@link ServicesStatusNamespace.uptime}. */
export const UPTIME_CACHE_SECONDS = 60;

/** Days of history the uptime report covers. */
export const UPTIME_WINDOW_DAYS = 90;

/**
 * The `services_status` namespace: the public status page.
 *
 * Both routes are anonymous (`allow_unauthenticated_access` with no `only:`),
 * and both are exempt from the visitor-logging after-action because the status
 * widget polls from every page load and would otherwise drown the activity
 * feed.
 *
 * ## The two calls have opposite cost profiles, and the names mislead
 *
 * {@link current} sounds cheap and is the expensive one; {@link uptime} sounds
 * heavy and is served from a cache. Read both method docs before you put
 * either behind a poller.
 */
export class ServicesStatusNamespace extends Resource {
  /**
   * `GET /services_status` - live health of the three external services.
   *
   * **This is the expensive endpoint in this namespace.** It performs the
   * probes inline, on the request thread, one after another - the controller
   * uses `index_with` with `Object#then`, so there is no concurrency - each
   * with a 2 second connect timeout and a 5 second read timeout. A healthy
   * call is a few tens of milliseconds; a call while all three are unreachable
   * holds a Puma thread for up to about 21 seconds and returns
   * `ok: false` three times.
   *
   * There is NO cache and NO dedicated rate limit, so it sits on the general
   * anonymous budget of 120 requests per minute per IP. Poll it at most once
   * every 30 seconds or so, and give it a client-side `timeoutMs` well above
   * the SDK default if your default is short - a slow answer here is the
   * normal answer during an outage, not a hung request.
   *
   * Only {@link EXTERNAL_SERVICE_SLUGS} appear in the map. The internal slugs
   * are absent because they have nothing to probe; read them out of
   * {@link uptime} instead.
   */
  async current(options: RequestOptions = {}): Promise<ServicesStatusMap> {
    return this.http.get<ServicesStatusMap>("/services_status", options);
  }

  /**
   * `GET /services_status/uptime` - 90 days of per-day history for all eleven
   * services, plus the 20 most recent public incidents.
   *
   * ## Cost and freshness, honestly
   *
   * This endpoint was flooded (roughly 900 requests a minute from a load
   * generator) and the fix was not a throttle: it was one grouped query plus a
   * cache. It still has no rack-attack bucket of its own.
   *
   * - **Freshness: up to 60 seconds stale.** The whole payload is memoised
   *   under the single global cache key `"services_status/uptime"` for
   *   {@link UPTIME_CACHE_SECONDS} seconds. The key is not per-caller and not
   *   per-parameter (there are no parameters), so every visitor on the site
   *   shares one entry. Polling faster than once a minute cannot produce a
   *   newer number - it just spends your rate budget re-fetching bytes you
   *   already have.
   * - **Cost on a hit: sending the payload.** Eleven services times ninety
   *   days is 990 day objects plus the incidents, so this is a
   *   double-digit-kilobyte response every time. There is no `ETag` and no
   *   `Last-Modified`, so it cannot answer `304` even when nothing changed.
   * - **Cost on a miss: one grouped aggregate** over
   *   `service_pings` - `GROUP BY slug, DATE(created_at), status` across the
   *   window - which is on the order of a million rows, since the healthcheck
   *   job writes one ping per slug per minute. Indexed on
   *   `(slug, created_at)`, but it is still the single heaviest query on the
   *   public surface, and exactly one request per minute pays it.
   *
   * ## Reading the numbers
   *
   * `up` and `down` are ping counts, not durations: a fully healthy day is
   * about 1440 up and 0 down. The window is 90 days and ping retention is also
   * 90 days, so the OLDEST day in every report is partially pruned and its
   * counts read low - do not compute an SLA off day zero.
   *
   * The eight internal slugs are `"up"` for every minute the Rails process was
   * running the healthcheck job, because that is literally what they measure.
   * They report the job's liveness, not the feature's.
   */
  async uptime(options: RequestOptions = {}): Promise<UptimeReport> {
    return this.http.get<UptimeReport>("/services_status/uptime", options);
  }
}
