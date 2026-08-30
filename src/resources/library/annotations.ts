/** The `library.annotations` namespace, with the inputs and limits only it uses. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams, ListQueryBase } from "../../listing";
import type { Paginated, RequestOptions } from "../../types";
import type { BookAnnotation, BookAnnotationId, BookAnnotationKind, BookAnnotationLocation, BookId } from "./types";
import { idSegment } from "./types";

/** Longest note accepted. */
export const BOOK_ANNOTATION_NOTE_MAX_LENGTH = 5000;

/** Longest selected text accepted. */
export const BOOK_ANNOTATION_SELECTED_TEXT_MAX_LENGTH = 8000;

/** Filter columns of `GET /book_annotations`, on top of {@link BASE_FILTER_COLUMNS}. */
export const BOOK_ANNOTATION_FILTER_COLUMNS = Object.freeze(["book_id", "kind"] as const);

/** Arguments for {@link LibraryAnnotationsNamespace.list}. */
export interface ListBookAnnotationsParams extends ListParams<(typeof BOOK_ANNOTATION_FILTER_COLUMNS)[number]> {
  /** Exact book id. The filter every reader screen uses. */
  readonly bookId?: BookId;
  /** Exact kind, or an array of kinds (which becomes `IN (...)`). */
  readonly kind?: BookAnnotationKind | readonly BookAnnotationKind[];
  /** `"column:asc"` / `"column:desc"`. Defaults to `created_at:asc`. */
  readonly order?: string;
}

/** Arguments for {@link LibraryAnnotationsNamespace.create}. */
export interface CreateBookAnnotationInput {
  readonly bookId: BookId;
  readonly kind: BookAnnotationKind;
  /** Omitted or empty becomes `{}`, which is a valid annotation with no anchor. */
  readonly location?: BookAnnotationLocation;
  readonly color?: string | null;
  readonly note?: string | null;
  readonly selectedText?: string | null;
}

/**
 * Arguments for {@link LibraryAnnotationsNamespace.update}.
 *
 * `kind`, `book_id` and `selected_text` are NOT updatable: only `color`,
 * `note` and `location` are read. Anything else is dropped in silence - a 200
 * with an unchanged row.
 */
export interface UpdateBookAnnotationInput {
  readonly color?: string | null;
  readonly note?: string | null;
  /**
   * Only sent when the key is present, because the server tests for the key
   * rather than for a value. Passing `{}` therefore CLEARS the anchor rather
   * than leaving it alone.
   */
  readonly location?: BookAnnotationLocation;
}

