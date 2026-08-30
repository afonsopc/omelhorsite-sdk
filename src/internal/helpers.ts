/** Small helpers shared by resource modules. Not part of the public surface. */

import { OmsError } from "../errors";

/** Fails fast on a value the server would answer for with a framework error. */
export function assertPresent(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OmsError(`${field} is required and cannot be blank.`, "invalid_request");
  }
}

/** Copies the keys that were supplied; `undefined` is skipped, an explicit `null` is kept. */
export function pickOptional<T extends object>(
  source: T,
  keys: readonly (keyof T & string)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Normalises a scope list given as an array or as a space/comma separated string. */
export function scopeList(scopes: readonly string[] | string): string[] {
  const parts = Array.isArray(scopes) ? scopes : String(scopes).split(/[\s,]+/);
  return parts.map((scope) => String(scope).trim()).filter((scope) => scope.length > 0);
}

/** Path-safe form of an integer id. */
export function idSegment(id: number): string {
  return encodeURIComponent(String(id));
}
