/** The `library.books` namespace, with the inputs, limits and upload helpers only it uses. */

import { OmsError } from "../../errors";
import type { OmsApiError } from "../../errors";
import type { FormFields } from "../../http";
import { NULL_SENTINEL, Resource, buildFormData, readJson } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams, ListQueryBase } from "../../listing";
import type { FileInput, FileOutput, Id, NativeFile, Paginated, RequestOptions } from "../../types";
import type {
  Book,
  BookAnnotation,
  BookAnnotationLocation,
  BookFormat,
  BookId,
  BookVisibility,
  PublicLibrary,
} from "./types";
import { idSegment } from "../../internal/helpers";

/**
 * Ceiling `POST /books` enforces on the uploaded file: 100 MiB.
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

/** Longest title accepted. Longer titles fail validation with a 400. */
export const BOOK_TITLE_MAX_LENGTH = 300;

/** Longest author accepted. */
export const BOOK_AUTHOR_MAX_LENGTH = 200;

/**
 * Most tags a book keeps.
 *
 * The server does NOT reject a longer list: it strips, downcases,
 * de-duplicates and then takes the first 30 in silence. Send more and the
 * excess is gone with no error to notice.
 */
export const BOOK_MAX_TAGS = 30;

/** Longest tag kept. Longer tags are TRUNCATED, not rejected. */
export const BOOK_TAG_MAX_LENGTH = 40;

/**
 * Book-file reads an ANONYMOUS caller gets per hour, per IP, across
 * `GET /books/:id/file` and `GET /books/:id/download` together.
 *
 * A signed-in caller is exempt. It exists because an anonymous visitor
 * pulling book bytes is the one expensive thing sharing a book opens up.
 */
export const ANONYMOUS_BOOK_FILE_RATE_LIMIT_PER_HOUR = 120;

/** Filter columns of `GET /books`, on top of {@link BASE_FILTER_COLUMNS}. */
export const BOOK_FILTER_COLUMNS = Object.freeze(["title", "author", "format", "user_id"] as const);

/** `extra_options` keys of `GET /books`. */
export const BOOK_EXTRA_OPTION_KEYS = Object.freeze(["scope", "owner_handle", "tags"] as const);

/** `extra_options` of `GET /books`. {@link ListBooksParams} has camelCased shortcuts for each key. */
export interface BookExtraOptions {
  readonly scope?: "mine" | "explore";
  readonly owner_handle?: string;
  readonly tags?: readonly string[];
}

/** Shortcuts over the filter columns of `GET /books`. */
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
}

/** Arguments for {@link LibraryBooksNamespace.list}. */
export interface ListBooksParams extends BookFilters, ListParams<(typeof BOOK_FILTER_COLUMNS)[number], BookExtraOptions> {
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
   * An unknown handle returns an EMPTY list, not a 404. Do not read empty as
   * "this person has no public books".
   *
   * Sending both this and `scope: "explore"` is contradictory when the handle
   * is your own; {@link LibraryBooksNamespace.explore} drops the scope whenever
   * a handle is given.
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
 * `null`, and as multipart it is written as the `\b` sentinel, which the
 * server decodes back to a null for update params exactly as it does for
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
   * There is no way to REMOVE a cover through this endpoint: the field is
   * only read when present, and `cover: null` clears nothing.
   */
  readonly cover?: FileInput | NativeFile;
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

/** The `library.books` namespace, reachable as `oms.library.books`. */
export class LibraryBooksNamespace extends Resource {
  /**
   * `GET /books` - browse the library.
   *
   * WORKS ANONYMOUSLY, and what it returns depends on who is asking: every
   * `public` book plus, for a signed-in caller, their own books whatever
   * their visibility. `unlisted` books are absent by
   * construction - that is what unlisted means - so a reader's own unlisted
   * book DOES appear here (it is theirs) while somebody else's never will.
   *
   * Pagination is FORCED: a request with no page modifier gets `1:500`, and
   * any larger size is clamped back to 500. That is a DoS guard - an
   * unbounded listing holds a server thread and a database connection for as
   * long as the serialisation takes.
   * The SDK always sends a page modifier, so {@link Paginated.pageSize} always
   * reports the size the rows were counted against.
   *
   * Order defaults to whatever Postgres returns, which is NOT stable across
   * pages. Pass an explicit `order` for any paged walk; `"created_at:desc"` is
   * what every library screen uses. An unknown column in `order` is IGNORED in
   * silence, so a typo costs you the ordering and no error.
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
    const base: ListQueryBase = {
      search: { title: params.title, author: params.author },
      exactSearch: { format: params.format, user_id: params.userId, id: params.ids },
      extraOptions: {
        scope: params.scope,
        owner_handle: params.ownerHandle,
        tags: params.tags !== undefined && params.tags.length > 0 ? params.tags : undefined,
      },
    };
    return paginate(params, 100, (at) =>
      this.http.get<Book[] | undefined>("/books", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * The caller's own books, whatever their visibility. Sugar for
   * {@link list} with `scope: "mine"`.
   *
   * Needs a credential to mean anything: the scope narrows to the caller's own
   * `user_id`, and for an anonymous caller that matches no row. An anonymous
   * call therefore returns an EMPTY list rather than a 401 - the endpoint is
   * genuinely public and has nothing to complain about.
   */
  async mine(params: Omit<ListBooksParams, "scope"> = {}, options: RequestOptions = {}): Promise<Paginated<Book>> {
    return this.list({ ...params, scope: "mine" }, options);
  }

