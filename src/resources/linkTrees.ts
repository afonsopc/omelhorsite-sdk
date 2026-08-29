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
import { SHORT_LINK_BASE_URL } from "./shortLinks";

/**
 * The reserved short-link namespace a link tree is served under.
 * `ShortLink::LINK_TREE_NAMESPACE`.
 *
 * Note it is `"t"` and not `"lt"`. The model's own comment says `"lt"`; the
 * constant says `"t"`, and the constant is what the rows carry.
 */
export const LINK_TREE_NAMESPACE = "t";

/** Public prefix a link tree resolves under. */
export const LINK_TREE_BASE_URL = `${SHORT_LINK_BASE_URL}/${LINK_TREE_NAMESPACE}`;

/** Longest a slug may be. */
export const LINK_TREE_SLUG_MAX_LENGTH = 63;

/**
 * Shortest a slug may actually be, which is **3** and not the 2 that
 * `LinkTree::SLUG_MIN` claims.
 *
 * Two validations run, and the tighter one wins. The length check allows 2,
 * but `SLUG_FORMAT` is `/\A[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?\z/`: either the
 * optional group is absent, which matches ONE character and then fails the
 * length check, or it is present and contributes at least two more. There is
 * no way to spell a valid two-character slug, so a caller that trusts
 * `SLUG_MIN` gets a 400 saying the slug "contains invalid characters".
 */
export const LINK_TREE_SLUG_MIN_LENGTH = 3;

/** Most items one tree may carry. */
export const LINK_TREE_MAX_ITEMS = 30;

/** Ceiling on the attached CV, which must also be a PDF. */
export const LINK_TREE_CV_MAX_BYTES = 10 * 1024 * 1024;

/**
 * One entry on a link tree, AS READ back.
 *
 * `id` is not optional here even though it is optional when writing:
 * `LinkTrees::InputSanitizer#items` mints `SecureRandom.uuid` for any entry
 * that arrives without one, so a stored entry always has one - and it has to,
 * because it is the key `clicks_by_item` is filed under.
 *
 * `label` and `url` are likewise always present, because an entry missing
 * either is DROPPED from the list rather than stored blank. The three
 * remaining keys are genuinely absent when unset: the sanitiser only writes
 * `icon` and `description` when non-blank, and `icon_image` only when it is a
 * `data:image/` URI under the cap.
 *
 * Write with {@link LinkTreeItemInput}.
 */
export interface LinkTreeItem {
  /** Stable within the tree, and the key `clicks_by_item` is filed under. */
  readonly id: string;
  /** Up to 80 characters, and never blank. */
  readonly label: string;
  /** Up to 1024 characters, and never blank. */
  readonly url: string;
  /** Icon slug the renderer resolves. Up to 40 characters. */
  readonly icon?: string;
  /** Up to 200 characters. */
  readonly description?: string;
  /** `data:image/...` under 80 KB, for a custom icon. */
  readonly icon_image?: string;
}

/**
 * One entry as WRITTEN.
 *
 * `url` must carry an `http`, `https`, `mailto`, `tel` or `sms` scheme; a bare
 * domain is rejected by the model, not silently fixed. An entry whose `label`
 * or `url` is blank is dropped by the sanitiser BEFORE validation, so it
 * disappears without an error rather than failing the write.
 *
 * A {@link LinkTreeItem} read off a tree is assignable here, so the
 * read-edit-write round trip needs no mapping - and keeping each item's `id`
 * through that round trip is what keeps `clicks_by_item` lined up with
 * anything.
 */
