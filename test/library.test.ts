/**
 * `bun test` coverage for the `library` namespace.
 *
 * Four things here can only be got wrong ONCE, silently, and then stay wrong:
 *
 * 1. **Which bucket a filter lands in.** `title` is a partial `search`,
 *    `format` is an exact one, and `scope`/`owner_handle`/`tags` are
 *    `extra_options` - a third allowlist with its own 400. Put a key in the
 *    wrong bucket and the server answers `400` naming it, which is loud; put
 *    the right key in the right bucket with raw `[` and `]` and iOS
 *    re-encodes the whole query into a listing that matches nothing, which is
 *    not. Both are asserted on the URL.
 * 2. **How `null` is spelled in each encoding.** A JSON update sends a literal
 *    `null`; a multipart one has no `null` and must send the `\b` sentinel. The
 *    same input has to produce both, and the multipart form is the one nobody
 *    checks.
 * 3. **`remove_book` carrying its argument at all.** The transport has no body
 *    slot on `DELETE`, so the book id goes in the query string. Lose it and the
 *    call still answers `200` with an unchanged shelf - a no-op that looks like
 *    a success.
 * 4. **The chat's two delivery paths agreeing on the ANSWER.** A delta split
 *    across two network chunks, a `done` frame, an in-band `error` after a
 *    `200`, and a stream that just stops. The React Native path is simulated by
 *    taking `ReadableStream` away, which is exactly what that runtime looks
 *    like to `supportsResponseStreaming`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { OmsApiError, OmsError } from "../src/errors";
import { ApiClient, NULL_SENTINEL } from "../src/http";
import {
  BOOK_UPLOAD_EDGE_LIMIT_BYTES,
  BookChatError,
  LibraryAnnotationsNamespace,
  LibraryBooksNamespace,
  LibraryNamespace,
  LibraryShelvesNamespace,
  bookChatIsIncremental,
  isBookChatBusy,
  type Book,
  type BookAnnotation,
  type BookShelf,
} from "../src/resources/library";

const BASE_URL = "https://api.test";
const TOKEN = "secret-session-token";

/** One request the SDK made, flattened into what the assertions care about. */
interface Recorded {
  readonly url: string;
  readonly path: string;
  /** Raw query string, brackets still percent-encoded. Assert on this. */
  readonly search: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

interface Harness {
  readonly library: LibraryNamespace;
  readonly books: LibraryBooksNamespace;
  readonly shelves: LibraryShelvesNamespace;
  readonly annotations: LibraryAnnotationsNamespace;
  readonly calls: Recorded[];
}

/** Queued answer: a body, or a whole Response the test built itself. */
type Reply = { body: unknown; status?: number; headers?: Record<string, string> } | Response;

/**
 * Builds a client whose `fetch` answers from a queue and records what it was
 * asked. The last queued reply is reused, so a paging test can hand back one
 * short page and be done.
 */
function harness(replies: Reply[]): Harness {
  const calls: Recorded[] = [];
  const queue = [...replies];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: input,
      path: parsed.pathname,
      // `parsed.search` normalises nothing, which is the point: it shows the
      // bytes that went on the wire.
      search: parsed.search,
      method: init?.method ?? "GET",
      body: init?.body,
      headers,
    });

    const next = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] as Reply);
    if (next instanceof Response) return next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json; charset=utf-8", ...(next.headers ?? {}) },
    });
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => TOKEN },
  });
  return {
    library: new LibraryNamespace(http),
    books: new LibraryBooksNamespace(http),
    shelves: new LibraryShelvesNamespace(http),
    annotations: new LibraryAnnotationsNamespace(http),
    calls,
  };
}

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 7,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    title: "Os Maias",
    author: "Eca de Queiros",
    description: null,
    format: "epub",
    isbn: null,
    language: "pt",
    page_count: 712,
    file_size_bytes: 4_200_000,
    tags: ["classicos"],
    visibility: "private",
    user_id: "usr_1",
    cover_fs_node_id: null,
    compressed_cover_fs_node_id: null,
    has_cover: false,
    owner_handle: "afonso",
    owner_name: "Afonso",
    editable: true,
    ...overrides,
  };
}

function shelf(overrides: Partial<BookShelf> = {}): BookShelf {
  return {
    id: 3,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    name: "Verao",
    description: null,
    visibility: "private",
    position: 1,
    user_id: "usr_1",
    owner_handle: "afonso",
    owner_name: "Afonso",
    editable: true,
    book_count: 2,
    ...overrides,
  };
}

