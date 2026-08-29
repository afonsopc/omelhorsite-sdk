/**
 * The `library` namespace: the virtual library - books, shelves, private
 * annotations, the public-library directory, and the streaming study assistant.
 *
 * Four endpoint families and one streaming route live here because they are one
 * product: a reader uploads a PDF or an EPUB, arranges books onto shelves,
 * highlights and annotates as they read, and asks an assistant about the
 * passage in front of them. They are exposed as one entry class with four
 * sub-namespaces ({@link LibraryNamespace.books}, `.shelves`, `.annotations`,
 * `.chat`), and every sub-namespace is also exported on its own so a host that
 * prefers `oms.books` can mount it there instead.
 *
 * ## Six things that have already cost bugs
 *
 * 1. **Every id here is an INTEGER.** `books`, `book_shelves`,
 *    `book_shelf_items` and `book_annotations` all kept auto-increment primary
 *    keys, so they arrive as JSON numbers - while the `user_id` and the
 *    `*_fs_node_id` columns right next to them are STRINGS. Do not widen
 *    {@link BookId} to `Id`.
 * 2. **`private` / `unlisted` / `public` is a two-axis rule, not three levels.**
 *    `unlisted` means "reachable by whoever has the link, listed nowhere": it
 *    is returned by `GET /books/:id` and it is deliberately absent from
 *    `GET /books`. A client that builds its library screen from the listing and
 *    then wonders where an unlisted book went is reading the design correctly.
 * 3. **Visibility cannot be set at creation.** `POST /books` does not read the
 *    field at all (`BookServices::Creator` never looks at it) and the column
 *    defaults to `private`. Sharing is always a second call. See
 *    {@link LibraryBooksNamespace.create}.
 * 4. **The 100 MB upload ceiling is enforced twice, and the outer one wins.**
 *    Rails refuses a book over {@link BOOK_MAX_FILE_BYTES} with a `413` that
 *    says so; production sits behind Cloudflare, which refuses a request body
 *    over its own ~100 MB with a `413` of its own, before Rails is reached and
 *    without a word about books. See {@link LibraryBooksNamespace.create}.
 * 5. **`GET /books/:id/cover` and `/download` answer `302` into object
 *    storage.** Following that redirect from a browser with a credential
 *    attached is rejected by CORS - the same failure `account.picture`
 *    documents. `/file` does NOT redirect: it is served by Rails, supports HTTP
 *    Range, and is the one to fetch bytes from.
 * 6. **The chat answers `200` and can still fail.** The status is written
 *    before the model has produced a token, so a failure mid-generation arrives
 *    as an SSE `error` frame inside a successful response. See
 *    {@link BookChatNamespace.stream} and {@link BookChatError}.
 *
 * ## Rate ceilings that apply here and nowhere else
 *
 * - `POST /books/:id/chat`: **15 per minute**, keyed on the `Authorization`
 *   header or, with none, on the client IP (see {@link BOOK_CHAT_RATE_LIMIT_PER_MINUTE}).
 * - `GET /books/:id/file` and `/download`, **anonymous callers only**: **120
 *   per hour per IP** (see {@link ANONYMOUS_BOOK_FILE_RATE_LIMIT_PER_HOUR}).
 *   A signed-in owner is not limited by it.
 * - `GET /books/:id/file` is additionally EXEMPT from the general
 *   authenticated ceiling of 600/min, because a Range-reading PDF viewer
 *   legitimately makes dozens of requests to open one book.
 *
 * Everything else in this namespace sits under the general ceiling: 600/min
 * authenticated, 120/min per IP anonymous.
 *
 * ## No OAuth token reaches ANY of this
 *
 * None of the four controllers declares an `oauth_scope`, and `enforce_oauth_scope!`
 * denies by omission - so every endpoint here answers `403` to a Doorkeeper
 * access token, INCLUDING the ones that are otherwise open to the public.
 * That last part is the trap: `GET /books` works for a caller with no
 * credential at all and fails for the same caller once it attaches an OAuth
 * token, because the scope filter runs even where `allow_unauthenticated_access`
 * took the auth filter off. A session (cookie or bearer session token) is the
 * only credential this namespace accepts. An OAuth-backed integration that
 * wants public books has to send nothing.
 */

import { OmsApiError, OmsError } from "../errors";
import type { FormFields } from "../http";
import { NULL_SENTINEL, Resource, buildFormData, pageModifier, readJson, supportsResponseStreaming } from "../http";
import type {
  FileInput,
  FileOutput,
  Id,
  NativeFile,
  PageParams,
  Paginated,
  QueryParams,
  QueryValue,
  RequestOptions,
  Timestamp,
} from "../types";
import { createPage } from "../types";

// ---------------------------------------------------------------------------
// Identifiers and enumerations

/**
 * Primary key of a book. A NUMBER: `books` never moved to the opaque string
 * ids the account-side tables use, even though its `user_id` and its three
 * `*_fs_node_id` columns are strings.
 */
export type BookId = number;

/** Primary key of a shelf. A number, like every id in this file. */
export type BookShelfId = number;

/** Primary key of an annotation. A number. */
export type BookAnnotationId = number;

/** The two file formats the library accepts. Mirrors `Book::FORMATS`. */
export const BOOK_FORMATS = ["pdf", "epub"] as const;

/** One of {@link BOOK_FORMATS}. */
export type BookFormat = (typeof BOOK_FORMATS)[number];

/**
 * Visibility of a book or a shelf. Mirrors `Book::VISIBILITIES`, which
 * `BookShelf::VISIBILITIES` aliases, so the two can never drift apart.
 *
 * - `private` - owner only.
 * - `unlisted` - anyone holding the link. Reachable by `GET /books/:id`,
 *   absent from every listing. This is the level a "share" button sets.
 * - `public` - anyone, AND listed in the owner's library and in explore.
 */
export const BOOK_VISIBILITIES = ["private", "unlisted", "public"] as const;

/** One of {@link BOOK_VISIBILITIES}. */
export type BookVisibility = (typeof BOOK_VISIBILITIES)[number];

/** Kinds of annotation. Mirrors `BookAnnotation::KINDS`. */
export const BOOK_ANNOTATION_KINDS = ["highlight", "note", "bookmark", "progress"] as const;

/** One of {@link BOOK_ANNOTATION_KINDS}. */
export type BookAnnotationKind = (typeof BOOK_ANNOTATION_KINDS)[number];

// ---------------------------------------------------------------------------
// Server-side limits, mirrored so a caller can fail before spending a request

/**
 * Ceiling `POST /books` enforces on the uploaded file: 100 MiB
 * (`BooksController::MAX_FILE_BYTES`, `100.megabytes`).
 *
 * NOT the ceiling you will actually hit in production. See
 * {@link BOOK_UPLOAD_EDGE_LIMIT_BYTES} and {@link LibraryBooksNamespace.create}.
 */
export const BOOK_MAX_FILE_BYTES = 104_857_600;

/**
 * The ceiling that bites first: roughly 100 MB of request body, refused by
 * Cloudflare before the origin is reached.
 *
 * Deliberately a decimal 100 MB against Rails' binary 100 MiB. The gap is real
 * and it is exactly the band where the failure stops making sense: a 102 MB
 * book is inside the limit Rails would allow and outside the one the edge
 * allows, so it fails with a `413` whose body is Cloudflare's HTML error page
 * and mentions neither books nor a size. There is no chunked upload route for
 * books - `POST /books` is a single multipart request - so this ceiling is
 * real and cannot be worked around by splitting the file.
 */
export const BOOK_UPLOAD_EDGE_LIMIT_BYTES = 100_000_000;

/** Mirrors `Book::TITLE_MAX_LENGTH`. Longer titles fail validation with a 400. */
export const BOOK_TITLE_MAX_LENGTH = 300;

/** Mirrors `Book::AUTHOR_MAX_LENGTH`. */
export const BOOK_AUTHOR_MAX_LENGTH = 200;

/**
 * Most tags a book keeps. Mirrors `Book::MAX_TAGS`.
 *
 * The server does NOT reject a longer list: `normalize_tags` strips, downcases,
 * de-duplicates and then takes the first 30 in silence. Send more and the
 * excess is gone with no error to notice.
 */
export const BOOK_MAX_TAGS = 30;

/** Mirrors `Book::TAG_MAX_LENGTH`. Longer tags are TRUNCATED, not rejected. */
export const BOOK_TAG_MAX_LENGTH = 40;

/** Mirrors `BookShelf::NAME_MAX_LENGTH`. */
export const BOOK_SHELF_NAME_MAX_LENGTH = 120;

