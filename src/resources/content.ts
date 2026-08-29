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
 * 9. **The intel routes are a generic proxy, not an API.** The SDK refuses to
 *    invent types for a service whose responses it cannot see. See
 *    {@link IntelProxyNamespace}.
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
 * If you want typed intel data, use the native Rails endpoints instead
 * (`/intel_articles`, `/intel_reports`, `/intel_sources`, `/intel_scripts`,
 * `/intel_stats`, `/intel_config`) - those are real controllers with real
 * blueprints. The web frontend moved onto them and left this proxy behind.
 * They are outside this namespace's scope and are not wrapped here.
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
  /** Read-only passthrough to the intel sidecar. Untyped on purpose. */
  readonly intel: IntelProxyNamespace;

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
    this.intel = new IntelProxyNamespace(http);
  }
}
