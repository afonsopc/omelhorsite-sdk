/**
 * The `dynamicQrs` namespace: QR codes whose destination can be changed after
 * the code has been printed.
 *
 * Under the hood each one is a `ShortLink` in the reserved `"qr"` namespace
 * with a server-minted UUID endpoint, plus the styling the renderer needs. It
 * is a separate resource because the endpoint is not user-chosen, the payload
 * carries `settings`, and the plain short-link listing filters system
 * namespaces out - a dynamic QR will never appear in `oms.shortLinks.list()`.
 *
 * Rendering the image itself is a LOCAL operation with no network: encode
 * `oms.dynamicQrs.publicUrl(qr)` with `oms.local.qr`. This namespace only
 * manages the redirect and its statistics.
 *
 * Every action here requires a credential; there is no anonymous path.
 */

import { Resource } from "../http";
import type { BaseRecord, Id, JsonObject, RequestOptions } from "../types";
import { SHORT_LINK_BASE_URL, type ShortLinkId, type ShortLinkStats } from "./shortLinks";

/**
 * The reserved short-link namespace every dynamic QR lives in.
 *
 * `ShortLink::DYNAMIC_QR_NAMESPACE`. It is not a user choice and it never
 * changes on a record, which is why {@link DynamicQr.namespace} is typed as
 * this literal rather than as a string.
 */
export const DYNAMIC_QR_NAMESPACE = "qr";

/** Public prefix a dynamic QR resolves under. */
export const DYNAMIC_QR_BASE_URL = `${SHORT_LINK_BASE_URL}/${DYNAMIC_QR_NAMESPACE}`;

/** Module shapes `DynamicQrs::SettingsSanitizer` accepts. Anything else is dropped. */
export type DynamicQrStyle = "classic" | "rounded" | "dots" | "extraRounded" | "classy" | "classyRounded";

/**
 * Styling of a dynamic QR.
 *
 * The backend runs this bag through `DynamicQrs::SettingsSanitizer`, which
 * **silently drops** every key it does not recognise and every value that fails
 * its check - a bad `style`, a colour that is not `#rrggbb`. An unknown or
 * malformed key is therefore a no-op, not an error, and the only way to know
 * what stuck is to read `settings` back off the response.
 *
 * The two exceptions that DO fail loudly are `logo` and `bg_image`: a value
 * that is neither `null`/`""` nor a `data:image/...` URI under the size cap is
 * a 400.
 *
 * The SDK does not render any of this; it is what the web tool's renderer
 * consumes. `oms.local.qr` draws a plain symbol from the matrix instead.
 */
export interface DynamicQrSettings {
  /** Module shape. Values outside {@link DynamicQrStyle} are dropped. */
  readonly style?: DynamicQrStyle;
  /** Error-correction level. Higher survives a bigger logo. Dropped unless `L`/`M`/`Q`/`H`. */
  readonly error_correction_level?: "L" | "M" | "Q" | "H";
  /** Foreground colour, `#rrggbb` exactly (six digits, leading `#`). Dropped otherwise. */
  readonly fg_color?: string;
  /** Background colour, `#rrggbb` exactly. Dropped otherwise. */
  readonly bg_color?: string;
  /** Foreground opacity, clamped to `[0, 1]`. */
  readonly fg_alpha?: number;
  /** Background opacity, clamped to `[0, 1]`. */
  readonly bg_alpha?: number;
  /** Legacy switch kept for old saved codes; equivalent to `fg_alpha: 0`. */
  readonly fg_transparent?: boolean;
  /** Legacy switch kept for old saved codes; equivalent to `bg_alpha: 0`. */
  readonly bg_transparent?: boolean;
  /**
   * Logo overlaid in the centre, as a `data:image/...` URI under 512 000 bytes.
   * `null` or `""` clears it. Anything else is a 400.
   */
  readonly logo?: string | null;
  /**
   * Background image, as a `data:image/...` URI under 2 048 000 bytes. `null`
   * or `""` clears it. Anything else is a 400.
   */
  readonly bg_image?: string | null;
  /** How the background image sits against `bg_color`. Anything but `"replace"` reads as `"behind"`. */
  readonly bg_image_mode?: "replace" | "behind";
  /**
   * The stored bag is free-form JSON, so a code saved by an older version of
   * the web tool can carry keys this interface does not name.
   */
  readonly [key: string]: unknown;
}

/**
 * A dynamic QR code.
 *
 * `DynamicQrBlueprint` renders `ApplicationBlueprint`'s three automatic keys
 * (`id`, `created_at`, `updated_at`) plus exactly five more, and that is the
 * whole record. Two keys a client migrating off the old web service will
 * expect are NOT here and never were on this endpoint: `website_id` and
 * `website_managed`. They are residue of the websites feature, which was
 * extracted out of this backend entirely - there is no such column on
 * `short_links` and no such field on any blueprint, so anything declaring them
 * has been reading `undefined`.
 *
 * The blueprint is also never resolved automatically. A dynamic QR IS a
 * `ShortLink`, and `ShortLinkBlueprint` already owns that name with a
 * different shape (associations, no `settings`), so every call site passes
 * this blueprint explicitly. That is why the two records disagree about which
 * fields exist even though they are rows in one table.
 */