/** Mirrors `BookShelf::DESCRIPTION_MAX_LENGTH`. */
export const BOOK_SHELF_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Most shelves one user may own. Mirrors `BookShelf::MAX_PER_USER`.
 *
 * Validated `on: :create` only, so the 101st shelf fails with a `400` carrying
 * `"You have reached the maximum of 100 shelves"`; existing shelves keep saving.
 */
export const BOOK_SHELVES_MAX_PER_USER = 100;

/** Mirrors `BookAnnotation::NOTE_MAX_LENGTH`. */
export const BOOK_ANNOTATION_NOTE_MAX_LENGTH = 5000;

/** Mirrors `BookAnnotation::SELECTED_TEXT_MAX_LENGTH`. */
export const BOOK_ANNOTATION_SELECTED_TEXT_MAX_LENGTH = 8000;

/**
 * Requests per minute allowed against `POST /books/:id/chat`.
 *
 * Keyed on the `Authorization` header when there is one, and on the client IP
 * when there is not - so a cookie-authenticated web client shares one budget
 * with every other visitor behind the same address. Over it: `429`.
 */
export const BOOK_CHAT_RATE_LIMIT_PER_MINUTE = 15;

/**
 * Largest chat request body Rails agrees to parse:
 * `BookChatsController::MAX_BODY_BYTES`, 512 KiB. Over it, `413`.
 *
 * This is a bound on what is PARSED, not on what reaches the model - the model
 * caps below are applied afterwards, inside `Ai::BookTutor`.
 */
export const BOOK_CHAT_MAX_BODY_BYTES = 524_288;

/**
 * Characters of {@link BookChatContext.text} the assistant will read. Mirrors
 * `Ai::BookTutor::MAX_CONTEXT_CHARS`.
 *
 * Silently truncated server-side, not refused. Sending a whole chapter costs
 * the bytes and buys nothing past this point.
 */
export const BOOK_CHAT_MAX_CONTEXT_CHARS = 12_000;

/** Turns of history the assistant reads, newest kept. Mirrors `MAX_HISTORY_MESSAGES`. */
export const BOOK_CHAT_MAX_HISTORY_MESSAGES = 12;

/** Characters kept per history turn. Mirrors `MAX_MESSAGE_CHARS`. */
export const BOOK_CHAT_MAX_MESSAGE_CHARS = 4_000;

/** Characters kept across the whole history. Mirrors `MAX_HISTORY_CHARS`. */
export const BOOK_CHAT_MAX_HISTORY_CHARS = 8_000;

/**
 * Book-file reads an ANONYMOUS caller gets per hour, per IP, across
 * `GET /books/:id/file` and `GET /books/:id/download` together.
 *
 * A signed-in caller is exempt: the guard carries `if: -> { Current.user.nil? }`.
 * It exists because an anonymous visitor pulling book bytes is the one
 * expensive thing sharing a book opens up.
 */
export const ANONYMOUS_BOOK_FILE_RATE_LIMIT_PER_HOUR = 120;

// ---------------------------------------------------------------------------
// Records

/**
 * A book.
 *
 * `editable` is computed against the ASKING user, which is what lets one
 * listing mix your own books with strangers' public ones and still know which
 * ones offer an edit affordance. It is `updatable_by?`, so it is also the
 * answer for "may I delete this".
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
  /** `updatable_by?` for the ASKING user. Also answers "may I delete this". */
  readonly editable: boolean;
}

/**
 * One row of the public-library directory: a person, not a book.
 *
 * This is the only payload in the namespace that is NOT a Blueprinter record -
 * `BooksController#libraries` builds the hashes by hand - so it carries no
 * `id`, no `created_at` and no `updated_at`, and the owner is addressed by
 * `handle`. Feed that handle back as {@link ListBooksParams.ownerHandle}.
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
  /** `updatable_by?` for the ASKING user. */
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
 * ALWAYS PRIVATE to the reader who made it, even on a public book:
 * `BookAnnotation.viewable_by` is `none` for an anonymous caller and
 * `where(user_id: user.id)` otherwise. There is no sharing of highlights, and
 * `GET /book_annotations` therefore needs no user filter - it can only ever
 * return your own.
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

// ---------------------------------------------------------------------------
// Chat payloads

/** One turn of the conversation, as the client remembers it. */
export interface BookChatTurn {
  /**
   * Only `"user"` and `"assistant"` reach the model: `Ai::BookTutor::ALLOWED_ROLES`
   * drops everything else, precisely so a client cannot inject a `"system"`
   * turn into our own framing.
   */
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * The passage the question is about. The CLIENT decides what that is - the
 * current selection, the chapter on screen, or whatever its search index
 * retrieved - and the server only frames it.
 */
export interface BookChatContext {
  readonly kind: "selection" | "chapter" | "passages";
  /** Chapter or section title, for the framing line. Truncated to 200 chars. */
  readonly title?: string;
  /** Truncated to {@link BOOK_CHAT_MAX_CONTEXT_CHARS} server-side, in silence. */
  readonly text: string;
}

/** Arguments for {@link BookChatNamespace.stream} and {@link BookChatNamespace.ask}. */
export interface BookChatInput {
  /**
   * The whole conversation, oldest first, INCLUDING the question being asked.
   * There is no server-side session: what you do not send did not happen.
   */
  readonly messages: readonly BookChatTurn[];
  /** The passage in front of the reader. Omit it and the assistant is told so. */
  readonly context?: BookChatContext | null;
}

/**
 * One decoded SSE frame from the chat stream.
 *
 * Exactly one field is set per frame. `delta` carries text to append, `done`
 * marks a complete answer, and `error` is a failure that happened AFTER the
 * `200` was written.
 */
export interface BookChatEvent {
  readonly delta?: string;
  readonly done?: boolean;
  readonly error?: string;
}

/** Why a chat stream failed. See {@link BookChatError}. */
export type BookChatFailureReason =
  /** The server wrote an `error` frame: generation failed after the 200. */
  | "assistant_unavailable"
  /** The stream ended without a `done` frame, so the answer is cut short. */
  | "truncated";

/**
 * The chat stream failed AFTER the response status was written.
 *
 * This is not an {@link OmsApiError}, and that is the whole point of it
 * existing. `BookChatsController` writes `200` and the SSE headers before the
 * model has produced a single token, so anything that goes wrong from then on -
 * the inference sidecar erroring, the proxy dropping a stream that went quiet -
 * arrives INSIDE a successful response. Code that decides success by status
 * alone reports a truncated answer, or an empty one, as a complete reply.
 *
 * `code` is `"server_error"`, so `error.retryable` is `true`: asking again is
 * the right move for both reasons, subject to
 * {@link BOOK_CHAT_RATE_LIMIT_PER_MINUTE}.
 */
export class BookChatError extends OmsError {
  static override readonly errorName: string = "BookChatError";

  /** Which of the two post-200 failures this is. */
  readonly reason: BookChatFailureReason;
  /** Text already yielded before the failure. Usually worth showing, marked as incomplete. */
  readonly partial: string;

  constructor(message: string, reason: BookChatFailureReason, partial: string, url?: string) {
    super(message, "server_error", { method: "POST", ...(url === undefined ? {} : { url }), attempts: 1 });
    this.reason = reason;
    this.partial = partial;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), reason: this.reason, partialLength: this.partial.length };
  }
}

/**
 * True when this error is the assistant refusing because every generation slot
 * is taken.
 *
 * `Ai::StreamSlots.acquire` fails closed rather than queueing - a caller parked
 * waiting for a slot is holding the very Puma thread the slots exist to protect
 * - so the answer is `503` with `"The assistant is busy, try again in a moment"`.
 * It is transient and it is NOT a rate limit: the caller did nothing wrong and
 * `Retry-After` is not sent, so back off on your own and try again.
 */
export function isBookChatBusy(error: unknown): boolean {
  return error instanceof OmsApiError && error.status === 503;
}

/**
 * Whether {@link BookChatNamespace.stream} will deliver this answer in pieces
 * on THIS runtime.
 *
 * `true` in a browser and in Bun, `false` in React Native, whose `fetch` hands
 * the whole body over at the end and has no `ReadableStream` at all. Both
 * paths reach the same endpoint and produce the same final text; only the
 * arrival differs, and this is the question to ask before a UI promises a
 * typing indicator. A typing indicator that never types is worse than a
 * spinner that admits it is waiting.
 *
 * Read it at the point of use, never cached at module load: a host may install
 * a polyfill after the SDK is imported.
 */
export function bookChatIsIncremental(): boolean {
  return supportsResponseStreaming();
}

// ---------------------------------------------------------------------------
// Inputs

