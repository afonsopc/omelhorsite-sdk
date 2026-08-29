/**
 * The `ipLookup` namespace: network metadata for an IP address.
 *
 * Works anonymously. The special argument `"mine"` asks the backend what IP it
 * sees the caller coming from, which is the only way for a client behind NAT
 * or a proxy to learn its own public address.
 *
 * The name promises more than the service delivers, and it is worth knowing
 * before you build a UI on it: the database behind `IpLookuper` is built by
 * `backend/bin/create_mmdb` from the iptoasn.com IP-to-ASN table, NOT from a
 * GeoIP City database. It knows the country, the autonomous system and the
 * network - it does not know the city, the coordinates or the timezone, and no
 * amount of asking will make those appear.
 */

import { Resource } from "../http";
import type { RequestOptions } from "../types";

/**
 * What the lookup service knows about an address.
 *
 * Exactly five keys, always all five. `IpLookuper` answers `{ ip:, **record }`
 * and nothing else: `country`, `asn` and `organization` are the three the MMDB
 * builder writes per range, and `network` is stamped on by the reader from the
 * prefix that matched. Nothing is computed and nothing is filled in for a
 * missing row - a miss is a 400, not a half-empty object.
 *
 * The name promises a GeoIP payload and this is not one, so there is no
 * `city`, no `latitude`/`longitude`, no `timezone` and no `postal`. Those keys
 * exist in the MaxMind gem's own result API and are all `nil` here, because
 * the database behind it is the iptoasn.com IP-to-ASN table.
 */
export interface IpLookupResult {
  /** The address that was looked up, echoed back. For `"mine"`, the resolved one. */
  readonly ip: string;
  /**
   * ISO 3166-1 alpha-2, **lowercase** (`"pt"`, `"us"`), or the literal
   * `"unknown"` when the source table had no country for the range. Uppercase
   * it yourself before feeding it to a flag or a locale lookup.
   */
  readonly country: string;
  /**
   * Autonomous system number, or `0` when the range is not announced. `0` is
   * the builder's substitute for a non-numeric column, not a real AS, so treat
   * it as "unknown" rather than looking it up.
   */
  readonly asn: number;
  /**
   * Network operator name as the AS registry spells it, e.g. `"GOOGLE"`.
   * Whitespace-squished, and the EMPTY STRING when the source table had no
   * name for the range - never `null`, so test it for length rather than for
   * presence.
   */
  readonly organization: string;
  /** The CIDR block the address fell in, e.g. `"8.8.8.0/24"`. */
  readonly network: string;
}

/** The `ipLookup` namespace, reachable as `oms.ipLookup`. */
export class IpLookupNamespace extends Resource {
  /**
   * `GET /ip_lookup/:ip` - looks up any IPv4 or IPv6 address.
   *
   * Anonymous. Counts against the general anonymous ceiling (120/min per IP)
   * or the authenticated one (600/min per session) when a token is set.
   *
   * @param ip The address, or the literal `"mine"` (prefer {@link mine} for
   *   that, it reads better at the call site).
   * @throws {OmsApiError} 400 `Invalid IP address` when the argument does not
   *   parse as an address, and also when it parses but the database has no row
   *   for it. The two cases are not distinguishable from the response.
   */
  async get(ip: string, options: RequestOptions = {}): Promise<IpLookupResult> {
    // The route matches any segment without a slash. Encoding keeps an IPv6
    // literal's colons out of Rails' path parsing.
    return this.http.get<IpLookupResult>(`/ip_lookup/${encodeURIComponent(ip)}`, options);
  }

  /**
   * `GET /ip_lookup/mine` - the public address the backend sees this client
   * arriving from.
   *
   * Behind Cloudflare the backend reads `CF-Connecting-IP`, so this is the
   * client's real address, not the edge's.
   */
  async mine(options: RequestOptions = {}): Promise<IpLookupResult> {
    return this.get("mine", options);
  }
}
