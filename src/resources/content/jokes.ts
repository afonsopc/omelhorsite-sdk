/** The joke table behind the loading screens. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../listing";
import type { Paginated, RequestOptions, Timestamp } from "../../types";

/** `GET /jokes` filters on {@link BASE_FILTER_COLUMNS} only. */
export const JOKE_FILTER_COLUMNS = Object.freeze([] as const);

/** Filters for {@link JokesNamespace.list}. */
export type ListJokesParams = ListParams<(typeof JOKE_FILTER_COLUMNS)[number]>;

/** Primary key of a joke. An INTEGER. */
export type JokeId = number;

/**
 * A joke.
 *
 * Unlike the blog records this one really does carry all three base fields.
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
   * **You cannot filter by language.** The allowlist is only the three
   * defaults - `id`, `created_at`, `updated_at` - and `lang` is not on it.
   * `search: { lang: "pt" }`
   * is `400 "Unknown search filter: lang"`, not a wider result: the DSL fails
   * closed. Pull a page and filter client-side, which is what every caller
   * ends up doing.
   *
   * For "give me a joke", `random: true` with `pageSize: 1` is the whole
   * recipe: the server applies `ORDER BY RANDOM()` and the pagination is
   * applied after it. Note that a random listing carries no `ETag` and can
   * never answer `304`, which is exactly what you want here and exactly what
   * you do not want on a normal page.
   *
   * `modifiers[order]` also accepts a third segment for an explicit value
   * ordering (`"lang:asc:pt,en"` puts those languages first), which the rest
   * of the SDK does not advertise because almost nothing needs it.
   */
  async list(params: ListJokesParams = {}, options: RequestOptions = {}): Promise<Paginated<Joke>> {
    return paginate(params, 100, (at) =>
      this.http.get<Joke[]>("/jokes", { ...options, query: listQuery(params, at) }),
    );
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