/** Filters `GET /books` accepts. Anything else is a `400` naming the key. */
export interface BookFilters {
  /** Partial, accent-insensitive match on the title (`search[title]`). */
  readonly title?: string;
  /** Partial, accent-insensitive match on the author (`search[author]`). */
  readonly author?: string;
  /** Exact match. Use it to split a shelf into PDFs and EPUBs. */
  readonly format?: BookFormat;
  /** Exact owner id. For a handle, use {@link ListBooksParams.ownerHandle}. */
  readonly userId?: Id;
  /** Exact ids. An array becomes `IN (...)`. */
  readonly ids?: readonly BookId[];
  /** Escape hatch: extra `search[...]` keys. Unknown keys are a 400. */
  readonly search?: Record<string, QueryValue>;
  /** Escape hatch: extra `exact_search[...]` keys. Unknown keys are a 400. */
  readonly exactSearch?: Record<string, QueryValue>;
}

/** Arguments for {@link LibraryBooksNamespace.list}. */
export interface ListBooksParams extends BookFilters, PageParams {
  /**
   * `"mine"` narrows to the caller's own books, `"explore"` to everybody
   * else's. Omitted, the listing is own + all public, mixed together.
   *
   * `"explore"` is a no-op for an anonymous caller (there is no "else" to
   * exclude), which is correct rather than a bug: an anonymous listing is
   * already nothing but other people's public books.
   */
  readonly scope?: "mine" | "explore";
  /**
   * Narrow to one owner by handle, matched case-insensitively.
   *
   * An unknown handle returns an EMPTY list, not a 404 - `apply_owner` falls
   * back to `.none`. Do not read empty as "this person has no public books".
   *
   * Sending both this and `scope: "explore"` is contradictory when the handle
   * is your own; the frontend drops the scope whenever a handle is given, and
   * so does {@link LibraryBooksNamespace.explore}.
   */
  readonly ownerHandle?: string;
  /**
   * Books carrying ALL of these tags (a `jsonb @>` containment test, so it is
   * AND, never OR). Stripped and downcased before matching, exactly as tags
   * are stored.
   */
  readonly tags?: readonly string[];
  /** `"column:asc"` / `"column:desc"`. See {@link LibraryBooksNamespace.list}. */
  readonly order?: string;
  /** Random ordering. Disables the `ETag`, and is not stable across pages. */
  readonly random?: boolean;
}

/** Arguments for {@link LibraryBooksNamespace.create}. */
export interface CreateBookInput {
  /**
   * The book. Required, and the ONLY thing that decides the format: the server
   * reads the extension, falls back to the content type, and refuses anything
   * that is not a PDF or an EPUB.
   *
   * On React Native pass the picker's `{ uri, name, type }` object directly -
   * it is appended verbatim and streamed off disk by the native layer. Make
   * sure `name` carries the real extension, because a `uri` alone does not.
   */
  readonly file: FileInput | NativeFile;
  /** Optional cover image. Re-encoded to a WebP thumbnail server-side. */
  readonly cover?: FileInput | NativeFile;
  /**
   * Defaults to the FILENAME without its extension when omitted or blank.
   * That is a real fallback, not an error path, so an untitled upload gets
   * `"war-and-peace"` rather than being rejected.
   */
  readonly title?: string;
  readonly author?: string;
  readonly description?: string;
  readonly isbn?: string;
  readonly language?: string;
  /** Coerced with `to_i` server-side, so `"abc"` becomes `0`, not an error. */
  readonly pageCount?: number;
  /** Stripped, downcased, de-duplicated, truncated, and cut to the first 30. */
  readonly tags?: readonly string[];
}

/**
 * Arguments for {@link LibraryBooksNamespace.update}.
 *
 * `null` CLEARS a column. It works in both encodings: as JSON it is a literal
 * `null`, and as multipart it is written as the backend's `\b` sentinel, which
 * `CrudActions` decodes back to `nil` for update params exactly as it does for
 * filters. `undefined` leaves the column alone.
 */
export interface UpdateBookInput {
  readonly title?: string;
  readonly author?: string | null;
  readonly description?: string | null;
  readonly isbn?: string | null;
  readonly language?: string | null;
  readonly pageCount?: number | null;
  /** The one field that decides who can see the book. Not settable at create. */
  readonly visibility?: BookVisibility;
  /** Replaces the whole list. There is no add or remove. */
  readonly tags?: readonly string[];
  /**
   * Replaces the cover. Its presence is what forces the request to multipart;
   * every other field goes as JSON.
   *
   * There is no way to REMOVE a cover through this endpoint: `params[:cover]`
   * is only read when present, and `cover: null` clears nothing.
   */
  readonly cover?: FileInput | NativeFile;
}