function annotation(overrides: Partial<BookAnnotation> = {}): BookAnnotation {
  return {
    id: 11,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    book_id: 7,
    user_id: "usr_1",
    kind: "highlight",
    location: { cfiRange: "epubcfi(/6/4!/4/2)" },
    color: "#ffd400",
    note: null,
    selected_text: "Carlos da Maia",
    ...overrides,
  };
}

/** Body of a recorded call, parsed back from the JSON string the transport sent. */
function jsonBody(call: Recorded): Record<string, unknown> {
  expect(typeof call.body).toBe("string");
  return JSON.parse(call.body as string) as Record<string, unknown>;
}

/** Every field of a recorded multipart call, as `[name, value]` pairs. */
function formEntries(call: Recorded): [string, unknown][] {
  expect(call.body).toBeInstanceOf(FormData);
  return [...(call.body as FormData).entries()];
}

// ---------------------------------------------------------------------------

describe("books.list", () => {
  test("splits filters across search, exact_search and extra_options", async () => {
    const h = harness([{ body: [book()] }]);
    await h.books.list({
      title: "maias",
      author: "eca",
      format: "epub",
      userId: "usr_1",
      scope: "explore",
      ownerHandle: "Afonso",
      tags: ["classicos", "pt"],
      order: "created_at:desc",
      page: 2,
      pageSize: 25,
    });

    const search = h.calls[0]!.search;
    expect(h.calls[0]!.path).toBe("/books");
    // Partial-match columns.
    expect(search).toContain("search%5Btitle%5D=maias");
    expect(search).toContain("search%5Bauthor%5D=eca");
    // Exact-match columns. `format` in `search` would be a partial LIKE, which
    // would make "epub" match nothing worse but "pdf" match "pdfa" one day.
    expect(search).toContain("exact_search%5Bformat%5D=epub");
    expect(search).toContain("exact_search%5Buser_id%5D=usr_1");
    // The third bucket, with its own allowlist.
    expect(search).toContain("extra_options%5Bscope%5D=explore");
    expect(search).toContain("extra_options%5Bowner_handle%5D=Afonso");
    expect(search).toContain("extra_options%5Btags%5D%5B%5D=classicos");
    expect(search).toContain("extra_options%5Btags%5D%5B%5D=pt");
    expect(search).toContain("modifiers%5Bpage%5D=2%3A25");
    expect(search).toContain("modifiers%5Border%5D=created_at%3Adesc");
  });

  test("never emits a raw bracket, because Apple's URL stack re-encodes the whole query", async () => {
    const h = harness([{ body: [] }]);
    await h.books.list({ title: "Cafe", tags: ["ficcao"] });
    expect(h.calls[0]!.search).not.toContain("[");
    expect(h.calls[0]!.search).not.toContain("]");
  });

  test("sends a page modifier even with no arguments at all", async () => {
    const h = harness([{ body: [] }]);
    await h.books.list();
    // Without one the server applies its own 1:500. Sending ours is what makes
    // Paginated.pageSize the number the rows were actually counted against.
    expect(h.calls[0]!.search).toContain("modifiers%5Bpage%5D=1%3A100");
  });

  test("hasMore is measured against the size the server would have applied", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => book({ id: i + 1 }));
    const h = harness([{ body: rows }]);
    // 1200 is clamped to 500 server-side. Comparing 500 rows to a requested
    // 1200 would report a full page as a short one and lose everything behind it.
    const page = await h.books.list({ pageSize: 1200 });
    expect(page.pageSize).toBe(500);
    expect(page.hasMore).toBe(true);
  });

  test("an empty tag list is not sent, so it cannot narrow to nothing", async () => {
    const h = harness([{ body: [] }]);
    await h.books.list({ tags: [] });
    expect(h.calls[0]!.search).not.toContain("tags");
  });
});

describe("books.mine / books.explore", () => {
  test("mine pins scope=mine", async () => {
    const h = harness([{ body: [] }]);
    await h.books.mine();
    expect(h.calls[0]!.search).toContain("extra_options%5Bscope%5D=mine");
  });

  test("explore drops the scope once a handle is given", async () => {
    const h = harness([{ body: [] }]);
    await h.books.explore({ ownerHandle: "biraj" });
    expect(h.calls[0]!.search).toContain("extra_options%5Bowner_handle%5D=biraj");
    expect(h.calls[0]!.search).not.toContain("scope");
  });

  test("explore without a handle asks for everybody else", async () => {
    const h = harness([{ body: [] }]);
    await h.books.explore();
    expect(h.calls[0]!.search).toContain("extra_options%5Bscope%5D=explore");
  });
});