/** The `library.annotations` namespace, reachable as `oms.library.annotations`. */
export class LibraryAnnotationsNamespace extends Resource {
  /**
   * `GET /book_annotations` - the caller's own highlights, notes, bookmarks and
   * progress markers.
   *
   * There is no owner filter and there does not need to be one: a caller can
   * only ever see its own rows - even on a book a thousand people have public
   * access to.
   *
   * Unlike every read in the other two namespaces, this one needs a session,
   * so an anonymous call is a `401`, not an empty list.
   *
   * Ordered by `created_at` ascending by default (the controller adds the
   * `order(:created_at)` itself), which is reading order for a set of
   * highlights. Override it with `order` for a "recently annotated" view.
   *
   * Filtering by `bookId` is the normal call, and it is what opens a reader:
   * one request per book, not one per highlight.
   *
   * @throws {OmsApiError} 400 naming the offending key when a filter is not
   *   one of `book_id`, `kind`, `id`, `created_at`, `updated_at`.
   */
  async list(
    params: ListBookAnnotationsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<BookAnnotation>> {
    const base: ListQueryBase = { exactSearch: { book_id: params.bookId, kind: params.kind } };
    return paginate(params, 100, (at) =>
      this.http.get<BookAnnotation[] | undefined>("/book_annotations", {
        ...options,
        query: listQuery(params, at, base),
      }),
    );
  }

  /**
   * Every annotation on one book, in reading order, following pages until the
   * book is exhausted.
   *
   * A convenience over {@link list} because this is what a reader does on open
   * and because a heavily annotated book genuinely passes 500 rows - the point
   * at which one page stops being enough and a naive caller silently loses the
   * rest.
   *
   * `kinds` narrows to, say, highlights only. It becomes an `IN (...)`.
   */
  async forBook(
    bookId: BookId,
    params: { kinds?: readonly BookAnnotationKind[]; pageSize?: number } = {},
    options: RequestOptions = {},
  ): Promise<BookAnnotation[]> {
    const pageSize = params.pageSize ?? 500;
    const all: BookAnnotation[] = [];
    let cursor: Paginated<BookAnnotation> | null = await this.list(
      {
        bookId,
        ...(params.kinds === undefined ? {} : { kind: params.kinds }),
        pageSize,
        order: "created_at:asc",
      },
      options,
    );
    while (cursor) {
      all.push(...cursor.items);
      cursor = await cursor.next();
    }
    return all;
  }

  /**
   * The reader's "where I left off" marker for one book, or `null` when they
   * have never opened it.
   *
   * There is at most one, because
   * {@link LibraryBooksNamespace.saveProgress} upserts on
   * `(book, user, kind: "progress")`. This reads it back; that writes it.
   */
  async progressFor(bookId: BookId, options: RequestOptions = {}): Promise<BookAnnotation | null> {
    const page = await this.list({ bookId, kind: "progress", pageSize: 1 }, options);
    return page.items[0] ?? null;
  }

  /**
   * "What am I in the middle of?" - the reader's most recently touched progress
   * markers, newest first.
   *
   * One request for the whole continue-reading shelf, which is the point: the
   * alternative is one request per cover. The rows carry `book_id` and nothing
   * about the book, so pair it with
   * {@link LibraryBooksNamespace.list} filtered by `ids` to get the titles in a
   * second request rather than in N.
   *
   * @param limit rows to return. Clamped to 500 by the server like any page.
   */
  async continueReading(limit = 24, options: RequestOptions = {}): Promise<BookAnnotation[]> {
    const page = await this.list(
      { kind: "progress", order: "updated_at:desc", pageSize: limit },
      options,
    );
    return page.items;
  }

  /**
   * `POST /book_annotations` - records a highlight, a note or a bookmark.
   *
   * The author is taken from the session, so `user_id` is not sendable. The
   * book additionally has to be visible to the caller, which is what lets a
   * reader annotate somebody else's public book while keeping the annotation
   * entirely private to them.
   *
   * Do NOT use this for reading progress. It would create a SECOND `progress`
   * row - nothing here de-duplicates by kind - and the reader would then have
   * two conflicting "where I left off" markers with no way to tell which is
   * live. {@link LibraryBooksNamespace.saveProgress} upserts; this does not.
   *
   * Not retried by default: a replay after a lost answer duplicates the
   * highlight.
   *
   * @throws {OmsAuthError} 401 twice over, with different bodies: `"Session
   *   required to access this resource."` when anonymous, and `"You are not
   *   authorized to create this resource"` when the book is not visible to
   *   the caller - a 401 rather than the 404 you might expect.
   * @throws {OmsApiError} 400 for a `kind` outside
   *   {@link BOOK_ANNOTATION_KINDS}, or a note or selection over its length
   *   cap.
   */
  async create(input: CreateBookAnnotationInput, options: RequestOptions = {}): Promise<BookAnnotation> {
    const body: Record<string, unknown> = { book_id: input.bookId, kind: input.kind };
    // Always sent: the server stores `location` unconditionally, so an omitted
    // one is stored as `{}` either way.
    body["location"] = input.location ?? {};
    if (input.color !== undefined) body["color"] = input.color;
    if (input.note !== undefined) body["note"] = input.note;
    if (input.selectedText !== undefined) body["selected_text"] = input.selectedText;
    return this.http.post<BookAnnotation>("/book_annotations", body, options);
  }

  /**
   * `PATCH /book_annotations/:id` - edits the note or the colour of an existing
   * annotation, and optionally moves it.
   *
   * Only `color`, `note` and `location` are writable. `kind`, `book_id` and
   * `selected_text` are dropped in silence - a `200` with an unchanged row,
   * which is the failure mode worth knowing about here. To change a highlight
   * into a note, delete and recreate.
   *
   * `location` is only sent when you pass one, because the server tests for
   * the key: passing `{}` therefore CLEARS the anchor rather than leaving it
   * alone.
   *
   * @throws {OmsAuthError} 401 when the annotation is not yours.
   * @throws {OmsApiError} 404 for an unknown id - and for anyone else's
   *   annotation, since nobody else's are ever visible.
   */
  async update(
    id: BookAnnotationId,
    input: UpdateBookAnnotationInput,
    options: RequestOptions = {},
  ): Promise<BookAnnotation> {
    const body: Record<string, unknown> = {};
    if (input.color !== undefined) body["color"] = input.color;
    if (input.note !== undefined) body["note"] = input.note;
    if (input.location !== undefined) body["location"] = input.location;
    return this.http.patch<BookAnnotation>(`/book_annotations/${idSegment(id)}`, body, options);
  }

  /**
   * `DELETE /book_annotations/:id` - removes one annotation.
   *
   * Deleting a `progress` row is how a reader is put back at the start of a
   * book; there is no other reset.
   *
   * @throws {OmsAuthError} 401 when the annotation is not yours.
   * @throws {OmsApiError} 404 the second time round.
   */
  async delete(id: BookAnnotationId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/book_annotations/${idSegment(id)}`, options);
  }

}