export interface DynamicQr extends Omit<BaseRecord, "id"> {
  /** Integer primary key: a dynamic QR is a `short_links` row. See {@link ShortLinkId}. */
  readonly id: number;
  /** Current destination. Changing it re-points every printed copy at once. */
  readonly url: string;
  /** Server-assigned UUID the QR image encodes. Not choosable, not renameable. */
  readonly endpoint: string;
  /**
   * Always {@link DYNAMIC_QR_NAMESPACE}. The controller writes it on create
   * and nothing can change it afterwards, and the listing scope filters on it,
   * so a record that reached you through this namespace cannot hold anything
   * else.
   */
  readonly namespace: typeof DYNAMIC_QR_NAMESPACE;
  /**
   * Owner. The column is nullable because anonymous short links exist, but
   * every route on this resource requires a credential and the controller
   * always sets the owner, so in practice this is never `null` for a dynamic
   * QR.
   */
  readonly user_id: Id | null;
  /** Never `null`: the blueprint substitutes `{}` for an unset bag. */
  readonly settings: DynamicQrSettings & JsonObject;
}

/** Arguments for creating a dynamic QR. */
export interface CreateDynamicQrInput {
  /** Absolute `http`/`https` destination. Blank is a 400. */
  readonly url: string;
  /** Initial styling. Unrecognised keys are dropped without complaint. */
  readonly settings?: DynamicQrSettings;
}

/**
 * Fields that can change afterwards.
 *
 * `settings` is **merged** into the stored bag by the backend, not replaced, so
 * an update can never unset a key by omitting it. To clear one, send it
 * explicitly with the value that means empty (`null` for `logo`/`bg_image`).
 */
export interface UpdateDynamicQrInput {
  readonly url?: string;
  readonly settings?: DynamicQrSettings;
}

/** The `dynamicQrs` namespace, reachable as `oms.dynamicQrs`. */
export class DynamicQrsNamespace extends Resource {
  /**
   * `GET /dynamic_qrs` - every code you own, newest first.
   *
   * Returns a plain array rather than a page object, and that is not an
   * oversight: this controller does not use `CrudActions` and ignores
   * `modifiers[page]` entirely, so it always answers with the complete set. A
   * `Paginated` here would be a fiction with a `next()` that refetched
   * everything.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   */
  async list(options: RequestOptions = {}): Promise<DynamicQr[]> {
    const items = await this.http.get<DynamicQr[] | undefined>("/dynamic_qrs", options);
    return items ?? [];
  }

  /**
   * `POST /dynamic_qrs` - mints a code and its permanent endpoint.
   *
   * Retries are off by default: a replayed `POST` after a 502 mints a second
   * code with a second endpoint, and the one that got printed is decided by
   * which response you happened to keep. Pass `retry` explicitly to override.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   * @throws {OmsApiError} 400 when `url` is blank or invalid, or when `logo` /
   *   `bg_image` is not a `data:` URI within the size cap.
   */
  async create(input: CreateDynamicQrInput, options: RequestOptions = {}): Promise<DynamicQr> {
    return this.http.post<DynamicQr>(
      "/dynamic_qrs",
      {
        url: input.url,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /dynamic_qrs/:id` - repoints the code or restyles it.
   *
   * This is the whole point of the resource: the printed symbol never changes,
   * only where it lands. `settings` merges; see {@link UpdateDynamicQrInput}.
   *
   * @throws {OmsApiError} 404 when the code is not yours, 400 on a blank URL or
   *   an oversized `logo` / `bg_image`.
   */
  async update(id: ShortLinkId, input: UpdateDynamicQrInput, options: RequestOptions = {}): Promise<DynamicQr> {
    return this.http.patch<DynamicQr>(`/dynamic_qrs/${encodeURIComponent(String(id))}`, { ...input }, options);
  }

  /**
   * `DELETE /dynamic_qrs/:id`.
   *
   * Every printed copy dies with it: the endpoint stops resolving and the
   * recorded clicks are destroyed alongside the row. There is no undo and no
   * tombstone redirect.
   *
   * @throws {OmsApiError} 404 when the code is not yours.
   */
  async delete(id: ShortLinkId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/dynamic_qrs/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `GET /dynamic_qrs/:id/stats` - byte-for-byte the same click summary a short
   * link gets, including the fixed 30-day window.
   *
   * @throws {OmsApiError} 404 when the code is not yours.
   */
  async stats(id: ShortLinkId, options: RequestOptions = {}): Promise<ShortLinkStats> {
    return this.http.get<ShortLinkStats>(`/dynamic_qrs/${encodeURIComponent(String(id))}/stats`, options);
  }

  /**
   * The URL the printed symbol should encode. Pure string building, no request.
   *
   * Always encode THIS, never `qr.url`: the whole redirect indirection is what
   * makes the destination editable after printing.
   *
   * ```ts
   * const qr = await oms.dynamicQrs.create({ url: "https://example.com" });
   * const svg = oms.local.qr.toSvg(oms.dynamicQrs.publicUrl(qr), { ecc: "H" });
   * ```
   */
  publicUrl(qr: Pick<DynamicQr, "endpoint">): string {
    return `${DYNAMIC_QR_BASE_URL}/${qr.endpoint}`;
  }
}