describe("books.create", () => {
  test("refuses locally when the size is knowable and over the edge ceiling", async () => {
    const h = harness([{ body: book() }]);
    const huge = new Blob([new Uint8Array(8)]);
    Object.defineProperty(huge, "size", { value: BOOK_UPLOAD_EDGE_LIMIT_BYTES + 1 });

    // Uploading it would spend minutes and come back as a Cloudflare 413 whose
    // body says nothing about books.
    expect(h.books.create({ file: { data: huge, filename: "scan.pdf" } })).rejects.toThrow(TypeError);
    expect(h.calls).toHaveLength(0);
  });

  test("sends multipart with the tags as repeated fields", async () => {
    const h = harness([{ body: book() }]);
    await h.books.create({
      file: { data: new Blob(["%PDF-"]), filename: "livro.pdf" },
      title: "Livro",
      pageCount: 120,
      tags: ["a", "b"],
    });

    const call = h.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/books");
    // The runtime has to set Content-Type so the multipart boundary matches.
    expect(call.headers["content-type"]).toBeUndefined();

    const names = formEntries(call).map(([name]) => name);
    expect(names).toContain("file");
    expect(names).toContain("title");
    // Rails reads a list from repeated `tags[]` parts.
    expect(names.filter((n) => n === "tags[]")).toHaveLength(2);
    // Numbers have to be strings in a form.
    expect(formEntries(call).find(([n]) => n === "page_count")?.[1]).toBe("120");
  });

  test("does not send a visibility, because the endpoint does not read one", async () => {
    const h = harness([{ body: book() }]);
    await h.books.create({ file: { data: new Blob(["x"]), filename: "a.epub" } });
    expect(formEntries(h.calls[0]!).map(([n]) => n)).not.toContain("visibility");
  });
});

describe("books.update", () => {
  test("JSON when there is no cover, with null meaning null", async () => {
    const h = harness([{ body: book() }]);
    await h.books.update(7, { author: null, visibility: "public", tags: [] });

    const call = h.calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(jsonBody(call)).toEqual({ author: null, visibility: "public", tags: [] });
  });

  test("multipart when a cover is attached, with null spelled as the backspace sentinel", async () => {
    const h = harness([{ body: book() }]);
    await h.books.update(7, {
      author: null,
      tags: [],
      cover: { data: new Blob(["png"]), filename: "cover.png" },
    });

    const entries = formEntries(h.calls[0]!);
    // A form field has no `null`. Omitting it would mean "leave it alone".
    expect(entries.find(([n]) => n === "author")?.[1]).toBe(NULL_SENTINEL);
    // An empty array appends nothing at all, which is the opposite of clearing.
    expect(entries.find(([n]) => n === "tags[]")?.[1]).toBe("");
    expect(entries.map(([n]) => n)).toContain("cover");
  });

  test("undefined fields are absent from the body entirely", async () => {
    const h = harness([{ body: book() }]);
    await h.books.update(7, { title: "Novo" });
    expect(jsonBody(h.calls[0]!)).toEqual({ title: "Novo" });
  });
});

describe("books file access", () => {
  test("fileRange asks for one closed range and reads Content-Range back", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const h = harness([
      new Response(bytes, {
        status: 206,
        headers: { "content-range": "bytes 1024-1027/98765", "content-type": "application/pdf" },
      }),
    ]);

    const slice = await h.books.fileRange(7, { start: 1024, end: 1027 });
    expect(h.calls[0]!.headers["range"]).toBe("bytes=1024-1027");
    expect(slice.start).toBe(1024);
    expect(slice.end).toBe(1027);
    expect(slice.total).toBe(98765);
    expect(new Uint8Array(slice.data)).toEqual(bytes);
  });

  test("an open-ended range leaves the end blank", async () => {
    const h = harness([
      new Response(new Uint8Array([9]), {
        status: 206,
        headers: { "content-range": "bytes 40-40/41" },
      }),
    ]);
    await h.books.fileRange(7, { start: 40 });
    expect(h.calls[0]!.headers["range"]).toBe("bytes=40-");
  });

  test("a 200 to a Range request is refused rather than read as a slice", async () => {
    // A proxy that strips Range answers the whole file with a 200. Reading it
    // as bytes 1024.. would corrupt the reader's buffer with no error anywhere.
    const h = harness([new Response(new Uint8Array([1, 2, 3]), { status: 200 })]);
    expect(h.books.fileRange(7, { start: 1024, end: 2047 })).rejects.toThrow(OmsError);
  });

  test("the three URL builders are synchronous and carry no credential", () => {
    const h = harness([{ body: [] }]);
    expect(h.books.fileUrl(7)).toBe(`${BASE_URL}/books/7/file`);
    expect(h.books.coverUrl(7)).toBe(`${BASE_URL}/books/7/cover`);
    expect(h.books.downloadUrl(7)).toBe(`${BASE_URL}/books/7/download`);
    // A `?token=` here would put a live session credential into access logs and
    // would be counted against the anonymous 120/hour file budget.
    expect(h.books.fileUrl(7)).not.toContain("token");
  });

  test("saveProgress posts the location to the upsert route", async () => {
    const h = harness([{ body: annotation({ kind: "progress" }) }]);
    await h.books.saveProgress(7, { pageNumber: 42 });
    expect(h.calls[0]!.method).toBe("POST");
    expect(h.calls[0]!.path).toBe("/books/7/progress");
    expect(jsonBody(h.calls[0]!)).toEqual({ location: { pageNumber: 42 } });
  });
});

