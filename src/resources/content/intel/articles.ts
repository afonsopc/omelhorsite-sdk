/** Intel stories: the analysed, grouped, scored output. */

import { Resource } from "../../../http";
import { listQuery, paginate } from "../../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../../listing";
import type { Id, Paginated, QueryParams, RequestOptions, Timestamp } from "../../../types";
import type { IntelArticleCategory, IntelReportKind } from "./types";

/**
 * A story: several raw items about the same event, grouped, scored and
 * categorised by the analysis pipeline.
 *
 * This is the shape an INDEX row has. `GET /intel_articles/:id` renders
 * `:extended`, which is this plus four more keys - see
 * {@link IntelArticleDetail}. The detail is always a superset, never a
 * different record.
 */
export interface IntelArticle {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Headline the model wrote. Nullable: the column has no `NOT NULL`. */
  readonly title: string | null;
  /** One-paragraph summary. Nullable for the same reason. */
  readonly summary: string | null;
  /**
   * 0-10, validated `only_integer, in: 0..10`. The buckets the dashboard uses
   * are in {@link IntelStats.by_importance} and they are NOT evenly spaced:
   * >=9 critical, 7-8 high, 5-6 medium, 3-4 low, <3 noise.
   */
  readonly importance: number;
  /** See {@link IntelArticleCategory}. `null` when unclassified. */
  readonly category: IntelArticleCategory | null;
  /**
   * Free-form tags. The column defaults to `[]`, but it is nullable, so a row
   * written before the default landed can still hand you `null`. Do not map
   * over it without a guard.
   */
  readonly tags: string[] | null;
  /**
   * The `og:image` of one of the story's sources, stored RAW and uncompressed
   * - it points at whatever news site published it, not at this API. Render it
   * through {@link intelArticleImageUrl} rather than directly; that helper
   * explains the trade it makes.
   */
  readonly image_url: string | null;
  /**
   * Whether the web-search enrichment pass has run on this story.
   *
   * `false` is not a failure, it is a queue position: `AnalyzeUserJob` enriches
   * at most three stories per run, only those at or above
   * {@link IntelConfig.enrich_min_importance}, and only while
   * {@link IntelConfig.web_search} is on. A low-importance story stays `false`
   * for ever, by design.
   */
  readonly enriched: boolean;
  /** When the story was first built. */
  readonly first_seen_at: Timestamp;
  /** Touched every time a new item joins the story. This is the "recency" clock. */
  readonly last_seen_at: Timestamp;
  /**
   * How many raw items back this story.
   *
   * Costs one COUNT query per row on the listing. A page of 500 stories is
   * 500 extra queries. This is the reason to keep `pageSize` modest on
   * {@link IntelArticlesNamespace.list}.
   */
  readonly n_sources: number;
}

/** One raw item cited by a story, as `:extended` inlines it. */
export interface IntelArticleSourceRef {
  /** Id of the {@link IntelItem}. Fetch the full row with `items.get(id)`. */
  readonly id: Id;
  /** Name of the {@link IntelSource} the item came from, or `null` if it was deleted. */
  readonly source_name: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly published_at: Timestamp | null;
}

/**
 * A story related to this one, as `:extended` inlines it.
 *
 * "Related" is not "duplicate": duplicates are merged during dedup and never
 * become two rows. `IntelArticleLink` is an undirected edge between two
 * DISTINCT stories, which is why {@link relation} is one label describing the
 * pair rather than a direction.
 */
export interface IntelRelatedArticleRef {
  readonly id: Id;
  readonly title: string | null;
  readonly importance: number;
  readonly category: IntelArticleCategory | null;
  /** Free text the model wrote for the edge, e.g. a pattern name. Nullable. */
  readonly relation: string | null;
}

/** A report this story appears in, as `:extended` inlines it. Newest period first. */
export interface IntelArticleReportRef {
  readonly id: Id;
  readonly kind: IntelReportKind;
  readonly title: string | null;
  readonly period_end: Timestamp;
}

/**
 * `GET /intel_articles/:id` - the `:extended` view.
 *
 * Four keys the listing does not carry, and all four are joins run inline:
 * `sources` walks `intel_items`, `related` walks the link table in
 * BOTH directions, `reports` orders the report join by `period_end`. There is
 * no paging on any of them, so a story that has been running for a week can
 * inline a lot of rows.
 */
export interface IntelArticleDetail extends IntelArticle {
  /** The long body. `null` until the enrichment pass writes one. */
  readonly details: string | null;
  /** Every raw item behind the story. Length matches {@link IntelArticle.n_sources}. */
  readonly sources: IntelArticleSourceRef[];
  /** Stories linked to this one. `[]` when the linker found nothing. */
  readonly related: IntelRelatedArticleRef[];
  /** Reports that cited this story, newest period first. */
  readonly reports: IntelArticleReportRef[];
}

/** Filter columns of `GET /intel_articles`, on top of {@link BASE_FILTER_COLUMNS}. */
export const INTEL_ARTICLE_FILTER_COLUMNS = Object.freeze(["title", "summary", "category", "importance", "enriched"] as const);

