/**
 * The `linkTrees` namespace: link-in-bio pages, their click statistics and the
 * optional CV attached to one.
 *
 * A tree is public at `by_slug/:slug`, and the slug is the identity a visitor
 * sees. Owner operations go through the record id, exactly like every other
 * resource. The slug is also the endpoint of a paired short link, so changing
 * it renames that link inside the same transaction and the old URL stops
 * resolving.
 */

import { Resource, buildFormData, readJson } from "../http";
import type { BaseRecord, FileInput, Id, RequestOptions, Timestamp } from "../types";

/** Longest a slug may be. The shortest is 2. */
export const LINK_TREE_SLUG_MAX_LENGTH = 63;

/** Most items one tree may carry. */
export const LINK_TREE_MAX_ITEMS = 30;

/** Ceiling on the attached CV, which must also be a PDF. */
export const LINK_TREE_CV_MAX_BYTES = 10 * 1024 * 1024;

/**
 * One entry on a link tree.
 *
 * `url` must carry an `http`, `https`, `mailto`, `tel` or `sms` scheme; a bare
 * domain is rejected by the model, not silently fixed.
 */
export interface LinkTreeItem {
  /** Stable within the tree, and the key click tracking is filed under. The
   * server mints a UUID when you leave it out, so read the tree back before
   * calling {@link LinkTreesNamespace.trackClick}. */
  readonly id?: string;
  /** Up to 80 characters. */
  readonly label: string;
  /** Up to 1024 characters, with a scheme. */
  readonly url: string;
  /** Icon slug the renderer resolves. Up to 40 characters. */
  readonly icon?: string;
  /** Up to 200 characters. */
  readonly description?: string;
  /** `data:image/...` under 80 KB, for a custom icon. */
  readonly icon_image?: string;
}

/**
 * Styling of a link tree. Colours must be `#RRGGBB` and images must be
 * `data:image/` URIs; anything else in here is dropped in silence on write.
 */
export interface LinkTreeTheme {
  readonly bg_color?: string;
  readonly text_color?: string;
  readonly button_bg?: string;
  readonly button_text?: string;
  readonly button_border_color?: string;
  readonly button_style?: "solid" | "outline" | "rounded" | "square";
  /** Clamped to 0..8. */
  readonly button_border_width?: number;
  /** `data:image/...` under 1.5 MB, or `null` to clear. */
  readonly bg_image?: string | null;
  /** `data:image/...` under 1 MB, or `null` to clear. */
  readonly banner_image?: string | null;
}

/** A link-in-bio page, owner view. */
export interface LinkTree extends BaseRecord {
  readonly user_id: Id;
  /** Public path segment. Lowercase letters, digits and dashes. */
  readonly slug: string;
  readonly title: string;
  readonly bio?: string | null;
  /** The avatar, inline as a `data:image/` URI rather than a URL. */
  readonly avatar_data_url?: string | null;
  readonly items: LinkTreeItem[];
  readonly theme: LinkTreeTheme;
  /** Click counters keyed by {@link LinkTreeItem.id}. */
  readonly clicks_by_item: Record<string, number>;
  /** Absolute URL that downloads the CV, or `null` when none is attached. */
  readonly cv_url: string | null;
  readonly cv_filename: string | null;
  /** The shareable short URL. */
  readonly public_url: string;
  /** Endpoint of the paired short link. Always equal to `slug`. */
  readonly short_link_endpoint: string;
  readonly short_link_namespace: string;
}

/**
 * The visitor's view: the same page with the owner-only fields removed. Note
 * that it carries no timestamps, so it is NOT a {@link LinkTree}.
 */
export interface PublicLinkTree {
  readonly id: Id;
  readonly slug: string;
  readonly title: string;
  readonly bio?: string | null;
  readonly avatar_data_url?: string | null;
  readonly items: LinkTreeItem[];
  readonly theme: LinkTreeTheme;
  readonly cv_url: string | null;
  readonly cv_filename: string | null;
}