describe("shelves", () => {
  test("add_book posts the id in the body", async () => {
    const h = harness([{ body: shelf() }]);
    await h.shelves.addBook(3, 7);
    expect(h.calls[0]!.method).toBe("POST");
    expect(h.calls[0]!.path).toBe("/book_shelves/3/add_book");
    expect(jsonBody(h.calls[0]!)).toEqual({ book_id: 7 });
  });

  test("remove_book carries the id in the QUERY, because DELETE has no body slot", async () => {
    const h = harness([{ body: shelf() }]);
    await h.shelves.removeBook(3, 7);

    const call = h.calls[0]!;
    expect(call.method).toBe("DELETE");
    expect(call.path).toBe("/book_shelves/3/remove_book");
    // Losing this argument is a silent no-op: the action is
    // `find_by(book_id: nil)&.destroy`, which answers 200 and changes nothing.
    expect(call.search).toBe("?book_id=7");
    expect(call.body).toBeUndefined();
  });

  test("reorder refuses an empty list before spending a request", () => {
    const h = harness([{ body: shelf() }]);
    expect(h.shelves.reorder(3, [])).rejects.toThrow(TypeError);
    expect(h.calls).toHaveLength(0);
  });

  test("reorder sends the whole list in order", async () => {
    const h = harness([{ body: shelf() }]);
    await h.shelves.reorder(3, [9, 7, 8]);
    expect(jsonBody(h.calls[0]!)).toEqual({ book_ids: [9, 7, 8] });
  });

  test("list filters on the two exact columns and nothing else", async () => {
    const h = harness([{ body: [shelf()] }]);
    const page = await h.shelves.list({ userId: "usr_1", visibility: "public", order: "position:asc" });
    expect(h.calls[0]!.search).toContain("exact_search%5Buser_id%5D=usr_1");
    expect(h.calls[0]!.search).toContain("exact_search%5Bvisibility%5D=public");
    // There are no extra_options on this controller: any key there is a 400.
    expect(h.calls[0]!.search).not.toContain("extra_options");
    // The index view does not inline the books. Only `get` does.
    expect(page.items[0]!.books).toBeUndefined();
  });
});

