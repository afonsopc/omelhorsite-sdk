/** Identifiers, enumerations and records shared by every library namespace. */

import type { Id, Timestamp } from "../../types";

/**
 * Primary key of a book. A NUMBER: `books` never moved to the opaque string
 * ids the account-side tables use, even though its `user_id` and its three
 * `*_fs_node_id` columns are strings.
 */
export type BookId = number;

/** Primary key of an annotation. A number. */
export type BookAnnotationId = number;

/** The two file formats the library accepts. */
export const BOOK_FORMATS = ["pdf", "epub"] as const;

/** One of {@link BOOK_FORMATS}. */
export type BookFormat = (typeof BOOK_FORMATS)[number];

/**
 * Visibility of a book or a shelf. The same three levels apply to both.
 *
 * - `private` - owner only.
 * - `unlisted` - anyone holding the link. Reachable by `GET /books/:id`,
 *   absent from every listing. This is the level a "share" button sets.
 * - `public` - anyone, AND listed in the owner's library and in explore.
 */
export const BOOK_VISIBILITIES = ["private", "unlisted", "public"] as const;

/** One of {@link BOOK_VISIBILITIES}. */
export type BookVisibility = (typeof BOOK_VISIBILITIES)[number];

/** Kinds of annotation. */
export const BOOK_ANNOTATION_KINDS = ["highlight", "note", "bookmark", "progress"] as const;

/** One of {@link BOOK_ANNOTATION_KINDS}. */
export type BookAnnotationKind = (typeof BOOK_ANNOTATION_KINDS)[number];

/**
 * A book.
 *
 * `editable` is computed against the ASKING user, which is what lets one
 * listing mix your own books with strangers' public ones and still know which
 * ones offer an edit affordance. It is also the answer for "may I delete
 * this".
 */
export interface Book {
  /** Integer primary key. See {@link BookId}. */
  readonly id: BookId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly title: string;
  readonly author: string | null;
  readonly description: string | null;
  /** Detected at upload from the extension or the content type, never from the caller. */
  readonly format: BookFormat;
  readonly isbn: string | null;
  readonly language: string | null;
  readonly page_count: number | null;
  /** Size of the stored file. `null` only on rows that predate the column. */
  readonly file_size_bytes: number | null;
  /** Always an array, never `null`: the column is `jsonb NOT NULL DEFAULT '[]'`. */
  readonly tags: string[];
  readonly visibility: BookVisibility;
  /** Owner. A string id, next to an integer `id`. */
  readonly user_id: Id;
  /** Storage node of the cover the owner uploaded. A STRING id. */
  readonly cover_fs_node_id: Id | null;
  /** Storage node of the WebP thumbnail the server derived from it. A STRING id. */
  readonly compressed_cover_fs_node_id: Id | null;
  /** True when either cover node is set. Branch on this, not on the two ids. */
  readonly has_cover: boolean;
  readonly owner_handle: string | null;
  readonly owner_name: string | null;
  /** Whether the ASKING user may edit the book. Also answers "may I delete this". */
  readonly editable: boolean;
}

/**
 * One row of the public-library directory: a person, not a book.
 *
 * Unlike every other payload in the namespace it carries no `id`, no
 * `created_at` and no `updated_at`, and the owner is addressed by `handle`.
 * Feed that handle back as {@link ListBooksParams.ownerHandle}.
 */
export interface PublicLibrary {
  readonly handle: string;
  readonly name: string;
  /** What the owner named their library, or `null` if they never did. */
  readonly library_name: string | null;
  readonly library_description: string | null;
  /** PUBLIC books only. An owner's unlisted and private books are not counted. */
  readonly book_count: number;
}

/**
 * Where in the book an annotation sits. Format-specific and opaque to the API:
 * the column is `jsonb NOT NULL DEFAULT '{}'` and nothing server-side reads
 * inside it.
 *
 * The two shapes the readers agree on today:
 * - EPUB: `{ cfiRange }` for a range, `{ cfi }` for a point;
 * - PDF: `{ pageNumber, rects: [{ x, y, w, h }] }`, page-normalised to `[0,1]`
 *   so a highlight survives a zoom.
 *
 * A new reader may write a new shape. Read defensively.
 */
export type BookAnnotationLocation = Record<string, unknown>;

/**
 * A highlight, a note, a bookmark, or a reading-progress marker.
 *
 * ALWAYS PRIVATE to the reader who made it, even on a public book: an
 * anonymous caller sees none, and a signed-in caller sees only their own.
 * There is no sharing of highlights, and `GET /book_annotations` therefore
 * needs no user filter - it can only ever return your own.
 */
export interface BookAnnotation {
  readonly id: BookAnnotationId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly book_id: BookId;
  /** Author. Always the caller, since nobody else's are visible. */
  readonly user_id: Id;
  readonly kind: BookAnnotationKind;
  readonly location: BookAnnotationLocation;
  /** Free-form, usually a CSS colour. Not validated server-side. */
  readonly color: string | null;
  readonly note: string | null;
  /** The passage the reader selected, kept so a highlight can be listed without opening the book. */
  readonly selected_text: string | null;
}