/** Arguments for creating a link tree. */
export interface CreateLinkTreeInput {
  /**
   * 2 to {@link LINK_TREE_SLUG_MAX_LENGTH} characters of `[a-z0-9-]`, starting
   * and ending alphanumeric, and never one of `new edit admin api root login
   * logout signup signin manage`.
   */
  readonly slug: string;
  /** Required: the model refuses a blank title. Up to 80 characters. */
  readonly title: string;
  /** Up to 280 characters. */
  readonly bio?: string;
  /** `data:image/...` under 500 KB. Build one with `dataUrlFromFile`. */
  readonly avatarDataUrl?: string;
  readonly items?: LinkTreeItem[];
  readonly theme?: LinkTreeTheme;
}

/**
 * Fields that can change afterwards. A true PATCH: only the keys you pass are
 * touched.
 *
 * `items` REPLACES the whole list - there is no per-item endpoint, so read,
 * edit the array, write it back, and accept that two concurrent editors
 * clobber each other. Keep each item's `id` when you do, or the click counters
 * in `clicks_by_item` stop lining up with anything.
 */
export interface UpdateLinkTreeInput {
  /** Renames the paired short link; the old public URL stops resolving. */
  readonly slug?: string;
  readonly title?: string;
  readonly bio?: string;
  readonly avatarDataUrl?: string | null;
  readonly items?: LinkTreeItem[];
  readonly theme?: LinkTreeTheme;
}

/** One day of the click histogram. Always 30 entries, oldest first. */
export interface LinkTreeDailyStat {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly count: number;
}

/** One row of {@link LinkTreeStats.top_countries}. */
export interface LinkTreeCountryStat {
  readonly country: string;
  readonly count: number;
}

/** One row of {@link LinkTreeStats.top_devices}. */
export interface LinkTreeDeviceStat {
  readonly device_name: string;
  readonly count: number;
}

/**
 * `GET /link_trees/:id/stats`.
 *
 * The totals and the histogram come from the paired short link, so they count
 * visits to the PAGE. `clicks_by_item` comes from the tree itself and counts
 * clicks on the links, so the two are not comparable and will not add up.
 */
export interface LinkTreeStats {
  readonly total_clicks: number;
  readonly last_click_at: Timestamp | null;
  /** The last 30 days, one bucket per day. */
  readonly clicks_daily: LinkTreeDailyStat[];
  /** Up to ten, biggest first. */
  readonly top_countries: LinkTreeCountryStat[];
  /** Up to five, biggest first. */
  readonly top_devices: LinkTreeDeviceStat[];
  /** Clicks keyed by {@link LinkTreeItem.id}. */
  readonly clicks_by_item: Record<string, number>;
}

/**
 * `GET /link_trees/slug_availability`. Read `available`; `suggestions` is only
 * present when the slug is well formed but taken.
 */
export interface LinkTreeSlugAvailability {
  readonly slug: string;
  readonly valid: boolean;
  readonly available: boolean;
  /** `"invalid"` for the format, `"reserved"` for the blocklist. */
  readonly reason?: string;
  readonly suggestions?: string[];
}

/** The `linkTrees` namespace, reachable as `oms.linkTrees`. */
export class LinkTreesNamespace extends Resource {
  /**
   * `GET /link_trees` - the pages you own, most recently edited first.
   *
   * Not paginated and not filterable: the endpoint takes no modifiers and
   * answers with the whole set.
   */
  async list(options: RequestOptions = {}): Promise<LinkTree[]> {
    return this.http.get<LinkTree[]>("/link_trees", options);
  }

  /** `GET /link_trees/:id` - owner view, with the click counters. */
  async get(id: Id, options: RequestOptions = {}): Promise<LinkTree> {
    return this.http.get<LinkTree>(`/link_trees/${encodeURIComponent(id)}`, options);
  }

  /**
   * `GET /link_trees/by_slug/:slug` - the visitor's view. No credential
   * needed, and unlike the forms equivalent it counts nothing.
   */
  async getPublic(slug: string, options: RequestOptions = {}): Promise<PublicLinkTree> {
    return this.http.get<PublicLinkTree>(`/link_trees/by_slug/${encodeURIComponent(slug)}`, options);
  }

  /**
   * `GET /link_trees/slug_availability` - whether a slug is free, with
   * alternatives when it is not. The server is still the authority: create can
   * lose a race and answer 400.
   */
  async slugAvailability(slug: string, options: RequestOptions = {}): Promise<LinkTreeSlugAvailability> {
    return this.http.get<LinkTreeSlugAvailability>("/link_trees/slug_availability", {
      ...options,
      query: { slug },
    });
  }