describe("annotations", () => {
  test("create always sends a location, so an omitted one is stored as {}", async () => {
    const h = harness([{ body: annotation() }]);
    await h.annotations.create({ bookId: 7, kind: "bookmark" });
    expect(jsonBody(h.calls[0]!)).toEqual({ book_id: 7, kind: "bookmark", location: {} });
  });

  test("update omits location unless one was passed, because the server tests key presence", async () => {
    const h = harness([{ body: annotation() }]);
    await h.annotations.update(11, { note: "reler" });
    expect(jsonBody(h.calls[0]!)).toEqual({ note: "reler" });
    expect(Object.keys(jsonBody(h.calls[0]!))).not.toContain("location");
  });

  test("a kind array becomes an IN, a single kind stays scalar", async () => {
    const many = harness([{ body: [] }]);
    await many.annotations.list({ kind: ["highlight", "note"] });
    expect(many.calls[0]!.search).toContain("exact_search%5Bkind%5D%5B%5D=highlight");
    expect(many.calls[0]!.search).toContain("exact_search%5Bkind%5D%5B%5D=note");

    const one = harness([{ body: [] }]);
    await one.annotations.list({ kind: "progress" });
    expect(one.calls[0]!.search).toContain("exact_search%5Bkind%5D=progress");
  });

  test("forBook walks every page, because a heavily annotated book passes 500 rows", async () => {
    const full = Array.from({ length: 500 }, (_, i) => annotation({ id: i + 1 }));
    const h = harness([{ body: full }, { body: [annotation({ id: 501 })] }, { body: [] }]);

    const all = await h.annotations.forBook(7);
    expect(all).toHaveLength(501);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.search).toContain("modifiers%5Bpage%5D=1%3A500");
    expect(h.calls[1]!.search).toContain("modifiers%5Bpage%5D=2%3A500");
  });

  test("progressFor asks for one row and returns null when there is none", async () => {
    const h = harness([{ body: [] }]);
    expect(await h.annotations.progressFor(7)).toBeNull();
    expect(h.calls[0]!.search).toContain("exact_search%5Bkind%5D=progress");
    expect(h.calls[0]!.search).toContain("exact_search%5Bbook_id%5D=7");
    expect(h.calls[0]!.search).toContain("modifiers%5Bpage%5D=1%3A1");
  });

  test("continueReading sorts by last touched, not by creation", async () => {
    const h = harness([{ body: [annotation({ kind: "progress" })] }]);
    await h.annotations.continueReading(5);
    // created_at:desc would pin the shelf to whatever was opened first, forever.
    expect(h.calls[0]!.search).toContain("modifiers%5Border%5D=updated_at%3Adesc");
    expect(h.calls[0]!.search).toContain("modifiers%5Bpage%5D=1%3A5");
  });
});

// ---------------------------------------------------------------------------
// Chat

/** Wraps SSE frames into a streaming Response, one network chunk per string. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The same frames as one finished body, which is all React Native ever sees. */
function bufferedResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const FRAMES = [
  'data: {"delta":"Carlos "}\n\n',
  'data: {"delta":"da Maia"}\n\n',
  'data: {"done":true}\n\n',
];

/**
 * Runs `body` with `ReadableStream` taken off the global, which is exactly what
 * `supportsResponseStreaming` sees on React Native: RN's fetch is XHR under a
 * whatwg-fetch shim and the class does not exist there at all.
 */
