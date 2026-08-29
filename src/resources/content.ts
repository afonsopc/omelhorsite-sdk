/**
 * The `content` namespace: the small, public-facing corners of the API that do
 * not belong to any of the big products.
 *
 * Ten endpoint families live here, and they have nothing in common except
 * being too small to deserve a file each: blogs and their posts, the
 * notification inbox, the feedback box, the joke table, the public config
 * blob, the status page, the per-user "recent services" counters, two admin
 * analysis reports, the Space Invaders leaderboard, and the read-only proxy in
 * front of the intel sidecar. Each is its own class so the grouping stays an
 * implementation detail: mount them wherever a host prefers.
 *
 * ## Nine things that have already cost bugs
 *
 * 1. **Half of these routes are NOT the list DSL.** `GET /blogs`,
 *    `GET /blog_posts`, `GET /space_invaders_games/leaderboard`,
 *    `GET /service_usages/top` and both `/analysis` reports are hand-written
 *    controller actions with a hard-coded `limit` and no paging at all. Only
 *    {@link NotificationsNamespace.list}, {@link JokesNamespace.list},
 *    {@link FeedbacksNamespace.list} and {@link SpaceInvadersNamespace.list}
 *    accept `search` / `exact_search` / `modifiers`.
 * 2. **Two of the responses carry an envelope**, which almost nothing else in
 *    this API does: `GET /blogs` and `GET /blog_posts` answer
 *    `{"posts": [...]}`, not a bare array. The SDK unwraps them, and says so
 *    on each method.
 * 3. **`PATCH /notifications/:id` is routed and can never succeed.**
 *    `Notification` never overrides `updatable_by?`, so `Authorizable`'s
 *    default `false` stands and every attempt is `401`. There is no way to
 *    mark ONE notification read over HTTP - only
 *    {@link NotificationsNamespace.markAllRead}. See that method.
 * 4. **`POST /blog_posts` and `PATCH /blog_posts/:id` are not the same shape
 *    of update.** Sending `publish` in a PATCH makes the controller publish
 *    and RETURN, silently discarding every other field in the same body. See
 *    {@link BlogPostsNamespace.setPublished}.
 * 5. **`money` and `time` on a Space Invaders game arrive as STRINGS.** They
 *    are `decimal` columns, and Rails encodes `BigDecimal` as a string so no
 *    precision is lost in transit. `kills` next to them is an integer and
 *    arrives as a number. See {@link SpaceInvadersGame}.
 * 6. **`GET /services_status` is the expensive one, not `/uptime`.** It pings
 *    three external services synchronously, one after another, with no cache.
 *    `/uptime` reads a cache. See {@link ServicesStatusNamespace}.
 * 7. **The ids in this file are not one type.** Blogs, posts, notifications,
 *    jokes, incidents and Space Invaders games are auto-increment INTEGERS;
 *    feedbacks are opaque STRINGS; users inside any of those payloads are
 *    strings. There is no rule to remember, only the table.
 * 8. **`POST /feedbacks` is the most heavily capped route here**: 5 per hour
 *    per IP, after a bot pushed roughly 200 notification emails through it in
 *    one burst, plus a three-minute de-duplication window inside the
 *    controller. See {@link FeedbacksNamespace.create}.
 * 9. **"Intel" is two unrelated things sharing a prefix.** `GET /intel/*path`
 *    is a generic forwarder to a sidecar whose routes are not in the backend
 *    repository, so it stays untyped on purpose ({@link IntelProxyNamespace}).
 *    The `/intel_articles`, `/intel_reports`, `/intel_sources`,
 *    `/intel_scripts`, `/intel_items`, `/intel_config` and `/intel_stats`
 *    routes are ordinary Rails controllers with blueprints, and they are fully
 *    typed ({@link IntelNamespace}). Reach for the second set.
 * 10. **Two blog routes are private by accident.** `allow_unauthenticated_access`
 *    lists `index` and `show` on both blog controllers and nothing else, so the
 *    public PERMALINK (`GET /blogs/:blog/posts/:slug`) rejects anonymous
 *    readers while `GET /blog_posts/:id` serves them the same post, and the
 *    anonymous email-subscribe branch inside `BlogsController#subscribe` can
 *    never run. See {@link BlogPostsNamespace.getBySlugs} and
 *    {@link BlogsNamespace.subscribe}.
 *
 * ## No OAuth token reaches ANY of this
 *
 * Not one of the ten controllers declares an `oauth_scope`, and
 * `enforce_oauth_scope!` denies by omission, so a Doorkeeper access token gets
 * `403 {"error":"insufficient_scope"}` on every route in this file - including
 * the ones that are open to callers with NO credential at all
 * (`GET /config`, `GET /jokes`, `GET /blogs`, `/services_status`,
 * `/space_invaders_games/leaderboard`). That is the trap: attaching an OAuth
 * token to a public read turns a working call into a 403. A session (cookie or
 * bearer session token) is the only credential this file accepts; an
 * OAuth-backed integration that wants the public reads must send nothing.
 *
 * ## Rate ceilings
 *
 * Only one route here has a bucket of its own: `POST /feedbacks`, at 5 per
 * hour per IP. Everything else rides the general ceiling - **600 requests per
 * minute** for an authenticated caller, **120 per minute per IP** for an
 * anonymous one. Notably `/services_status/uptime` has NO dedicated bucket
 * even though it was DoSed: it was fixed with a cache and one grouped query
 * rather than a throttle. See {@link ServicesStatusNamespace.uptime}.
 */

import { ApiClient, Resource, pageModifier } from "../http";
import type {
  FileOutput,
  Id,
  Json,
  PageParams,
  Paginated,
  QueryParams,
  QueryValue,
  RequestOptions,
  Timestamp,
} from "../types";
import { createPage } from "../types";
import type { FsNode } from "./storage";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Filters accepted by the four listings in this file that really are the list
 * DSL. Mirrors the shape the other namespaces use.
 *
 * `search` is a partial, accent-insensitive match; `exact_search` is equality,
 * with an array meaning `IN` and `null` meaning `IS NULL`. Both fail CLOSED:
 * a key the controller did not declare is `400 "Unknown search filter: x"`,
 * never a silently wider result. The declared keys differ per endpoint and are
 * documented on each `list()`; they are much narrower here than you would
 * guess, because most of these controllers declare no `search_params` at all
 * and inherit only `id`, `created_at` and `updated_at`.
 */
export interface ContentListParams extends PageParams {
  /** Partial, accent-insensitive match. Only the columns the endpoint declares. */
  readonly search?: Record<string, QueryValue>;
  /** Exact match. Array means `IN`, `null` means `IS NULL`. */
  readonly exactSearch?: Record<string, QueryValue>;
  /**
   * Ask for rows in random order. Mutually useful with a small `pageSize`.
   *
   * Two side effects worth knowing: `QueryModifier` applies `RANDOM()` with
   * `reorder`, so it REPLACES any `order` the controller set for itself, and
   * `CrudActions#resources_stale?` short-circuits for a random listing, so the
   * response carries no `ETag` and can never answer `304`.
   */
  readonly random?: boolean;
}

/** Builds the `modifiers`/`search`/`exact_search` query bag from {@link ContentListParams}. */
function listQuery(params: ContentListParams, page: number, pageSize: number): QueryParams {
  const modifiers: Record<string, QueryValue> = { page: pageModifier(page, pageSize) };
  if (params.order !== undefined) modifiers.order = params.order;
  if (params.random === true) modifiers.random = true;
  const query: QueryParams = { modifiers };
  if (params.search !== undefined) query.search = params.search;
  if (params.exactSearch !== undefined) query.exact_search = params.exactSearch;
  return query;
}

// ---------------------------------------------------------------------------
// Blogs
// ---------------------------------------------------------------------------

/** Primary key of a blog. An INTEGER: `blogs` kept its auto-increment id. */
export type BlogId = number;

/** Primary key of a blog post. An integer, like the blog it hangs off. */
export type BlogPostId = number;

/** The author of a blog, embedded in {@link Blog}. Not a full user record. */
export interface BlogAuthor {
  /** User id. A STRING, unlike every other id in this section. */
  readonly id: Id;
  readonly handle: string;
  readonly name: string;
}

/**
 * A blog: one per user, created lazily.
 *
 * Deliberately NOT a `BaseRecord`. `BlogBlueprint` inherits `Blueprinter::Base`
 * directly rather than `ApplicationBlueprint`, precisely so the payload keeps
 * the exact key set the web frontend was built against - which means it has
 * `created_at` and NO `updated_at`. Do not reach for one.
 */
export interface Blog {
  readonly id: BlogId;
  /**
   * URL-safe handle of the blog, and the ONLY way to address it on the read
   * routes. Matches `/\A[a-z0-9][a-z0-9_-]*\z/`, 1-64 characters, unique
   * across the whole table. Defaults to the owner's handle, lowercased.
   */
  readonly slug: string;
  /** Display name. Defaults to `"<name>'s blog"`. Up to 80 characters. */
  readonly name: string;
  /** Up to 240 characters, or `null`. */
  readonly description: string | null;
  /** Who owns it. One blog per user, enforced by a unique index on `user_id`. */
  readonly user: BlogAuthor;
  /**
   * Subscribers with a `confirmed_at`, counted live on every render.
   *
   * In practice that is every subscriber: the only reachable way to subscribe
   * requires a session, and a signed-in subscription is confirmed on the spot.
   * See {@link BlogsNamespace.subscribe}.
   */
  readonly followers_count: number;
  /** Posts with a `published_at`, counted live on every render. */
  readonly published_posts_count: number;
  readonly created_at: Timestamp;
  /**
   * Whether the CALLING user subscribes to this blog. Computed against the
   * caller, so the same row differs per identity - never cache it across
   * identities, and note it is `false` (not `null`) for an anonymous caller.
   */
  readonly is_following: boolean;
}

/**
 * A post as it appears in a listing: the summary view.
 *
 * Like {@link Blog}, this is not a `BaseRecord`: the default view of
 * `BlogPostBlueprint` carries neither `created_at` nor `updated_at`. They
 * appear only on {@link BlogPost}, the `:extended` view, which - per the
 * Blueprinter convention - is this shape PLUS extras, never a subset.
 */
export interface BlogPostSummary {
  readonly id: BlogPostId;
  /** URL-safe, unique within the blog. Derived from the title when omitted. */
  readonly slug: string;
  /** Up to 200 characters. */
  readonly title: string;
  /**
   * Up to 240 characters, derived from the first characters of `content_md`
   * with the markdown punctuation stripped, unless the author wrote one. The
   * derivation runs in a `before_save`, so it is refreshed on every write
   * where the excerpt is blank - and never once it is not.
   */
  readonly excerpt: string | null;
  /** `null` for a draft. Presence of this field IS the published flag. */
  readonly published_at: Timestamp | null;
  /**
   * Estimated reading time, recomputed on every save at 220 words per minute
   * and floored at 1. Server-owned: sending it is ignored.
   */
  readonly reading_minutes: number;
  /** Lowercased, de-duplicated, at most 10. Never `null` in the payload. */
  readonly tags: string[];
  /** The blog it belongs to, trimmed to three fields. */
  readonly blog: { readonly id: BlogId; readonly slug: string; readonly name: string };
}

/** A post with its body: the `:extended` view, returned by every single-post route. */
export interface BlogPost extends BlogPostSummary {
  /**
   * The markdown source, up to 200 000 characters.
   *
   * There is a `content_html` column next to it in the database, rendered on
   * write - but no blueprint exposes it, so the client renders the markdown
   * itself.
   */
  readonly content_md: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Whether the CALLING user may edit it. Per-viewer, like `is_following`. */
  readonly is_owner: boolean;
}

/** A {@link Blog} plus the posts the caller may see. Returned by `show` and `mine`. */
export interface BlogWithPosts extends Blog {
  /**
   * Newest first (`published_at DESC, created_at DESC`).
   *
   * NOT paginated and NOT capped: `blog.blog_posts.viewable_by(...).recent`
   * runs with no `limit`, so a blog with a thousand posts returns a thousand
   * summaries in one response. This is the one listing in the file with no
   * ceiling of any kind.
   *
   * On `show` this is published posts only, unless the caller owns the blog,
   * in which case drafts are included too. On `mine` it is every post,
   * published or not.
   */
  readonly posts: BlogPostSummary[];
}

/** Fields {@link BlogsNamespace.updateMine} may change. */
export interface UpdateBlogInput {
  /**
   * New slug. Must match `/\A[a-z0-9][a-z0-9_-]*\z/` (1-64 chars) and be free
   * across the whole table, or the call is `400`. Changing it BREAKS every
   * link already published against the old one: there is no redirect and no
   * history table.
   */
  readonly slug?: string;
  /** Up to 80 characters. */
  readonly name?: string;
  /** Up to 240 characters. */
  readonly description?: string | null;
}

/** Result of a subscribe call. */
export interface BlogSubscribeResult {
  readonly ok: boolean;
  /**
   * `true` when the subscription is live.
   *
   * In practice it is ALWAYS `true` today. The field exists because the
   * controller can also create an unconfirmed, email-only subscription - but
   * that branch is unreachable over HTTP (see
   * {@link BlogsNamespace.subscribe}), so every row this route can actually
   * create is a signed-in one, and `set_confirmed_at_for_user_subs` confirms
   * those on insert.
   *
   * Were a `false` ever to reach you, there would be nothing to do about it:
   * the row carries an `unsubscribe_token`, but no route in the application
   * reads it, so there is no confirmation step to complete.
   */
  readonly confirmed: boolean;
}

/**
 * The `blogs` namespace: one blog per user, markdown posts, and a subscriber
 * list.
 *
 * The read routes address a blog by its SLUG, never by its id -
 * `BlogsController#show` does `Blog.find_by(slug: params[:id].downcase)` and
 * nothing else, so passing the numeric id gets `404 "Blog not found"`. The two
 * subscribe routes are the exception: they try the slug first and then fall
 * back to the id, so they accept either.
 *
 * Reads (`GET /blogs`, `GET /blogs/:slug`, `GET /blog_posts`,
 * `GET /blog_posts/:id`, `GET /blogs/:blog/posts/:slug`) are open to anonymous
 * callers; everything else needs a session.
 */
