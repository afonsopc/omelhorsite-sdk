/** The `library.shelves` namespace, with the record, inputs and limits only it uses. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams, ListQueryBase } from "../../listing";
import type { Id, Paginated, QueryParams, RequestOptions, Timestamp } from "../../types";
import type { Book, BookId, BookVisibility } from "./types";
import { idSegment } from "../../internal/helpers";

/** Primary key of a shelf. A number, like every id in this file. */
export type BookShelfId = number;

/** Longest shelf name accepted. */
export const BOOK_SHELF_NAME_MAX_LENGTH = 120;

/** Longest shelf description accepted. */
export const BOOK_SHELF_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Most shelves one user may own.
 *
 * Checked on creation only, so the 101st shelf fails with a `400` carrying
 * `"You have reached the maximum of 100 shelves"`; existing shelves keep saving.
 */
export const BOOK_SHELVES_MAX_PER_USER = 100;

/**
 * A shelf: a named, ordered group of one reader's own books.
 *
 * `books` is present ONLY on the `:extended` view, which means
 * {@link LibraryShelvesNamespace.get} and the three arrange calls carry it and
 * {@link LibraryShelvesNamespace.list} does not. That is not an oversight to
 * work around by listing and hoping - it is why `get` exists.
 */
export interface BookShelf {
  readonly id: BookShelfId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: BookVisibility;
  /** The owner's ordering of their own shelves. Ascending. */
  readonly position: number;
  /** Owner. A string id. */
  readonly user_id: Id;
  readonly owner_handle: string | null;
  readonly owner_name: string | null;
  /** Whether the ASKING user may edit the shelf. */
  readonly editable: boolean;
  /**
   * How many of this shelf's books the ASKING user may actually open, which is
   * not how many are on it: a shelf can hold a book its owner later made
   * private again, and counting those would promise a stranger rows they
   * cannot see. So `book_count` can be smaller than `books.length` would be
   * for the owner, and it costs one extra query PER SHELF in a listing.
   */
  readonly book_count: number;
  /**
   * The shelf's books, in `position` order, filtered to what the asking user
   * may see. Present on the `:extended` view only - see the note above.
   */
  readonly books?: Book[];
}

/** Filter columns of `GET /book_shelves`, on top of {@link BASE_FILTER_COLUMNS}. */
export const BOOK_SHELF_FILTER_COLUMNS = Object.freeze(["user_id", "visibility"] as const);

/** Arguments for {@link LibraryShelvesNamespace.list}. */
export interface ListBookShelvesParams extends ListParams<(typeof BOOK_SHELF_FILTER_COLUMNS)[number]> {
  /** Exact owner id. The only way to ask for one person's shelves. */
  readonly userId?: Id;
  /** Exact visibility. */
  readonly visibility?: BookVisibility;
  /** Exact ids. An array becomes `IN (...)`. */
  readonly ids?: readonly BookShelfId[];
  /** `"column:asc"` / `"column:desc"`. Defaults to the endpoint's own ordering. */
  readonly order?: string;
}

/** Arguments for {@link LibraryShelvesNamespace.create}. */
export interface CreateBookShelfInput {
  readonly name: string;
  readonly description?: string | null;
  /** Defaults to `"private"` server-side. */
  readonly visibility?: BookVisibility;
}

/**
 * Arguments for {@link LibraryShelvesNamespace.update}.
 *
 * `position` is writable here and nowhere else: it orders the owner's SHELVES
 * against each other, and has nothing to do with the order of books ON a shelf
 * (that is {@link LibraryShelvesNamespace.reorder}).
 */
export interface UpdateBookShelfInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly visibility?: BookVisibility;
  readonly position?: number;
}