  /** {@link slugAvailability} reduced to its verdict. */
  async slugAvailable(slug: string, options: RequestOptions = {}): Promise<boolean> {
    const availability = await this.slugAvailability(slug, options);
    return availability.available;
  }

  /**
   * `POST /link_trees` - creates the page and reserves its slug in one
   * transaction.
   *
   * Not retried by default: a replayed create would fail on the slug being
   * taken by its own first attempt.
   */
  async create(input: CreateLinkTreeInput, options: RequestOptions = {}): Promise<LinkTree> {
    return this.http.post<LinkTree>(
      "/link_trees",
      {
        slug: input.slug,
        title: input.title,
        bio: input.bio,
        avatar_data_url: input.avatarDataUrl,
        items: input.items,
        theme: input.theme,
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /link_trees/:id`. Only the keys you pass are touched. See the note
   * on {@link UpdateLinkTreeInput.items}: the list is replaced wholesale.
   */
  async update(id: Id, input: UpdateLinkTreeInput, options: RequestOptions = {}): Promise<LinkTree> {
    return this.http.patch<LinkTree>(
      `/link_trees/${encodeURIComponent(id)}`,
      {
        slug: input.slug,
        title: input.title,
        bio: input.bio,
        avatar_data_url: input.avatarDataUrl,
        items: input.items,
        theme: input.theme,
      },
      options,
    );
  }

  /** `DELETE /link_trees/:id`. Takes the paired short link with it. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/link_trees/${encodeURIComponent(id)}`, options);
  }

  /** `GET /link_trees/:id/stats` - page visits, and the per-item breakdown. */
  async stats(id: Id, options: RequestOptions = {}): Promise<LinkTreeStats> {
    return this.http.get<LinkTreeStats>(`/link_trees/${encodeURIComponent(id)}/stats`, options);
  }

  /**
   * `PATCH /link_trees/:id/upload_cv` - attaches a PDF visitors can download.
   *
   * Multipart, and PDF only: another content type or anything over
   * {@link LINK_TREE_CV_MAX_BYTES} is rejected with 400. Replaces whatever was
   * attached before.
   */
  async uploadCv(id: Id, file: FileInput, options: RequestOptions = {}): Promise<LinkTree> {
    const form = await buildFormData({ cv: file });
    const response = await this.http.raw("PATCH", `/link_trees/${encodeURIComponent(id)}/upload_cv`, {
      ...options,
      body: form,
    });
    return (await readJson(response)) as LinkTree;
  }

  /** `DELETE /link_trees/:id/remove_cv` - returns the updated tree, not 204. */
  async removeCv(id: Id, options: RequestOptions = {}): Promise<LinkTree> {
    return this.http.delete<LinkTree>(`/link_trees/${encodeURIComponent(id)}/remove_cv`, options);
  }

  /**
   * `GET /link_trees/by_slug/:slug/cv` - downloads the attached CV.
   *
   * Served inline by Rails rather than redirected, so the bytes come through
   * the API. The filename is on the record, as `cv_filename`.
   */
  async downloadCv(slug: string, options: RequestOptions = {}): Promise<Blob> {
    const response = await this.http.raw("GET", `/link_trees/by_slug/${encodeURIComponent(slug)}/cv`, options);
    return response.blob();
  }

  /**
   * `POST /link_trees/by_slug/:slug/track_click` - records a click on one
   * item.
   *
   * Only a client rendering the page itself should call this. The SDK's own
   * read methods never track, so reading a tree does not pollute its owner's
   * statistics.
   *
   * Answers 204 whatever happens - an unknown slug and an unknown item id both
   * look like success, deliberately, so the endpoint cannot be used to probe
   * which slugs exist.
   */
  async trackClick(slug: string, itemId: string, options: RequestOptions = {}): Promise<void> {
    await this.http.post<void>(
      `/link_trees/by_slug/${encodeURIComponent(slug)}/track_click`,
      { item_id: itemId },
      { retry: false, ...options },
    );
  }
}
