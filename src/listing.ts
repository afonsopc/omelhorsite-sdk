/**
 * The listing query language every `list()` in the SDK accepts.
 *
 * | wire                       | meaning                                                   |
 * |----------------------------|-----------------------------------------------------------|
 * | `search[col]=v`            | partial match; strings are accent- and case-insensitive   |
 * | `exact_search[col]=v`      | equality; an array is `IN (...)`, `null` is `IS NULL`     |
 * | `modifiers[page]=N:SIZE`   | 1-based page, `SIZE` capped at 500                        |
 * | `modifiers[order]=col:asc` | sort; an unknown column is ignored                        |
 * | `modifiers[random]=true`   | random order; replaces any sort and disables the `ETag`   |
 * | `extra_options[key]=v`     | endpoint-specific filters, typed per resource             |
 *
 * Filter keys are validated by the server: a column outside the endpoint's
 * allowlist is a `400`, never a wider result. Each resource names its columns
 * as a string-literal union so the mistake is caught at compile time instead.
 *
 * Column TYPES are not visible to the compiler. `search` on a number or date
 * column is an exact `IN`, not a prefix; on a string column it compares
 * lower-cased, accent-stripped slugs on both sides.
 */

import { pageModifier } from "./http";
import type { PageLoader, PageParams, Paginated, QueryParams, QueryValue } from "./types";
import { createPage, resolvePageNumber, resolvePageSize } from "./types";

/** Columns every listing accepts in `search` and `exactSearch`, whatever else it declares. */
export const BASE_FILTER_COLUMNS = Object.freeze(["id", "created_at", "updated_at"] as const);

/** One of {@link BASE_FILTER_COLUMNS}. */
export type BaseFilterColumn = (typeof BASE_FILTER_COLUMNS)[number];

/** The scalar half of {@link FilterValue}. A `Date` is sent as ISO-8601. */
export type FilterScalar = string | number | boolean | Date | null;

/**
 * A filter value. An array is `IN (...)` under `exactSearch` and an OR of
 * partial matches under `search`; `null` means `IS NULL` (only `exactSearch`
 * can express it); `undefined` is not sent.
 */
export type FilterValue = FilterScalar | readonly FilterScalar[] | undefined;

/** Filters keyed by column. `string` is the untyped escape hatch. */
export type FilterBag<Column extends string = string> = { readonly [K in Column]?: FilterValue };

/**
 * The parameters every `list()` accepts. Resources extend this with their
 * column union, their `extra_options` shape, and camelCased shortcuts.
 *
 * Shortcuts and buckets may name the same column; the bucket wins, key by
 * key, so `{ userId: "a", exactSearch: { user_id: "b" } }` sends `b`.
 *
 * @typeParam Column columns accepted in `search` / `exactSearch`, on top of
 *   {@link BaseFilterColumn}.
 * @typeParam Extra the `extra_options` shape. Defaults to `never`, which makes
 *   `extraOptions` unsettable on the endpoints that declare none.
 */
export interface ListParams<Column extends string = string, Extra extends object = never> extends PageParams {
  /** Partial match per column. */
  readonly search?: FilterBag<Column | BaseFilterColumn>;
  /** Equality per column. Use it for ids, enums and foreign keys. */
  readonly exactSearch?: FilterBag<Column | BaseFilterColumn>;
  /**
   * Random order. The shuffle is redrawn on every request, so pages overlap;
   * use it for "give me N rows", not for walking a listing.
   */
  readonly random?: boolean;
  /** Endpoint-specific filters. Typed per resource. */
  readonly extraOptions?: Extra;
}

/** What a resource adds to a caller's {@link ListParams} before encoding. */
export interface ListQueryBase {
  /** Sort applied when the caller gave none. */
  readonly order?: string;
  /** Shortcut-derived `search` keys. The caller's bucket wins. */
  readonly search?: FilterBag;
  /** Shortcut-derived `exact_search` keys. The caller's bucket wins. */
  readonly exactSearch?: FilterBag;
  /** Shortcut-derived `extra_options` keys. The caller's bucket wins. */
  readonly extraOptions?: FilterBag;
  /** Top-level query keys outside the DSL, copied verbatim. */
  readonly top?: QueryParams;
}

/** The page a loader is asked for. */
export interface PageAt {
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Encodes one page of a listing as a query bag. Pass `at: undefined` for an
 * endpoint that must see the whole scope rather than a page.
 */
export function listQuery(params: ListParams<string, object>, at: PageAt | undefined, base: ListQueryBase = {}): QueryParams {
  const search = bucket(base.search, params.search);
  const exact = bucket(base.exactSearch, params.exactSearch);
  const extra = bucket(base.extraOptions, params.extraOptions as FilterBag | undefined);

  const modifiers: Record<string, QueryValue> = {};
  if (at !== undefined) modifiers["page"] = pageModifier(at.page, at.pageSize);
  // A random listing must send no order: the server only shuffles when none is
  // given. `null` says the same thing explicitly.
  const order = params.order === null ? undefined : (params.order ?? (params.random === true ? undefined : base.order));
  if (order !== undefined) modifiers["order"] = order;
  if (params.random === true) modifiers["random"] = true;

  return {
    ...(base.top ?? {}),
    ...(search === undefined ? {} : { search }),
    ...(exact === undefined ? {} : { exact_search: exact }),
    ...(Object.keys(modifiers).length === 0 ? {} : { modifiers }),
    ...(extra === undefined ? {} : { extra_options: extra }),
  };
}

/**
 * Loads the first page of a listing and returns it as a {@link Paginated}
 * whose `next()` fetches the following pages at the same size.
 */
export async function paginate<T>(
  params: PageParams,
  defaultPageSize: number,
  load: (at: PageAt) => Promise<readonly T[] | undefined>,
): Promise<Paginated<T>> {
  const pageSize = resolvePageSize(params.pageSize ?? defaultPageSize);
  const page = resolvePageNumber(params.page);
  const loader: PageLoader<T> = async (at) => {
    const rows = await load(at);
    return Array.isArray(rows) ? [...rows] : [];
  };
  return createPage(await loader({ page, pageSize }), page, pageSize, loader);
}

function bucket(sugar: FilterBag | undefined, explicit: FilterBag | undefined): Record<string, QueryValue> | undefined {
  const merged: Record<string, FilterValue> = { ...(sugar ?? {}), ...(explicit ?? {}) };
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...(value as readonly FilterScalar[])] : (value as QueryValue);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
