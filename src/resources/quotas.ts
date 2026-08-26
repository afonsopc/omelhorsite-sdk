/**
 * The `quotas` namespace: every ceiling on the account, in one call.
 *
 * This exists because the question an agent actually asks is "how much is left
 * of everything", and answering it used to mean knowing which four tools were
 * metered, calling four endpoints, and then knowing that neither storage nor
 * music was in any of those answers. `oms.quotas.list()` is one request and
 * returns every resource the server meters, each in the same shape.
 *
 * The per-tool `quota()` calls have NOT gone anywhere and answer exactly what
 * they always answered - they are published API. Use them when you want one
 * tool and nothing else, or when the credential carries `tools:read` but not
 * `profile`; use this when you want the picture.
 *
 * Two things to read before trusting a number:
 *
 * - **`period` is not decoration.** A `"daily"` resource resets at midnight,
 *   server time, and `used` is what today has spent. A `"total"` resource is
 *   what is stored RIGHT NOW and only falls when something is deleted; waiting
 *   does not give it back.
 * - **Anonymous callers get a shorter list.** Without a credential the server
 *   answers with the daily resources only, counted per IP, because an
 *   anonymous caller has no file tree and no music library. Never index the
 *   array by position - look the resource up by name, or use
 *   {@link quotaFor}, which returns `undefined` rather than lying.
 *
 * Needs the `profile` scope for an OAuth token, the same scope
 * `account.usage()` needs, because a quota is account state and it spans tools,
 * storage and music at once.
 *
 * ```ts
 * const report = await oms.quotas.list();
 * const music = quotaFor(report, "music_storage_bytes");
 * if (music && !quotaAffords(music, file.size)) throw new Error("no room");
 * ```
 */

import { Resource } from "../http";
import type { RequestOptions } from "../types";

/**
 * Every resource the server's catalogue defines today, in the order it answers
 * them: the four metered tools first, then the two storage ceilings.
 *
 * A server that grows a seventh keeps working - {@link QuotaEntry.resource} is
 * widened to `string` on purpose, so an unknown name arrives as data rather
 * than as a type error in a client nobody has rebuilt.
 */
export const QUOTA_RESOURCES = [
  "vocal_separation_seconds",
  "transcription_seconds",
  "caption_seconds",
  "jumpstyle_edits",
  "storage_nodes",
  "music_storage_bytes",
] as const;

/** One of {@link QUOTA_RESOURCES}. */
export type QuotaResource = (typeof QUOTA_RESOURCES)[number];

/**
 * What the numbers count. `"seconds"` of media, `"count"` of whole things
 * (edits, files and folders), `"bytes"` of stored media.
 */
export type QuotaUnit = "seconds" | "count" | "bytes";

/**
 * `"daily"` spends and resets at midnight, server time. `"total"` is what is
 * stored right now and only falls when something is deleted.
 */
export type QuotaPeriod = "daily" | "total";

/** One resource, in the one shape every resource uses. */
export interface QuotaEntry {
  /** A {@link QuotaResource}, or a name added to the server since this build. */
  readonly resource: QuotaResource | string;
  readonly unit: QuotaUnit | string;
  readonly period: QuotaPeriod | string;
  /** Spent today for a daily resource; stored right now for a total one. */
  readonly used: number;
  /** `null` exactly when {@link unlimited} is `true`. */
  readonly limit: number | null;
  /** `null` exactly when {@link unlimited} is `true`. Never negative. */
  readonly remaining: number | null;
  /** `true` when this account has no ceiling on this resource. */
  readonly unlimited: boolean;
}

/** `GET /quotas` in full. */
export interface QuotaReport {
  /** Whether the caller was recognised. Anonymous callers get a shorter list. */
  readonly authenticated: boolean;
  /** One entry per resource the caller can actually spend. */
  readonly quotas: QuotaEntry[];
}

/** The `quotas` namespace, reachable as `oms.quotas`. */
export class QuotasNamespace extends Resource {
  /**
   * `GET /quotas` - every ceiling on the account, in one request.
   *
   * Works anonymously, and then answers with the daily resources only.
   *
   * Every number is computed on the spot - the daily ones are aggregates over
   * today's rows, and the two totals are a subtree row count and a blob-size
   * sum - so this is a call to make BEFORE an expensive upload, not one to
   * poll. The server throttles it at thirty a minute per caller, well above
   * that use and well below a loop.
   */
  async list(options: RequestOptions = {}): Promise<QuotaReport> {
    const answer = await this.http.get<QuotaReport>("/quotas", options);
    return {
      authenticated: answer?.authenticated === true,
      quotas: answer?.quotas ?? [],
    };
  }

  /**
   * One resource, or `null` when the caller cannot spend it - which is what an
   * anonymous caller gets for `storage_nodes` and `music_storage_bytes`.
   *
   * Costs the same single request as {@link list}, because the server has no
   * per-resource endpoint. Asking for three resources means calling
   * {@link list} once and using {@link quotaFor} three times, not calling this
   * three times.
   */
  async get(resource: QuotaResource | string, options: RequestOptions = {}): Promise<QuotaEntry | null> {
    return quotaFor(await this.list(options), resource) ?? null;
  }
}

/**
 * Finds one resource in a report. Returns `undefined` when it is not there,
 * which is a real answer and not a failure: an anonymous caller has no storage
 * quota because they have no storage.
 */
export function quotaFor(report: QuotaReport, resource: QuotaResource | string): QuotaEntry | undefined {
  return report.quotas.find((entry) => entry.resource === resource);
}

/** True when there is nothing left to spend. Always false when unlimited. */
export function quotaExhausted(entry: QuotaEntry): boolean {
  if (entry.unlimited || entry.remaining === null) return false;
  return entry.remaining <= 0;
}

/**
 * Whether `amount` more fits under the ceiling, in the resource's own unit.
 *
 * Always true when unlimited. Uses `remaining` when the server sent one and
 * falls back to `limit - used` when it did not, so it is honest about a report
 * that is missing a field rather than reading `null` as zero.
 */
export function quotaAffords(entry: QuotaEntry, amount: number): boolean {
  if (entry.unlimited) return true;
  const remaining = entry.remaining ?? (entry.limit === null ? null : Math.max(0, entry.limit - entry.used));
  if (remaining === null) return true;
  return amount <= remaining;
}