/** Arguments for {@link LibraryShelvesNamespace.list}. */
export interface ListBookShelvesParams extends PageParams {
  /** Exact owner id. The only way to ask for one person's shelves. */
  readonly userId?: Id;
  /** Exact visibility. */
  readonly visibility?: BookVisibility;
  /** Exact ids. An array becomes `IN (...)`. */
  readonly ids?: readonly BookShelfId[];
  /** `"column:asc"` / `"column:desc"`. Defaults to the endpoint's own ordering. */
  readonly order?: string;
  /** Escape hatch: extra `search[...]` keys. Unknown keys are a 400. */
  readonly search?: Record<string, QueryValue>;
  /** Escape hatch: extra `exact_search[...]` keys. Unknown keys are a 400. */
  readonly exactSearch?: Record<string, QueryValue>;
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

/** Arguments for {@link LibraryAnnotationsNamespace.list}. */
export interface ListBookAnnotationsParams extends PageParams {
  /** Exact book id. The filter every reader screen uses. */
  readonly bookId?: BookId;
  /** Exact kind, or an array of kinds (which becomes `IN (...)`). */
  readonly kind?: BookAnnotationKind | readonly BookAnnotationKind[];
  /** `"column:asc"` / `"column:desc"`. Defaults to `created_at:asc`. */
  readonly order?: string;
  /** Escape hatch: extra `search[...]` keys. Unknown keys are a 400. */
  readonly search?: Record<string, QueryValue>;
  /** Escape hatch: extra `exact_search[...]` keys. Unknown keys are a 400. */
  readonly exactSearch?: Record<string, QueryValue>;
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
 * `kind`, `book_id` and `selected_text` are NOT updatable: `update_params` on
 * the controller lists `color` and `note` only, and `location` is spliced in by
 * hand. Anything else is dropped in silence by `permit` - a 200 with an
 * unchanged row.
 */
export interface UpdateBookAnnotationInput {
  readonly color?: string | null;
  readonly note?: string | null;
  /**
   * Only sent when the key is present, because the controller tests
   * `params.key?(:location)` rather than presence. Passing `{}` therefore
   * CLEARS the anchor rather than leaving it alone.
   */
  readonly location?: BookAnnotationLocation;
}

/** A byte range of a book file, as {@link LibraryBooksNamespace.fileRange} returns it. */
export interface BookFileRange {
  /** The bytes. */
  readonly data: ArrayBuffer;
  /** First byte offset, inclusive, as the server reported it. */
  readonly start: number;
  /** Last byte offset, INCLUSIVE. HTTP ranges are closed at both ends. */
  readonly end: number;
  /** Total size of the file, from the `Content-Range` header. */
  readonly total: number;
  /** Pinned to the book's format server-side, never sniffed from the bytes. */
  readonly contentType: string;
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Byte length of an upload when the caller already knows it, `undefined` when
 * they do not.
 *
 * A `Blob` always knows; a picked {@link NativeFile} usually reports one; a
 * `Uint8Array` has a `byteLength`; a `ReadableStream` knows nothing and is
 * left alone rather than buffered, because buffering a 90 MB book into memory
 * to check a limit is worse than sending it and being told.
 */
function knownByteSize(input: FileInput | NativeFile): number | undefined {
  if (typeof input === "object" && input !== null && "size" in input && typeof input.size === "number") {
    return input.size;
  }
  const data = (input as FileInput).data;
  if (data && typeof (data as Blob).size === "number") return (data as Blob).size;
  if (data && typeof (data as Uint8Array).byteLength === "number") return (data as Uint8Array).byteLength;
  return undefined;
}

/** Path-safe form of an integer id. Ids here are numbers, but never trust that at a boundary. */
function idSegment(id: number): string {
  return encodeURIComponent(String(id));
}

/**
 * Parses `Content-Range: bytes 0-1023/98765`.
 *
 * Returns `undefined` for anything that is not that exact shape, including the
 * unsatisfiable form Rails answers a 416 with, which puts a star where the
 * range would be. So a caller never reads a `start` the server did not state.
 */
function parseContentRange(header: string | null): { start: number; end: number; total: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(header.trim());
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// Books

/** The `library.books` namespace, reachable as `oms.library.books`. */
export class LibraryBooksNamespace extends Resource {
  /**
   * `GET /books` - browse the library.
   *
   * WORKS ANONYMOUSLY, and what it returns depends on who is asking:
   * `Book.listable_by` is every `public` book plus, for a signed-in caller,
   * their own books whatever their visibility. `unlisted` books are absent by
   * construction - that is what unlisted means - so a reader's own unlisted
   * book DOES appear here (it is theirs) while somebody else's never will.
   *
   * Pagination is FORCED: `CrudActions#index_modifiers_params` gives a request
   * with no page modifier `1:500`, and `QueryModifier` clamps any larger size
   * back to 500. That is a DoS guard - an unbounded listing holds a Puma
   * thread and a database connection for as long as the serialisation takes.
   * The SDK always sends a page modifier, so {@link Paginated.pageSize} always
   * reports the size the rows were counted against.
   *
   * Order defaults to whatever Postgres returns, which is NOT stable across
   * pages. Pass an explicit `order` for any paged walk; `"created_at:desc"` is
   * what every library screen uses. An unknown column in `order` is IGNORED in
   * silence (`QueryModifier` checks `column_names` and returns), so a typo
   * costs you the ordering and no error.
   *
   * The response carries an `ETag` and honours `If-None-Match` (except with
   * `random`), so a repeated identical listing is cheap for the server even
   * though the SDK does not cache it for you.
   *
   * @throws {OmsApiError} 400 naming the offending key when a filter is not
   *   one of `title`, `author`, `format`, `user_id`, `id`, `created_at`,
   *   `updated_at`. Filters fail closed on purpose: silently dropping an
   *   unknown one used to answer with the UNFILTERED set.
   */
  async list(params: ListBooksParams = {}, options: RequestOptions = {}): Promise<Paginated<Book>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;

    const load = (at: { page: number; pageSize: number }): Promise<Book[]> =>
      this.http
        .get<Book[] | undefined>("/books", { ...options, query: this.bookQuery(params, at) })
        .then((rows) => rows ?? []);

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * The caller's own books, whatever their visibility. Sugar for
   * {@link list} with `scope: "mine"`.
   *
   * Needs a credential to mean anything: `apply_scope` narrows to
   * `user_id: Current.user&.id`, and for an anonymous caller that is
   * `user_id: nil`, which matches no row. An anonymous call therefore returns
   * an EMPTY list rather than a 401 - the endpoint is genuinely public and has
   * nothing to complain about.
   */
  async mine(params: Omit<ListBooksParams, "scope"> = {}, options: RequestOptions = {}): Promise<Paginated<Book>> {
    return this.list({ ...params, scope: "mine" }, options);
  }

  /**
   * Other people's public books. Sugar for {@link list} with
   * `scope: "explore"`, or with `ownerHandle` when one is given.
   *
   * The scope is DROPPED as soon as a handle is supplied, matching the web
   * client: asking for "everybody but me, and also only this person" reads as
   * a filter but behaves as a way to make your own library invisible when you
   * pass your own handle.
   */
  async explore(
    params: Omit<ListBooksParams, "scope"> = {},
    options: RequestOptions = {},
  ): Promise<Paginated<Book>> {
    return this.list(
      params.ownerHandle === undefined ? { ...params, scope: "explore" } : params,
      options,
    );
  }

  /**
   * `GET /books/:id` - one book.
   *
   * The route an `unlisted` share link resolves through, so it works
   * anonymously and its scope (`Book.viewable_by`) is deliberately WIDER than
   * the listing's: public, unlisted, plus your own.
   *
   * Renders the `:extended` view, which `BookBlueprint` leaves identical to the
   * default one, so this returns exactly what a row of {@link list} carries.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` - for an id that does not
   *   exist AND for a private book belonging to someone else, indistinguishably.
   *   The scope is applied before the id is compared, which is what stops the
   *   endpoint being an existence oracle for other people's private books.
   */
  async get(id: BookId, options: RequestOptions = {}): Promise<Book> {
    return this.http.get<Book>(`/books/${idSegment(id)}`, options);
  }

  /**
   * `POST /books` - uploads a PDF or an EPUB and adds it to the library.
   *
   * Multipart, synchronous, and slow: Rails buffers the whole body, writes the
   * file to storage, and derives a WebP thumbnail when a cover came with it.
   * The per-attempt deadline defaults to five minutes here instead of the
   * client's usual one, and the call is NOT retried - a replay after a lost
   * answer uploads the book twice.
   *
   * ## Two size ceilings, and the one you will actually hit
   *
   * Rails refuses anything over {@link BOOK_MAX_FILE_BYTES} (100 MiB) with
   * `413 "File too big (max 100 MB)"`. In production that message is nearly
   * unreachable, because Cloudflare sits in front and refuses a request body
   * over roughly {@link BOOK_UPLOAD_EDGE_LIMIT_BYTES} with its OWN `413`
   * before the origin sees a byte. That one arrives as an
   * {@link OmsApiError} whose body is an HTML error page and which mentions
   * neither books nor a limit, so a caller matching on the message will not
   * recognise it. Match on `status === 413` instead, and say "the file is too
   * large" whatever the body claims.
   *
   * There is no chunked route for books, so splitting the file is not an
   * option; a 400 MB scan has to be shrunk before it can be uploaded. (This is
   * the same ceiling `songs.import` documents, hit far more often here: a
   * scanned book is routinely bigger than an album.)
   *
   * This method checks the size LOCALLY first when the size is knowable - a
   * `Blob`, a `Uint8Array`, or a picked file whose descriptor reported one -
   * and throws before spending several minutes uploading something that will
   * be refused. A `ReadableStream` reports nothing and is sent as-is.
   *
   * ## What the server decides for you
   *
   * - **Format**, from the filename extension, falling back to the content
   *   type. A `.pdf` that is really an EPUB is stored as a PDF and will not
   *   open; the reader pins `Content-Type` to this value and sends
   *   `X-Content-Type-Options: nosniff`, so nothing downstream corrects it.
   * - **Title**, when you send none: the filename without its extension.
   * - **Visibility**: always `private`. `BookServices::Creator` never reads the
   *   field, so passing one changes nothing. Sharing a freshly uploaded book is
   *   always a second call to {@link update}.
   * - **`file_size_bytes`**, from the stored node. Not from anything you send.
   *
   * @throws {TypeError} before any request when the file is over the edge
   *   ceiling and its size was knowable locally.
   * @throws {OmsAuthError} 401 `"Session required"` when anonymous. Note it is
   *   checked in the action, so this is a 401 and not the 403 an OAuth token
   *   would get.
   * @throws {OmsApiError} 413 for an oversized body (from Rails, or from the
   *   edge - see above); 400 `"No file provided"`, `"Unsupported file type,
   *   only PDF and EPUB are accepted"`, `"Library storage unavailable"`, or the
   *   model's validation messages.
   */
  async create(input: CreateBookInput, options: RequestOptions = {}): Promise<Book> {
    const size = knownByteSize(input.file);
    if (size !== undefined && size > BOOK_UPLOAD_EDGE_LIMIT_BYTES) {
      throw new TypeError(
        `This book is ${size} bytes. Uploads are refused above about ${BOOK_UPLOAD_EDGE_LIMIT_BYTES} bytes by the edge ` +
          "(and above 104857600 by the API itself), there is no chunked upload route for books, and the edge's refusal " +
          "is a 413 whose body says nothing about books. Shrink the file before uploading it.",
      );
    }

    const fields: FormFields = { file: input.file };
    if (input.cover !== undefined) fields["cover"] = input.cover;
    if (input.title !== undefined) fields["title"] = input.title;
    if (input.author !== undefined) fields["author"] = input.author;
    if (input.description !== undefined) fields["description"] = input.description;
    if (input.isbn !== undefined) fields["isbn"] = input.isbn;
    if (input.language !== undefined) fields["language"] = input.language;
    if (input.pageCount !== undefined) fields["page_count"] = String(input.pageCount);
    if (input.tags !== undefined) fields["tags"] = [...input.tags];

    return this.http.postForm<Book>("/books", fields, { timeoutMs: 300_000, ...options });
  }

  /**
   * `PATCH /books/:id` - edits metadata, visibility, and optionally the cover.
   *
   * JSON normally; multipart as soon as {@link UpdateBookInput.cover} is
   * present, because that is the only way to carry a file. Both encodings reach
   * the same code path, and this method papers over the one place they would
   * otherwise differ: clearing a column. Every multipart field is a string, so
   * there is no `null` to send - the backend's `\b` sentinel is decoded for
   * update params exactly as it is for filters, and this writes it for you when
   * you pass `null`.
   *
   * This is where a book becomes shareable. `visibility` is the only field that
   * changes who can reach it, and it cannot be set at upload time.
   *
   * Replacing the cover leaves the OLD cover nodes behind as orphans until the
   * book itself is destroyed: `update_params` creates a new node and points the
   * book at it, and only `compress_cover` destroys the previous compressed
   * twin. Not a bug you can fix from here, but it is why re-cropping a cover
   * repeatedly costs storage quota.
   *
   * @throws {OmsAuthError} 401 when the book is not yours - `CrudActions#update`
   *   checks `updatable_by?` and answers 401, not 403.
   * @throws {OmsApiError} 404 when the id is unknown or the book is someone
   *   else's PRIVATE one (the lookup is scoped first); 400 with the model's
   *   validation messages, e.g. a `visibility` outside
   *   {@link BOOK_VISIBILITIES} or a title over
   *   {@link BOOK_TITLE_MAX_LENGTH}.
   */
  async update(id: BookId, input: UpdateBookInput, options: RequestOptions = {}): Promise<Book> {
    const path = `/books/${idSegment(id)}`;

    if (input.cover === undefined) {
      return this.http.patch<Book>(path, this.updateBody(input), options);
    }

    const form = await buildFormData({ ...this.multipartUpdateFields(input), cover: input.cover });
    const response = await this.http.raw("PATCH", path, { timeoutMs: 120_000, ...options, body: form });
    return (await readJson(response)) as Book;
  }

  /**
   * `DELETE /books/:id` - removes the book, its file, its covers, its
   * annotations and its place on every shelf.
   *
   * Genuinely destructive and not recoverable: `file_fs_node` is
   * `dependent: :destroy`, so the stored PDF or EPUB goes with the row, and so
   * do every reader's highlights on it.
   *
   * @throws {OmsAuthError} 401 when the book is not yours.
   * @throws {OmsApiError} 404 the second time, because the row is already gone.
   *   That is why this is never retried on a torn connection: a replay would
   *   report "not found" for a delete that worked perfectly well.
   */
  async delete(id: BookId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/books/${idSegment(id)}`, options);
  }

  /**
   * `GET /books/libraries` - every reader who opted their library public and
   * has at least one public book.
   *
   * A directory of PEOPLE, not of books, and the one payload here that is not a
   * Blueprinter record - see {@link PublicLibrary}. Anonymous, unpaged, and
   * cheap: the set is small by construction and the counts come from one
   * grouped query.
   *
   * A reader appears only when BOTH halves are true: `library_public` on their
   * user record (set through `account.update`, not from this namespace) AND at
   * least one book at `public`. Making a single book public does not publish a
   * library, and publishing a library with only unlisted books lists nobody.
   */
  async libraries(options: RequestOptions = {}): Promise<PublicLibrary[]> {
    return this.http.get<PublicLibrary[]>("/books/libraries", options);
  }

  /**
   * `GET /books/:id/file` - the raw bytes, for an in-app reader.
   *
   * The one media route in this namespace that does NOT redirect: Rails serves
   * the bytes itself, same-origin to the API, precisely so a reader
   * (`react-pdf`, `epub.js`) can pull them over XHR without a cross-origin hop
   * into object storage. It sends `Accept-Ranges: bytes`, pins `Content-Type`
   * to the validated format, and sets `X-Content-Type-Options: nosniff` so a
   * doctored `.pdf` full of HTML cannot be rendered as a document.
   *
   * Conditional GET is deliberately DISABLED on this route
   * (`Cache-Control: no-cache, no-store, must-revalidate`): `Rack::ETag` would
   * otherwise tag the body and the browser would revalidate into an empty `304`
   * that an XHR reader cannot parse. So every call is a full transfer and
   * caching is the client's job.
   *
   * **This reads the whole book into memory twice** - once in Rails
   * (`send_data blob.download`) and once here. For a large PDF prefer
   * {@link fileRange}, which is what a PDF viewer does on its own, or
   * {@link fileUrl} plus a native downloader on a phone.
   *
   * Anonymous callers are limited to
   * {@link ANONYMOUS_BOOK_FILE_RATE_LIMIT_PER_HOUR} reads an hour per IP across
   * this route and {@link download} together; a signed-in caller is not
   * limited by it. The route is also exempt from the general 600/min ceiling,
   * so a Range-reading viewer opening one book cannot trip it.
   *
   * @throws {OmsApiError} 404 `"No file attached"` when the row exists but its
   *   node lost its blob, and `"Resource not found"` when the book is not
   *   visible to the caller; 429 for an anonymous caller over the hourly cap.
   */
  async file(id: BookId, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download(`/books/${idSegment(id)}/file`, { timeoutMs: 300_000, ...options });
  }

  /**
   * `GET /books/:id/file` with a `Range` header - one slice of the book.
   *
   * This is how a PDF viewer opens a 60 MB scan in under a second: it reads the
   * trailer, then the pages it needs, and never downloads the rest. The server
   * answers `206` with `Content-Range` and serves the slice through
   * `blob.service.download_chunk`, so the origin does not read the whole file
   * either.
   *
   * `end` is INCLUSIVE, as HTTP ranges are: `{ start: 0, end: 1023 }` is the
   * first 1024 bytes. Omit `end` for "from here to the end of the file". A
   * suffix range (the LAST n bytes) is not offered here because the server's
   * `Content-Range` is the only way back to absolute offsets and this method
   * would have to guess; send the header yourself through `http.raw` if you
   * need one.
   *
   * ONE range per request. `BooksController#send_file_range` answers `416` to a
   * multi-range header rather than building a multipart/byteranges body, so do
   * not batch.
   *
   * @throws {OmsApiError} 416 when the range starts past the end of the file,
   *   or when more than one range was asked for. The response carries
   *   a `Content-Range` naming the real size, with a star where the range
   *   would be. That is how a caller learns the size after guessing wrong.
   * @throws {OmsError} when the server answered `200` instead of `206` - a
   *   proxy that stripped the `Range` header, which would otherwise be read as
   *   a slice and quietly corrupt the reader's buffer.
   */
  async fileRange(
    id: BookId,
    range: { start: number; end?: number },
    options: RequestOptions = {},
  ): Promise<BookFileRange> {
    const header = `bytes=${range.start}-${range.end === undefined ? "" : range.end}`;
    const path = `/books/${idSegment(id)}/file`;
    const response = await this.http.raw("GET", path, {
      ...options,
      headers: { ...(options.headers ?? {}), Range: header },
    });

    const contentRange = parseContentRange(response.headers.get("content-range"));
    if (response.status !== 206 || !contentRange) {
      throw new OmsError(
        `Asked for ${header} and the server answered ${response.status} without a usable Content-Range. ` +
          "Something between here and Rails dropped the Range header; treat the body as the WHOLE file, not a slice.",
        "server_error",
        { method: "GET", url: this.http.url(path), attempts: 1 },
      );
    }

    return {
      data: await response.arrayBuffer(),
      start: contentRange.start,
      end: contentRange.end,
      total: contentRange.total,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Absolute URL of the book's bytes, for a reader that fetches them itself.
   *
   * Synchronous, and it carries NO CREDENTIAL - it cannot, because a token
   * provider may be async and this is called while a component renders. What
   * that means in practice depends on the book:
   *
   * - a `public` or `unlisted` book opens with no credential at all;
   * - a `private` one needs one, and the caller has to attach it. For pdf.js
   *   that is `httpHeaders: { Authorization: 'Bearer ...' }` on a token client,
   *   or `withCredentials: true` on a cookie client. Both, on a client that has
   *   both, would be a request the API refuses to disambiguate.
   *
   * Prefer NOT to append `?token=...`. The API does accept a query token
   * (`Session.candidate_tokens` reads `params[:token]`) and the web frontend
   * uses it for `cover` and `download`, but it puts a live session credential
   * into access logs and into anything that copies the URL - a pasted link
   * hands over the account, and the token never expires on its own.
   *
   * The rate-limit half of that warning used to be stated here and was wrong:
   * a query token is NOT counted as anonymous. `Rack::Attack.authed_session`
   * resolves through `Session.find_by_request_readonly`, which calls
   * `resolve_from_request` with `allow_query_param: true` by default, so a
   * valid `?token=` resolves to a live session and the request is keyed
   * `sess:<id>` in the authenticated 600/min bucket. Only
   * `find_by_browser_request` drops the query param, and it is used solely by
   * the HTML consent and device pages. The leak is the reason to avoid it; the
   * budget is not.
   */
  fileUrl(id: BookId): string {
    return this.http.url(`/books/${idSegment(id)}/file`);
  }

  /**
   * `GET /books/:id/cover` - `302` to the cover image in object storage.
   *
   * Prefer {@link coverUrl} in markup. This method exists for when the bytes
   * themselves are wanted, and it sends the caller's credential because it has
   * to: the action resolves the book through `Book.viewable_by(Current.user)`,
   * so your own private book's cover is a `404` without one.
   *
   * ## It does not work from a browser, and that is not fixable here
   *
   * The `302` goes to `minio.omelhorsite.pt`. Per the Fetch standard a CORS
   * request redirected cross-origin gets an opaque origin on the next hop, MinIO
   * answers a null origin with `Access-Control-Allow-Origin: *`, and a wildcard
   * is illegal for a credentialed request - so the browser rejects the response
   * before any JavaScript sees it. `account.picture` solves this by sending no
   * credential; that is not available here, because a private cover needs one.
   *
   * In a browser, put {@link coverUrl} in an `<img>` and let the platform
   * follow the redirect with no CORS check at all. In Bun, in a Worker and on
   * React Native, where no CORS is enforced, this method is fine.
   *
   * @throws {OmsApiError} 404 `"No cover"` when the book has none, and
   *   `"Resource not found"` when it is not visible to the caller.
   */
  async cover(id: BookId, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download(`/books/${idSegment(id)}/cover`, options);
  }

  /**
   * Absolute URL of the cover, for an `<img>` or a `background-image`.
   *
   * Synchronous, uncredentialed, and safe to put in markup for a `public` or
   * `unlisted` book. A PRIVATE book's cover answers `404` through this URL
   * unless the platform attaches the session cookie for you - which an `<img>`
   * on the same site does and an element with `crossorigin="anonymous"` does
   * not. Give the element an `onError` that falls back to a generated cover.
   *
   * The redirect target is a presigned URL, so do not cache this URL's
   * RESOLVED destination anywhere; cache this URL instead.
   */
  coverUrl(id: BookId): string {
    return this.http.url(`/books/${idSegment(id)}/cover`);
  }

  /**
   * `GET /books/:id/download` - `302` to the book file as an attachment.
   *
   * The difference from {@link file} is only the disposition: this one is
   * `attachment` with a slugged filename (`war-and-peace.pdf`), and it goes
   * through object storage rather than through Rails. Same CORS caveat as
   * {@link cover} - see it - and the same anonymous ceiling of
   * {@link ANONYMOUS_BOOK_FILE_RATE_LIMIT_PER_HOUR} per hour per IP.
   *
   * On a phone, do not pull a whole book through JavaScript for the sake of
   * saving it: hand {@link downloadUrl} to a native downloader.
   */
  async download(id: BookId, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download(`/books/${idSegment(id)}/download`, { timeoutMs: 300_000, ...options });
  }

  /**
   * Absolute URL that saves the book as a file. Synchronous and
   * uncredentialed, with the same visibility caveat as {@link coverUrl}.
   *
   * Suitable for an `<a href>` or for a native downloader. The filename comes
   * from the server's `Content-Disposition`, so there is no need for a
   * `download` attribute - which a cross-origin link ignores anyway.
   */
  downloadUrl(id: BookId): string {
    return this.http.url(`/books/${idSegment(id)}/download`);
  }

  /**
   * `POST /books/:id/progress` - upserts "where I left off" for this reader.
   *
   * An UPSERT, not a create: the controller does
   * `first_or_initialize` on `(book, user, kind: "progress")`, so there is
   * exactly one progress marker per reader per book however many times this is
   * called, and no id is needed. Call it freely as the reader turns pages.
   *
   * Private to the reader even on a public book, and it works on somebody
   * else's public book - which is the point: reading a shared book should
   * remember where you were.
   *
   * `location` is opaque `jsonb`. A blank or omitted one is stored as `{}`,
   * which reads back as "no position recorded" rather than as page zero.
   *
   * Returns the annotation, so the row that comes back is the same shape
   * {@link LibraryAnnotationsNamespace} deals in and can be dropped straight
   * into a client-side cache of markers.
   *
   * @throws {OmsAuthError} 401 when anonymous - unlike the read routes, this
   *   one is not in `allow_unauthenticated_access`.
   * @throws {OmsApiError} 404 when the book is not visible to the caller.
   */
  async saveProgress(
    id: BookId,
    location: BookAnnotationLocation,
    options: RequestOptions = {},
  ): Promise<BookAnnotation> {
    return this.http.post<BookAnnotation>(`/books/${idSegment(id)}/progress`, { location }, options);
  }

  /**
   * Builds the query for {@link list}.
   *
   * `title` and `author` go in `search` (partial, accent-insensitive); the
   * exact-match columns go in `exact_search`; `scope`, `owner_handle` and
   * `tags` go in `extra_options`, which is a THIRD bucket with its own
   * allowlist - `BooksController` declares only those three, so any other key
   * there is a 400.
   */
  private bookQuery(params: ListBooksParams, at?: { page: number; pageSize: number }): QueryParams {
    const search: Record<string, QueryValue> = { ...(params.search ?? {}) };
    if (params.title !== undefined) search["title"] = params.title;
    if (params.author !== undefined) search["author"] = params.author;

    const exact: Record<string, QueryValue> = { ...(params.exactSearch ?? {}) };
    if (params.format !== undefined) exact["format"] = params.format;
    if (params.userId !== undefined) exact["user_id"] = params.userId;
    if (params.ids !== undefined) exact["id"] = [...params.ids];

    const modifiers: Record<string, QueryValue> = {};
    if (at) modifiers["page"] = pageModifier(at.page, at.pageSize);
    if (params.order !== undefined) modifiers["order"] = params.order;
    if (params.random) modifiers["random"] = true;

    const extra: Record<string, QueryValue> = {};
    if (params.scope !== undefined) extra["scope"] = params.scope;
    if (params.ownerHandle !== undefined) extra["owner_handle"] = params.ownerHandle;
    if (params.tags !== undefined && params.tags.length > 0) extra["tags"] = [...params.tags];

    return {
      ...(Object.keys(search).length > 0 ? { search } : {}),
      ...(Object.keys(exact).length > 0 ? { exact_search: exact } : {}),
      ...(Object.keys(modifiers).length > 0 ? { modifiers } : {}),
      ...(Object.keys(extra).length > 0 ? { extra_options: extra } : {}),
    };
  }

  /** JSON body for an update. `null` stays `null`; the transport does not touch a body. */
  private updateBody(input: UpdateBookInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body["title"] = input.title;
    if (input.author !== undefined) body["author"] = input.author;
    if (input.description !== undefined) body["description"] = input.description;
    if (input.isbn !== undefined) body["isbn"] = input.isbn;
    if (input.language !== undefined) body["language"] = input.language;
    if (input.pageCount !== undefined) body["page_count"] = input.pageCount;
    if (input.visibility !== undefined) body["visibility"] = input.visibility;
    if (input.tags !== undefined) body["tags"] = [...input.tags];
    return body;
  }

  /**
   * Multipart fields for an update, with the one encoding difference fixed.
   *
   * `null` becomes the `\b` sentinel, which `CrudActions` decodes back to `nil`
   * for update params exactly as it does for filters - a form field has no
   * other way to say "clear this column". An empty `tags` list is sent as a
   * single empty string, because appending an empty array appends nothing and
   * an absent key means "leave the tags alone", which is the opposite of what
   * clearing them means. `normalize_tags` drops the blank entry, leaving `[]`.
   */
  private multipartUpdateFields(input: UpdateBookInput): Record<string, string | string[]> {
    const fields: Record<string, string | string[]> = {};
    const scalar = (key: string, value: string | number | null | undefined): void => {
      if (value === undefined) return;
      fields[key] = value === null ? NULL_SENTINEL : String(value);
    };

    scalar("title", input.title);
    scalar("author", input.author);
    scalar("description", input.description);
    scalar("isbn", input.isbn);
    scalar("language", input.language);
    scalar("page_count", input.pageCount);
    scalar("visibility", input.visibility);
    if (input.tags !== undefined) fields["tags"] = input.tags.length === 0 ? [""] : [...input.tags];
    return fields;
  }
}

// ---------------------------------------------------------------------------
// Shelves

/** The `library.shelves` namespace, reachable as `oms.library.shelves`. */
export class LibraryShelvesNamespace extends Resource {
  /**
   * `GET /book_shelves` - browse shelves.
   *
   * Same two-axis visibility rule as books: `BookShelf.listable_by` is every
   * `public` shelf plus, for a signed-in caller, their own whatever their
   * visibility. An `unlisted` shelf opens by its link and appears in no
   * listing.
   *
   * Ordered by `(position, created_at)` unless you override it: the controller
   * chains `.ordered` onto the listing scope, so the owner's own arrangement is
   * the default and a paged walk is stable without asking.
   *
   * **The rows here carry no `books`.** `index` renders the default view and
   * only the `:extended` one inlines the association. Every other method in
   * this namespace returns the extended shape; this one does not. Do not build
   * a shelf screen by listing and reading `books` - it is `undefined`.
   *
   * Note also that `book_count` costs one query per shelf
   * (`shelf.visible_books(user).count`, per row, un-eager-loadable because it
   * depends on who is asking). A 100-shelf page is 100 extra counts. Page it.
   *
   * @throws {OmsApiError} 400 naming the offending key when a filter is not
   *   one of `user_id`, `visibility`, `id`, `created_at`, `updated_at`. There
   *   are no `extra_options` on this controller at all, so ANY key in that
   *   bucket is a 400.
   */
  async list(params: ListBookShelvesParams = {}, options: RequestOptions = {}): Promise<Paginated<BookShelf>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;

    const load = (at: { page: number; pageSize: number }): Promise<BookShelf[]> =>
      this.http
        .get<BookShelf[] | undefined>("/book_shelves", { ...options, query: this.shelfQuery(params, at) })
        .then((rows) => rows ?? []);

    return createPage(await load({ page, pageSize }), page, pageSize, load);
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
   * Works anonymously, through the wider `viewable_by` scope, which is how an
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
   * The owner is taken from the session and cannot be sent: `create_params`
   * merges `Current.user` in after permitting the three writable fields.
   * Visibility defaults to `private`.
   *
   * Not retried by default, like every create: a replay after a lost answer
   * makes a second identical shelf, and shelves are capped per user.
   *
   * @throws {OmsAuthError} 401 when anonymous - `creatable_by?` is simply
   *   `user.present?`.
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
   * IDEMPOTENT: `find_or_initialize_by` means adding a book that is already
   * there is a no-op with a `200`, not a duplicate and not a 422. Position is
   * assigned automatically at the end of the shelf.
   *
   * The book must be the shelf owner's own. `Current.user.books.find_by` is
   * what resolves it, so somebody else's book - public or not - is a `404
   * "Book not found"` rather than a permission error, and a shelf can never
   * hold a book whose owner might later make it private and leak it through
   * the shelf's visibility.
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
   * IDEMPOTENT to the point of being silent: the action is
   * `find_by(...)&.destroy`, so removing a book that was never on the shelf
   * answers `200` with the unchanged shelf. There is no way to tell the two
   * apart from the response - compare `book_count` yourself if you need to.
   *
   * The book id travels as a QUERY PARAMETER rather than in a body. Rails reads
   * `params[:book_id]` from either, and a `DELETE` with a body is the shape
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
   * Ids that are not on this shelf are ignored in silence (the `update_all`
   * matches no row), and so are ids of books that do not exist. So this cannot
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

  /** Builds the query for {@link list}. Both filterable columns are exact-match. */
  private shelfQuery(params: ListBookShelvesParams, at?: { page: number; pageSize: number }): QueryParams {
    const search: Record<string, QueryValue> = { ...(params.search ?? {}) };

    const exact: Record<string, QueryValue> = { ...(params.exactSearch ?? {}) };
    if (params.userId !== undefined) exact["user_id"] = params.userId;
    if (params.visibility !== undefined) exact["visibility"] = params.visibility;
    if (params.ids !== undefined) exact["id"] = [...params.ids];

    const modifiers: Record<string, QueryValue> = {};
    if (at) modifiers["page"] = pageModifier(at.page, at.pageSize);
    if (params.order !== undefined) modifiers["order"] = params.order;

    return {
      ...(Object.keys(search).length > 0 ? { search } : {}),
      ...(Object.keys(exact).length > 0 ? { exact_search: exact } : {}),
      ...(Object.keys(modifiers).length > 0 ? { modifiers } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Annotations

/** The `library.annotations` namespace, reachable as `oms.library.annotations`. */
export class LibraryAnnotationsNamespace extends Resource {
  /**
   * `GET /book_annotations` - the caller's own highlights, notes, bookmarks and
   * progress markers.
   *
   * There is no owner filter and there does not need to be one:
   * `BookAnnotation.viewable_by` is `where(user_id: user.id)`, so a caller can
   * only ever see its own rows - even on a book a thousand people have public
   * access to.
   *
   * Unlike every read in the other two namespaces, this controller declares no
   * `allow_unauthenticated_access`, so an anonymous call is a `401`, not an
   * empty list.
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
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;

    const load = (at: { page: number; pageSize: number }): Promise<BookAnnotation[]> =>
      this.http
        .get<BookAnnotation[] | undefined>("/book_annotations", {
          ...options,
          query: this.annotationQuery(params, at),
        })
        .then((rows) => rows ?? []);

    return createPage(await load({ page, pageSize }), page, pageSize, load);
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
   * The author is taken from the session (`set_user_as_current_user`), so
   * `user_id` is not sendable. `creatable_by?` additionally requires the book to
   * be in `Book.viewable_by(user)`, which is what lets a reader annotate
   * somebody else's public book while keeping the annotation entirely private
   * to them.
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
   *   required to access this resource."` from the auth filter when anonymous,
   *   and `"You are not authorized to create this resource"` when the book is
   *   not in `Book.viewable_by` - `CrudActions#create` turns a failed
   *   `creatable_by?` into a 401 rather than the 404 you might expect.
   * @throws {OmsApiError} 400 for a `kind` outside
   *   {@link BOOK_ANNOTATION_KINDS}, or a note or selection over its length
   *   cap.
   */
  async create(input: CreateBookAnnotationInput, options: RequestOptions = {}): Promise<BookAnnotation> {
    const body: Record<string, unknown> = { book_id: input.bookId, kind: input.kind };
    // Always sent: `create_params` writes `location` unconditionally from
    // `sanitized_location`, so an omitted one is stored as `{}` either way.
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
   * `selected_text` are NOT in `update_params` and are dropped in silence by
   * `permit` - a `200` with an unchanged row, which is the failure mode worth
   * knowing about here. To change a highlight into a note, delete and recreate.
   *
   * `location` is only sent when you pass one, because the controller tests
   * `params.key?(:location)`: passing `{}` therefore CLEARS the anchor rather
   * than leaving it alone.
   *
   * @throws {OmsAuthError} 401 when the annotation is not yours.
   * @throws {OmsApiError} 404 for an unknown id - and for anyone else's
   *   annotation, since `viewable_by` never returns one.
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

  /** Builds the query for {@link list}. Both filterable columns are exact-match. */
  private annotationQuery(
    params: ListBookAnnotationsParams,
    at?: { page: number; pageSize: number },
  ): QueryParams {
    const search: Record<string, QueryValue> = { ...(params.search ?? {}) };

    const exact: Record<string, QueryValue> = { ...(params.exactSearch ?? {}) };
    if (params.bookId !== undefined) exact["book_id"] = params.bookId;
    if (params.kind !== undefined) exact["kind"] = typeof params.kind === "string" ? params.kind : [...params.kind];

    const modifiers: Record<string, QueryValue> = {};
    if (at) modifiers["page"] = pageModifier(at.page, at.pageSize);
    if (params.order !== undefined) modifiers["order"] = params.order;

    return {
      ...(Object.keys(search).length > 0 ? { search } : {}),
      ...(Object.keys(exact).length > 0 ? { exact_search: exact } : {}),
      ...(Object.keys(modifiers).length > 0 ? { modifiers } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Study assistant

/** Options for {@link BookChatNamespace.stream} and {@link BookChatNamespace.ask}. */
export interface BookChatStreamOptions extends RequestOptions {
  /**
   * How long to wait for the NEXT piece of the answer before giving up, in
   * milliseconds. Defaults to the transport's 45 seconds; `0` disables it.
   *
   * A silence limit, not a total: an answer that keeps producing runs as long
   * as it likes. It exists because a stalled sidecar once answered `200` and
   * then said nothing for two minutes at a time, and `await reader.read()` has
   * no deadline of its own, so the chat panel span for as long as the tab
   * stayed open. `timeoutMs` cannot cover this: it is disposed the moment the
   * headers arrive, or no stream could outlive it.
   *
   * It has to sit well clear of a cold model's first token - the 8B model has
   * to be paged in before it can answer - which is why 45 seconds and not five.
   *
   * IGNORED on the buffered path (React Native), where there is one read and
   * the caller's `signal` is what bounds it.
   */
  readonly silenceTimeoutMs?: number;
}

/**
 * The `library.chat` namespace: the reader's study assistant.
 *
 * `POST /books/:id/chat` is the only STREAMING endpoint in the whole API. It is
 * its own controller rather than an action on `BooksController` for a concrete
 * reason: `ActionController::Live` wraps every action of the controller it is
 * included in, and `Live::Response` drops `Content-Length` on first write -
 * which is exactly the header `GET /books/:id/file` must keep, because pdf.js
 * reads it to decide whether the server supports range requests.
 *
 * ## What it costs, and why it refuses rather than queues
 *
 * One request parks a Puma thread for the whole generation, tens of seconds on
 * the local model. `Ai::StreamSlots` caps how many generations run at once and
 * FAILS CLOSED when they are all taken - a caller parked waiting for a slot
 * would be holding the very thread the slots exist to protect. That refusal is
 * a `503`; see {@link isBookChatBusy}. On top of it, one client may only START
 * {@link BOOK_CHAT_RATE_LIMIT_PER_MINUTE} generations a minute, so a loop
 * cannot take whatever slot frees up next.
 *
 * ## The client owns the conversation
 *
 * There is no server-side session and no history storage. Every request carries
 * the whole conversation and the passage the question is about; what you do not
 * send did not happen. The server owns the framing and the caps, and it drops
 * any role other than `user` and `assistant` so a client cannot inject a
 * `system` turn into our own prompt.
 */
export class BookChatNamespace extends Resource {
  /**
   * `POST /books/:id/chat` - asks the assistant and yields the answer as it
   * arrives.
   *
   * Yields TEXT DELTAS, already unwrapped from their SSE frames: concatenating
   * everything this yields is the complete answer. Framing is handled here
   * because a chunk is not a frame - a `data:` line can arrive split across two
   * network chunks - and every client that tried to parse the raw stream itself
   * got that wrong at least once.
   *
   * ## The two runtimes do not deliver the same way, and the difference is real
   *
   * - **browser and Bun**: one yield per delta, as the model produces it. A
   *   typing UI works, and abandoning the loop (a `break`, or an early
   *   `return`) cancels the reader, closes the connection, and the server sees
   *   `ClientDisconnected` and RELEASES ITS GENERATION SLOT. Stopping early
   *   genuinely stops the work.
   * - **React Native**: ONE yield, containing the entire answer, after the
   *   server has finished generating. RN's `fetch` is `XMLHttpRequest` under a
   *   shim, the whole body is accumulated natively and handed over at the end,
   *   and `response.body` does not exist. This is not a gap to polyfill.
   *   Consequences to design around: a typing indicator will sit still and then
   *   snap to the finished answer, so ask {@link bookChatIsIncremental} and
   *   show a spinner instead; and `break`ing out of the loop cancels NOTHING,
   *   because the request already completed - only an `AbortSignal` can stop
   *   the work, and only by tearing down the whole request.
   *
   * The final text is identical on both. Nothing is lost, nothing is
   * reordered, and no chunk boundary is invented to make one look like the
   * other.
   *
   * ## A `200` does not mean the answer worked
   *
   * The status and the SSE headers are written before the model has produced a
   * token, so every later failure is in-band. Two of them, both raised as
   * {@link BookChatError} with the text already yielded attached:
   *
   * - an `error` frame (`reason: "assistant_unavailable"`) - the inference
   *   client raised, and the upstream message is deliberately withheld because
   *   it can carry the sidecar's internals;
   * - the stream ending without a `done` frame (`reason: "truncated"`) - the
   *   proxy dropped a stream that went quiet, or the connection was cut
   *   mid-answer. Returning quietly here would report a half-answer as a
   *   complete one, which is the whole reason the `done` frame exists.
   *
   * @example
   * ```ts
   * let answer = "";
   * for await (const delta of oms.library.chat.stream(bookId, { messages, context })) {
   *   answer += delta;
   *   render(answer);            // one paint per delta, or one paint on RN
   * }
   * ```
   *
   * @throws {OmsAuthError} 401 `"Session required"` when anonymous.
   * @throws {OmsApiError} 404 `"Book not found"` when the book is not viewable;
   *   413 `"Request too big"` over {@link BOOK_CHAT_MAX_BODY_BYTES}; 429 over
   *   {@link BOOK_CHAT_RATE_LIMIT_PER_MINUTE}; 503 when every generation slot
   *   is taken ({@link isBookChatBusy}).
   * @throws {BookChatError} for either post-`200` failure. Check `reason` and
   *   `partial`.
   * @throws {OmsTimeoutError} when the stream goes quiet for
   *   {@link BookChatStreamOptions.silenceTimeoutMs}. Streaming path only.
   */
  async *stream(
    bookId: BookId,
    input: BookChatInput,
    options: BookChatStreamOptions = {},
  ): AsyncGenerator<string, void, undefined> {
    const path = `/books/${idSegment(bookId)}/chat`;
    const body: Record<string, unknown> = { messages: [...input.messages] };
    if (input.context !== undefined) body["context"] = input.context;

    let buffer = "";
    let produced = "";

    for await (const chunk of this.http.streamText("POST", path, { ...options, body })) {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;

        const data = line.slice("data:".length).trim();
        if (data.length === 0) continue;

        let event: BookChatEvent;
        try {
          event = JSON.parse(data) as BookChatEvent;
        } catch {
          // A partial or unrecognised frame. Never fatal: the buffer above
          // already guarantees whole lines, so this is the server having
          // written something we do not model, not a split payload.
          continue;
        }

        if (event.error !== undefined) {
          throw new BookChatError(
            "The assistant failed while answering. The request itself succeeded - this arrived inside a 200.",
            "assistant_unavailable",
            produced,
            this.http.url(path),
          );
        }
        if (event.delta !== undefined && event.delta.length > 0) {
          produced += event.delta;
          yield event.delta;
        }
        // The one frame that means the answer is complete. Returning here runs
        // this generator's `finally` chain, which cancels the reader and lets
        // the server release its generation slot.
        if (event.done === true) return;
      }
    }

    throw new BookChatError(
      "The answer stopped without the frame that marks it finished, so it is cut short. The connection was dropped " +
        "mid-generation - usually the proxy giving up on a stream that went quiet.",
      "truncated",
      produced,
      this.http.url(path),
    );
  }

  /**
   * The same call as {@link stream}, waited out and handed back as one string.
   *
   * For the CLI, the MCP server, and anywhere a partial answer has nowhere to
   * go. It is exactly `stream` drained into a buffer, so it raises the same
   * errors for the same reasons - including {@link BookChatError} on a
   * truncated stream, which is the case a naive `await response.text()` would
   * hand back as a successful half-answer.
   *
   * It does NOT make the request cheaper or faster anywhere. On a browser and
   * on Bun the answer still streams in and is merely accumulated here; on React
   * Native it was going to arrive in one piece regardless. Choose it because
   * the CALLER has no use for pieces, never as a way to avoid streaming.
   */
  async ask(bookId: BookId, input: BookChatInput, options: BookChatStreamOptions = {}): Promise<string> {
    let answer = "";
    for await (const delta of this.stream(bookId, input, options)) answer += delta;
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * The `library` namespace, reachable as `oms.library`.
 *
 * A thin holder for the four sub-namespaces. Each of them is exported on its
 * own too, so a host that would rather write `oms.books` can construct
 * {@link LibraryBooksNamespace} directly with the same `ApiClient`.
 */
export class LibraryNamespace extends Resource {
  /** Books: upload, browse, share, read the bytes. */
  readonly books: LibraryBooksNamespace = new LibraryBooksNamespace(this.http);
  /** Shelves: named, ordered, shareable groups of your own books. */
  readonly shelves: LibraryShelvesNamespace = new LibraryShelvesNamespace(this.http);
  /** Highlights, notes, bookmarks and reading progress. Always private. */
  readonly annotations: LibraryAnnotationsNamespace = new LibraryAnnotationsNamespace(this.http);
  /** The streaming study assistant. */
  readonly chat: BookChatNamespace = new BookChatNamespace(this.http);

  /**
   * `GET /books/libraries` - the public-library directory.
   *
   * Delegates to {@link LibraryBooksNamespace.libraries}. It lives on the books
   * route because that is where Rails mounted it, and it is surfaced here
   * because it is a directory of READERS, which is what a caller looking for it
   * expects `oms.library` to have.
   */
  async publicLibraries(options: RequestOptions = {}): Promise<PublicLibrary[]> {
    return this.books.libraries(options);
  }
}