/** Filters for {@link IntelArticlesNamespace.list}. */
export interface ListIntelArticlesParams extends ListParams<(typeof INTEL_ARTICLE_FILTER_COLUMNS)[number]> {
  /**
   * Free-text search over `title`, `summary` AND `details`.
   *
   * A TOP-LEVEL parameter, not a `search` key: the controller reads
   * `params[:q]` itself, which is why it can reach `details` (a column that is
   * not in `search_params` at all) and why an unknown-filter 400 cannot
   * happen for it.
   *
   * Three ways it differs from {@link ListParams.search}:
   *
   * - it is **accent-SENSITIVE**. The controller does `LOWER(col) LIKE
   *   LOWER(term)`, with no unaccenting, while the list DSL's `search` strips
   *   accents on both sides. `"policia"` will not find `"polícia"` here.
   * - `%` and `_` in your term are **not escaped**. The controller wraps the
   *   term as `"%#{q}%"` and binds it, so a term containing `%` is a wildcard,
   *   not a literal percent sign. Not an injection - it is a bound parameter -
   *   but a surprise. Strip them if you are passing user input through.
   * - it is an unanchored `LIKE` over three text columns with no index, so it
   *   is a sequential scan of your stories. Fine for thousands, not for
   *   millions.
   */
  readonly q?: string;
  /**
   * Keep only stories at or above this importance. Also top-level.
   *
   * Sent through Ruby's `String#to_i`, which does NOT raise: `"high"` becomes
   * `0` and the filter silently matches everything. Pass a number and let the
   * SDK stringify it.
   */
  readonly minImportance?: number;
  /**
   * `"recent"` orders by `last_seen_at` descending. Anything else - including
   * omitting it - orders by `importance` descending, then `last_seen_at`
   * descending. There is no third value and no ascending variant.
   *
   * If you ALSO pass {@link PageParams.order}, both apply and yours wins: the
   * controller appends its ordering after the list DSL has applied
   * `modifiers[order]`, so your column becomes the primary sort key and the
   * controller's becomes the tie-breaker. That is the opposite of what the
   * parameter names suggest.
   */
  readonly sort?: "recent" | "importance";
}

/**
 * `GET /intel_articles` and friends: the stories the pipeline built.
 *
 * Read-only plus a delete. There is no create and no update route -
 * `IntelArticle#creatable_by?` and `#updatable_by?` both return `false`
 * unconditionally, and the route is `only: [:index, :show, :destroy]`. Stories
 * come from `Intel::ArticleBuilder`, never from a client.
 */
export class IntelArticlesNamespace extends Resource {
  /**
   * `GET /intel_articles` - your stories, most important first.
   *
   * Ordering is the controller's, not yours by default: `importance DESC,
   * last_seen_at DESC`, or `last_seen_at DESC` alone with `sort: "recent"`.
   * See {@link ListIntelArticlesParams.sort} for what happens when you pass
   * `order` as well - it is not what the names imply.
   *
   * Filter keys this controller declares for `search` / `exactSearch`:
   * `title`, `summary`, `category`, `importance`, `enriched`, plus the
   * inherited `id`, `created_at`, `updated_at`. Anything else is
   * `400 "Unknown search filter: x"` - fail-closed, never a wider result. The
   * free-text and importance filters are top-level instead: `q` and
   * `minImportance`.
   *
   * **Cost.** Every row runs its own `COUNT` for
   * {@link IntelArticle.n_sources}. Keep `pageSize` in the tens, not at 500.
   *
   * The response carries an `ETag` and can answer `304` - except when
   * `random` is set, which short-circuits `resources_stale?`.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   * @throws {OmsApiError} 403 `"Intel access is restricted."` for a signed-in
   *   account outside the allowlist; 400 for an unrecognised filter key.
   */
  async list(params: ListIntelArticlesParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelArticle>> {
    const top: QueryParams = {};
    if (params.q !== undefined) top["q"] = params.q;
    if (params.minImportance !== undefined) top["min_importance"] = params.minImportance;
    if (params.sort !== undefined) top["sort"] = params.sort;

    return paginate(params, 50, (at) =>
      this.http.get<IntelArticle[]>("/intel_articles", { ...options, query: listQuery(params, at, { top }) }),
    );
  }

  /**
   * `GET /intel_articles/:id` - one story with its body, its sources, its
   * related stories and the reports that cited it.
   *
   * The `:extended` view, so it is a strict superset of the listing row. All
   * four extras are inlined without paging; see {@link IntelArticleDetail}.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` when the id is not one of
   *   yours - the lookup is `viewable_by(Current.user).find_by(id:)`, so
   *   somebody else's story is indistinguishable from a typo, which is the
   *   point.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelArticleDetail> {
    return this.http.get<IntelArticleDetail>(`/intel_articles/${encodeURIComponent(id)}`, options);
  }

  /**
   * `DELETE /intel_articles/:id` - drops a story. `204`, empty body.
   *
   * The story's links to items are removed with it (`dependent: :destroy` on
   * `intel_article_sources`), but the {@link IntelItem} rows themselves SURVIVE
   * - they belong to the source, not to the story. They are also still marked
   * `processed_at`, so deleting a story does not make the pipeline rebuild it.
   * This is a hide, not an undo.
   *
   * @throws {OmsApiError} 404 when the story is not yours. 401
   *   `"You are not authorized to destroy this resource"` cannot happen here -
   *   `destroyable_by?` is `user == self.user` and the lookup already scoped it
   *   - but note the API's habit of answering 401 rather than 403 for a failed
   *   authorisation check, which the scripts routes DO hit.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_articles/${encodeURIComponent(id)}`, options);
  }
}