export class BlogsNamespace extends Resource {
  /** Posts, blog metadata and publishing. Also mounted as `oms.blogPosts`. */
  readonly posts: BlogPostsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.posts = new BlogPostsNamespace(http);
  }

  /**
   * `GET /blogs` - the discovery feed: the 30 most recent PUBLISHED posts
   * across every blog on the site.
   *
   * Despite the path this returns POSTS, not blogs, and there is no endpoint
   * anywhere that lists blogs. The wire shape is `{"posts": [...]}`, one of
   * the two envelopes in this file; the array is unwrapped here.
   *
   * Fixed at 30 rows, newest first. No paging, no filters, no `search` - the
   * action is `BlogPost.published.recent.limit(30)` and reads nothing off the
   * query string, so anything you add to it is ignored rather than rejected.
   * To go deeper than 30, there is nothing to page: this is a front page, not
   * an archive.
   *
   * Anonymous-safe, and drafts never leak into it regardless of who asks.
   */
  async discover(options: RequestOptions = {}): Promise<BlogPostSummary[]> {
    const body = await this.http.get<{ posts: BlogPostSummary[] }>("/blogs", options);
    return body.posts;
  }

  /**
   * `GET /blogs/:slug` - one blog with all of its visible posts.
   *
   * The slug is lowercased by the server before the lookup, so case does not
   * matter. A numeric id does NOT work here; use the slug.
   *
   * Published posts only, unless the caller OWNS the blog, in which case their
   * drafts are included. `BlogPost.viewable_by` keys on `blog.user_id` alone,
   * so an admin looking at somebody else's blog sees exactly what the public
   * sees. The `posts` array is unbounded - see {@link BlogWithPosts.posts}.
   *
   * @throws {OmsApiError} 404 `"Blog not found"`.
   */
  async show(slug: string, options: RequestOptions = {}): Promise<BlogWithPosts> {
    return this.http.get<BlogWithPosts>(`/blogs/${encodeURIComponent(slug)}`, options);
  }

  /**
   * `GET /blogs/mine` - the caller's own blog, drafts included.
   *
   * **This read has a side effect.** `Blog.find_or_create_for` CREATES the
   * blog row on first call, with the slug defaulted to the caller's handle and
   * the name defaulted to `"<name>'s blog"`, and the creation fires a Discord
   * `blog_created` alert. So "does this user have a blog" is not a question
   * this endpoint can answer - by the time it replies, they do. Call it when
   * the user opens their blog dashboard, not to probe.
   *
   * The default slug is the user's handle, which can collide with a blog
   * somebody already owns under that slug - handles and blog slugs are
   * separate namespaces and nothing keeps them apart. `create!` then raises
   * `ActiveRecord::RecordInvalid`, which reaches the caller as a `422` with a
   * Rails error page rather than this API's usual bare string, and fires a
   * Discord error alert on the way out. Rare, and unfixable from the client:
   * the endpoint takes no arguments.
   *
   * @throws {OmsApiError} 401 `"Session required to access this resource."`.
   *   The action also carries its own `unauthorized!("Not authenticated")`
   *   guard, but `allow_unauthenticated_access` covers only `index` and `show`,
   *   so the framework filter fires first and that message never ships.
   */
  async mine(options: RequestOptions = {}): Promise<BlogWithPosts> {
    return this.http.get<BlogWithPosts>("/blogs/mine", options);
  }

  /**
   * `PATCH /blogs/mine` - renames or re-slugs the caller's blog.
   *
   * Creates the blog first if there is none, exactly like {@link mine}, so
   * this can be the very first call a client makes.
   *
   * Answers the blog ALONE - no `posts` key, unlike every other blog route.
   * That asymmetry is the reason this returns {@link Blog} and not
   * {@link BlogWithPosts}.
   *
   * Only `slug`, `name` and `description` are permitted; anything else in the
   * body is dropped in silence. Re-slugging breaks published links - see
   * {@link UpdateBlogInput.slug}.
   *
   * @throws {OmsApiError} 400 with the validation sentence when the slug is
   *   taken or malformed; 401 `"Session required to access this resource."`.
   */
  async updateMine(input: UpdateBlogInput, options: RequestOptions = {}): Promise<Blog> {
    return this.http.patch<Blog>("/blogs/mine", input, options);
  }

  /**
   * `POST /blogs/:slug/subscribe` - follows a blog.
   *
   * **Signed-in callers only, despite appearances.** The action reads like it
   * supports anonymous email subscriptions - there is a whole branch for it,
   * ending in `400 "Email required for anonymous subscribe"` - but
   * `allow_unauthenticated_access` covers only `index` and `show`, so
   * `require_authentication` rejects an anonymous caller with
   * `401 "Session required to access this resource."` long before that branch
   * runs. The email path is dead code today.
   *
   * Which means `email` is effectively ignored: with a session present the
   * controller always takes the user branch, the subscription is attached to
   * the account, and it is confirmed on insert, so `confirmed` is always
   * `true` and `followers_count` moves. The parameter is kept here because the
   * server accepts it and because the branch could be revived by one line in
   * the controller - not because sending it changes anything today.
   *
   * Idempotent by construction: `find_or_initialize_by` on
   * `(blog, user, email)` means subscribing twice is a no-op that answers
   * `200` both times, so this is one of the few POSTs here where a retry
   * cannot duplicate anything.
   *
   * Accepts either the slug or the numeric id in the path - this route and its
   * `DELETE` twin are the only ones in the file that do.
   *
   * @throws {OmsApiError} 404 `"Blog not found"`; 401 without a session.
   */
  async subscribe(
    slugOrId: string | BlogId,
    input: { readonly email?: string } = {},
    options: RequestOptions = {},
  ): Promise<BlogSubscribeResult> {
    return this.http.post<BlogSubscribeResult>(
      `/blogs/${encodeURIComponent(String(slugOrId))}/subscribe`,
      input.email === undefined ? {} : { email: input.email },
      options,
    );
  }

  /**
   * `DELETE /blogs/:slug/subscribe` - unfollows a blog.
   *
   * Signed-in callers only, and it removes only the CALLER's own subscription:
   * the scope is `where(blog:, user: Current.user)`, so an email-only row
   * (were one to exist) could not be removed through here at all.
   *
   * Answers `{"ok": true}` whether or not a subscription existed - it is a
   * `delete_all` on a scope, so "not subscribed" and "unsubscribed" are the
   * same answer, and a double call is harmless.
   *
   * @throws {OmsApiError} 404 `"Blog not found"`; 401
   *   `"Session required to access this resource."`.
   */
  async unsubscribe(slugOrId: string | BlogId, options: RequestOptions = {}): Promise<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/blogs/${encodeURIComponent(String(slugOrId))}/subscribe`, options);
  }
}

/** Arguments for {@link BlogPostsNamespace.create}. */
export interface CreateBlogPostInput {
  /** Required, up to 200 characters. */
  readonly title: string;
  /**
   * URL-safe slug, unique within the blog. Omit it and the server derives one
   * from the title (lowercased, non-alphanumerics collapsed to `-`, trimmed to
   * 80 characters), falling back to `post-<6 hex>` when the title has no
   * alphanumerics at all - a title written entirely in a non-Latin script
   * therefore gets a random slug, not a transliterated one.
   */
  readonly slug?: string;
  /** Markdown source, up to 200 000 characters. */
  readonly content_md?: string;
  /**
   * Up to 280 characters by the model, but only 240 are ever written by the
   * derivation. Leave it out and the server writes the first 240 characters of
   * the stripped markdown; it is re-derived on every save where it is blank,
   * so clearing it back to `""` re-enables the automatic one.
   */
  readonly excerpt?: string;
  /**
   * Up to 10 tags. Lowercased, trimmed, de-duplicated and blank-filtered by
   * the controller, and anything past the tenth is dropped in silence.
   */
  readonly tags?: readonly string[];
}

/**
 * Arguments for {@link BlogPostsNamespace.update}.
 *
 * `tags` is optional in the type and DANGEROUS to omit. `post_params` ends
 * with an unconditional `raw[:tags] = (raw[:tags] || []) ...`, so a PATCH that
 * does not mention tags assigns the EMPTY ARRAY over whatever the post had.
 * There is no partial-update semantics for this field: resend the tags you
 * already hold on every update, or watch them disappear. Same shape of bug as
 * `manifest_json` on movie addons.
 */
export interface UpdateBlogPostInput {
  readonly title?: string;
  /** Changing it breaks published links; uniqueness is scoped to the blog. */
  readonly slug?: string;
  readonly content_md?: string;
  readonly excerpt?: string;
  /** ALWAYS send this. Omitting it clears the post's tags. See the interface docs. */
  readonly tags?: readonly string[];
}

/**
 * Posts, reachable as `oms.content.blogs.posts`.
 *
 * A post lives under exactly one blog and a user has exactly one blog, so
 * there is no "which blog" argument anywhere: {@link create} always writes to
 * the caller's own, creating it if needed.
 */
export class BlogPostsNamespace extends Resource {
  /**
   * `GET /blog_posts` - the 50 most recent posts the caller may see, newest
   * first, optionally narrowed to one blog.
   *
   * Envelope: the wire shape is `{"posts": [...]}` and the array is unwrapped
   * here.
   *
   * NOT the list DSL, despite the plural path. `blog_slug` is the only
   * parameter the action reads; `search`, `exact_search` and `modifiers` are
   * ignored rather than rejected, and the limit of 50 is not negotiable. There
   * is no way to page past it, so this is a feed and not an archive - to walk
   * a whole blog, read {@link BlogsNamespace.show}, whose `posts` array is
   * uncapped.
   *
   * Visibility follows the caller: published posts always, plus the caller's
   * OWN drafts. An anonymous caller sees published posts only.
   *
   * @param input.blogSlug Restrict to one blog. An unknown slug does NOT 404 -
   *   `find_by` returns nil and the action silently falls back to the
   *   site-wide listing, so a typo here returns everybody's posts instead of
   *   an empty list. Check the `blog` on each row if that distinction matters.
   */
  async list(input: { readonly blogSlug?: string } = {}, options: RequestOptions = {}): Promise<BlogPostSummary[]> {
    const body = await this.http.get<{ posts: BlogPostSummary[] }>("/blog_posts", {
      ...options,
      ...(input.blogSlug === undefined ? {} : { query: { blog_slug: input.blogSlug } }),
    });
    return body.posts;
  }

  /**
   * `GET /blog_posts/:id` - one post by numeric id, with its body.
   *
   * @throws {OmsApiError} 404 `"Post not found"`; **401**
   *   `"Draft only visible to author"` when the post exists but is
   *   unpublished and the caller is not its author. Note that this is a 401
   *   rather than a 404, so it confirms that a draft with that id exists.
   */
  async get(id: BlogPostId, options: RequestOptions = {}): Promise<BlogPost> {
    return this.http.get<BlogPost>(`/blog_posts/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `GET /blogs/:blogSlug/posts/:slug` - one post by the pair of slugs, which
   * is the shape a public permalink has.
   *
   * **This route needs a session, and the id route does not.** That is almost
   * certainly a mistake in the backend and it is worth knowing before you
   * build a public permalink on it: `BlogPostsController` declares
   * `allow_unauthenticated_access only: %i[index show]`, and `show_by_slugs`
   * is a third action that was never added to the list. So an anonymous
   * reader following a shared link gets `401 "Session required to access this
   * resource."` here, while {@link get} hands them the very same published
   * post. Until that is fixed, render public permalinks through {@link get}
   * with the numeric id, or expect signed-in readers only.
   *
   * Both slugs are lowercased server-side before the lookup. The route is
   * declared with `constraints: { blog_slug: /[^\/]+/, slug: /[^\/]+/ }`, so a
   * slug containing a slash cannot reach it at all - not a concern for
   * server-minted slugs, which are `[a-z0-9_-]` only.
   *
   * @throws {OmsApiError} 401 without a session, before anything else is
   *   checked; 404 `"Blog not found"` or `"Post not found"`; 401
   *   `"Draft only visible to author"`.
   */
  async getBySlugs(blogSlug: string, slug: string, options: RequestOptions = {}): Promise<BlogPost> {
    return this.http.get<BlogPost>(
      `/blogs/${encodeURIComponent(blogSlug)}/posts/${encodeURIComponent(slug)}`,
      options,
    );
  }

  /**
   * `POST /blog_posts` - writes a new post to the caller's own blog. `201`.
   *
   * There is no blog argument because there is no choice: the controller calls
   * `Blog.find_or_create_for(Current.user)`, so this CREATES the caller's blog
   * as a side effect on their very first post, exactly like
   * {@link BlogsNamespace.mine}.
   *
   * The post starts as a DRAFT - `published_at` is not settable here and no
   * amount of arguments will publish it. Publishing is a second call, and it
   * is {@link setPublished}, not {@link update}.
   *
   * Rides the general ceiling: there is no per-user cap on how many posts may
   * be created, and no length cap beyond the model's 200 000 characters of
   * markdown.
   *
   * @throws {OmsApiError} 401 `"Session required to access this resource."`;
   *   400 with the validation sentence, most often the slug already existing
   *   in this blog.
   */
  async create(input: CreateBlogPostInput, options: RequestOptions = {}): Promise<BlogPost> {
    return this.http.post<BlogPost>("/blog_posts", input, options);
  }

  /**
   * `PATCH /blog_posts/:id` - edits a post's fields.
   *
   * Do NOT put `publish` in this body. The controller checks for it FIRST and,
   * when it is a boolean or the string `"true"`/`"false"`, publishes or
   * unpublishes and returns immediately - `ok!` raises the response - so every
   * other field in the same request is discarded without a word. That is a
   * silent data loss, not an error you can catch. Use {@link setPublished} for
   * the flag and this method for the content; two calls, in either order.
   *
   * Always send `tags`, including when they have not changed. See
   * {@link UpdateBlogPostInput}.
   *
   * Editing does not change `published_at`, so an edit to a published post
   * stays published and does not move in the feed's ordering.
   *
   * @throws {OmsApiError} 404 `"Post not found"`; 401 `"Not your post"`; 400
   *   with the validation sentence.
   */
  async update(id: BlogPostId, input: UpdateBlogPostInput, options: RequestOptions = {}): Promise<BlogPost> {
    return this.http.patch<BlogPost>(`/blog_posts/${encodeURIComponent(String(id))}`, input, options);
  }

  /**
   * `PATCH /blog_posts/:id` with `{ publish }` - the publish switch, on its
   * own.
   *
   * Separated from {@link update} because the controller treats it as an
   * early-return branch rather than as a field: a body carrying `publish`
   * never reaches `post.update(post_params)`, so mixing the two loses the
   * content edit. Sending it alone is the only safe way to use it.
   *
   * `publish: true` stamps `published_at` with the current time - and moves
   * the post to the top of every `recent` ordering. Re-publishing an already
   * published post is a no-op that still answers `200` with the ORIGINAL
   * `published_at`, so this cannot be used to bump a post. `publish: false`
   * clears `published_at`, which unlists the post everywhere and, for a
   * non-owner, turns {@link get} into a 401.
   *
   * @throws {OmsApiError} 404 `"Post not found"`; 401 `"Not your post"`.
   */
  async setPublished(id: BlogPostId, publish: boolean, options: RequestOptions = {}): Promise<BlogPost> {
    return this.http.patch<BlogPost>(`/blog_posts/${encodeURIComponent(String(id))}`, { publish }, options);
  }

  /**
   * `DELETE /blog_posts/:id` - permanent. `204`, no body.
   *
   * Takes the attached `cover_image` with it (`dependent: :destroy`). There is
   * no trash and no undo.
   *
   * @throws {OmsApiError} 404 `"Post not found"`; 401 `"Not your post"`.
   */
  async destroy(id: BlogPostId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/blog_posts/${encodeURIComponent(String(id))}`, options);
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Primary key of a notification. An INTEGER. */
export type NotificationId = number;

/**
 * The `kind` strings the backend emits today.
 *
 * NOT a closed set and not validated anywhere - `Notification` only requires
 * `kind` to be present, so a new feature can add one without a migration. The
 * union is here so the kinds you handle autocomplete; keep a default branch
 * for the ones you do not, and never let an unknown kind break the inbox.
 *
 * Each kind implies a different {@link Notification.context} shape, which is
 * why `context` is typed as an open record rather than a discriminated union:
 * the backend guarantees a JSON object and nothing about its keys.
 */
export type NotificationKind =
  | "friendship_request"
  | "friendship_accepted"
  | "user_followed"
  | "message_received"
  | "fs_grant_received"
  | "jam_invite"
  | "vocal_separation_done"
  | "vocal_separation_failed"
  | (string & {});

/**
 * One notification in a user's inbox.
 *
 * Unlike most of this file it IS a full `ApplicationBlueprint` record, so it
 * carries `id`, `created_at` and `updated_at`. The `:extended` view adds
 * nothing, so a notification arriving over the cable and one arriving over
 * HTTP have the same fields.
 */
export interface Notification {
  /** An integer. The web frontend types it as a string; it is a JSON number. */
  readonly id: NotificationId;
  /** What happened. See {@link NotificationKind}. */
  readonly kind: NotificationKind;
  /**
   * Free-form JSON payload, whose keys depend entirely on `kind` - these are
   * the i18n interpolation values the client renders the sentence with.
   *
   * Never `null` (the column is `NOT NULL DEFAULT '{}'`), and never large: the
   * emitter runs user-supplied text through a 120-character preview before
   * storing it, so a message-received notification carries a truncated
   * snippet, not the message.
   *
   * One shape is documented outside the code and worth having here:
   * `jam_invite` carries `{ jam_id, host_id, host_handle, inviter_id,
   * inviter_handle }`. The rest you learn by reading a row.
   */
  readonly context: Record<string, unknown>;
  /** Whether it has been marked read. See {@link NotificationsNamespace.markAllRead}. */
  readonly read: boolean;
  /** Owner. Always the caller: the scope is `user.notifications`. A STRING. */
  readonly user_id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/**
 * The `notifications` namespace: the per-user inbox.
 *
 * ## This covers the HTTP half only
 *
 * Notifications are pushed in real time over ActionCable, on the per-user
 * `NotificationsChannel` stream, and that is where a live inbox gets its
 * updates from: the channel transmits `{type: "unread_count", unread_count}`
 * on subscribe, `{type: "created", notification, unread_count}` when one
 * arrives, and `{type: "unread_count", unread_count}` again whenever the read
 * state or the row count changes. The SDK does not open that socket and does
 * not wrap it - it has no cable client - so these methods are the polling
 * fallback and the write path, not the way to keep a badge live. A host with a
 * socket should subscribe and use {@link unreadCount} only for the first
 * paint.
 *
 * ## You cannot mark ONE notification read
 *
 * `PATCH /notifications/:id` is routed, and it cannot succeed for anybody.
 * `Notification` overrides `destroyable_by?` but never `updatable_by?`, so
 * `Authorizable`'s default `false` stands and `CrudActions#update` answers
 * `401 "You are not authorized to update this resource"` on every call - for
 * the owner, for an admin, for everyone. The model even has an
 * `after_update_commit` hook waiting to broadcast the new count, which is dead
 * code today. The SDK therefore exposes no `markRead(id)`: there is nothing
 * honest to put behind it. Mark the whole inbox with {@link markAllRead}, or
 * remove the row with {@link dismiss}, which is what the web client does.
 *
 * There is also no `GET /notifications/:id`: the resource is declared
 * `only: [:index, :update, :destroy]`, so a single fetch by id is a routing
 * 404. Read one out of {@link list}.
 *
 * Everything here needs a session and rides the general 600/min ceiling.
 */
export class NotificationsNamespace extends Resource {
  /**
   * `GET /notifications` - the caller's inbox, one page at a time.
   *
   * Scoped to the caller by `viewable_by` (`user.notifications`), so there is
   * no way to read anybody else's and the `user_id` filter below is redundant.
   *
   * **The filterable columns are almost none.** The controller declares
   * `search_params :user_id`, which the DSL merges with the three defaults, so
   * the complete allowlist is `id`, `created_at`, `updated_at` and `user_id`.
   * `read` and `kind` are NOT on it, and filters fail closed: asking for
   * `exact_search: { read: false }` - the obvious way to fetch the unread ones -
   * is `400 "Unknown exact_search filter: read"`, not an unfiltered list.
   * Fetch a page and filter client-side, or read {@link unreadCount} for the
   * badge.
   *
   * No default ordering is declared, so rows come back in whatever order
   * Postgres chooses. Pass `order: "created_at:desc"` for an inbox; there is
   * an index on `(user_id, created_at)` behind it.
   *
   * Sends an `ETag`, so an unchanged page answers `304` and costs nothing -
   * except with `random: true`, which disables the check.
   */
  async list(params: ContentListParams = {}, options: RequestOptions = {}): Promise<Paginated<Notification>> {
    const load = async (p: { page: number; pageSize: number }): Promise<Notification[]> =>
      this.http.get<Notification[]>("/notifications", {
        ...options,
        query: listQuery(params, p.page, p.pageSize),
      });
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const items = await load({ page, pageSize });
    return createPage(items, page, pageSize, load);
  }

  /**
   * `GET /notifications/unread_count` - how many unread notifications the
   * caller has. Unwraps the `{"count": n}` the server sends.
   *
   * One indexed `COUNT` behind a partial index (`WHERE read = false`), so it is
   * cheap - but it is still a request per call, and the cable already pushes
   * this number on subscribe and on every change. Poll it only where there is
   * no socket.
   */
  async unreadCount(options: RequestOptions = {}): Promise<number> {
    const body = await this.http.get<{ count: number }>("/notifications/unread_count", options);
    return body.count;
  }

  /**
   * `POST /notifications/read_all` - marks every unread notification read.
   *
   * Returns how many rows changed, which is the unread count from an instant
   * ago; calling it twice returns `0` the second time. `200`, not `201` - it
   * creates nothing.
   *
   * Runs as a single `update_all`, so no model callback fires and the per-row
   * broadcast is skipped; the controller pushes the new count over the cable
   * by hand afterwards, which is why every device still updates.
   *
   * Idempotent, so a retry is harmless. It is not enabled by default (the
   * transport does not replay a `POST`); pass `retry: {}` if you want one.
   */
  async markAllRead(options: RequestOptions = {}): Promise<number> {
    const body = await this.http.post<{ count: number }>("/notifications/read_all", undefined, options);
    return body.count;
  }

  /**
   * `DELETE /notifications/:id` - removes one notification. `204`, no body.
   *
   * This is the closest thing to "mark as read" the API has, and it is what
   * the web client uses: the row is gone, so the unread count drops and an
   * `after_destroy_commit` pushes the new count over the cable.
   *
   * Owner only - `viewable_by` scopes the lookup to the caller, so somebody
   * else's id is `404 "Resource not found"` rather than a 401.
   */
  async dismiss(id: NotificationId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/notifications/${encodeURIComponent(String(id))}`, options);
  }
}

// ---------------------------------------------------------------------------
// Feedbacks
// ---------------------------------------------------------------------------

/**
 * Primary key of a feedback report. A STRING, not an integer: `feedbacks` is
 * one of the tables that moved to opaque random ids, and it is the only one in
 * this file that did.
 */
export type FeedbackId = Id;

/** Triage state of a report. Mirrors `Feedback::STATUSES`. */
export const FEEDBACK_STATUSES = ["new", "read", "archived"] as const;

/** One of {@link FEEDBACK_STATUSES}. */
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Longest report the endpoint accepts, in BYTES. Mirrors `Feedback::CONTENT_MAX_LENGTH`. */
export const FEEDBACK_CONTENT_MAX_BYTES = 5_000;

/** How many attachments survive one submission. Mirrors `MAX_ATTACHMENTS_COUNT`. */
export const FEEDBACK_MAX_ATTACHMENTS = 6;

/** Combined decoded size of the attachments that get stored. 10 MiB. */
export const FEEDBACK_MAX_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;

/** Longest single `data:` URL the attacher will decode. 15 MiB of base64. */
export const FEEDBACK_MAX_ATTACHMENT_DATA_URL_BYTES = 15 * 1024 * 1024;

/** Anonymous submissions allowed per hour per IP, before rack-attack answers 429. */
export const FEEDBACK_CREATE_RATE_LIMIT_PER_HOUR = 5;

/** How long an identical report from the same IP is folded into the first one. */
export const FEEDBACK_DUPLICATE_WINDOW_MS = 3 * 60 * 1000;

/** A stored attachment, as it appears on a report. Admin-visible only. */
export interface FeedbackAttachment {
  /** ActiveStorage blob id. An INTEGER, and the segment `attachmentUrl` needs. */
  readonly blob_id: number;
  readonly filename: string;
  readonly content_type: string;
  readonly byte_size: number;
}

/** The submitter, when they were signed in. Carries their email, so admin-only. */
export interface FeedbackSubmitter {
  readonly id: Id;
  readonly handle: string;
  readonly name: string;
  readonly email: string;
}

/**
 * A feedback report, as an admin reads it.
 *
 * Nobody else ever sees this shape: `viewable_by` is `user&.admin? ? all : none`,
 * so a non-admin's listing is empty and a non-admin's `show` is a 404. The
 * submitter cannot read back what they sent - {@link FeedbacksNamespace.create}
 * answers with an id and nothing else.
 */
export interface Feedback {
  readonly id: FeedbackId;
  /** What the person wrote. Up to {@link FEEDBACK_CONTENT_MAX_BYTES} bytes. */
  readonly content: string;
  readonly status: FeedbackStatus;
  /**
   * The three context keys the controller keeps (`path`, `source`,
   * `user_agent`); everything else the client sent is dropped before the row
   * is written. `{}` when nothing was sent.
   */
  readonly context: Record<string, string>;
  /** The account that submitted it, or `null` for an anonymous report. */
  readonly user_id: Id | null;
  /** Reply address for an anonymous report, or `null`. */
  readonly email: string | null;
  /**
   * ISO country resolved from the submitter's IP by `FeedbackIntakeJob`.
   *
   * Written by a background job AFTER the response, so it is `null` on a row
   * read immediately after submission and fills in a moment later. Same for
   * {@link device_name}.
   */
  readonly country: string | null;
  /** Device name parsed out of the user agent, by the same background job. */
  readonly device_name: string | null;
  /** Expanded account, or `null` when the report was anonymous. */
  readonly user: FeedbackSubmitter | null;
  /** Screenshots, in submission order. Empty when none survived the filters. */
  readonly attachments: FeedbackAttachment[];
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** One screenshot, sent inline as a `data:` URL rather than as multipart. */
export interface FeedbackAttachmentInput {
  /**
   * A full `data:<mime>;base64,<payload>` URL. Anything that does not match
   * that exact regex - a bare base64 string, a `data:` URL that is not base64 -
   * is skipped in silence.
   */
  readonly data_url: string;
  /** Name to store. Sanitised server-side; defaults to `feedback-<id>-attachment-<n>.<ext>`. */
  readonly filename?: string;
}

/** Arguments for {@link FeedbacksNamespace.create}. */
export interface CreateFeedbackInput {
  /**
   * The report. Trimmed, and rejected when blank
   * (`400 "Feedback can't be empty"`) or over
   * {@link FEEDBACK_CONTENT_MAX_BYTES} BYTES - bytes, not characters, so
   * accented text runs out sooner than the number suggests
   * (`400 "Feedback is too long"`).
   */
  readonly content: string;
  /**
   * Reply address. Only meaningful for an anonymous report: a signed-in
   * submitter is linked by `user_id` and their account email is what the admin
   * sees. Validated against `URI::MailTo::EMAIL_REGEXP` when present.
   */
  readonly email?: string;
  /**
   * Where the report came from. Only `path`, `source` and `user_agent`
   * survive; every other key is dropped without an error.
   */
  readonly context?: {
    readonly path?: string;
    readonly source?: string;
    readonly user_agent?: string;
  };
  /**
   * Screenshots, at most {@link FEEDBACK_MAX_ATTACHMENTS}.
   *
   * Every rule here fails SILENTLY - the attacher logs and moves on, and the
   * submission still answers `201`. An attachment is dropped when it is not a
   * base64 `data:` URL, when its MIME type is not `image/*`, when the URL is
   * over {@link FEEDBACK_MAX_ATTACHMENT_DATA_URL_BYTES}, or when the running
   * decoded total passes {@link FEEDBACK_MAX_ATTACHMENTS_TOTAL_BYTES} (which
   * drops that one AND every one after it). Anything past the sixth is
   * discarded before the loop even starts. So do not treat a `201` as proof
   * the screenshots arrived; only an admin reading {@link Feedback.attachments}
   * can confirm that.
   *
   * Base64 is roughly 4/3 the size of the bytes, and the whole thing travels
   * inside one JSON body: production sits behind Cloudflare's ~100 MB request
   * cap, which rejects an oversized body with a `413` of its own before Rails
   * sees it.
   */
  readonly attachments?: readonly FeedbackAttachmentInput[];
  /**
   * Cloudflare Turnstile token. REQUIRED for an anonymous submission and
   * ignored for a signed-in one.
   *
   * Get the site key from {@link SiteConfigNamespace.get} first. Missing is
   * `400 "Captcha token missing"`; present but not verifying is
   * `403 "Captcha verification failed"`. A token is single-use at Cloudflare,
   * so it cannot be replayed - which also means an SDK-level retry of a failed
   * anonymous submission needs a FRESH token, not the same one.
   */
  readonly cf_turnstile_token?: string;
}

/**
 * The `feedbacks` namespace: the site's feedback box, plus its admin queue.
 *
 * Two audiences and one route table. {@link create} is the only thing a normal
 * caller can reach, and it is deliberately anonymous-friendly; everything else
 * is `before_action :require_admin!` and answers `401` with a `null` body to
 * anyone else.
 */
export class FeedbacksNamespace extends Resource {
  /**
   * `POST /feedbacks` - submits a report. `201` with `{"id": "..."}`, which is
   * unwrapped here to the id string.
   *
   * The response carries the id ALONE. There is no way to read the row back
   * without being an admin, so the id is only useful for correlating with a
   * support conversation.
   *
   * ## The ceilings, and why they are there
   *
   * This route has the only dedicated rack-attack bucket in this file:
   * **{@link FEEDBACK_CREATE_RATE_LIMIT_PER_HOUR} per hour, keyed on the IP**,
   * added after a bot pushed roughly 200 admin notification emails through it
   * in a single burst. It is keyed on the IP for EVERY caller, signed in or
   * not, so a shared egress address (an office, a mobile carrier's NAT, a
   * corporate VPN) shares the budget. Over it, `429` with
   * `{"error":"rate_limited"}`, which arrives here as an {@link OmsQuotaError}.
   *
   * On top of that the controller de-duplicates: the same `content` from the
   * same IP inside {@link FEEDBACK_DUPLICATE_WINDOW_MS} returns the id of the
   * EXISTING row with a `201` and writes nothing, attaches nothing and sends
   * no email. So a double-submitted form is harmless, and a retry inside the
   * window is genuinely idempotent - but note the flip side: a user who
   * legitimately sends the same short sentence twice in three minutes gets one
   * report, and the second submission's ATTACHMENTS are silently lost, because
   * the de-duplication branch returns before the attacher runs.
   *
   * ## What happens after the 201
   *
   * `FeedbackIntakeJob` runs on the queue: geo-locates the IP into
   * {@link Feedback.country}, parses the user agent into
   * {@link Feedback.device_name}, sends one coalesced email to every admin,
   * and fires a Discord alert. None of it blocks the response, and none of it
   * can fail the submission.
   *
   * The submitter's IP and user agent are stored on the row regardless of
   * whether they signed in. Say so in your UI if that matters.
   *
   * @throws {OmsApiError} 400 `"Feedback can't be empty"` / `"Feedback is too long"`
   *   / `"Captcha token missing"`; 403 `"Captcha verification failed"`.
   * @throws {OmsQuotaError} 429 once the per-IP hourly budget is spent.
   */
  async create(input: CreateFeedbackInput, options: RequestOptions = {}): Promise<FeedbackId> {
    const body = await this.http.post<{ id: FeedbackId }>("/feedbacks", input, options);
    return body.id;
  }

  /**
   * `GET /feedbacks` - the admin triage queue. **Admin only.**
   *
   * A non-admin is stopped by `before_action :require_admin!` with a `401`
   * whose body is `null` - no message to show the user, so write your own.
   * `Feedback.viewable_by` collapsing to `none` for a non-admin is the second
   * layer behind that, not the one you will hit.
   *
   * Filterable on `status` and `user_id`, plus the three defaults (`id`,
   * `created_at`, `updated_at`). Any other key is `400`.
   *
   * The scope is ordered `created_at DESC` before the DSL runs, and
   * `modifiers[order]` uses `reorder`, so passing {@link ContentListParams.order}
   * REPLACES that default rather than refining it.
   */
  async list(params: ContentListParams = {}, options: RequestOptions = {}): Promise<Paginated<Feedback>> {
    const load = async (p: { page: number; pageSize: number }): Promise<Feedback[]> =>
      this.http.get<Feedback[]>("/feedbacks", {
        ...options,
        query: listQuery(params, p.page, p.pageSize),
      });
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const items = await load({ page, pageSize });
    return createPage(items, page, pageSize, load);
  }

  /**
   * `GET /feedbacks/:id` - one report in full. **Admin only**; anybody else
   * gets `401` with a `null` body.
   */
  async get(id: FeedbackId, options: RequestOptions = {}): Promise<Feedback> {
    return this.http.get<Feedback>(`/feedbacks/${encodeURIComponent(id)}`, options);
  }

  /**
   * `PATCH /feedbacks/:id` - moves a report through triage. **Admin only.**
   *
   * `status` is the only writable field: `update_params :status` is the whole
   * allowlist, so `content` and `email` cannot be edited, and a value outside
   * {@link FEEDBACK_STATUSES} is rejected by a `before_update` hook with
   * `400 "Invalid status"` before the model is touched.
   */
  async setStatus(id: FeedbackId, status: FeedbackStatus, options: RequestOptions = {}): Promise<Feedback> {
    return this.http.patch<Feedback>(`/feedbacks/${encodeURIComponent(id)}`, { status }, options);
  }

  /**
   * `DELETE /feedbacks/:id` - permanent, attachments included. `204`.
   * **Admin only.**
   */
  async destroy(id: FeedbackId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/feedbacks/${encodeURIComponent(id)}`, options);
  }

  /**
   * `GET /feedbacks/:id/attachment/:blobId` - downloads one screenshot.
   * **Admin only.**
   *
   * The endpoint answers a `302` into object storage, not the bytes, so this
   * follows the redirect and buffers the result. That works in the CLI and in
   * React Native; in a BROWSER it is the same CORS trap `account.picture`
   * documents - the redirect target does not accept a credentialed
   * cross-origin request, and the fetch fails after the 302. A web client
   * should point an `<img>` at {@link attachmentUrl} instead and let the
   * browser follow the redirect without credentials.
   */
  async attachment(id: FeedbackId, blobId: number, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download(
      `/feedbacks/${encodeURIComponent(id)}/attachment/${encodeURIComponent(String(blobId))}`,
      options,
    );
  }

  /**
   * The absolute URL of an attachment, for an `<img src>` or an `<a href>`.
   *
   * Builds the string and makes no request, so it carries whatever credential
   * the BROWSER attaches - which for a cookie session on the API's own origin
   * is the session cookie, and for a bearer-token client is nothing at all. A
   * token-authenticated host has to fetch the bytes with {@link attachment}
   * instead; there is no query-string credential this SDK will mint for you.
   */
  attachmentUrl(id: FeedbackId, blobId: number): string {
    return this.http.url(`/feedbacks/${encodeURIComponent(id)}/attachment/${encodeURIComponent(String(blobId))}`);
  }
}

// ---------------------------------------------------------------------------
// Jokes
// ---------------------------------------------------------------------------

/** Primary key of a joke. An INTEGER. */
export type JokeId = number;

/**
 * A joke.
 *
 * `JokeBlueprint` extends `ApplicationBlueprint`, so unlike the blog records
 * this one really does carry all three base fields.
 */
export interface Joke {
  readonly id: JokeId;
  /**
   * Language tag, as whoever typed it wrote it. Free text with a presence
   * validation and NOTHING else - no inclusion list, no normalisation - so the
   * table can and does hold `"pt"` next to `"PT"` next to `"pt-PT"`. Compare
   * case-insensitively, and see {@link JokesNamespace.list} for why you cannot
   * make the server do the filtering.
   */
  readonly lang: string;
  /**
   * The joke. A `varchar` with no database limit and no model validation; the
   * web composer caps input at 255 characters as a house rule, which nothing
   * server-side enforces.
   */
  readonly content: string;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** Arguments for {@link JokesNamespace.create}. Both fields are required by the model. */
export interface JokeInput {
  readonly lang: string;
  readonly content: string;
}

/**
 * The `jokes` namespace: the joke table behind the site's loading screens.
 *
 * Reading is fully public; writing is admin-only. `Joke.viewable_by` is `all`,
 * so every joke is visible to every caller including anonymous ones, and
 * `creatable_by?`/`updatable_by?`/`destroyable_by?` all reduce to
 * `user.admin?`.
 */
export class JokesNamespace extends Resource {
  /**
   * `GET /jokes` - the joke table, paged. Anonymous callers welcome.
   *
   * **You cannot filter by language.** `JokesController` declares no
   * `search_params`, so the allowlist is only the three defaults - `id`,
   * `created_at`, `updated_at` - and `lang` is not on it. `search: { lang: "pt" }`
   * is `400 "Unknown search filter: lang"`, not a wider result: the DSL fails
   * closed. Pull a page and filter client-side, which is what every caller
   * ends up doing.
   *
   * For "give me a joke", `random: true` with `pageSize: 1` is the whole
   * recipe: `QueryModifier` applies `ORDER BY RANDOM()` and the pagination is
   * applied after it. Note that a random listing carries no `ETag` and can
   * never answer `304`, which is exactly what you want here and exactly what
   * you do not want on a normal page.
   *
   * `modifiers[order]` also accepts a third segment for an explicit value
   * ordering (`"lang:asc:pt,en"` puts those languages first), which the rest
   * of the SDK does not advertise because almost nothing needs it.
   */
  async list(params: ContentListParams = {}, options: RequestOptions = {}): Promise<Paginated<Joke>> {
    const load = async (p: { page: number; pageSize: number }): Promise<Joke[]> =>
      this.http.get<Joke[]>("/jokes", { ...options, query: listQuery(params, p.page, p.pageSize) });
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const items = await load({ page, pageSize });
    return createPage(items, page, pageSize, load);
  }

  /**
   * `POST /jokes` - adds a joke. `201`. **Admin only.**
   *
   * A signed-in non-admin gets `401 "You are not authorized to create this
   * resource"`; an anonymous caller gets `401 "Session required to access
   * this resource."` from the authentication filter first.
   */
  async create(input: JokeInput, options: RequestOptions = {}): Promise<Joke> {
    return this.http.post<Joke>("/jokes", input, options);
  }

  /**
   * `PATCH /jokes/:id` - edits a joke. **Admin only.**
   *
   * Both fields are permitted and both are optional; the model requires each
   * to be present, so sending `content: ""` is `400`, not a clear.
   */
  async update(id: JokeId, input: Partial<JokeInput>, options: RequestOptions = {}): Promise<Joke> {
    return this.http.patch<Joke>(`/jokes/${encodeURIComponent(String(id))}`, input, options);
  }

  /**
   * `DELETE /jokes/:id` - removes a joke. `204`. **Admin only.**
   *
   * There is no `GET /jokes/:id`: the resource is declared
   * `only: [:create, :index, :update, :destroy]`, so a single fetch by id is a
   * routing 404.
   */
  async destroy(id: JokeId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/jokes/${encodeURIComponent(String(id))}`, options);
  }
}

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

/**
 * The public configuration blob. One key today; treat it as open, since this
 * is where any future "the browser needs to know this before signing in"
 * value will land.
 */
export interface SiteConfig {
  /**
   * Cloudflare Turnstile site key, for rendering the widget.
   *
   * `null` when the credential is not configured - in development, and in any
   * environment where the key was never set. A `null` here does NOT mean the
   * captcha is disabled server-side: `require_captcha_if_anonymous!` still
   * runs and still rejects an anonymous {@link FeedbacksNamespace.create}, so
   * a client that skips the widget because this was null will see a 400 it
   * cannot explain. Treat `null` as "anonymous submission is unavailable".
   */
  readonly turnstile_site_key: string | null;
}

/**
 * The `config` namespace: one anonymous GET that bootstraps the client.
 *
 * Deliberately tiny and deliberately public - it is the only thing a client
 * can read before it has any credential at all, and the only reason it exists
 * is that the Turnstile widget needs a site key before the anonymous feedback
 * form can be submitted.
 */
export class SiteConfigNamespace extends Resource {
  /**
   * `GET /config` - the public configuration blob.
   *
   * Anonymous, no side effects, reads no database. It is not cached
   * server-side and has no `ETag`, so it is a full round trip every time -
   * fetch it once at boot and hold it, do not call it per form.
   *
   * Counts against the general ceiling like everything else (120/min per IP
   * anonymous), and - the trap this file repeats - answers `403` if you attach
   * an OAuth access token to it, because no controller here declares a scope.
   */
  async get(options: RequestOptions = {}): Promise<SiteConfig> {
    return this.http.get<SiteConfig>("/config", options);
  }
}

// ---------------------------------------------------------------------------
// Services status
// ---------------------------------------------------------------------------

/**
 * The three services `GET /services_status` actually probes. Mirrors
 * `ServiceHealthRegistry::EXTERNAL`.
 */
export const EXTERNAL_SERVICE_SLUGS = ["vocal_separator", "ai", "yt_dlp"] as const;

/**
 * The eight services that live inside the Rails process and are therefore
 * "up" whenever the healthcheck job runs at all. They appear in
 * {@link ServicesStatusNamespace.uptime} and NOT in
 * {@link ServicesStatusNamespace.current}.
 */
export const INTERNAL_SERVICE_SLUGS = [
  "accounts",
  "notifications",
  "storage",
  "socials",
  "short_links",
  "ip_lookup",
  "jokes",
  "space_invaders",
] as const;

/** Every slug the uptime report covers. Mirrors `ServiceHealthRegistry::ALL_SLUGS`. */
export const ALL_SERVICE_SLUGS = [...INTERNAL_SERVICE_SLUGS, ...EXTERNAL_SERVICE_SLUGS] as const;

/** A service slug. Open, because the registry is a constant somebody will extend. */
export type ServiceSlug = (typeof ALL_SERVICE_SLUGS)[number] | (string & {});

/** Live health of one external service. */
export interface ServiceHealth {
  /** `true` when the probe got a 2xx from the service's `/health`. */
  readonly ok: boolean;
  /**
   * A STRING, and not the HTTP status you might expect from the name.
   *
   * It is `"OK"` when the probe succeeded, and otherwise the failure's
   * identity: either a Ruby exception class (`"Errno::ECONNREFUSED"`,
   * `"Net::OpenTimeout"`, `"SocketError"`), or `"HTTP<code>"` for a
   * non-success response (`"HTTP503"`), or `"MissingURL"` when the service has
   * no URL configured. Show it, do not parse it - the set is whatever Ruby
   * happens to raise.
   *
   * The web frontend types this field as `number` and adds an `error` key that
   * the server never sends. Both are wrong; this is the controller's actual
   * output.
   */
  readonly status: string;
}

/**
 * The live status map: one entry per external slug, and nothing else.
 *
 * Keyed by {@link EXTERNAL_SERVICE_SLUGS} only - the internal services do not
 * appear, because there is nothing to ping.
 */
export type ServicesStatusMap = Record<string, ServiceHealth>;

/** One day of a service's history in the uptime report. */
export interface UptimeDay {
  /** `YYYY-MM-DD`, in the SERVER's timezone - the bucket is `DATE(created_at)`. */
  readonly date: string;
  /**
   * - `"up"` - every ping that day succeeded;
   * - `"degraded"` - some succeeded and some did not;
   * - `"down"` - every ping failed;
   * - `"unknown"` - no pings at all that day (the future half of today, days
   *   before the service existed, and any window where the healthcheck job was
   *   not running).
   */
  readonly status: "up" | "degraded" | "down" | "unknown";
  /** Successful pings that day. Roughly 1440 on a fully healthy day. */
  readonly up: number;
  /** Failed pings that day. */
  readonly down: number;
}

/** One service's 90-day history. */
export interface UptimeService {
  readonly slug: ServiceSlug;
  /**
   * Exactly 90 entries, oldest first, with no gaps: a day with no data is
   * present with `status: "unknown"` and zero counts rather than missing.
   * Index 89 is today, and today is partial.
   */
  readonly days: UptimeDay[];
  /**
   * Successful pings over total pings across the whole window, as a
   * percentage rounded to two decimals. `null` when the service has no pings
   * at all in the window - a brand new slug, or a long outage of the
   * healthcheck job itself. Do not render `null` as `0%`.
   */
  readonly uptime_pct: number | null;
}

/** A note appended to an incident as it progressed. */
export interface IncidentUpdate {
  /**
   * Free text. Auto-opened incidents post `"investigating"` and `"resolved"`;
   * a hand-written one can say anything.
   */
  readonly status: string;
  readonly body: string | null;
  readonly created_at: Timestamp;
}

/** A public incident on the status page. */
export interface Incident {
  /** An INTEGER. */
  readonly id: number;
  /** Auto-opened incidents are titled `"<slug> indisponível"`, in Portuguese. */
  readonly title: string;
  readonly body: string | null;
  /** Mirrors `ServiceIncident::SEVERITIES`. Auto-opened ones are always `"major"`. */
  readonly severity: "minor" | "major" | "critical";
  readonly started_at: Timestamp;
  /** `null` while the incident is open. */
  readonly resolved_at: Timestamp | null;
  /** Affected slugs. Can be empty, and can name a slug not in the registry. */
  readonly services: ServiceSlug[];
  /** Oldest first. */
  readonly updates: IncidentUpdate[];
}

/** The whole uptime report. */
export interface UptimeReport {
  /** First day of the window, `YYYY-MM-DD`. 89 days before `to`. */
  readonly from: string;
  /** Today, `YYYY-MM-DD`. */
  readonly to: string;
  /** One entry per slug in {@link ALL_SERVICE_SLUGS}, in registry order. */
  readonly services: UptimeService[];
  /** The 20 most recent PUBLIC incidents, newest first. Private ones are omitted. */
  readonly incidents: Incident[];
}

/** Seconds of server-side caching on {@link ServicesStatusNamespace.uptime}. */
export const UPTIME_CACHE_SECONDS = 60;

/** Days of history the uptime report covers. Mirrors `ServicesStatusController::UPTIME_DAYS`. */
export const UPTIME_WINDOW_DAYS = 90;

/**
 * The `services_status` namespace: the public status page.
 *
 * Both routes are anonymous (`allow_unauthenticated_access` with no `only:`),
 * and both are exempt from the visitor-logging after-action because the status
 * widget polls from every page load and would otherwise drown the activity
 * feed.
 *
 * ## The two calls have opposite cost profiles, and the names mislead
 *
 * {@link current} sounds cheap and is the expensive one; {@link uptime} sounds
 * heavy and is served from a cache. Read both method docs before you put
 * either behind a poller.
 */
export class ServicesStatusNamespace extends Resource {
  /**
   * `GET /services_status` - live health of the three external services.
   *
   * **This is the expensive endpoint in this namespace.** It performs the
   * probes inline, on the request thread, one after another - the controller
   * uses `index_with` with `Object#then`, so there is no concurrency - each
   * with a 2 second connect timeout and a 5 second read timeout. A healthy
   * call is a few tens of milliseconds; a call while all three are unreachable
   * holds a Puma thread for up to about 21 seconds and returns
   * `ok: false` three times.
   *
   * There is NO cache and NO dedicated rate limit, so it sits on the general
   * anonymous budget of 120 requests per minute per IP. Poll it at most once
   * every 30 seconds or so, and give it a client-side `timeoutMs` well above
   * the SDK default if your default is short - a slow answer here is the
   * normal answer during an outage, not a hung request.
   *
   * Only {@link EXTERNAL_SERVICE_SLUGS} appear in the map. The internal slugs
   * are absent because they have nothing to probe; read them out of
   * {@link uptime} instead.
   */
  async current(options: RequestOptions = {}): Promise<ServicesStatusMap> {
    return this.http.get<ServicesStatusMap>("/services_status", options);
  }

  /**
   * `GET /services_status/uptime` - 90 days of per-day history for all eleven
   * services, plus the 20 most recent public incidents.
   *
   * ## Cost and freshness, honestly
   *
   * This endpoint was flooded (roughly 900 requests a minute from a load
   * generator) and the fix was not a throttle: it was one grouped query plus a
   * cache. It still has no rack-attack bucket of its own.
   *
   * - **Freshness: up to 60 seconds stale.** The whole payload is memoised
   *   under the single global cache key `"services_status/uptime"` for
   *   {@link UPTIME_CACHE_SECONDS} seconds. The key is not per-caller and not
   *   per-parameter (there are no parameters), so every visitor on the site
   *   shares one entry. Polling faster than once a minute cannot produce a
   *   newer number - it just spends your rate budget re-fetching bytes you
   *   already have.
   * - **Cost on a hit: sending the payload.** Eleven services times ninety
   *   days is 990 day objects plus the incidents, so this is a
   *   double-digit-kilobyte response every time. There is no `ETag` and no
   *   `Last-Modified`, so it cannot answer `304` even when nothing changed.
   * - **Cost on a miss: one grouped aggregate** over
   *   `service_pings` - `GROUP BY slug, DATE(created_at), status` across the
   *   window - which is on the order of a million rows, since the healthcheck
   *   job writes one ping per slug per minute. Indexed on
   *   `(slug, created_at)`, but it is still the single heaviest query on the
   *   public surface, and exactly one request per minute pays it.
   *
   * ## Reading the numbers
   *
   * `up` and `down` are ping counts, not durations: a fully healthy day is
   * about 1440 up and 0 down. The window is 90 days and ping retention is also
   * 90 days, so the OLDEST day in every report is partially pruned and its
   * counts read low - do not compute an SLA off day zero.
   *
   * The eight internal slugs are `"up"` for every minute the Rails process was
   * running the healthcheck job, because that is literally what they measure.
   * They report the job's liveness, not the feature's.
   */
  async uptime(options: RequestOptions = {}): Promise<UptimeReport> {
    return this.http.get<UptimeReport>("/services_status/uptime", options);
  }
}

// ---------------------------------------------------------------------------
// Service usages
// ---------------------------------------------------------------------------

/**
 * The twelve service ids the counter accepts. Mirrors
 * `ServiceUsage::ALLOWED_SERVICE_IDS`, and it is a closed set: anything else
 * is `400 "Unknown service_id"`.
 */
export const SERVICE_USAGE_IDS = [
  "storage",
  "tools",
  "games",
  "music",
  "movies",
  "ai",
  "account",
  "tickets",
  "messages",
  "blogs",
  "status",
  "administration",
] as const;

/** One of {@link SERVICE_USAGE_IDS}. */
export type ServiceUsageId = (typeof SERVICE_USAGE_IDS)[number];

/**
 * A per-user visit counter.
 *
 * Note what is NOT here: no `id`, no `user_id`, no timestamps. Both routes
 * build the JSON by hand (`{ service_id:, count: }`) instead of going through
 * a blueprint, so this is one of the very few payloads in the API that is not
 * a record.
 */
export interface ServiceUsage {
  readonly service_id: ServiceUsageId;
  /** Lifetime visit count for this user and service. Monotonic, never reset. */
  readonly count: number;
}

/**
 * The `service_usages` namespace: which parts of the site a user opens, so the
 * home screen can put their favourites first.
 *
 * Both routes need a session - there is no `allow_unauthenticated_access` on
 * this controller - and both are pure bookkeeping. The music app calls
 * {@link record} with `"music"` on launch, fire and forget.
 */
export class ServiceUsagesNamespace extends Resource {
  /**
   * `POST /service_usages` - increments the caller's counter for one service.
   *
   * Answers **`200`, not `201`**, even on the very first call that creates the
   * row: the controller uses `ok!` rather than `created!`, so this is one of
   * the handful of creates in the API that breaks the 201 convention. The body
   * is the updated `{ service_id, count }`.
   *
   * ## Not idempotent, and it can page somebody
   *
   * Every call does `count += 1` and stamps `last_visited_at`, so a retry
   * inflates the number. That is why the transport's default of never
   * replaying a `POST` is the right default here: do not pass `retry: {}`.
   *
   * It can also fire a Discord `service_opened` alert - on the first ever
   * visit, and again whenever more than an hour has passed since the last one.
   * A client that calls this on every route change inside an app is fine (the
   * hour gap suppresses the alert), but a client that calls it from a
   * background poller is a pager, not telemetry.
   *
   * Fire and forget: nothing in a UI should wait on this, and nothing should
   * fail because it failed.
   *
   * @throws {OmsApiError} 400 `"Unknown service_id"` for anything outside
   *   {@link SERVICE_USAGE_IDS}; 401 without a session.
   */
  async record(serviceId: ServiceUsageId, options: RequestOptions = {}): Promise<ServiceUsage> {
    return this.http.post<ServiceUsage>("/service_usages", { service_id: serviceId }, options);
  }

  /**
   * `GET /service_usages/top` - the caller's most-used services, busiest
   * first, tie-broken by most recently visited.
   *
   * Not the list DSL: `limit` is the only parameter, it is clamped to
   * `1..10` (silently - asking for 50 returns 10), and it defaults to 3. There
   * is no paging and no way to read the full set.
   *
   * Only services the caller has actually opened appear, so a fresh account
   * gets an empty array rather than every id with a zero.
   */
  async top(input: { readonly limit?: number } = {}, options: RequestOptions = {}): Promise<ServiceUsage[]> {
    return this.http.get<ServiceUsage[]>("/service_usages/top", {
      ...options,
      ...(input.limit === undefined ? {} : { query: { limit: input.limit } }),
    });
  }
}

// ---------------------------------------------------------------------------
// Analysis (admin)
// ---------------------------------------------------------------------------

/** One day in a daily-count series. Mirrors `DailyBucketStats#daily_series`. */
export interface AnalysisDailyPoint {
  /** `YYYY-MM-DD`, server timezone. */
  readonly date: string;
  /** Rows created that day. `0` for a day with none - the series has no gaps. */
  readonly count: number;
}

/** Days covered by {@link AnalysisNamespace.filesDaily}. Mirrors `DAILY_WINDOW_DAYS`. */
export const ANALYSIS_DAILY_WINDOW_DAYS = 30;

/**
 * The `analysis` namespace: two admin reports about storage.
 *
 * **Admin only, and the refusal is unusual.** `require_admin!` answers `403`
 * whose body is a long quotation from Monster House rather than an error code,
 * so do not try to match on the message - check the status. An anonymous
 * caller is stopped earlier, by the authentication filter, with the ordinary
 * `401 "Session required to access this resource."`.
 *
 * The route is declared as a full `resources :analysis`, so paths like
 * `GET /analysis` and `GET /analysis/:id` exist in the router with no action
 * behind them - `AnalysisController` defines only the two collection actions.
 * Calling one fails inside Rails with `AbstractController::ActionNotFound`,
 * which surfaces as a `404` carrying a Rails error page rather than this
 * API's usual bare string. There are exactly two usable routes here and they
 * are both below.
 */
export class AnalysisNamespace extends Resource {
  /**
   * `GET /analysis/storages` - every root directory in the system, with its
   * recursive size.
   *
   * This is `FsNode.directory.root_nodes.render`: every node with no parent,
   * for every user, which in practice means each account's home, trash and
   * vault roots. Rendered in the DEFAULT `FsNodeBlueprint` view, which is what
   * {@link FsNode} describes.
   *
   * Two things to expect:
   *
   * - **No owner.** The blueprint does not emit `user_id`, so the payload
   *   tells you that a root called `"home"` holds 40 GB and not whose it is.
   *   Correlating means another query.
   * - **No limit and no paging.** The scope is unbounded, so the response
   *   grows linearly with the number of accounts. It is an admin report, not
   *   something to poll.
   *
   * The `size` on a root is the recursive total maintained by the storage
   * layer; it has drifted from the true sum before, so read it as an estimate.
   */
  async storages(options: RequestOptions = {}): Promise<FsNode[]> {
    return this.http.get<FsNode[]>("/analysis/storages", options);
  }

  /**
   * `GET /analysis/files_daily` - files created per day over the last
   * {@link ANALYSIS_DAILY_WINDOW_DAYS} days. Unwraps `{"creations_daily": [...]}`.
   *
   * Exactly 30 entries, oldest first, zero-filled: a day with no uploads is
   * present with `count: 0`. The last entry is today and is partial.
   *
   * Counts `fs_nodes` of kind `file` by `DATE(created_at)`, so it measures
   * node creation and not bytes - a folder copy that mints 50 000 nodes shows
   * up here as 50 000 files.
   */
  async filesDaily(options: RequestOptions = {}): Promise<AnalysisDailyPoint[]> {
    const body = await this.http.get<{ creations_daily: AnalysisDailyPoint[] }>("/analysis/files_daily", options);
    return body.creations_daily;
  }
}

// ---------------------------------------------------------------------------
// Space Invaders
// ---------------------------------------------------------------------------

/** Primary key of a leaderboard entry. An INTEGER. */
export type SpaceInvadersGameId = number;

/** Points a single kill can be worth. Mirrors `MAX_POINTS_PER_KILL`. */
export const SPACE_INVADERS_MAX_POINTS_PER_KILL = 10;

/** Kills per second the validator will believe. Mirrors `MAX_KILLS_PER_SECOND`. */
export const SPACE_INVADERS_MAX_KILLS_PER_SECOND = 1;

/** Longest session the validator accepts, in seconds. 24 hours. */
export const SPACE_INVADERS_MAX_SESSION_SECONDS = 24 * 60 * 60;

/** Rows the leaderboard returns. Mirrors the `leaderboard` scope's `limit`. */
export const SPACE_INVADERS_LEADERBOARD_SIZE = 100;

/**
 * One finished game.
 *
 * ## `money` and `time` are STRINGS
 *
 * They are `decimal` columns with no precision or scale, and Rails encodes
 * `BigDecimal` as a JSON string on purpose - a JSON number would be parsed as
 * a float by most clients and silently lose precision. So the wire carries
 * `"1200.0"`, not `1200`. `kills` is an `integer` column right next to them
 * and arrives as a real number.
 *
 * The web frontend types all three as `number`, which happens to work only
 * because it never does arithmetic on them - it interpolates them into a cell.
 * Anything that sorts, sums or compares these must `Number()` them first;
 * `"9.0" > "10.0"` is `true` in JavaScript.
 */
export interface SpaceInvadersGame {
  readonly id: SpaceInvadersGameId;
  /** The player. A STRING id. */
  readonly user_id: Id;
  /** Score. A decimal serialised as a STRING - see the interface docs. */
  readonly money: string;
  /** Session length in seconds. Also a decimal serialised as a STRING. */
  readonly time: string;
  /** Enemies killed. An integer, and a real JSON number. */
  readonly kills: number;
  /**
   * When the game ended. Stamped SERVER-side from `Time.current` in a
   * `before_create`, and deliberately not accepted from the request body, so a
   * client cannot back-date or future-date an entry. Sending it is ignored.
   */
  readonly played_at: Timestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/**
 * Arguments for {@link SpaceInvadersNamespace.submit}.
 *
 * All three are required and all three are validated against each other. The
 * bounds mirror `frontend/public/spaceinvaders/config.json` and are documented
 * in the model as what they are: not anti-cheat, just a rejection of scores
 * that are impossible under the game's own rules. The score is
 * client-authoritative, so anybody willing to call this endpoint by hand can
 * post any score inside the bounds.
 */
export interface SubmitSpaceInvadersGameInput {
  /**
   * Score. Must be `>= 0` and no greater than
   * `kills * {@link SPACE_INVADERS_MAX_POINTS_PER_KILL}`, or the call is
   * `400 "Money is impossibly high for N kills"`.
   */
  readonly money: number;
  /**
   * Session length in seconds. Must be `>= 0` and
   * `<= {@link SPACE_INVADERS_MAX_SESSION_SECONDS}`.
   */
  readonly time: number;
  /**
   * Enemies killed. Must be a non-negative integer and no greater than
   * `ceil(time * {@link SPACE_INVADERS_MAX_KILLS_PER_SECOND})`, or the call is
   * `400 "Kills are impossibly high for a Ns game"`.
   */
  readonly kills: number;
}

/**
 * The `space_invaders_games` namespace: the leaderboard for the embedded game.
 *
 * The only genuinely public thing here is {@link leaderboard}. Submitting
 * needs a session, and so - oddly - does {@link list}.
 */
export class SpaceInvadersNamespace extends Resource {
  /**
   * `GET /space_invaders_games/leaderboard` - the top
   * {@link SPACE_INVADERS_LEADERBOARD_SIZE} scores, highest `money` first.
   *
   * Anonymous callers welcome. Not the list DSL: no paging, no filters, no
   * ordering - `order(money: :desc).limit(100)` is the whole query, and it is
   * backed by a descending index on `money`.
   *
   * One row per GAME, not per player: a player who posts three good runs
   * occupies three slots. Deduplicate client-side if you want a per-player
   * board.
   *
   * The rows carry `user_id` and nothing else about the player - no handle, no
   * avatar - so a board with names needs a separate lookup.
   */
  async leaderboard(options: RequestOptions = {}): Promise<SpaceInvadersGame[]> {
    return this.http.get<SpaceInvadersGame[]>("/space_invaders_games/leaderboard", options);
  }

  /**
   * `GET /space_invaders_games` - every game ever recorded, paged.
   *
   * `viewable_by` is `all`, so any signed-in caller enumerates the whole
   * table, everybody's runs included. It needs a session even though
   * {@link leaderboard} does not, which is the wrong way round if you were
   * expecting the listing to be the public one.
   *
   * **You cannot filter by player.** The controller declares only
   * `create_params`, so the search allowlist is the three defaults - `id`,
   * `created_at`, `updated_at`. `exact_search: { user_id: "..." }` is
   * `400 "Unknown exact_search filter: user_id"`. To show one player's
   * history, page and filter client-side, or use `order: "money:desc"` and
   * stop early.
   *
   * No default ordering, so pass one. Sends an `ETag`.
   */
  async list(params: ContentListParams = {}, options: RequestOptions = {}): Promise<Paginated<SpaceInvadersGame>> {
    const load = async (p: { page: number; pageSize: number }): Promise<SpaceInvadersGame[]> =>
      this.http.get<SpaceInvadersGame[]>("/space_invaders_games", {
        ...options,
        query: listQuery(params, p.page, p.pageSize),
      });
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const items = await load({ page, pageSize });
    return createPage(items, page, pageSize, load);
  }

  /**
   * `POST /space_invaders_games` - records a finished run. `201`.
   *
   * The player is taken from the session and `played_at` is stamped
   * server-side; neither can be supplied. Any signed-in user may submit.
   *
   * Every submission is a new row, so a retry after a lost response posts the
   * run twice and both appear on the leaderboard. The transport does not
   * replay a `POST` by default, and this is an endpoint where you should not
   * ask it to.
   *
   * There is no per-user rate limit beyond the general 600/min, and no
   * de-duplication: two identical runs are two rows.
   *
   * @throws {OmsApiError} 400 with the validation sentence when the score
   *   fails the plausibility bounds - see {@link SubmitSpaceInvadersGameInput};
   *   401 without a session.
   */
  async submit(
    input: SubmitSpaceInvadersGameInput,
    options: RequestOptions = {},
  ): Promise<SpaceInvadersGame> {
    return this.http.post<SpaceInvadersGame>("/space_invaders_games", input, options);
  }

  /**
   * `DELETE /space_invaders_games/:id` - removes an entry. `204`.
   *
   * The player who set it, or an admin. Anybody else gets
   * `401 "You are not authorized to destroy this resource"` - and note it is a
   * 401 rather than a 404, because `viewable_by` is `all` and the lookup
   * succeeds before the authorisation check.
   *
   * There is no update route: the resource is declared
   * `only: [:create, :index, :destroy]`, so a score can be deleted but never
   * edited.
   */
  async destroy(id: SpaceInvadersGameId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/space_invaders_games/${encodeURIComponent(String(id))}`, options);
  }
}

// ---------------------------------------------------------------------------
// Intel proxy
// ---------------------------------------------------------------------------

/**
 * The two path prefixes the proxy will forward. Mirrors
 * `IntelController::ALLOWED_PREFIXES`.
 *
 * `api` is the sidecar's JSON surface; `img` is its image surface. Anything
 * else - and any path containing `..` - is `400 "Invalid intel path."` before
 * a byte leaves the backend.
 */
export const INTEL_ALLOWED_PREFIXES = ["api", "img"] as const;

/** Connect timeout the backend applies to the sidecar, in milliseconds. */
export const INTEL_UPSTREAM_OPEN_TIMEOUT_MS = 5_000;

/** Read timeout the backend applies to the sidecar, in milliseconds. */
export const INTEL_UPSTREAM_READ_TIMEOUT_MS = 60_000;

/**
 * The `intel` proxy: a read-only passthrough to an internal service.
 *
 * ## Why this namespace has no types
 *
 * `GET /intel/*path` is not an API. It is a generic forwarder:
 * `IntelController#proxy` checks who is asking, refuses anything outside
 * {@link INTEL_ALLOWED_PREFIXES}, joins the rest of the path onto the
 * sidecar's base URL, replays the query string VERBATIM, injects an
 * `X-API-Key` that never reaches the browser, and hands back whatever comes
 * out - the upstream body, the upstream `Content-Type`, the upstream
 * `Cache-Control` and the upstream STATUS CODE, unexamined.
 *
 * The SDK cannot see that service, its routes are not in this repository, and
 * nothing in the backend validates or reshapes its answers. Publishing typed
 * `getStories()` / `getReport()` methods here would be inventing a contract
 * nobody can hold up, and it would rot the first time the sidecar changed. So
 * this namespace offers exactly what the endpoint offers: a path, a query bag,
 * and a caller-supplied result type it is the CALLER's job to justify.
 *
 * If you want typed intel data, use the native Rails endpoints instead -
 * they are real controllers with real blueprints, the web frontend moved onto
 * them and left this proxy behind, and they ARE wrapped, one family per
 * sub-namespace under {@link IntelNamespace}. This class is only for the
 * embedded hub the old page still renders and for its image bytes.
 *
 * ## Access
 *
 * Effectively a single-user endpoint. `Intel::Access.allowed?` is an admin
 * check OR a hard-coded handle allowlist, so every other authenticated caller
 * gets `403 "Intel access is restricted."` and an anonymous one gets the
 * ordinary `401` first. Do not build a shared feature on this.
 *
 * ## Errors are not the API's errors
 *
 * The upstream status is forwarded as-is, so a 4xx or 5xx here carries the
 * SIDECAR's body - which may be JSON, may be HTML, may be empty, and is
 * certainly not this API's usual bare JSON string. Read
 * {@link OmsApiError.body} defensively.
 *
 * When the sidecar cannot be reached at all - refused connection, DNS
 * failure, or a timeout past
 * {@link INTEL_UPSTREAM_OPEN_TIMEOUT_MS} / {@link INTEL_UPSTREAM_READ_TIMEOUT_MS} -
 * the backend answers `502 "Intel service unreachable."`, which is a normal
 * bare-string error.
 *
 * Only `GET` is routed. There is no way to write anything through this proxy.
 *
 * @deprecated Intel now lives ENTIRELY inside Rails. The analysis pipeline
 *   moved into Ruby and Solid Queue, and sources became per-user records with
 *   sandboxed TS scripts, so the `omelhorsite-intel-analise` sidecar this
 *   forwards to is on its way out. The route still answers today, which is why
 *   this class is still here rather than deleted, but nothing new should be
 *   built on it: when the sidecar goes, every call through here becomes a
 *   `502 "Intel service unreachable."` with no deprecation window, because the
 *   backend cannot tell a retired sidecar from a broken one.
 *
 *   Use the typed families under {@link IntelNamespace} instead: `articles`,
 *   `reports`, `sources`, `scripts`, `items`, `config` and `stats` are real
 *   controllers with real blueprints over the API's own tables.
 */
export class IntelProxyNamespace extends Resource {
  /**
   * `GET /intel/<path>` - forwards a read and parses the answer as JSON.
   *
   * The type parameter is a PROMISE YOU are making, not one the SDK or the
   * backend can check. Default it to `unknown` and narrow at the call site
   * unless you own the sidecar's route.
   *
   * `path` is relative and must start with `api/` or `img/`
   * (see {@link INTEL_ALLOWED_PREFIXES}). A leading slash is stripped, and
   * each segment is percent-encoded while the separators are kept, so
   * `"api/articles/abc def"` reaches the sidecar as `api/articles/abc%20def`.
   * Pass an unencoded path; passing a pre-encoded one double-encodes it.
   *
   * `query` is encoded by the SDK's normal rules and then replayed to the
   * sidecar untouched, `null` sentinel and all - which is worth knowing,
   * because the sentinel is a Rails convention the sidecar has never heard of.
   * Prefer plain values here.
   *
   * The route is declared `format: false`, so a trailing `.json` stays part of
   * the path instead of being read as a Rails format.
   *
   * If the answer is not JSON it comes back as the raw text (the transport
   * falls back to a string rather than throwing), so a `T` of `unknown`
   * genuinely can be a `string`.
   *
   * Cost: the backend buffers the entire upstream body in memory before
   * sending it on - there is no streaming - and holds a Puma thread for up to
   * {@link INTEL_UPSTREAM_READ_TIMEOUT_MS} while it waits.
   *
   * @throws {OmsApiError} 400 `"Invalid intel path."` for a path outside the
   *   allowed prefixes or containing `..`; 403 `"Intel access is restricted."`;
   *   502 `"Intel service unreachable."`; or anything at all, forwarded from
   *   the sidecar.
   */
  async get<T = unknown>(path: string, query?: QueryParams, options: RequestOptions = {}): Promise<T> {
    return this.http.get<T>(intelPath(path), { ...options, ...(query === undefined ? {} : { query }) });
  }

  /**
   * `GET /intel/<path>` - forwards a read and keeps the bytes.
   *
   * For the `img/` prefix, and for any `api/` route that answers with
   * something other than JSON. Buffers the whole body, so do not point it at
   * anything large.
   *
   * {@link FileOutput.filename} will be `undefined`: the backend sends
   * `Content-Disposition: inline` with no filename. `contentType` is whatever
   * the sidecar declared.
   */
  async fetch(path: string, query?: QueryParams, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download(intelPath(path), { ...options, ...(query === undefined ? {} : { query }) });
  }

  /**
   * The absolute URL of a proxied path, for an `<img src>` or an `<a href>`.
   *
   * Builds the string and makes no request. Useful only for a cookie-session
   * browser client on the API's origin: the proxy requires an authenticated,
   * allowlisted caller, so a bare URL opened without a credential is a `401`.
   */
  url(path: string, query?: QueryParams): string {
    return this.http.url(intelPath(path), query);
  }
}

/**
 * Turns a caller's relative intel path into a request path.
 *
 * Strips leading slashes, then percent-encodes each segment while keeping the
 * separators, so slashes survive and spaces and accents do not. Deliberately
 * does NOT reject a path outside {@link INTEL_ALLOWED_PREFIXES}: that rule
 * lives in the controller, the SDK does not know when it will be widened, and
 * a 400 from the server naming the real rule is more useful than a local guess
 * that could be out of date. `..` is left alone for the same reason - it is
 * escaped nowhere and rejected server-side.
 */
function intelPath(path: string): string {
  const segments = path.replace(/^\/+/, "").split("/");
  return `/intel/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

// ---------------------------------------------------------------------------
// Intel: the native Rails endpoints
// ---------------------------------------------------------------------------

/**
 * ## Why these ARE typed, when the proxy above is not
 *
 * The two halves of "intel" look alike and are nothing alike.
 * {@link IntelProxyNamespace} forwards `GET /intel/*path` to a service whose
 * routes are not in the backend repository, so its answers are genuinely
 * unknowable. Everything below is the opposite: seven ordinary Rails
 * controllers over eight of the backend's own tables, each with a Blueprinter
 * blueprint that names every key it emits. `IntelArticleBlueprint`,
 * `IntelReportBlueprint`, `IntelSourceBlueprint`, `IntelScriptBlueprint`,
 * `IntelItemBlueprint` and `IntelConfigBlueprint` are the contract, and
 * `IntelStatsController#show` hand-writes its hash literally. Nothing here is
 * forwarded, nothing here is opaque, and the SDK types it the way it types any
 * other resource.
 *
 * Where the two meet: the sidecar behind the proxy is the OLD, separate intel
 * product embedded in the web app's `/intel` page. The routes below are the one
 * that replaced it. Reach for these first; the proxy is for the embedded hub
 * and for image bytes.
 *
 * ## Access: this is effectively a one-user feature
 *
 * `IntelAccess` runs `before_action :require_intel_access` on all seven
 * controllers, and `Intel::Access.allowed?` is `user.admin? ||
 * ALLOWED_HANDLES.include?(user.handle)` with `ALLOWED_HANDLES` frozen to a
 * single handle in the source. So: anonymous is `401`, any other signed-in
 * account is `403 "Intel access is restricted."`, and no amount of correct
 * request shaping changes that. Do not build a shared feature on it, and do not
 * treat a 403 here as a bug in the caller.
 *
 * As with everything else in this file, no controller declares an
 * `oauth_scope`, so an OAuth access token is `403 {"error":"insufficient_scope"}`
 * on every route below. Session credential only.
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

/** Categories `IntelArticle::CATEGORIES` allows. `null` when the classifier declined to pick one. */
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

/** Report windows `IntelReport::KINDS` allows. */
export const INTEL_REPORT_KINDS = ["6h", "day", "week", "month"] as const;

/** Which window a report covers. */
export type IntelReportKind = (typeof INTEL_REPORT_KINDS)[number] | (string & {});

/** The three values `IntelSource::HEALTHS` allows. */
export const INTEL_SOURCE_HEALTHS = ["unknown", "ok", "error"] as const;

/** Health of a source's last run. `"unknown"` until it has ever run. */
export type IntelSourceHealth = (typeof INTEL_SOURCE_HEALTHS)[number];

/**
 * The only keys {@link IntelConfig.prompts} accepts, from
 * `IntelConfig::PROMPT_KEYS`.
 *
 * Any other key fails the whole `PATCH` with
 * `400 "Prompts unknown keys: <the offenders>"`. A key that is present but
 * empty is not the same as an absent one: absent means "use the platform
 * default", present-and-empty means the pipeline gets an empty prompt.
 */
export const INTEL_PROMPT_KEYS = ["build", "enrich_plan", "enrich_actors", "enrich_synth", "report"] as const;

/** One overridable prompt in the analysis pipeline. */
export type IntelPromptKey = (typeof INTEL_PROMPT_KEYS)[number];

/**
 * Consecutive failures after which `IntelSource#register_failure!` flips
 * `enabled` to `false` by itself. Mirrors `IntelSource::DISABLE_AFTER_FAILURES`.
 *
 * Nothing turns it back on: a source that hit this stays off until someone
 * `update()`s `enabled` back to `true`. That is what
 * {@link IntelSource.consecutive_failures} is for - watch it, do not wait for
 * an alert.
 */
export const INTEL_SOURCE_DISABLE_AFTER_FAILURES = 20;

/** Largest script body `IntelScript` will store, from `IntelScript::MAX_CODE_BYTES`. */
export const INTEL_SCRIPT_MAX_CODE_BYTES = 64 * 1024;

/**
 * A story: several raw items about the same event, grouped, scored and
 * categorised by the analysis pipeline.
 *
 * This is the shape an INDEX row has. `GET /intel_articles/:id` renders
 * `:extended`, which is this plus four more keys - see
 * {@link IntelArticleDetail}. Blueprinter views inherit, so the detail is
 * always a superset, never a different record.
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
   * Computed in the blueprint as `article.intel_article_sources.size`, which
   * means one COUNT query per row unless the association is already loaded -
   * and the index does not preload it. A page of 500 stories is 500 extra
   * queries. This is the reason to keep `pageSize` modest on
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
 * Four keys the listing does not carry, and all four are joins the blueprint
 * runs inline: `sources` walks `intel_items`, `related` walks the link table in
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

/** A story as a report inlines it. Four keys, no summary and no body. */
export interface IntelReportArticleRef {
  readonly id: Id;
  readonly title: string | null;
  readonly importance: number;
  readonly category: IntelArticleCategory | null;
}

/**
 * A generated report over one closed time window.
 *
 * The index shape. `GET /intel_reports/:id` adds three keys - see
 * {@link IntelReportDetail}.
 *
 * There is at most ONE report per `(user, kind, period_end)`: the migration
 * puts a unique index on that triple precisely so a re-run of
 * `GenerateReportJob` cannot mint a duplicate. Windows are the last CLOSED
 * period, computed by `IntelReport.last_window`, so a `"day"` report covers
 * yesterday and never the day in progress.
 */
export interface IntelReport {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Which window: see {@link INTEL_REPORT_KINDS}. */
  readonly kind: IntelReportKind;
  /** Title the model wrote. Nullable. */
  readonly title: string | null;
  /** Start of the window, inclusive. */
  readonly period_start: Timestamp;
  /** End of the window, exclusive. Also the sort key of the listing. */
  readonly period_end: Timestamp;
  /** LLM that wrote it, as configured at generation time. Nullable. */
  readonly model: string | null;
}

/** `GET /intel_reports/:id` - the `:extended` view. */
export interface IntelReportDetail extends IntelReport {
  /** The report body, usually Markdown. `null` if generation failed halfway. */
  readonly content: string | null;
  /**
   * Whatever the generator chose to record about the run. A free-form JSON
   * object with no schema on either side, defaulting to `{}` - which is why it
   * is typed as a bag rather than as fields. Read it defensively.
   */
  readonly stats: Record<string, Json> | null;
  /** The stories the report covered, most important first. */
  readonly articles: IntelReportArticleRef[];
}

/**
 * A configured feed: a script plus the settings that script needs.
 *
 * A source is polled by `PollDispatcherJob` once every
 * {@link poll_interval_minutes}, and each poll writes {@link IntelItem} rows
 * that the analysis pipeline later turns into stories.
 */
export interface IntelSource {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Up to 200 characters, whitespace-trimmed by the model, unique per user. */
  readonly name: string;
  /**
   * The script's own settings - a URL, a channel, a CSS selector. There is no
   * schema: the backend permits `config: {}`, meaning an arbitrary object, and
   * the SCRIPT decides what it reads out of it. What belongs in here is
   * documented by the script, not by this API.
   */
  readonly config: Record<string, Json>;
  /** Which {@link IntelScript} fetches this source. */
  readonly intel_script_id: Id;
  /** Minutes between polls. Validated `in: 5..1440`. */
  readonly poll_interval_minutes: number;
  /**
   * Whether the dispatcher will poll it.
   *
   * Can flip to `false` WITHOUT anyone asking: see
   * {@link INTEL_SOURCE_DISABLE_AFTER_FAILURES}.
   */
  readonly enabled: boolean;
  /**
   * Incremental cursor the script returned last time - a timestamp, an etag, a
   * last-seen id, whatever that script uses. Opaque to everything but the
   * script. Writable, so clearing it is how you force a full re-fetch.
   */
  readonly cursor: string | null;
  /** Result of the last run. `"unknown"` until it has run once. */
  readonly health: IntelSourceHealth;
  /** Failure message from the last failed run, truncated to 1000 characters. */
  readonly last_error: string | null;
  /** When the source last ran, successfully or not. */
  readonly last_run_at: Timestamp | null;
  /** When it last SUCCEEDED. A gap between the two is the thing to alert on. */
  readonly last_success_at: Timestamp | null;
  /** Reset to 0 on any success. See {@link INTEL_SOURCE_DISABLE_AFTER_FAILURES}. */
  readonly consecutive_failures: number;
}

/**
 * A TypeScript fetcher that knows how to pull items out of one kind of feed.
 *
 * Runs in the `intel-runner` sidecar, inside a V8 isolate with nothing but the
 * injected `ctx`. Two populations share this table:
 *
 * - **built-ins** (`builtin: true`, `user_id: null`, `slug` set) are managed by
 *   `Intel::BuiltinScripts`, visible to everyone, and immutable over HTTP;
 * - **user scripts** (`builtin: false`, `user_id` set, `slug: null`) are yours.
 *
 * `viewable_by` is `builtin OR mine`, so a listing mixes the two. Check
 * {@link builtin} before offering an edit affordance - see
 * {@link IntelScriptsNamespace.update} for what happens if you do not.
 */
export interface IntelScript {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Up to 120 characters, whitespace-trimmed by the model. */
  readonly name: string;
  /** Stable handle, e.g. `"rss"`. Non-null for built-ins ONLY; always `null` for yours. */
  readonly slug: string | null;
  readonly description: string | null;
  /** `true` for a platform script. Immutable, and not yours to delete. */
  readonly builtin: boolean;
  /** Owner. `null` exactly when {@link builtin} is `true`. */
  readonly user_id: Id | null;
  /**
   * The source code - **only on the `:extended` view**.
   *
   * `IntelScriptBlueprint` puts `code` inside `view :extended`, so `get()`,
   * `create()` and `update()` carry it and `list()` does not. That is a
   * deliberate weight decision (a listing of 64 KiB bodies), not an oversight,
   * and it is why this key is optional. A row from `list()` has it `undefined`;
   * fetch the script by id when you actually need the body.
   */
  readonly code?: string;
}

/**
 * A raw item, exactly as a script returned it.
 *
 * Written only by `Intel::FetchSourceJob`; over HTTP it is read-only plus a
 * delete. Items are the substrate the stories are built from - the story never
 * copies the body, it points here.
 */
export interface IntelItem {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Which source produced it. */
  readonly intel_source_id: Id;
  /**
   * The script's own id for this item, unique per source. This is the
   * de-duplication key: a second poll that returns the same `external_id` does
   * not create a second row.
   */
  readonly external_id: string;
  readonly title: string | null;
  /** The body the script extracted. Can be large; a listing carries all of it. */
  readonly content: string | null;
  readonly url: string | null;
  readonly author: string | null;
  /** Publication time as the feed reported it, not as we saw it. */
  readonly published_at: Timestamp | null;
  /** When the poll that produced this item ran. Never null. */
  readonly fetched_at: Timestamp;
}

/**
 * The per-user knobs on the analysis pipeline. One row per user, created on
 * demand - see {@link IntelConfigNamespace.get}.
 */
export interface IntelConfig {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /**
   * Free text telling the classifier what "important" means for you. `null`
   * falls back to the platform default. This is the single highest-leverage
   * field here: everything else is a threshold applied to the score this
   * produces.
   */
  readonly rubric: string | null;
  /**
   * Prompt overrides, keyed by {@link IntelPromptKey}. `{}` means "platform
   * defaults everywhere"; a key present means that one stage is overridden.
   *
   * Nullable at the database level even though it defaults to `{}`.
   */
  readonly prompts: Partial<Record<IntelPromptKey, string>> | null;
  /** LLM for the story-building pass. `null` uses the platform default. */
  readonly build_model: string | null;
  /** LLM for report generation. `null` uses the platform default. */
  readonly report_model: string | null;
  /** Stories below this importance are left out of reports. 0-10, default 4. */
  readonly report_min_importance: number;
  /**
   * Stories below this importance are never web-enriched. 0-10, default 6.
   *
   * Lowering it does not enrich the backlog quickly: the job does three
   * stories per run, highest importance first.
   */
  readonly enrich_min_importance: number;
  /**
   * Master switch for the enrichment pass. `false` leaves every story at
   * `enriched: false` and `details: null` for ever.
   */
  readonly web_search: boolean;
  /**
   * How many {@link IntelSource} rows you may own. 1-500, default 50.
   *
   * Enforced on CREATE only (`validate :within_source_quota, on: :create`), so
   * lowering it below your current count does not delete anything - it just
   * stops the next create with `400 "Source limit reached (N)"`.
   */
  readonly max_sources: number;
}

/** One category bucket of {@link IntelStats}. */
export interface IntelCategoryCount {
  readonly category: string;
  /** Named `c`, not `count` - the controller builds this hash by hand. */
  readonly c: number;
}

/** One day of the {@link IntelStats} histogram. */
export interface IntelDayCount {
  /** `YYYY-MM-DD`, from Postgres `DATE(last_seen_at)`. Not a full timestamp. */
  readonly day: string;
  readonly c: number;
}

/**
 * The importance histogram, with the backend's own Portuguese bucket names.
 *
 * The boundaries are hard-coded in `IntelStatsController` and are not
 * configurable: `critico` >=9, `alta` 7-8, `media` 5-6, `baixa` 3-4, `ruido`
 * <3. Note they are NOT the same thresholds as
 * {@link IntelConfig.report_min_importance} or
 * {@link IntelConfig.enrich_min_importance} - those are yours, these are the
 * dashboard's.
 */
export interface IntelImportanceBuckets {
  readonly critico: number;
  readonly alta: number;
  readonly media: number;
  readonly baixa: number;
  readonly ruido: number;
}

/** Row counts on the {@link IntelStats} answer. */
export interface IntelStatsTotals {
  /** Stories you own. */
  readonly articles: number;
  /**
   * **Not the number of feeds you have configured.** The controller counts
   * `IntelArticleSource`, the story-to-item POINTER table, so this is "how
   * many citations exist across all my stories" and it grows without bound as
   * stories accumulate. If you want the number of configured sources, read the
   * length of {@link IntelSourcesNamespace.list}. The name is the backend's and
   * the SDK does not rename it, but do not put it under a "Sources" label.
   */
  readonly sources: number;
  readonly reports: number;
  /** Raw items you own, processed or not. */
  readonly items: number;
  /**
   * Items the analysis pipeline has not consumed yet (`processed_at IS NULL`).
   *
   * The one number worth watching: a figure that climbs and never falls means
   * the pipeline is not running - most often because `Intel::LlmClient` is
   * disabled for want of an API key, in which case `AnalysisDispatcherJob`
   * returns immediately and silently.
   */
  readonly pending_items: number;
}

/**
 * `GET /intel_stats` - counters for the intel dashboard.
 *
 * Hand-built in the controller rather than rendered by a blueprint, so it has
 * no `id`, no timestamps and no `:extended` view.
 */
export interface IntelStats {
  readonly totals: IntelStatsTotals;
  /**
   * Categories by story count, descending. Stories with a `null` category are
   * EXCLUDED, so these do not sum to `totals.articles`.
   */
  readonly by_category: IntelCategoryCount[];
  /**
   * The last 30 days by `last_seen_at`, ascending.
   *
   * Sparse: a day with no activity is simply ABSENT, not present with zero.
   * Fill the gaps before plotting or the line will lie about its own x-axis.
   */
  readonly by_day: IntelDayCount[];
  readonly by_importance: IntelImportanceBuckets;
  /** Stories touched in the last 24 hours. */
  readonly last24h: number;
}

/** Filters for {@link IntelArticlesNamespace.list}. */
export interface ListIntelArticlesParams extends ContentListParams {
  /**
   * Free-text search over `title`, `summary` AND `details`.
   *
   * A TOP-LEVEL parameter, not a `search` key: the controller reads
   * `params[:q]` itself, which is why it can reach `details` (a column that is
   * not in `search_params` at all) and why an unknown-filter 400 cannot
   * happen for it.
   *
   * Three ways it differs from {@link ContentListParams.search}:
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

/** Filters for {@link IntelReportsNamespace.list}. */
export interface ListIntelReportsParams extends ContentListParams {
  /**
   * Narrow to one window, e.g. `"day"`. Sent as `exact_search[kind]`, so it is
   * equality rather than a prefix match - `"6h"` will not also match `"6hx"`.
   *
   * Passing it through {@link ContentListParams.search} instead would be a
   * partial match and would work too; `kind` is on this controller's
   * `search_params` allowlist. Equality is what you want.
   */
  readonly kind?: IntelReportKind;
}

/** Filters for {@link IntelSourcesNamespace.list}. */
export interface ListIntelSourcesParams extends ContentListParams {
  /** Only healthy / only broken feeds. Sent as `exact_search[health]`. */
  readonly health?: IntelSourceHealth;
  /** Only enabled, or only the ones that switched themselves off. */
  readonly enabled?: boolean;
  /** Every source driven by one script. */
  readonly scriptId?: Id;
}

/** Filters for {@link IntelScriptsNamespace.list}. */
export interface ListIntelScriptsParams extends ContentListParams {
  /**
   * `true` for the platform scripts, `false` for yours. Omit for both - the
   * listing scope is `builtin OR mine`, so both populations are mixed by
   * default.
   */
  readonly builtin?: boolean;
}

/** Filters for {@link IntelItemsNamespace.list}. */
export interface ListIntelItemsParams extends ContentListParams {
  /** Only items produced by one source. Sent as `exact_search[intel_source_id]`. */
  readonly sourceId?: Id;
}

/** Arguments for {@link IntelSourcesNamespace.create}. */
export interface CreateIntelSourceInput {
  /** Up to 200 characters, and unique among YOUR sources - a clash is a 400. */
  readonly name: string;
  /**
   * The script that fetches it. Must be a built-in or one of yours;
   * `script_visible_to_owner` rejects anything else with
   * `400 "Intel script is not accessible"` rather than a 404, so this also
   * tells you the id exists. Do not use it as an existence oracle.
   */
  readonly intelScriptId: Id;
  /** Whatever that script reads. Free-form; the API validates nothing in it. */
  readonly config?: Record<string, Json>;
  /** 5-1440. Defaults to 15 server-side. */
  readonly pollIntervalMinutes?: number;
  /** Defaults to `true`. Create it disabled if you want to configure first. */
  readonly enabled?: boolean;
}

/**
 * Arguments for {@link IntelSourcesNamespace.update}.
 *
 * One key wider than the create form: `cursor` is updatable and not creatable.
 */
export interface UpdateIntelSourceInput {
  readonly name?: string;
  readonly intelScriptId?: Id;
  /**
   * REPLACES the whole object; there is no merge. `assign_attributes` writes
   * the JSON column wholesale, so sending `{ url: "..." }` to a source that
   * also had a `selector` drops the selector. Read the source, spread, write.
   */
  readonly config?: Record<string, Json>;
  readonly pollIntervalMinutes?: number;
  /** Set back to `true` to revive a source that disabled itself. */
  readonly enabled?: boolean;
  /**
   * The incremental cursor. Set it to `null` to force the next poll to start
   * from the beginning - which for most scripts means re-fetching everything.
   *
   * `null` here is a JSON body `null`, not the query-string sentinel: bodies
   * never carry `\b`.
   */
  readonly cursor?: string | null;
}

/** Arguments for {@link IntelScriptsNamespace.create}. */
export interface CreateIntelScriptInput {
  /** Up to 120 characters. */
  readonly name: string;
  /** The body. Up to {@link INTEL_SCRIPT_MAX_CODE_BYTES}. */
  readonly code: string;
  readonly description?: string;
}

/** Arguments for {@link IntelScriptsNamespace.update}. */
export interface UpdateIntelScriptInput {
  readonly name?: string;
  readonly code?: string;
  readonly description?: string;
}

/**
 * Arguments for {@link IntelConfigNamespace.update}.
 *
 * Every key is optional and only the keys you send are written -
 * `assign_attributes` over a permitted hash - so this is a genuine partial
 * update, unlike {@link UpdateIntelSourceInput.config}.
 */
export interface UpdateIntelConfigInput {
  readonly rubric?: string | null;
  /**
   * REPLACES the whole prompts object. Same trap as
   * {@link UpdateIntelSourceInput.config}: it is one JSON column, so a partial
   * object drops the keys you left out. Spread the current value.
   *
   * Only {@link INTEL_PROMPT_KEYS} are accepted; anything else fails the whole
   * request with a 400 naming the offenders.
   */
  readonly prompts?: Partial<Record<IntelPromptKey, string>>;
  readonly buildModel?: string | null;
  readonly reportModel?: string | null;
  /** 0-10. Outside the range is a 400, not a clamp. */
  readonly reportMinImportance?: number;
  /** 0-10. Outside the range is a 400, not a clamp. */
  readonly enrichMinImportance?: number;
  readonly webSearch?: boolean;
  /** 1-500. Outside the range is a 400, not a clamp. */
  readonly maxSources?: number;
}

/** What `POST /intel_sources/:id/run` answers with. The whole body. */
export interface IntelSourceRunAccepted {
  /** Always `true`. The job was enqueued; nothing has been fetched yet. */
  readonly queued: boolean;
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
   * {@link IntelArticle.n_sources}, because the blueprint calls
   * `intel_article_sources.size` and the index preloads nothing. Keep
   * `pageSize` in the tens, not at 500.
   *
   * The response carries an `ETag` and can answer `304` - except when
   * `random` is set, which short-circuits `resources_stale?`.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   * @throws {OmsApiError} 403 `"Intel access is restricted."` for a signed-in
   *   account outside the allowlist; 400 for an unrecognised filter key.
   */
  async list(params: ListIntelArticlesParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelArticle>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 50;

    const load = (at: { page: number; pageSize: number }): Promise<IntelArticle[]> => {
      const query = listQuery(params, at.page, at.pageSize);
      if (params.q !== undefined) query.q = params.q;
      if (params.minImportance !== undefined) query.min_importance = params.minImportance;
      if (params.sort !== undefined) query.sort = params.sort;
      return this.http.get<IntelArticle[]>("/intel_articles", { ...options, query });
    };

    return createPage(await load({ page, pageSize }), page, pageSize, load);
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

/**
 * `GET /intel_reports` - the generated digests.
 *
 * Read-only plus a delete, for the same reason as the stories: reports come
 * from `Intel::GenerateReportJob`. There is no way to ask for one to be
 * generated over HTTP.
 */
export class IntelReportsNamespace extends Resource {
  /**
   * `GET /intel_reports` - your reports, newest window first.
   *
   * `period_end DESC` is applied by the controller; as with the stories, a
   * `order` of your own becomes the PRIMARY key and this becomes the
   * tie-breaker.
   *
   * `kind` is the only declared filter beyond the inherited three. Use
   * {@link ListIntelReportsParams.kind}, which sends it as an exact match.
   *
   * @throws {OmsApiError} 403 `"Intel access is restricted."` outside the
   *   allowlist.
   */
  async list(params: ListIntelReportsParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelReport>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 50;
    const exactSearch = {
      ...params.exactSearch,
      ...(params.kind === undefined ? {} : { kind: params.kind }),
    };

    const load = (at: { page: number; pageSize: number }): Promise<IntelReport[]> =>
      this.http.get<IntelReport[]>("/intel_reports", {
        ...options,
        query: listQuery(
          { ...params, ...(Object.keys(exactSearch).length === 0 ? {} : { exactSearch }) },
          at.page,
          at.pageSize,
        ),
      });

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `GET /intel_reports/:id` - the report with its body and its stories.
   *
   * @throws {OmsApiError} 404 when the report is not yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelReportDetail> {
    return this.http.get<IntelReportDetail>(`/intel_reports/${encodeURIComponent(id)}`, options);
  }

  /**
   * `DELETE /intel_reports/:id`. `204`, empty body.
   *
   * The stories it cited are untouched - only the join rows go.
   *
   * A deleted report can come back: `GenerateReportJob` is keyed by the unique
   * `(user, kind, period_end)` index, and deleting the row frees that key, so
   * the next dispatcher pass over the same window will regenerate it. Delete a
   * report to re-run it, not to suppress it.
   *
   * @throws {OmsApiError} 404 when the report is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_reports/${encodeURIComponent(id)}`, options);
  }
}

/**
 * `/intel_sources` - the feeds you have configured. Full CRUD, plus a manual
 * run.
 */
export class IntelSourcesNamespace extends Resource {
  /**
   * `GET /intel_sources` - your feeds.
   *
   * Declared filters: `name`, `health`, `enabled`, `intel_script_id`, plus the
   * inherited `id`, `created_at`, `updated_at`. The controller sets NO ordering
   * of its own, so a listing with no `order` is in whatever order Postgres
   * returns rows - which is not stable across pages. The SDK therefore sends
   * `created_at:desc` unless you say otherwise.
   *
   * A good health check in one call: `list({ health: "error" })`.
   *
   * @throws {OmsApiError} 403 outside the allowlist.
   */
  async list(params: ListIntelSourcesParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelSource>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const exactSearch = {
      ...params.exactSearch,
      ...(params.health === undefined ? {} : { health: params.health }),
      ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
      ...(params.scriptId === undefined ? {} : { intel_script_id: params.scriptId }),
    };

    const load = (at: { page: number; pageSize: number }): Promise<IntelSource[]> =>
      this.http.get<IntelSource[]>("/intel_sources", {
        ...options,
        query: listQuery(
          {
            ...params,
            // Explicitly, not by spread order: an `order: undefined` present on
            // the caller's object would otherwise overwrite the default with
            // undefined and leave the listing unordered again.
            order: params.order ?? "created_at:desc",
            ...(Object.keys(exactSearch).length === 0 ? {} : { exactSearch }),
          },
          at.page,
          at.pageSize,
        ),
      });

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `GET /intel_sources/:id`.
   *
   * `IntelSourceBlueprint` declares no `:extended` extras, so this is exactly
   * the shape a listing row has. Fetching one adds nothing but a round trip;
   * prefer finding it in {@link list} when you already have the page.
   *
   * @throws {OmsApiError} 404 when the source is not yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelSource> {
    return this.http.get<IntelSource>(`/intel_sources/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /intel_sources` - configures a feed. `201`.
   *
   * The source starts `health: "unknown"` and is not polled immediately: the
   * dispatcher picks it up on its next pass, or you can force it with
   * {@link run}.
   *
   * Three ways this fails with a 400 and a bare-string body:
   *
   * - `"Name has already been taken"` - names are unique per user;
   * - `"Intel script is not accessible"` - the script is neither a built-in nor
   *   yours. This is a 400 rather than a 404, so it does not tell you whether
   *   the id exists;
   * - `"Source limit reached (N)"` - you are at
   *   {@link IntelConfig.max_sources}. Raise it with
   *   {@link IntelConfigNamespace.update} if the ceiling is yours to raise.
   *
   * Not retried by default: a replayed `POST` after a lost response would fail
   * the uniqueness check rather than duplicate the row, but it would report
   * that failure as if the first attempt had never worked.
   */
  async create(input: CreateIntelSourceInput, options: RequestOptions = {}): Promise<IntelSource> {
    return this.http.post<IntelSource>(
      "/intel_sources",
      {
        name: input.name,
        intel_script_id: input.intelScriptId,
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.pollIntervalMinutes === undefined ? {} : { poll_interval_minutes: input.pollIntervalMinutes }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /intel_sources/:id`.
   *
   * Note what is NOT writable: `health`, `last_error`, `last_run_at`,
   * `last_success_at` and `consecutive_failures` are not on `update_params`, so
   * you cannot clear a source's failure history by hand. Only a successful run
   * resets it (`register_success!`). Re-enabling a source that disabled itself
   * therefore leaves `consecutive_failures` at 20 until the next success - do
   * not read that field as "currently failing".
   *
   * {@link UpdateIntelSourceInput.config} replaces the whole object.
   *
   * @throws {OmsApiError} 404 when the source is not yours; 400 with the
   *   validation sentence otherwise.
   */
  async update(id: Id, input: UpdateIntelSourceInput, options: RequestOptions = {}): Promise<IntelSource> {
    return this.http.patch<IntelSource>(
      `/intel_sources/${encodeURIComponent(id)}`,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.intelScriptId === undefined ? {} : { intel_script_id: input.intelScriptId }),
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.pollIntervalMinutes === undefined ? {} : { poll_interval_minutes: input.pollIntervalMinutes }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      options,
    );
  }

  /**
   * `DELETE /intel_sources/:id`. `204`, empty body.
   *
   * Destructive well beyond the row: `has_many :intel_items, dependent:
   * :destroy` takes every raw item this source ever produced, and the stories
   * built from them lose their citations
   * ({@link IntelArticleDetail.sources} shrinks, {@link IntelArticle.n_sources}
   * with it) while the stories themselves stay. Disabling is almost always what
   * you meant: `update(id, { enabled: false })`.
   *
   * @throws {OmsApiError} 404 when the source is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_sources/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /intel_sources/:id/run` - polls the source now instead of waiting
   * for its interval. `202 {"queued":true}`.
   *
   * **It enqueues; it does not fetch.** The answer arrives before anything has
   * happened, and it says nothing about whether the poll will succeed. To see
   * the outcome, re-read the source and watch {@link IntelSource.last_run_at},
   * {@link IntelSource.health} and {@link IntelSource.last_error}. There is no
   * job id and nothing to wait on.
   *
   * Three sharp edges:
   *
   * - it runs a source even when {@link IntelSource.enabled} is `false`. The
   *   action does not look at the flag, so this is also how you test a feed you
   *   have deliberately switched off;
   * - it is authorised by VISIBILITY only. The action does its own `find_by`
   *   inside `viewable_by` and never calls `updatable_by?` - which happens to
   *   be the same set here, since sources are only ever visible to their owner;
   * - it has **no bucket of its own**. It rides the general 600-per-minute
   *   ceiling, so a loop can enqueue hundreds of `FetchSourceJob`s into the
   *   `syncs` queue in seconds and starve everything else on it. Call it on a
   *   user gesture; never in a poll loop.
   *
   * Not retried by default: a replay enqueues a second fetch.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` when the source is not
   *   yours.
   */
  async run(id: Id, options: RequestOptions = {}): Promise<IntelSourceRunAccepted> {
    return this.http.post<IntelSourceRunAccepted>(
      `/intel_sources/${encodeURIComponent(id)}/run`,
      undefined,
      { retry: false, ...options },
    );
  }
}

/**
 * `/intel_scripts` - the fetchers. Full CRUD over YOUR scripts, read-only over
 * the platform's.
 */
export class IntelScriptsNamespace extends Resource {
  /**
   * `GET /intel_scripts` - the built-ins plus yours, mixed.
   *
   * **No `code`.** The body is on the `:extended` view only, so every row here
   * has `code: undefined`. See {@link IntelScript.code}.
   *
   * Declared filters: `name`, `builtin`, `slug`, plus the inherited three.
   * The controller sets no ordering, so the SDK sends `created_at:desc`.
   *
   * @throws {OmsApiError} 403 outside the allowlist.
   */
  async list(params: ListIntelScriptsParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelScript>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const exactSearch = {
      ...params.exactSearch,
      ...(params.builtin === undefined ? {} : { builtin: params.builtin }),
    };

    const load = (at: { page: number; pageSize: number }): Promise<IntelScript[]> =>
      this.http.get<IntelScript[]>("/intel_scripts", {
        ...options,
        query: listQuery(
          {
            ...params,
            // Explicitly, not by spread order: an `order: undefined` present on
            // the caller's object would otherwise overwrite the default with
            // undefined and leave the listing unordered again.
            order: params.order ?? "created_at:desc",
            ...(Object.keys(exactSearch).length === 0 ? {} : { exactSearch }),
          },
          at.page,
          at.pageSize,
        ),
      });

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `GET /intel_scripts/:id` - the script WITH its body.
   *
   * This is the only read that carries {@link IntelScript.code}. Works for a
   * built-in too: they are visible to everyone, so this is how you read one
   * before forking it.
   *
   * @throws {OmsApiError} 404 when the id is neither a built-in nor yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelScript> {
    return this.http.get<IntelScript>(`/intel_scripts/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /intel_scripts` - saves a fetcher. `201`, with `code`.
   *
   * The controller transpiles the body in the `intel-runner` sidecar BEFORE
   * saving, so a syntax error surfaces here rather than at the first poll:
   * `400 "Invalid script: <the compiler's message>"`.
   *
   * **The check is best-effort and fails OPEN.** `check_script!` rescues
   * `Intel::RunnerClient::Error` and returns `nil`, so when the runner is down
   * or unreachable the script saves unchecked and a `201` means only "stored".
   * There is nothing on the response that distinguishes a checked save from an
   * unchecked one. Treat a successful create as "it parses, probably", and
   * confirm with {@link IntelSourcesNamespace.run} on a throwaway source.
   *
   * The check is a transpile, not an execution: it proves the code parses, not
   * that it fetches anything.
   *
   * The created script is always yours - `builtin` is not on `create_params`,
   * so it cannot be set - and up to
   * {@link INTEL_SCRIPT_MAX_CODE_BYTES} long.
   *
   * Not retried by default: a replay creates a second script.
   */
  async create(input: CreateIntelScriptInput, options: RequestOptions = {}): Promise<IntelScript> {
    return this.http.post<IntelScript>(
      "/intel_scripts",
      {
        name: input.name,
        code: input.code,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /intel_scripts/:id` - edits one of YOUR scripts. Answers with `code`.
   *
   * Same best-effort transpile check as {@link create}, and only when `code` is
   * present in the body.
   *
   * **A built-in answers `401`, not `403`.** `IntelScript#updatable_by?`
   * requires `!builtin?`, and `CrudActions#update` reports a failed
   * authorisation with `unauthorized!` - so the body is
   * `"You are not authorized to update this resource"` under a 401 status. That
   * is an authorisation refusal wearing an authentication status code: do NOT
   * let a generic 401 handler log the user out over it. Check
   * {@link IntelScript.builtin} first and fork instead of editing.
   *
   * A live edit takes effect on the next poll of every source using this
   * script; there is no versioning and no rollback.
   *
   * @throws {OmsApiError} 404 when the id is not visible to you; 401 for a
   *   built-in; 400 for a syntax error or an over-long body.
   */
  async update(id: Id, input: UpdateIntelScriptInput, options: RequestOptions = {}): Promise<IntelScript> {
    return this.http.patch<IntelScript>(
      `/intel_scripts/${encodeURIComponent(id)}`,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      options,
    );
  }

  /**
   * `DELETE /intel_scripts/:id`. `204`, empty body.
   *
   * Refuses while any source still uses it: `has_many :intel_sources,
   * dependent: :restrict_with_error` turns the destroy into a validation
   * failure, which `CrudActions#destroy` reports as
   * `400 "Cannot delete record because dependent intel sources exist"`. Delete
   * or repoint the sources first - {@link IntelSourcesNamespace.list} with
   * `scriptId` finds them in one call.
   *
   * A built-in answers `401` with `"You are not authorized to destroy this
   * resource"`, for the reason spelled out on {@link update}.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_scripts/${encodeURIComponent(id)}`, options);
  }
}

/**
 * `/intel_items` - the raw material.
 *
 * Read-only plus a delete: `creatable_by?` and `updatable_by?` are hard `false`
 * and the route is `only: [:index, :show, :destroy]`. Items are written by
 * `Intel::FetchSourceJob` and by nothing else.
 *
 * The web frontend never touches this family. It is here because the stories
 * only carry a citation stub ({@link IntelArticleSourceRef}) and this is the
 * only way to read the body behind one.
 */
export class IntelItemsNamespace extends Resource {
  /**
   * `GET /intel_items` - raw items, newest first.
   *
   * **Heavy.** Every row carries {@link IntelItem.content} in full - the whole
   * article text a script scraped - and there is no lighter view. The SDK
   * defaults to a page of 25 for that reason; raising it is how you get a
   * multi-megabyte response.
   *
   * Declared filters: `intel_source_id`, `external_id`, `title`, `content`,
   * `url`, plus the inherited three. Note `processed_at` is NOT among them and
   * is not on the blueprint either, so there is no way to list only the
   * unprocessed items - {@link IntelStats.totals.pending_items} is the only
   * window onto that backlog.
   *
   * The controller sets no ordering; the SDK sends `created_at:desc`.
   */
  async list(params: ListIntelItemsParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelItem>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 25;
    const exactSearch = {
      ...params.exactSearch,
      ...(params.sourceId === undefined ? {} : { intel_source_id: params.sourceId }),
    };

    const load = (at: { page: number; pageSize: number }): Promise<IntelItem[]> =>
      this.http.get<IntelItem[]>("/intel_items", {
        ...options,
        query: listQuery(
          {
            ...params,
            // Explicitly, not by spread order: an `order: undefined` present on
            // the caller's object would otherwise overwrite the default with
            // undefined and leave the listing unordered again.
            order: params.order ?? "created_at:desc",
            ...(Object.keys(exactSearch).length === 0 ? {} : { exactSearch }),
          },
          at.page,
          at.pageSize,
        ),
      });

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `GET /intel_items/:id` - one raw item.
   *
   * The blueprint has no `:extended` extras, so this is the same shape a
   * listing row has. Use it to expand one {@link IntelArticleSourceRef} without
   * pulling a page of bodies.
   *
   * @throws {OmsApiError} 404 when the item is not yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelItem> {
    return this.http.get<IntelItem>(`/intel_items/${encodeURIComponent(id)}`, options);
  }

  /**
   * `DELETE /intel_items/:id`. `204`, empty body.
   *
   * Rarely what you want. The item's `external_id` uniqueness is what stops the
   * next poll re-fetching it, so deleting one invites it straight back on the
   * following run - and if the story built from it survives, you get a second
   * citation of the same thing. Delete the SOURCE, or leave items alone.
   *
   * @throws {OmsApiError} 404 when the item is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_items/${encodeURIComponent(id)}`, options);
  }
}

/**
 * `/intel_config` - the per-user pipeline settings.
 *
 * A Rails SINGULAR resource (`resource :intel_config`), so the path has no id
 * and there is no listing: `GET /intel_config` and `PATCH /intel_config` are
 * the whole surface. Both act on the caller's own row and there is no way to
 * address anybody else's.
 */
export class IntelConfigNamespace extends Resource {
  /**
   * `GET /intel_config` - your settings.
   *
   * **This read WRITES.** The controller calls `IntelConfig.for(Current.user)`,
   * which is `find_or_create_by!`, so a first call inserts the row with the
   * column defaults and returns it. Consequences worth knowing: it is not safe
   * to fire at high frequency (two concurrent first calls race on the unique
   * index and one raises), the response is a `200` even when it just created
   * something, and `created_at` on a "read" can be now.
   *
   * @throws {OmsApiError} 403 `"Intel access is restricted."` outside the
   *   allowlist - checked before the row is created, so a refused caller does
   *   not leave a row behind.
   */
  async get(options: RequestOptions = {}): Promise<IntelConfig> {
    return this.http.get<IntelConfig>("/intel_config", options);
  }

  /**
   * `PATCH /intel_config` - changes settings. Answers with the whole row.
   *
   * A genuine partial update for the scalar fields, and a whole-object replace
   * for `prompts` - see {@link UpdateIntelConfigInput.prompts}.
   *
   * The route also accepts `PUT`, and it means exactly the same thing: Rails
   * maps both onto `update` and the controller does not read the verb. There is
   * no "replace the whole config" call.
   *
   * Failures are a `400` whose body is ONE sentence, not a field map:
   * `ApplicationRecord#error_messages` is `errors.full_messages.to_sentence`,
   * so several violations arrive joined by commas and "and". Parse it for
   * humans, not for code.
   *
   * @throws {OmsApiError} 400 for a threshold outside `0..10`, a `max_sources`
   *   outside `1..500`, or a `prompts` key outside {@link INTEL_PROMPT_KEYS}.
   */
  async update(input: UpdateIntelConfigInput, options: RequestOptions = {}): Promise<IntelConfig> {
    return this.http.patch<IntelConfig>(
      "/intel_config",
      {
        ...(input.rubric === undefined ? {} : { rubric: input.rubric }),
        ...(input.prompts === undefined ? {} : { prompts: input.prompts }),
        ...(input.buildModel === undefined ? {} : { build_model: input.buildModel }),
        ...(input.reportModel === undefined ? {} : { report_model: input.reportModel }),
        ...(input.reportMinImportance === undefined ? {} : { report_min_importance: input.reportMinImportance }),
        ...(input.enrichMinImportance === undefined ? {} : { enrich_min_importance: input.enrichMinImportance }),
        ...(input.webSearch === undefined ? {} : { web_search: input.webSearch }),
        ...(input.maxSources === undefined ? {} : { max_sources: input.maxSources }),
      },
      options,
    );
  }
}

/** `/intel_stats` - the dashboard counters. One route, one verb. */
export class IntelStatsNamespace extends Resource {
  /**
   * `GET /intel_stats` - every counter the intel dashboard shows, in one call.
   *
   * Also a Rails singular resource, so the path is `/intel_stats` with no id
   * despite the plural spelling.
   *
   * **Cost, and the reason not to poll this.** The controller does
   * `articles.pluck(:importance)` - it loads the importance of EVERY story you
   * own into Ruby memory to build {@link IntelStats.by_importance} - and then
   * runs five more aggregate queries beside it. There is no cache, no `ETag`
   * (the hand-written action never calls `stale?`, unlike every list in this
   * file) and therefore no `304`. Cost grows linearly with your story count for
   * ever. Fetch it on a dashboard open, not on a timer.
   *
   * Read {@link IntelStatsTotals.sources} before you label it: it does not
   * count your feeds.
   *
   * @throws {OmsApiError} 403 `"Intel access is restricted."` outside the
   *   allowlist.
   */
  async get(options: RequestOptions = {}): Promise<IntelStats> {
    return this.http.get<IntelStats>("/intel_stats", options);
  }
}

/**
 * Base of the third-party image proxy {@link intelArticleImageUrl} builds on.
 *
 * `wsrv.nl` is a free public image CDN. It is NOT this API and NOT our
 * infrastructure.
 */
export const INTEL_IMAGE_PROXY_BASE_URL = "https://wsrv.nl/";

/** Knobs for {@link intelArticleImageUrl}. The defaults are the web app's. */
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
 * this API resizes it. The web frontend's answer is to route it through
 * `wsrv.nl`, a free public image CDN, which fetches the origin image and hands
 * back a width-limited WebP.
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
 * size it in CSS. This helper exists because the web app cannot drop its own
 * intel service without it, and it is ported here rather than reinvented.
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

/**
 * The `intel` namespace, reachable as `oms.content.intel`.
 *
 * Seven typed families over the backend's own tables, plus {@link proxy} for
 * the untyped passthrough to the old sidecar. The three proxy methods are also
 * mirrored on this class so that code written against 0.3.0's
 * `oms.content.intel.get(path)` keeps working; new code should say
 * `oms.content.intel.proxy.get(path)`, which cannot be confused with
 * {@link IntelArticlesNamespace.get}.
 *
 * A tour of the data model, because the names do not give it away:
 *
 * 1. a {@link IntelScript} knows HOW to fetch one kind of feed;
 * 2. an {@link IntelSource} is that script plus its settings - a feed you
 *    actually follow;
 * 3. polling a source writes {@link IntelItem} rows: raw, unprocessed, one per
 *    thing the feed published;
 * 4. the analysis pipeline groups items into {@link IntelArticle} stories,
 *    scores them against your {@link IntelConfig} rubric, enriches the
 *    important ones and links related ones together;
 * 5. {@link IntelReport} digests summarise a closed time window of stories.
 *
 * Only steps 1 and 2 are yours to write. Everything from step 3 on is produced
 * by background jobs and is read-only over HTTP - a delete is the only mutation
 * you get, and it is a hide, not an undo.
 */
export class IntelNamespace extends Resource {
  /** Stories: the analysed, grouped, scored output. Read plus delete. */
  readonly articles: IntelArticlesNamespace;
  /** Generated digests over closed time windows. Read plus delete. */
  readonly reports: IntelReportsNamespace;
  /** The feeds you follow. Full CRUD, plus a manual run. */
  readonly sources: IntelSourcesNamespace;
  /** The fetchers. Full CRUD over yours; the built-ins are read-only. */
  readonly scripts: IntelScriptsNamespace;
  /** The raw material behind the stories. Read plus delete. */
  readonly items: IntelItemsNamespace;
  /** Your rubric, thresholds and prompt overrides. */
  readonly config: IntelConfigNamespace;
  /** Dashboard counters, in one expensive call. */
  readonly stats: IntelStatsNamespace;
  /**
   * The untyped passthrough to the old intel sidecar.
   *
   * @deprecated See {@link IntelProxyNamespace}. Kept only because the route
   *   still answers; the typed families above are the intel API now.
   */
  readonly proxy: IntelProxyNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.articles = new IntelArticlesNamespace(http);
    this.reports = new IntelReportsNamespace(http);
    this.sources = new IntelSourcesNamespace(http);
    this.scripts = new IntelScriptsNamespace(http);
    this.items = new IntelItemsNamespace(http);
    this.config = new IntelConfigNamespace(http);
    this.stats = new IntelStatsNamespace(http);
    this.proxy = new IntelProxyNamespace(http);
  }

  /**
   * Alias for {@link IntelProxyNamespace.get}. Kept so 0.3.0 call sites still
   * compile; prefer `oms.content.intel.proxy.get(path)`.
   *
   * @deprecated The intel sidecar is being retired: intel now lives entirely
   *   inside Rails. See {@link IntelProxyNamespace}.
   */
  async get<T = unknown>(path: string, query?: QueryParams, options: RequestOptions = {}): Promise<T> {
    return this.proxy.get<T>(path, query, options);
  }

  /**
   * Alias for {@link IntelProxyNamespace.fetch}. Kept so 0.3.0 call sites still
   * compile; prefer `oms.content.intel.proxy.fetch(path)`.
   *
   * @deprecated The intel sidecar is being retired: intel now lives entirely
   *   inside Rails. See {@link IntelProxyNamespace}.
   */
  async fetch(path: string, query?: QueryParams, options: RequestOptions = {}): Promise<FileOutput> {
    return this.proxy.fetch(path, query, options);
  }

  /**
   * Alias for {@link IntelProxyNamespace.url}. Kept so 0.3.0 call sites still
   * compile; prefer `oms.content.intel.proxy.url(path)`.
   *
   * @deprecated The intel sidecar is being retired: intel now lives entirely
   *   inside Rails. See {@link IntelProxyNamespace}.
   */
  url(path: string, query?: QueryParams): string {
    return this.proxy.url(path, query);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The `content` namespace, reachable as `oms.content`.
 *
 * An umbrella over ten unrelated corners of the API. Nothing is shared between
 * them, so mount the sub-namespaces directly if a flatter surface reads better
 * - each one is exported on its own.
 */
export class ContentNamespace extends Resource {
  /** Blogs, blog posts and subscriptions. `.posts` hangs off it. */
  readonly blogs: BlogsNamespace;
  /** The notification inbox. HTTP half only; the cable pushes the rest. */
  readonly notifications: NotificationsNamespace;
  /** The feedback box, and its admin queue. */
  readonly feedbacks: FeedbacksNamespace;
  /** The joke table behind the loading screens. */
  readonly jokes: JokesNamespace;
  /** The public config blob a client reads before it has a credential. */
  readonly config: SiteConfigNamespace;
  /** The status page: live probes and the 90-day uptime report. */
  readonly status: ServicesStatusNamespace;
  /** Per-user "which parts of the site do you open" counters. */
  readonly serviceUsages: ServiceUsagesNamespace;
  /** Two admin storage reports. */
  readonly analysis: AnalysisNamespace;
  /** The Space Invaders leaderboard. */
  readonly spaceInvaders: SpaceInvadersNamespace;
  /**
   * Intel: seven typed families over the backend's own tables, with the
   * untyped sidecar passthrough kept on `.proxy`. See {@link IntelNamespace}.
   */
  readonly intel: IntelNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.blogs = new BlogsNamespace(http);
    this.notifications = new NotificationsNamespace(http);
    this.feedbacks = new FeedbacksNamespace(http);
    this.jokes = new JokesNamespace(http);
    this.config = new SiteConfigNamespace(http);
    this.status = new ServicesStatusNamespace(http);
    this.serviceUsages = new ServiceUsagesNamespace(http);
    this.analysis = new AnalysisNamespace(http);
    this.spaceInvaders = new SpaceInvadersNamespace(http);
    this.intel = new IntelNamespace(http);
  }
}
