/** `oms.admin.quotas` - another person's quota ceilings. Administrators only. */

import type { QuotaPeriod, QuotaResource, QuotaUnit } from "../quotas";
import { Resource } from "../../http";
import type { Id, RequestOptions } from "../../types";

/**
 * How an override behaves.
 *
 * - `"default"` DELETES the override row, so the person falls back to the
 *   catalogue default. It does not write a number equal to the default, which
 *   matters the day a default changes;
 * - `"unlimited"` writes an override with a NULL value, which the server reads
 *   as no ceiling at all;
 * - `"limit"` writes the number in `value`.
 */
export type AdminQuotaOverrideMode = "default" | "unlimited" | "limit";

/** One change to apply. See {@link AdminQuotasNamespace.update}. */
export interface AdminQuotaOverride {
  readonly resource: QuotaResource | string;
  readonly mode: AdminQuotaOverrideMode;
  /** Required for `"limit"`, ignored otherwise. Must be `>= 0` and fit in a signed 64-bit integer. */
  readonly value?: number;
}

/** The stored override behind a {@link AdminUserQuotaEntry}, if there is one. */
export interface AdminQuotaOverrideState {
  /** The number, or `null` when the override means unlimited. */
  readonly value: number | null;
  /** `true` exactly when `value` is `null`. */
  readonly unlimited: boolean;
}

/**
 * One resource, for one person, as an administrator sees it.
 *
 * This is the ordinary quota entry that `oms.quotas.list()` returns, plus the
 * two keys that only make sense while editing: what the default WOULD be, and
 * what is currently overriding it.
 */
export interface AdminUserQuotaEntry {
  readonly resource: QuotaResource | string;
  readonly unit: QuotaUnit | string;
  readonly period: QuotaPeriod | string;
  /** Consumption right now, in `unit`. */
  readonly used: number;
  /** The effective ceiling, or `null` when unlimited. */
  readonly limit: number | null;
  /** `limit - used`, floored at zero. `null` when unlimited. */
  readonly remaining: number | null;
  readonly unlimited: boolean;
  /** The catalogue default for a signed-in user. What `"default"` mode restores. */
  readonly user_default: number;
  /** The stored override, or `null` when there is none and the default applies. */
  readonly override: AdminQuotaOverrideState | null;
}

/** What {@link AdminQuotasNamespace} returns. */
export interface AdminUserQuotas {
  readonly user_id: Id;
  readonly handle: string;
  /**
   * **Every** resource in the catalogue, including the storage and music
   * ceilings. Unlike the anonymous answer from `oms.quotas.list()`, nothing is
   * left out here. Look entries up by `resource`, never by position.
   */
  readonly quotas: AdminUserQuotaEntry[];
  /**
   * Legacy twin of the `music_storage_bytes` entry's `limit`, `null` when
   * unlimited. Kept for older clients that read it. Prefer the catalogue
   * entry; this key is on its way out.
   */
  readonly music_storage_limit_bytes: number | null;
}

/**
 * `oms.admin.quotas` - **administrators only**. Another person's ceilings.
 *
 * The person's own view of the same numbers is `oms.quotas.list()`, which needs
 * no privilege and cannot change anything.
 */
export class AdminQuotasNamespace extends Resource {
  /**
   * `GET /admin/users/:user/quotas` - the full catalogue for one person.
   *
   * **`user` may be a user id OR a handle.** The lookup tries the id first and
   * then the handle, downcased, which is why an admin tool can take whatever
   * was typed into a search box.
   *
   * @throws {OmsApiError} 404 `"User not found"` (a bare JSON string).
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async get(user: Id | string, options: RequestOptions = {}): Promise<AdminUserQuotas> {
    return this.http.get<AdminUserQuotas>(
      `/admin/users/${encodeURIComponent(user)}/quotas`,
      options,
    );
  }

  /**
   * `PUT /admin/users/:user/quotas` - applies a batch of overrides.
   *
   * **`PUT`, not `PATCH`.** The server accepts either verb for this update;
   * this SDK sends `PUT`.
   *
   * **The batch is NOT atomic, and this is the thing to design around.** The
   * server loops over `overrides` and writes each one as it goes, with no
   * transaction around the loop: a bad entry in the middle answers `400` with
   * everything BEFORE it already written and everything after it untouched. So
   * a failed call leaves a partial state, and the only reliable way to know
   * what landed is the answer to a fresh {@link get}. Validate the batch
   * yourself before sending it, or send one override per call.
   *
   * Passing an empty `overrides` array is a legal no-op and a cheap way to read
   * the quotas back, though {@link get} is the honest way to do that.
   *
   * The response is the full, reloaded catalogue, so there is no need to follow
   * this with a read on the success path.
   *
   * @throws {OmsApiError} 400 `"Unknown resource: x"`, `"Invalid mode: x"`, or
   *   `"Invalid value for x"` for a negative number or one past the signed
   *   64-bit ceiling. All three are bare JSON strings. 404 `"User not found"`.
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async update(
    user: Id | string,
    overrides: readonly AdminQuotaOverride[],
    options: RequestOptions = {},
  ): Promise<AdminUserQuotas> {
    return this.http.put<AdminUserQuotas>(
      `/admin/users/${encodeURIComponent(user)}/quotas`,
      {
        overrides: overrides.map((override) => ({
          resource: override.resource,
          mode: override.mode,
          ...(override.value === undefined ? {} : { value: override.value }),
        })),
      },
      options,
    );
  }
}
