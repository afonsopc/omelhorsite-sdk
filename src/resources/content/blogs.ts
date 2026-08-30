/** Blogs, blog posts and subscriptions. */

import { type ApiClient, Resource } from "../../http";
import type { Id, RequestOptions, Timestamp } from "../../types";

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
 * Deliberately NOT a `BaseRecord`: the payload has `created_at` and NO
 * `updated_at`. Do not reach for one.
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
 * Like {@link Blog}, this is not a `BaseRecord`: the summary carries neither
 * `created_at` nor `updated_at`. They appear only on {@link BlogPost}, the
 * `:extended` view, which is this shape PLUS extras, never a subset.
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
   * write - but no response exposes it, so the client renders the markdown
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
 * The read routes address a blog by its SLUG, never by its id - the lookup is
 * by lowercased slug and nothing else, so passing the numeric id gets
 * `404 "Blog not found"`. The two subscribe routes are the exception: they try
 * the slug first and then fall back to the id, so they accept either.
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
   * build a public permalink on it: an anonymous reader following a shared
   * link gets `401 "Session required to access this resource."` here, while
   * {@link get} hands them the very same published post. Until that is fixed,
   * render public permalinks through {@link get} with the numeric id, or
   * expect signed-in readers only.
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