/** The `library.shelves` namespace, reachable as `oms.library.shelves`. */
export class LibraryShelvesNamespace extends Resource {
  /**
   * `GET /book_shelves` - browse shelves.
   *
   * Same two-axis visibility rule as books: every `public` shelf plus, for a
   * signed-in caller, their own whatever their visibility. An `unlisted`
   * shelf opens by its link and appears in no listing.
   *
   * Ordered by `(position, created_at)` unless you override it, so the owner's
   * own arrangement is the default and a paged walk is stable without asking.
   *
   * **The rows here carry no `books`.** `index` renders the default view and
   * only the `:extended` one inlines the association. Every other method in
   * this namespace returns the extended shape; this one does not. Do not build
   * a shelf screen by listing and reading `books` - it is `undefined`.
   *
   * Note also that `book_count` costs one query per shelf (per row, because
   * it depends on who is asking). A 100-shelf page is 100 extra counts. Page
   * it.
   *
   * @throws {OmsApiError} 400 naming the offending key when a filter is not
   *   one of `user_id`, `visibility`, `id`, `created_at`, `updated_at`. There
   *   are no `extra_options` on this endpoint at all, so ANY key in that
   *   bucket is a 400.
   */
  async list(params: ListBookShelvesParams = {}, options: RequestOptions = {}): Promise<Paginated<BookShelf>> {
    const base: ListQueryBase = {
      exactSearch: { user_id: params.userId, visibility: params.visibility, id: params.ids },
    };
    return paginate(params, 100, (at) =>
      this.http.get<BookShelf[] | undefined>("/book_shelves", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /book_shelves/:id` - one shelf, WITH its books.
   *
   * The `:extended` view, so {@link BookShelf.books} is populated here and
   * nowhere in {@link list}. The books are filtered to what the ASKING user may
   * open, in shelf order: a shelf that holds a book its owner later made
   * private again shows that book to the owner and silently omits it for
   * everyone else, which is also why `book_count` and `books.length` can
   * disagree between two viewers of the same shelf.
   *
   * Works anonymously, through the wider visibility scope, which is how an
   * `unlisted` shelf link resolves.
   *
   * @throws {OmsApiError} 404 for an unknown id and for someone else's private
   *   shelf, indistinguishably.
   */
  async get(id: BookShelfId, options: RequestOptions = {}): Promise<BookShelf> {
    return this.http.get<BookShelf>(`/book_shelves/${idSegment(id)}`, options);
  }

  /**
   * `POST /book_shelves` - creates an empty shelf owned by the caller.
   *
   * The owner is taken from the session and cannot be sent. Visibility
   * defaults to `private`.
   *
   * Not retried by default, like every create: a replay after a lost answer
   * makes a second identical shelf, and shelves are capped per user.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   * @throws {OmsApiError} 400 `"You have reached the maximum of 100 shelves"`
   *   at {@link BOOK_SHELVES_MAX_PER_USER}, or the model's validation messages
   *   for a missing or over-long name.
   */
  async create(input: CreateBookShelfInput, options: RequestOptions = {}): Promise<BookShelf> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.description !== undefined) body["description"] = input.description;
    if (input.visibility !== undefined) body["visibility"] = input.visibility;
    return this.http.post<BookShelf>("/book_shelves", body, options);
  }

  /**
   * `PATCH /book_shelves/:id` - renames, re-describes, re-shares, or moves the
   * shelf among the owner's other shelves.
   *
   * {@link UpdateBookShelfInput.position} orders SHELVES, not the books on one.
   * Nothing renumbers the others, so two shelves can share a position and the
   * `(position, created_at)` sort then decides between them by age.
   *
   * @throws {OmsAuthError} 401 when the shelf is not yours.
   * @throws {OmsApiError} 404 for an unknown id or someone else's private
   *   shelf; 400 with the model's validation messages.
   */
  async update(id: BookShelfId, input: UpdateBookShelfInput, options: RequestOptions = {}): Promise<BookShelf> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body["name"] = input.name;
    if (input.description !== undefined) body["description"] = input.description;
    if (input.visibility !== undefined) body["visibility"] = input.visibility;
    if (input.position !== undefined) body["position"] = input.position;
    return this.http.patch<BookShelf>(`/book_shelves/${idSegment(id)}`, body, options);
  }

  /**
   * `DELETE /book_shelves/:id` - removes the shelf.
   *
   * The BOOKS SURVIVE. Only the `book_shelf_items` join rows are destroyed, so
   * this un-files the books rather than deleting them - the opposite of
   * {@link LibraryBooksNamespace.delete}, and worth saying in the confirmation
   * dialog.
   *
   * @throws {OmsAuthError} 401 when the shelf is not yours.
   * @throws {OmsApiError} 404 the second time round.
   */
  async delete(id: BookShelfId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/book_shelves/${idSegment(id)}`, options);
  }

  /**
   * `POST /book_shelves/:id/add_book` - puts one of YOUR books on the shelf.
   *
   * IDEMPOTENT: adding a book that is already there is a no-op with a `200`,
   * not a duplicate and not a 422. Position is assigned automatically at the
   * end of the shelf.
   *
   * The book must be the shelf owner's own: somebody else's book - public or
   * not - is a `404 "Book not found"` rather than a permission error, and a
   * shelf can never hold a book whose owner might later make it private and
   * leak it through the shelf's visibility.
   *
   * Answers the whole shelf in its `:extended` view, so the response already
   * contains the new arrangement and there is no need to re-fetch.
   *
   * @throws {OmsApiError} 404 `"Shelf not found"` for an unknown shelf,
   *   `"Book not found"` for a book that is not yours; 403 `"Not your shelf"`
   *   for someone else's shelf - note this action answers **403** where
   *   {@link update} answers 401 for the same offence.
   * @throws {OmsApiError} 422 with the item's validation messages, which in
   *   practice only fires if the ownership check is ever relaxed.
   */
  async addBook(id: BookShelfId, bookId: BookId, options: RequestOptions = {}): Promise<BookShelf> {
    return this.http.post<BookShelf>(`/book_shelves/${idSegment(id)}/add_book`, { book_id: bookId }, options);
  }

  /**
   * `DELETE /book_shelves/:id/remove_book` - takes a book off the shelf.
   *
   * The book itself is untouched; only the join row goes.
   *
   * IDEMPOTENT to the point of being silent: removing a book that was never
   * on the shelf answers `200` with the unchanged shelf. There is no way to
   * tell the two
   * apart from the response - compare `book_count` yourself if you need to.
   *
   * The book id travels as a QUERY PARAMETER rather than in a body. The server
   * reads it from either, and a `DELETE` with a body is the shape
   * that intermediaries are least reliable about forwarding; the transport
   * also has no body slot on `delete`. Nothing here is a filter bucket, so the
   * unknown-key guard does not apply.
   *
   * @throws {OmsApiError} 404 `"Shelf not found"`; 403 `"Not your shelf"`.
   */
  async removeBook(id: BookShelfId, bookId: BookId, options: RequestOptions = {}): Promise<BookShelf> {
    return this.http.delete<BookShelf>(`/book_shelves/${idSegment(id)}/remove_book`, {
      ...options,
      query: { ...(options as { query?: QueryParams }).query, book_id: bookId },
    });
  }

  /**
   * `POST /book_shelves/:id/reorder` - sets the order of the books on a shelf.
   *
   * SEND THE COMPLETE LIST, in the order you want, every time. The action
   * writes `position = index + 1` for each id it was given and touches nothing
   * else, so a partial list leaves the omitted books on their OLD positions -
   * which now collide with the new ones, and the shelf comes back interleaved
   * in an order nobody chose. There is no error: it is a `200` and a shelf that
   * looks shuffled.
   *
   * Ids that are not on this shelf are ignored in silence, and so are ids of
   * books that do not exist. So this cannot
   * be used to add a book - use {@link addBook} first, then reorder.
   *
   * The whole thing runs in one transaction, so a shelf is never left half
   * renumbered.
   *
   * @throws {TypeError} before any request for an empty list, which the server
   *   would answer `400 "No order given"`.
   * @throws {OmsApiError} 404 `"Shelf not found"`; 403 `"Not your shelf"`.
   */
  async reorder(id: BookShelfId, bookIds: readonly BookId[], options: RequestOptions = {}): Promise<BookShelf> {
    if (bookIds.length === 0) {
      throw new TypeError(
        "reorder needs the complete list of book ids in their new order. An empty list is a 400 server-side, and a " +
          "PARTIAL list is worse than an error: the books you left out keep their old positions and collide with the new ones.",
      );
    }
    return this.http.post<BookShelf>(
      `/book_shelves/${idSegment(id)}/reorder`,
      { book_ids: [...bookIds] },
      options,
    );
  }

}