  /**
   * Other people's public books. Sugar for {@link list} with
   * `scope: "explore"`, or with `ownerHandle` when one is given.
   *
   * The scope is DROPPED as soon as a handle is supplied: asking for
   * "everybody but me, and also only this person" reads as a filter but
   * behaves as a way to make your own library invisible when you pass your
   * own handle.
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
   * anonymously and its scope is deliberately WIDER than the listing's:
   * public, unlisted, plus your own.
   *
   * Returns exactly what a row of {@link list} carries.
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
   * - **Visibility**: always `private`. The field is never read at creation,
   *   so passing one changes nothing. Sharing a freshly uploaded book is
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
   * book itself is destroyed: a new node is created and the book pointed at
   * it, and only the previous compressed twin is destroyed. Not a bug you can
   * fix from here, but it is why re-cropping a cover repeatedly costs storage
   * quota.
   *
   * @throws {OmsAuthError} 401 when the book is not yours - the ownership
   *   check answers 401, not 403.
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
   * Genuinely destructive and not recoverable: the stored PDF or EPUB goes
   * with the row, and so do every reader's highlights on it.
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
   * A directory of PEOPLE, not of books - see {@link PublicLibrary}. Anonymous,
   * unpaged, and cheap: the set is small by construction and the counts come
   * from one grouped query.
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
   * (`Cache-Control: no-cache, no-store, must-revalidate`): the body would
   * otherwise carry an `ETag` and the browser would revalidate into an empty
   * `304` that an XHR reader cannot parse. So every call is a full transfer
   * and caching is the client's job.
   *
   * **This reads the whole book into memory twice** - once on the server and
   * once here. For a large PDF prefer
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
   * answers `206` with `Content-Range` and reads only the slice, so the origin
   * does not read the whole file either.
   *
   * `end` is INCLUSIVE, as HTTP ranges are: `{ start: 0, end: 1023 }` is the
   * first 1024 bytes. Omit `end` for "from here to the end of the file". A
   * suffix range (the LAST n bytes) is not offered here because the server's
   * `Content-Range` is the only way back to absolute offsets and this method
   * would have to guess; send the header yourself through `http.raw` if you
   * need one.
   *
   * ONE range per request. The server answers `416` to a multi-range header
   * rather than building a multipart/byteranges body, so do not batch.
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
   * Prefer NOT to append `?token=...`. The API does accept a query token, but
   * it puts a live session credential into access logs and into anything that
   * copies the URL - a pasted link hands over the account, and the token never
   * expires on its own.
   *
   * A query token is NOT counted as anonymous: a valid `?token=` resolves to a
   * live session and the request is keyed to that session in the
   * authenticated 600/min bucket. The leak is the reason to avoid it; the
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
   * to: the book is resolved through the caller's visibility, so your own
   * private book's cover is a `404` without one.
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
   * An UPSERT, not a create: there is exactly one progress marker per reader
   * per book however many times this is called, and no id is needed. Call it
   * freely as the reader turns pages.
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
   *   one needs a session.
   * @throws {OmsApiError} 404 when the book is not visible to the caller.
   */
  async saveProgress(
    id: BookId,
    location: BookAnnotationLocation,
    options: RequestOptions = {},
  ): Promise<BookAnnotation> {
    return this.http.post<BookAnnotation>(`/books/${idSegment(id)}/progress`, { location }, options);
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
   * `null` becomes the `\b` sentinel, which the server decodes back to a null
   * for update params exactly as it does for filters - a form field has no
   * other way to say "clear this column". An empty `tags` list is sent as a
   * single empty string, because appending an empty array appends nothing and
   * an absent key means "leave the tags alone", which is the opposite of what
   * clearing them means. The server drops the blank entry, leaving `[]`.
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