export interface LinkTreeItemInput {
  /** Omit and the server mints a UUID, which you then have to read back before
   * you can call {@link LinkTreesNamespace.trackClick} for this entry. */
  readonly id?: string;
  readonly label: string;
  readonly url: string;
  readonly icon?: string;
  readonly description?: string;
  /**
   * `data:image/...` under 80 KB. `null` and any other non-conforming value
   * are DROPPED by the sanitiser rather than rejected, so sending `null` here
   * clears the icon by omission and answers 200 either way.
   */
  readonly icon_image?: string | null;
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

/**
 * A link-in-bio page, owner view.
 *
 * Every key is present on every owner-facing response: index, show, create,
 * update, `uploadCv` and `removeCv` all render the blueprint's DEFAULT view,
 * never `:extended`, so there is no richer variant and nothing here is
 * conditional. Four of the values are nullable.
 */
export interface LinkTree extends BaseRecord {
  readonly user_id: Id;
  /** Public path segment. Lowercase letters, digits and dashes. */
  readonly slug: string;
  /** Never blank: the model validates presence. Up to 80 characters. */
  readonly title: string;
  /** Up to 280 characters, or `null`. Never `undefined`. */
  readonly bio: string | null;
  /** The avatar, inline as a `data:image/` URI rather than a URL, or `null`. */
  readonly avatar_data_url: string | null;
  /** Never `null`: the blueprint substitutes `[]` for an unset list. */
  readonly items: LinkTreeItem[];
  /** Never `null`: the blueprint substitutes `{}` for an unset bag. */
  readonly theme: LinkTreeTheme;
  /**
   * Click counters keyed by {@link LinkTreeItem.id}. Never `null` - `{}` for a
   * tree nobody has clicked - and it can hold ids of items that have since
   * been deleted, because nothing prunes it.
   */
  readonly clicks_by_item: Record<string, number>;
  /** Absolute URL that downloads the CV, or `null` when none is attached. */
  readonly cv_url: string | null;
  readonly cv_filename: string | null;
  /** The shareable short URL: `{@link LINK_TREE_BASE_URL}/{slug}`. */
  readonly public_url: string;
  /** Endpoint of the paired short link. Always equal to `slug`. */
  readonly short_link_endpoint: string;
  /** Always {@link LINK_TREE_NAMESPACE}; the blueprint renders the constant. */
  readonly short_link_namespace: typeof LINK_TREE_NAMESPACE;
}

/**
 * The visitor's view: the same page with the owner-only fields removed.
 *
 * The `:public` view excludes exactly seven keys - `user_id`,
 * `clicks_by_item`, `public_url`, `short_link_endpoint`,
 * `short_link_namespace`, `created_at` and `updated_at` - and INHERITS
 * everything else from the default view, which is why `id`, `cv_url` and
 * `cv_filename` are still here. It carries no timestamps, so it is NOT a
 * {@link LinkTree} and cannot be passed where one is expected.
 */
export interface PublicLinkTree {
  readonly id: Id;
  readonly slug: string;
  readonly title: string;
  readonly bio: string | null;
  readonly avatar_data_url: string | null;
  readonly items: LinkTreeItem[];
  readonly theme: LinkTreeTheme;
  readonly cv_url: string | null;
  readonly cv_filename: string | null;
}

/** Arguments for creating a link tree. */
export interface CreateLinkTreeInput {
  /**
   * {@link LINK_TREE_SLUG_MIN_LENGTH} to {@link LINK_TREE_SLUG_MAX_LENGTH}
   * characters of `[a-z0-9-]`, starting and ending alphanumeric, and never one
   * of `new edit admin api root login logout signup signin manage`.
   *
   * Lowercased and trimmed server-side before any check, so casing is not a
   * reason to be refused.
   */
  readonly slug: string;
  /** Required: the model refuses a blank title. Up to 80 characters. */
  readonly title: string;
  /** Up to 280 characters. */
  readonly bio?: string;
  /**
   * `data:image/...` under 500 KB. Anything else - a plain URL, an oversized
   * image - is turned into `null` by the sanitiser before validation, so a bad
   * avatar creates the tree WITHOUT one rather than failing. Read
   * `avatar_data_url` back off the answer.
   */
  readonly avatarDataUrl?: string;
  /** At most {@link LINK_TREE_MAX_ITEMS}; more is a 400. */
  readonly items?: LinkTreeItemInput[];
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
  /**
   * Accepts `null`, but note what it does: the controller assigns
   * `params[:bio].to_s.strip`, so `null` stores the empty STRING and not
   * `null`. There is no way through this endpoint to put the column back to
   * `null` once it holds a value; `""` is as empty as it gets.
   */
  readonly bio?: string | null;
  /** `null` or `""` clears the avatar. Anything malformed also clears it. */
  readonly avatarDataUrl?: string | null;
  readonly items?: LinkTreeItemInput[];
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
  /**
   * Only when `valid` is `false`. `"invalid"` for the format or the length,
   * `"reserved"` for the blocklist - link trees distinguish the two, unlike
   * the otherwise identical `FormEndpointAvailability`, which only ever says
   * `"invalid"`.
   */
  readonly reason?: "invalid" | "reserved";
  /** Only when `valid` is `true` and `available` is `false`. */
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

  /**
   * The public URL a slug is served from. Pure string building, no request, and
   * the same string the server puts in {@link LinkTree.public_url}.
   *
   * Prefer `tree.public_url` when you are holding an owner-view record. Reach
   * for this when all you have is a slug - after {@link slugAvailability}, or
   * from a {@link PublicLinkTree}, whose `:public` view deliberately drops
   * `public_url` along with the rest of the pairing metadata.
   */
  publicUrl(slug: string): string {
    return `${LINK_TREE_BASE_URL}/${slug}`;
  }
}
