/** Vocabulary shared across the intel families. */

/**
 * ## Access: this is effectively a one-user feature
 *
 * Every intel route is gated by a fixed allowlist of one handle plus admins.
 * So: anonymous is `401`, any other signed-in account is
 * `403 "Intel access is restricted."`, and no amount of correct request
 * shaping changes that. Do not build a shared feature on it, and do not
 * treat a 403 here as a bug in the caller.
 *
 * An OAuth access token is `403 {"error":"insufficient_scope"}` on every
 * route below. Session credential only.
 *
 * ## Ids are STRINGS here, unlike the rest of this file
 *
 * Both intel migrations create every table with `id: :string`, so articles,
 * reports, sources, scripts, items and the config row all carry opaque string
 * ids - while blogs, notifications, jokes and Space Invaders games two hundred
 * lines up are integers. Nothing in intel is ever a number you can compare or
 * sort by.
 *
 * ## Ceilings
 *
 * None of their own. Every route rides the general bucket: 600 requests per
 * minute for an authenticated caller. Two of them are still expensive and are
 * documented as such - {@link IntelStatsNamespace.get} and
 * {@link IntelSourcesNamespace.run}.
 */

/** Categories a story can carry. `null` when the classifier declined to pick one. */
export const INTEL_ARTICLE_CATEGORIES = [
  "incidente",
  "politica",
  "comunidade",
  "sociedade",
  "internacional",
  "economia",
  "outro",
] as const;

/**
 * A story's category.
 *
 * Widened with `string & {}` deliberately: the list is a Ruby constant that a
 * migration can extend without the SDK noticing, and a `switch` that fails to
 * compile on a new category is worse than one that falls through to a default.
 * The backend DOES validate inclusion, so a value outside the list can only
 * mean the constant moved.
 */
export type IntelArticleCategory = (typeof INTEL_ARTICLE_CATEGORIES)[number] | (string & {});

/** Report windows a report can cover. */
export const INTEL_REPORT_KINDS = ["6h", "day", "week", "month"] as const;

/** Which window a report covers. */
export type IntelReportKind = (typeof INTEL_REPORT_KINDS)[number] | (string & {});

/**
 * Base of the third-party image proxy {@link intelArticleImageUrl} builds on.
 *
 * `wsrv.nl` is a free public image CDN. It is NOT this API and NOT our
 * infrastructure.
 */
export const INTEL_IMAGE_PROXY_BASE_URL = "https://wsrv.nl/";

/** Knobs for {@link intelArticleImageUrl}. */
export interface IntelImageOptions {
  /** Target width in pixels. Default 480. Height follows the aspect ratio. */
  readonly width?: number;
  /** Quality, 1-100. Default 45 - low on purpose; these are thumbnails. */
  readonly quality?: number;
}

/**
 * Builds a resized, re-compressed URL for {@link IntelArticle.image_url}.
 *
 * Pure string building, no request, isolate-safe. Returns `""` for a story with
 * no image so it can be dropped straight into an `<img src>` without a
 * conditional - though a real client should test the field and render nothing.
 *
 * ## What this actually does, and why you might not want it
 *
 * `image_url` is the raw `og:image` of a news site: full size, arbitrary
 * format, arbitrary weight, and served from that site's own host. Nothing in
 * this API resizes it. This helper routes it through `wsrv.nl`, a free public
 * image CDN, which fetches the origin image and hands back a width-limited
 * WebP.
 *
 * The trade is explicit and it is not the SDK's to make silently:
 *
 * - the ORIGIN URL is sent to a third party in a query string, so wsrv.nl
 *   learns which article your user is looking at, and so does anyone reading
 *   the request. There is no credential involved - the images are public - but
 *   it is still a referrer-shaped leak;
 * - availability is theirs, not ours. A wsrv.nl outage is a page of broken
 *   images, and there is no fallback in the URL;
 * - `&we` asks it not to enlarge images smaller than `width`.
 *
 * If neither trade suits you, use {@link IntelArticle.image_url} directly and
 * size it in CSS.
 */
export function intelArticleImageUrl(
  imageUrl: string | null | undefined,
  options: IntelImageOptions = {},
): string {
  if (!imageUrl) return "";
  const width = options.width ?? 480;
  const quality = options.quality ?? 45;
  return `${INTEL_IMAGE_PROXY_BASE_URL}?url=${encodeURIComponent(imageUrl)}&w=${width}&q=${quality}&output=webp&we`;
}
