/** Shared vocabulary of the movies namespace: title types, the Stremio manifest, and the guards every area uses. */

import { OmsError } from "../../errors";

/**
 * What a title is. Stremio's own vocabulary, and the backend stores it as a
 * free string with no inclusion validation, so an addon may invent one.
 * Compare against this union for the cases you handle and fall through for the
 * rest rather than assuming the list is closed.
 */
export type MovieType = "movie" | "series" | "channel" | "tv" | (string & {});

/** The four resource names a Stremio manifest may advertise. */
export type StremioResourceName = "catalog" | "meta" | "stream" | "subtitles";

/** One catalogue an addon offers, as declared in its manifest. */
export interface StremioCatalog {
  readonly type: string;
  readonly id: string;
  readonly name?: string;
  readonly extra?: ReadonlyArray<{
    readonly name: string;
    readonly isRequired?: boolean;
    readonly options?: readonly string[];
  }>;
}

/**
 * An addon's `manifest.json`, stored verbatim in a `jsonb` column.
 *
 * The backend does not validate a single key of it beyond "not blank": it is
 * written straight to the column and read straight back. So the fields below
 * are what a well-behaved Stremio addon sends, not a contract the server
 * enforces - `id` and `name` can be missing on a hostile or broken manifest
 * even though they are typed as required here, and the index signature is
 * there because whatever else the addon declared round-trips untouched.
 *
 * Never trust `logo`, `background` or any URL inside one without checking the
 * origin: this blob is user-supplied content that the app renders.
 */
export interface StremioManifest {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly resources?: ReadonlyArray<
    StremioResourceName | { readonly name: StremioResourceName; readonly types?: readonly string[] }
  >;
  readonly types?: readonly string[];
  readonly catalogs?: readonly StremioCatalog[];
  readonly logo?: string;
  readonly background?: string;
  /** Anything else the manifest carried. `jsonb` keeps it all. */
  readonly [key: string]: unknown;
}

/**
 * Copies the keys that were actually supplied.
 *
 * `undefined` is skipped so an omitted key never reaches the wire, while an
 * explicit `null` is kept: for these endpoints `null` means "clear this
 * column", and the two are not interchangeable. `finished` deliberately does
 * NOT go through here - see {@link watchProgressBody}.
 */
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

/** Fails fast on a value the server would answer for with a validation error. */
export function assertPresent(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OmsError(`${field} is required and cannot be blank.`, "invalid_request");
  }
}
