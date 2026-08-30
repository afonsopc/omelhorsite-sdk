/** The `library` domain: books, shelves, annotations and the study assistant, reachable as `oms.library`. */

import { Resource } from "../../http";
import type { RequestOptions } from "../../types";
import { LibraryAnnotationsNamespace } from "./annotations";
import { LibraryBooksNamespace } from "./books";
import { BookChatNamespace } from "./chat";
import { LibraryShelvesNamespace } from "./shelves";
import type { PublicLibrary } from "./types";

export * from "./types";
export * from "./books";
export * from "./shelves";
export * from "./annotations";
export * from "./chat";

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