async function withoutResponseStreaming<T>(body: () => Promise<T>): Promise<T> {
  const saved = Reflect.get(globalThis, "ReadableStream");
  Reflect.deleteProperty(globalThis, "ReadableStream");
  try {
    return await body();
  } finally {
    Object.defineProperty(globalThis, "ReadableStream", {
      value: saved,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

afterEach(() => {
  // A leaked deletion would make every later streaming test silently take the
  // buffered path and still pass.
  expect(typeof (globalThis as { ReadableStream?: unknown }).ReadableStream).toBe("function");
});

describe("chat.stream", () => {
  test("yields deltas and stops on the done frame", async () => {
    const h = harness([sseResponse(FRAMES)]);
    const seen: string[] = [];
    for await (const delta of h.library.chat.stream(7, { messages: [{ role: "user", content: "quem?" }] })) {
      seen.push(delta);
    }
    expect(seen).toEqual(["Carlos ", "da Maia"]);
    expect(h.calls[0]!.method).toBe("POST");
    expect(h.calls[0]!.path).toBe("/books/7/chat");
  });

  test("reassembles a frame split across two network chunks", async () => {
    // A `data:` line is not a network chunk and never was. Parsing per chunk
    // loses this delta and every later one on the same boundary.
    const h = harness([sseResponse(['data: {"del', 'ta":"olá"}\n\ndata: {"done":true}\n\n'])]);
    const seen: string[] = [];
    for await (const delta of h.library.chat.stream(7, { messages: [] })) seen.push(delta);
    expect(seen).toEqual(["olá"]);
  });

  test("sends the whole conversation, because there is no server-side session", async () => {
    const h = harness([sseResponse(FRAMES)]);
    const messages = [
      { role: "user" as const, content: "quem e o Carlos?" },
      { role: "assistant" as const, content: "o neto." },
      { role: "user" as const, content: "e o pai?" },
    ];
    for await (const _ of h.library.chat.stream(7, {
      messages,
      context: { kind: "selection", text: "..." },
    })) {
      // drained
    }
    const body = jsonBody(h.calls[0]!);
    expect(body["messages"]).toHaveLength(3);
    expect(body["context"]).toEqual({ kind: "selection", text: "..." });
  });

  test("an error frame inside a 200 is a BookChatError carrying what arrived first", async () => {
    const h = harness([
      sseResponse(['data: {"delta":"Carl"}\n\n', 'data: {"error":"The assistant is unavailable right now"}\n\n']),
    ]);

    const seen: string[] = [];
    let raised: unknown;
    try {
      for await (const delta of h.library.chat.stream(7, { messages: [] })) seen.push(delta);
    } catch (thrown) {
      raised = thrown;
    }

    // The status was 200: nothing that routes on status alone would notice.
    expect(raised).toBeInstanceOf(BookChatError);
    expect((raised as BookChatError).reason).toBe("assistant_unavailable");
    expect((raised as BookChatError).partial).toBe("Carl");
    expect(seen).toEqual(["Carl"]);
  });

  test("a stream that stops without a done frame is truncated, not finished", async () => {
    const h = harness([sseResponse(['data: {"delta":"meio "}\n\n', 'data: {"delta":"caminho"}\n\n'])]);
    let raised: unknown;
    try {
      for await (const _ of h.library.chat.stream(7, { messages: [] })) {
        // drained
      }
    } catch (thrown) {
      raised = thrown;
    }
    // Returning quietly here reports half an answer as a complete one.
    expect(raised).toBeInstanceOf(BookChatError);
    expect((raised as BookChatError).reason).toBe("truncated");
    expect((raised as BookChatError).partial).toBe("meio caminho");
  });

  test("ask drains the same stream into one string", async () => {
    const h = harness([sseResponse(FRAMES)]);
    expect(await h.library.chat.ask(7, { messages: [] })).toBe("Carlos da Maia");
  });

  test("503 is the assistant being full, and is not a rate limit", async () => {
    const h = harness([{ body: "The assistant is busy, try again in a moment", status: 503 }]);
    let raised: unknown;
    try {
      await h.library.chat.ask(7, { messages: [] }, { retry: false });
    } catch (thrown) {
      raised = thrown;
    }
    expect(raised).toBeInstanceOf(OmsApiError);
    expect(isBookChatBusy(raised)).toBe(true);
    // A 429 is a different problem with a different remedy.
    expect(isBookChatBusy(new OmsApiError("nope", { status: 429 }))).toBe(false);
  });
});

describe("chat on React Native", () => {
  test("the buffered path yields once and produces the identical answer", async () => {
    await withoutResponseStreaming(async () => {
      expect(bookChatIsIncremental()).toBe(false);

      // Two responses because a Response body can only be read once: the second
      // call below is a second request, not a replay of the first.
      const h = harness([bufferedResponse(FRAMES), bufferedResponse(FRAMES)]);
      const seen: string[] = [];
      for await (const delta of h.library.chat.stream(7, { messages: [] })) seen.push(delta);

      // Both deltas arrive inside ONE read, so the generator yields them one by
      // one from a buffer that was already complete. Same text, no live UI.
      expect(seen.join("")).toBe("Carlos da Maia");
      expect(await h.library.chat.ask(7, { messages: [] })).toBe("Carlos da Maia");
    });
  });

  test("the buffered path still detects a truncated answer", async () => {
    await withoutResponseStreaming(async () => {
      const h = harness([bufferedResponse(['data: {"delta":"meio"}\n\n'])]);
      let raised: unknown;
      try {
        for await (const _ of h.library.chat.stream(7, { messages: [] })) {
          // drained
        }
      } catch (thrown) {
        raised = thrown;
      }
      expect(raised).toBeInstanceOf(BookChatError);
      expect((raised as BookChatError).reason).toBe("truncated");
    });
  });

  test("bookChatIsIncremental is read live, never cached at import", () => {
    expect(bookChatIsIncremental()).toBe(true);
  });
});

describe("library entry point", () => {
  test("publicLibraries reaches the collection route on books", async () => {
    const h = harness([{ body: [{ handle: "afonso", name: "Afonso", library_name: null, library_description: null, book_count: 3 }] }]);
    const rows = await h.library.publicLibraries();
    expect(h.calls[0]!.path).toBe("/books/libraries");
    expect(rows[0]!.handle).toBe("afonso");
  });

  test("the four sub-namespaces share one transport", () => {
    const h = harness([{ body: [] }]);
    expect(h.library.books).toBeInstanceOf(LibraryBooksNamespace);
    expect(h.library.shelves).toBeInstanceOf(LibraryShelvesNamespace);
    expect(h.library.annotations).toBeInstanceOf(LibraryAnnotationsNamespace);
    expect(h.library.books.fileUrl(1)).toStartWith(BASE_URL);
  });
});
