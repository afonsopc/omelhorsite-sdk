/**
 * `bun test` coverage for the storage namespace and its direct-upload driver.
 *
 * These two modules carry the only three-phase protocol in the SDK and, until
 * this file, the only ~2100 lines of it with no test at all. Three things are
 * asserted, in the order they cost the most when wrong:
 *
 * 1. **Which filter goes on the wire.** `GET /fs_nodes` takes two different
 *    parent filters and only one of them can say "the roots". The other fails
 *    OPEN: hand it the null sentinel and the server drops the filter in silence
 *    and answers with the caller's entire tree. That is not a hypothetical - the
 *    fake index below implements both filters exactly as the Rails chain does,
 *    so the roots test genuinely observes the whole tree when the request is
 *    built the old way.
 * 2. **The 32 MiB threshold**, which is written down in three independent
 *    places (`NodeBatchCreator`, the web frontend's `upload_core.ts`, and here)
 *    and whose drift is silent in the direction that matters.
 * 3. **The three phases**, driven against a scripted object store: that bytes go
 *    to the presigned URL and NOT to Rails, that they go without the bearer
 *    token, that multipart slices with the size the SERVER reported, and that a
 *    torn run aborts its session instead of stranding parts on the store.
 *
 * The transport is a hand-built `fetch`. Both the API and the object store are
 * scripted through the SAME one, on purpose: `objectStoreFetch` is supposed to
 * reuse the injected transport rather than reach for a global, and a single
 * call log is how that gets checked.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { StorageNamespace, type FsNode } from "../src/resources/storage";
import {
  MULTIPART_THRESHOLD,
  UploadManager,
  manifestEntryFor,
  md5Base64,
} from "../src/resources/storage/upload";
import { file } from "../src/types";
import type { Progress } from "../src/types";

const BASE_URL = "https://api.test";
const STORE_URL = "https://store.test";
const TOKEN = "secret-session-token";

/** The server's null sentinel, U+0008. Spelled out so the tests read as the wire does. */
const SENTINEL = "\b";

interface RecordedCall {
  readonly url: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly method: string;
  readonly headers: Record<string, string>;
  /** Parsed JSON for an API call, the raw Blob for a store PUT. */
  readonly body: unknown;
}

type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

interface Harness {
  readonly storage: StorageNamespace;
  readonly uploads: UploadManager;
  readonly http: ApiClient;
  readonly calls: RecordedCall[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function harness(handler: Handler): Harness {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const raw = init?.body;
    const call: RecordedCall = {
      url: input,
      path: url.pathname,
      query: url.searchParams,
      method: init?.method ?? "GET",
      headers,
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => TOKEN },
  });
  return { storage: new StorageNamespace(http), uploads: new UploadManager(http), http, calls };
}

function node(overrides: Partial<FsNode> & { id: string }): FsNode {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    kind: overrides.kind ?? "file",
    parent_id: overrides.parent_id ?? null,
    size: overrides.size ?? 0,
    max_size: overrides.max_size ?? null,
    created_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
  };
}

/**
 * One user's tree: three roots, and five nodes underneath them.
 *
 * Small on purpose. The roots test is about the DIFFERENCE between three rows
 * and eight, not about volume.
 */
const HOME = node({ id: "home", name: "Home", kind: "directory", max_size: 5_000_000 });
const TRASH = node({ id: "trash", name: "Trash", kind: "directory" });
const VAULT = node({ id: "vault", name: "Vault", kind: "directory" });
const DOCS = node({ id: "docs", name: "docs", kind: "directory", parent_id: "home" });
const REPORT = node({ id: "report", name: "relatorio.pdf", parent_id: "docs", size: 1024 });
const NOTE = node({ id: "note", name: "notas.txt", parent_id: "home", size: 12 });
const PENDING = node({ id: "pending", name: "meio-carregado.bin", parent_id: "home", size: 900 });
const IN_TRASH = node({ id: "old", name: "antigo.txt", parent_id: "trash", size: 7 });

const TREE = [HOME, TRASH, VAULT, DOCS, REPORT, NOTE, PENDING, IN_TRASH];
/** Nodes whose blob never landed. `FsNode.without_pending_files` hides these. */
const PENDING_IDS = new Set(["pending"]);

/**
 * `GET /fs_nodes`, implemented the way the Rails chain implements it.
 *
 * Every step here is a line of backend code, and the whole point of the fake is
 * the third one:
 *
 * - `CrudActions#define_option_param_getter` rewrites any option value equal to
 *   `"\b"` to `nil`, for EVERY option bag - `exact_search` and `extra_options`
 *   alike. That is one shared `transform_values!`.
 * - `Searchable.exact_search` is a bare `where(params)`, so a `nil` there lands
 *   as `WHERE parent_id IS NULL`: the roots.
 * - `QueryExtraOptions::FsNodes#apply_parent_id_option` opens with
 *   `return unless params[:parent_id].present?`. `nil` is not present, so the
 *   filter is SKIPPED and the listing stays unfiltered. No error, no 400, just
 *   the whole tree with a 200 on it.
 */
function fsNodesIndex(query: URLSearchParams): FsNode[] {
  const option = (key: string): string | null | undefined => {
    const raw = query.get(key);
    if (raw === null) return undefined; // not sent
    return raw === SENTINEL ? null : raw; // CrudActions: "\b" -> nil
  };

  let rows = [...TREE];

  const exact = option("exact_search[parent_id]");
  if (exact !== undefined) rows = rows.filter((row) => row.parent_id === exact);

  const extra = option("extra_options[parent_id]");
  // `.present?` is false for nil AND for "", which is why this is the filter
  // that cannot express "no parent".
  if (extra !== undefined && extra !== null && extra !== "") {
    rows = rows.filter((row) => row.parent_id === extra || row.id === extra);
  }

  // FsNodesController#listing_scope merges without_pending_files unless asked.
  if (query.get("extra_options[include_pending]") !== "true") {
    rows = rows.filter((row) => !PENDING_IDS.has(row.id));
  }

  const [number, size] = (query.get("modifiers[page]") ?? "1:500").split(":").map(Number);
  const offset = ((number ?? 1) - 1) * (size ?? 500);
  return rows.slice(offset, offset + (size ?? 500));
}

describe("storage.list: which parent filter goes on the wire", () => {
  test("the roots are asked for with the exact_search sentinel", async () => {
    const { storage, calls } = harness((call) => json(fsNodesIndex(call.query)));

    const page = await storage.list({ parentId: null });

    expect(calls[0]?.path).toBe("/fs_nodes");
    expect(calls[0]?.query.get("exact_search[parent_id]")).toBe(SENTINEL);
    expect(calls[0]?.query.get("extra_options[parent_id]")).toBeNull();
    expect(page.items.map((item) => item.id)).toEqual(["home", "trash", "vault"]);
  });

  test("includeSelf does NOT redirect the roots into the filter that fails open", async () => {
    // The regression. Built the old way this request carried only
    // extra_options[parent_id]="\b", the server dropped the filter in silence,
    // and a call for three roots answered with the caller's whole tree.
    const { storage, calls } = harness((call) => json(fsNodesIndex(call.query)));

    const page = await storage.list({ parentId: null, includeSelf: true });

    // The damage first, so a regression reads as what the user would see.
    expect(page.items.map((item) => item.id)).toEqual(["home", "trash", "vault"]);
    expect(page.items).not.toContain(REPORT);
    // ...then the request that caused it.
    expect(calls[0]?.query.get("extra_options[parent_id]")).toBeNull();
    expect(calls[0]?.query.get("exact_search[parent_id]")).toBe(SENTINEL);
  });

  test("a real directory lists its children through exact_search", async () => {
    const { storage, calls } = harness((call) => json(fsNodesIndex(call.query)));

    const page = await storage.list({ parentId: "home" });

    expect(calls[0]?.query.get("exact_search[parent_id]")).toBe("home");
    expect(calls[0]?.query.get("extra_options[parent_id]")).toBeNull();
    expect(page.items.map((item) => item.id)).toEqual(["docs", "note"]);
  });

  test("includeSelf under a real directory folds the folder back in, and only there", async () => {
    const { storage, calls } = harness((call) => json(fsNodesIndex(call.query)));

    const page = await storage.list({ parentId: "home", includeSelf: true });

    expect(calls[0]?.query.get("extra_options[parent_id]")).toBe("home");
    expect(calls[0]?.query.get("exact_search[parent_id]")).toBeNull();
    expect(page.items.map((item) => item.id)).toEqual(["home", "docs", "note"]);
  });

  test("includePending is a separate extra option and survives either parent filter", async () => {
    const { storage, calls } = harness((call) => json(fsNodesIndex(call.query)));

    const roots = await storage.list({ parentId: "home", includePending: true });
    const folded = await storage.list({ parentId: "home", includeSelf: true, includePending: true });

    expect(calls[0]?.query.get("extra_options[include_pending]")).toBe("true");
    expect(calls[0]?.query.get("exact_search[parent_id]")).toBe("home");
    expect(roots.items.map((item) => item.id)).toEqual(["docs", "note", "pending"]);

    expect(calls[1]?.query.get("extra_options[include_pending]")).toBe("true");
    expect(calls[1]?.query.get("extra_options[parent_id]")).toBe("home");
    expect(folded.items.map((item) => item.id)).toEqual(["home", "docs", "note", "pending"]);
  });

  test("the listing asks the runtime not to revalidate, because a 304 has no body", async () => {
    const { storage, calls } = harness((call) => json(fsNodesIndex(call.query)));

    await storage.list({ parentId: "home" });

    expect(calls[0]?.headers["cache-control"]).toBe("no-cache");
  });

  test("a node comes back exactly as the blueprint sent it, with nothing invented", async () => {
    // The frontend's own type declares data, url, creator_id, updater_id and
    // destroyer_id. Three of those are real COLUMNS; none of them is a field on
    // FsNodeBlueprint or on its (empty, inheriting) :extended view.
    const { storage } = harness((call) => json(fsNodesIndex(call.query)));

    const page = await storage.list({ parentId: "docs" });

    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([
      "created_at",
      "id",
      "kind",
      "max_size",
      "name",
      "parent_id",
      "size",
      "updated_at",
    ]);
  });
});

describe("storage.list: paging", () => {
  /** A directory with more children than fit on one page. */
  const many = (count: number): FsNode[] =>
    Array.from({ length: count }, (_, index) => node({ id: `n${index}`, parent_id: "big" }));

  test("the default page is 200 rows, in the modifiers[page] string the backend parses", async () => {
    const { storage, calls } = harness(() => json([]));

    await storage.list({ parentId: "home" });

    expect(calls[0]?.query.get("modifiers[page]")).toBe("1:200");
  });

  test("a page size above the server maximum is clamped rather than sent and 500'd", async () => {
    // QueryModifier::MAX_PAGE_SIZE is 500.
    const { storage, calls } = harness(() => json([]));

    await storage.list({ parentId: "home", pageSize: 5000 });

    expect(calls[0]?.query.get("modifiers[page]")).toBe("1:500");
  });

  test("order is passed through as its own modifier", async () => {
    const { storage, calls } = harness(() => json([]));

    await storage.list({ parentId: "home", order: "name:asc" });

    expect(calls[0]?.query.get("modifiers[order]")).toBe("name:asc");
  });

  test("a full page can be walked, and the next request asks for page 2 at the same size", async () => {
    const rows = many(5);
    const { storage, calls } = harness((call) => {
      const [number, size] = (call.query.get("modifiers[page]") ?? "1:3").split(":").map(Number);
      const offset = ((number ?? 1) - 1) * (size ?? 3);
      return json(rows.slice(offset, offset + (size ?? 3)));
    });

    const first = await storage.list({ parentId: "big", pageSize: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.hasMore).toBe(true);

    const second = await first.next();
    expect(calls[1]?.query.get("modifiers[page]")).toBe("2:3");
    expect(second?.items.map((item) => item.id)).toEqual(["n3", "n4"]);
    expect(second?.page).toBe(2);
  });

  test("a short page is the last one and next() stops rather than looping", async () => {
    const { storage, calls } = harness(() => json(many(2)));

    const page = await storage.list({ parentId: "big", pageSize: 3 });

    expect(page.hasMore).toBe(false);
    expect(await page.next()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("a starting page other than 1 is honoured on the way out and on the way forward", async () => {
    const { storage, calls } = harness(() => json(many(2)));

    const page = await storage.list({ parentId: "big", page: 4, pageSize: 2 });

    expect(calls[0]?.query.get("modifiers[page]")).toBe("4:2");
    expect(page.page).toBe(4);
  });
});

describe("the multipart threshold", () => {
  test("is 32 MiB, the same number the backend and the web frontend hold", () => {
    // FsServices::NodeBatchCreator::MULTIPART_THRESHOLD = 32.megabytes
    // frontend/lib/upload_core.ts                       = 32 * 1024 * 1024
    // Changing this without changing those is an upload that dies at MinIO
    // with a signature error that never mentions checksums.
    expect(MULTIPART_THRESHOLD).toBe(32 * 1024 * 1024);
    expect(MULTIPART_THRESHOLD).toBe(33_554_432);
  });

  test("a file below it carries a checksum in the manifest, because the signature covers one", async () => {
    const entry = await manifestEntryFor(file(new TextEncoder().encode("abc"), "a.txt"), {
      clientId: "c0",
    });

    expect(entry.size).toBe(3);
    expect(entry.checksum).toBe("kAFQmDzST7DWlj99KOF/cg==");
  });

  test("a file AT the threshold carries none, matching the server's >= comparison", async () => {
    const big = new Blob([new Uint8Array(MULTIPART_THRESHOLD)], { type: "application/octet-stream" });

    const entry = await manifestEntryFor({ data: big, filename: "big.bin" }, { clientId: "c1" });

    expect(entry.size).toBe(MULTIPART_THRESHOLD);
    expect(entry.checksum).toBeUndefined();
  });

  test("a `..` segment is refused here rather than spent on a 400", async () => {
    await expect(
      manifestEntryFor(file(new Uint8Array(1), "a.txt"), { clientId: "c2", relativePath: "../etc/a.txt" }),
    ).rejects.toThrow(/\.\./);
  });
});

describe("md5Base64", () => {
  // The digest is Content-MD5-bound into the presigned signature, so a wrong
  // one is not a warning, it is a rejected upload. Vectors from `openssl md5`.
  test.each([
    ["", "1B2M2Y8AsgTpgAmY7PhCfg=="],
    ["abc", "kAFQmDzST7DWlj99KOF/cg=="],
    // 106 bytes: more than one 64-byte block, tail short enough to pad in place.
    [
      "the quick brown fox jumps over the lazy dog, twice, for good measure and to cross a 64 byte block boundary",
      "K7i0V/h/Z8wVmzCk18fjag==",
    ],
    // 120 bytes: leaves 56 bytes in the last block, the case that needs a
    // SECOND padding block rather than padding the one in hand.
    ["a".repeat(120), "X2HAzK1MrETHX/UF4fHlNw=="],
    // Large enough to arrive as several stream chunks rather than one.
    ["b".repeat(200_000), "WaKhDdFob2ee6IX8HrpRgw=="],
  ])("hashes a %#-th vector the way the object store will", async (input, expected) => {
    expect(await md5Base64(new Blob([input as string]))).toBe(expected);
  });
});

describe("the upload protocol: the direct tier", () => {
  const BYTES = new TextEncoder().encode("abc");

  /** Scripts all three phases plus the read-back listing. */
  function directHarness(): Harness {
    return harness((call) => {
      if (call.path === "/fs_nodes/batch_upload_urls") {
        return json({
          parent_id: "home",
          directories: [],
          results: [
            {
              client_id: "0-a.txt",
              fs_node_id: "new-node",
              strategy: "direct",
              upload: {
                url: `${STORE_URL}/bucket/k7f2?X-Amz-Signature=deadbeef`,
                headers: { "Content-Type": "text/plain", "Content-MD5": "kAFQmDzST7DWlj99KOF/cg==" },
                blob_signed_id: "signed-blob-1",
              },
            },
          ],
          errors: [],
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 200, headers: { etag: '"abc123"' } });
      if (call.path === "/fs_nodes/batch_attach_blobs") {
        return json({ results: [{ fs_node_id: "new-node", attached: true }] });
      }
      if (call.path === "/fs_nodes") {
        return json([node({ id: "new-node", name: "a.txt", parent_id: "home", size: 3 })]);
      }
      throw new Error(`unscripted call: ${call.method} ${call.path}`);
    });
  }

  test("runs manifest, presigned PUT, attach and read-back, in that order", async () => {
    const { storage, calls } = directHarness();

    const nodes = await storage.upload({ parentId: "home", files: [file(BYTES, "a.txt")] });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /fs_nodes/batch_upload_urls",
      "PUT /bucket/k7f2",
      "POST /fs_nodes/batch_attach_blobs",
      "GET /fs_nodes",
    ]);
    expect(nodes.map((entry) => entry.id)).toEqual(["new-node"]);
  });

  test("the manifest carries what the server needs to plan and reserve", async () => {
    const { storage, calls } = directHarness();

    await storage.upload({ parentId: "home", files: [file(BYTES, "a.txt", { contentType: "text/plain" })] });

    const body = calls[0]?.body as { parent_id: string; files: Record<string, unknown>[] };
    expect(body.parent_id).toBe("home");
    expect(body.files[0]).toEqual({
      client_id: "0-a.txt",
      name: "a.txt",
      size: 3,
      content_type: "text/plain",
      checksum: "kAFQmDzST7DWlj99KOF/cg==",
    });
  });

  test("the bytes go to the store, not to Rails, and carry no bearer token", async () => {
    // MinIO rejects a request that arrives with a presigned signature AND an
    // Authorization header: two authentication schemes on one request.
    const { storage, calls } = directHarness();

    await storage.upload({ parentId: "home", files: [file(BYTES, "a.txt")] });

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url.startsWith(STORE_URL)).toBe(true);
    expect(put?.headers["authorization"]).toBeUndefined();
    // Sent verbatim: the signature covers Content-MD5, so an edit here is a 403.
    expect(put?.headers["content-md5"]).toBe("kAFQmDzST7DWlj99KOF/cg==");
    expect(await (put?.body as Blob).text()).toBe("abc");

    // ...while the control plane does carry it.
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  test("attaching binds the signed blob id the plan handed out", async () => {
    const { storage, calls } = directHarness();

    await storage.upload({ parentId: "home", files: [file(BYTES, "a.txt")] });

    expect((calls[2]?.body as { attachments: unknown[] }).attachments).toEqual([
      { fs_node_id: "new-node", blob_signed_id: "signed-blob-1" },
    ]);
  });

  test("the read-back is one filtered listing, which is what proves the blob is bound", async () => {
    // A normal listing hides a node whose bytes never landed, so the node
    // coming back at all IS the verification.
    const { storage, calls } = directHarness();

    await storage.upload({ parentId: "home", files: [file(BYTES, "a.txt")] });

    expect(calls[3]?.query.getAll("exact_search[id][]")).toEqual(["new-node"]);
  });

  test("verify: false skips the read-back entirely", async () => {
    const { storage, calls } = directHarness();

    const nodes = await storage.upload({ parentId: "home", files: [file(BYTES, "a.txt")], verify: false });

    expect(calls.map((call) => call.path)).not.toContain("/fs_nodes");
    expect(nodes).toEqual([]);
  });

  test("a per-file rejection is reported, not thrown, and the rest of the batch lands", async () => {
    const { uploads } = harness((call) => {
      if (call.path === "/fs_nodes/batch_upload_urls") {
        return json({
          parent_id: "home",
          directories: [],
          results: [
            {
              client_id: "1-b.txt",
              fs_node_id: "node-b",
              strategy: "direct",
              upload: { url: `${STORE_URL}/bucket/b`, headers: {}, blob_signed_id: "signed-b" },
            },
          ],
          errors: [{ client_id: "0-a.txt", code: "quota_exceeded", message: "Not enough space" }],
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 200 });
      if (call.path === "/fs_nodes/batch_attach_blobs") {
        return json({ results: [{ fs_node_id: "node-b", attached: true }] });
      }
      return json([node({ id: "node-b", name: "b.txt", parent_id: "home" })]);
    });

    const results = await uploads.upload({
      parentId: "home",
      files: [file(new Uint8Array(1), "a.txt"), file(new Uint8Array(1), "b.txt")],
    });

    expect(results[0]?.error?.code).toBe("quota_exceeded");
    expect(results[0]?.fs_node_id).toBeNull();
    expect(results[1]?.error).toBeUndefined();
    expect(results[1]?.node?.id).toBe("node-b");
  });

  test("an attach that answers 200 with attached:false is still a failure", async () => {
    const { uploads } = harness((call) => {
      if (call.path === "/fs_nodes/batch_upload_urls") {
        return json({
          parent_id: "home",
          directories: [],
          results: [
            {
              client_id: "0-a.txt",
              fs_node_id: "node-a",
              strategy: "direct",
              upload: { url: `${STORE_URL}/bucket/a`, headers: {}, blob_signed_id: "signed-a" },
            },
          ],
          errors: [],
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 200 });
      if (call.path === "/fs_nodes/batch_attach_blobs") {
        return json({ results: [{ fs_node_id: "node-a", attached: false, code: "blob_not_found" }] });
      }
      return json([]);
    });

    const results = await uploads.upload({ parentId: "home", files: [file(new Uint8Array(1), "a.txt")] });

    expect(results[0]?.error?.code).toBe("blob_not_found");
  });

  test("a 4xx from the store is not retried: an expired signature does not improve", async () => {
    let puts = 0;
    const { uploads } = harness((call) => {
      if (call.path === "/fs_nodes/batch_upload_urls") {
        return json({
          parent_id: "home",
          directories: [],
          results: [
            {
              client_id: "0-a.txt",
              fs_node_id: "node-a",
              strategy: "direct",
              upload: { url: `${STORE_URL}/bucket/a`, headers: {}, blob_signed_id: "signed-a" },
            },
          ],
          errors: [],
        });
      }
      if (call.method === "PUT") {
        puts += 1;
        return new Response("<Error><Message>Signature does not match</Message></Error>", { status: 403 });
      }
      return json([]);
    });

    const results = await uploads.upload({ parentId: "home", files: [file(new Uint8Array(1), "a.txt")] });

    expect(puts).toBe(1);
    expect(results[0]?.error?.message).toMatch(/Signature does not match/);
  });
});

describe("the upload protocol: the multipart tier", () => {
  const BODY = "0123456789"; // 10 bytes, sliced into 4 + 4 + 2 by the server's part_size

  /**
   * Scripts start / part_urls / complete. The plan says `multipart` regardless
   * of size: the SERVER picks the strategy, so a ten-byte body exercises the
   * whole flow without allocating 32 MiB.
   */
  function multipartHarness(options: { failPart?: number } = {}): Harness {
    return harness((call) => {
      if (call.path === "/fs_nodes/batch_upload_urls") {
        return json({
          parent_id: "home",
          directories: [],
          results: [{ client_id: "0-big.bin", fs_node_id: "node-m", strategy: "multipart" }],
          errors: [],
        });
      }
      if (call.path === "/fs_nodes/node-m/multipart/start") {
        return json({ upload_token: "signed-token", part_size: 4, part_count: 3 });
      }
      if (call.path === "/fs_nodes/node-m/multipart/part_urls") {
        const numbers = (call.body as { part_numbers: number[] }).part_numbers;
        return json({ part_urls: numbers.map((n) => ({ part_number: n, url: `${STORE_URL}/bucket/m?part=${n}` })) });
      }
      if (call.method === "PUT") {
        const part = Number(call.query.get("part"));
        if (options.failPart === part) return new Response("<Error><Message>nope</Message></Error>", { status: 403 });
        // Quoted, the way S3 and MinIO actually answer.
        return new Response(null, { status: 200, headers: { etag: `"etag-${part}"` } });
      }
      if (call.path === "/fs_nodes/node-m/multipart/complete") return json({ attached: true, byte_size: 10 });
      if (call.path === "/fs_nodes/node-m/multipart/abort") return json({ aborted: true });
      if (call.path === "/fs_nodes") return json([node({ id: "node-m", name: "big.bin", parent_id: "home", size: 10 })]);
      throw new Error(`unscripted call: ${call.method} ${call.path}`);
    });
  }

  test("drives start, part_urls, the parts and complete, and never calls attach_blobs", async () => {
    // multipart/complete creates the blob row itself; a batch_attach_blobs on
    // this tier would be a second, wrong finalisation.
    const { storage, calls } = multipartHarness();

    await storage.upload({ parentId: "home", files: [file(new TextEncoder().encode(BODY), "big.bin")] });

    expect(calls.map((call) => call.path)).toEqual([
      "/fs_nodes/batch_upload_urls",
      "/fs_nodes/node-m/multipart/start",
      "/fs_nodes/node-m/multipart/part_urls",
      "/bucket/m",
      "/bucket/m",
      "/bucket/m",
      "/fs_nodes/node-m/multipart/complete",
      "/fs_nodes",
    ]);
  });

  test("slices with the part size the SERVER reported, not with the local constant", async () => {
    const { storage, calls } = multipartHarness();

    await storage.upload({ parentId: "home", files: [file(new TextEncoder().encode(BODY), "big.bin")] });

    const puts = calls.filter((call) => call.method === "PUT");
    expect(await Promise.all(puts.map((put) => (put.body as Blob).text()))).toEqual(["0123", "4567", "89"]);
  });

  test("part ETags are unquoted and sorted before they are handed back to complete", async () => {
    const { storage, calls } = multipartHarness();

    await storage.upload({ parentId: "home", files: [file(new TextEncoder().encode(BODY), "big.bin")] });

    const complete = calls.find((call) => call.path.endsWith("/multipart/complete"));
    expect(complete?.body).toEqual({
      upload_token: "signed-token",
      parts: [
        { part_number: 1, etag: "etag-1" },
        { part_number: 2, etag: "etag-2" },
        { part_number: 3, etag: "etag-3" },
      ],
    });
  });

  test("a torn transfer aborts the session instead of stranding parts and quota", async () => {
    // Without the abort the parts stay on the store and the node stays charged
    // against the root's quota until a reaper notices, which is a schedule and
    // not a plan.
    const { uploads, calls } = multipartHarness({ failPart: 2 });

    const results = await uploads.upload({
      parentId: "home",
      files: [file(new TextEncoder().encode(BODY), "big.bin")],
    });

    const abort = calls.find((call) => call.path.endsWith("/multipart/abort"));
    expect(abort?.body).toEqual({ upload_token: "signed-token" });
    expect(calls.some((call) => call.path.endsWith("/multipart/complete"))).toBe(false);
    expect(results[0]?.error?.message).toMatch(/nope/);
  });

  test("a store that hides its ETag fails loudly rather than completing with nothing", async () => {
    // In a browser this is a bucket whose CORS policy omits ETag from
    // Access-Control-Expose-Headers, and the failure is otherwise invisible.
    const { uploads } = harness((call) => {
      if (call.path === "/fs_nodes/batch_upload_urls") {
        return json({
          parent_id: "home",
          directories: [],
          results: [{ client_id: "0-big.bin", fs_node_id: "node-m", strategy: "multipart" }],
          errors: [],
        });
      }
      if (call.path === "/fs_nodes/node-m/multipart/start") return json({ upload_token: "t", part_size: 4, part_count: 3 });
      if (call.path === "/fs_nodes/node-m/multipart/part_urls") {
        const numbers = (call.body as { part_numbers: number[] }).part_numbers;
        return json({ part_urls: numbers.map((n) => ({ part_number: n, url: `${STORE_URL}/b?part=${n}` })) });
      }
      if (call.method === "PUT") return new Response(null, { status: 200 });
      if (call.path === "/fs_nodes/node-m/multipart/abort") return json({ aborted: true });
      return json([]);
    });

    const results = await uploads.upload({
      parentId: "home",
      files: [file(new TextEncoder().encode(BODY), "big.bin")],
    });

    expect(results[0]?.error?.message).toMatch(/ETag/);
  });

  test("resuming counts the parts already on the store instead of restarting the bar at zero", async () => {
    const { uploads, calls } = multipartHarness();
    const seen: Progress[] = [];

    await uploads.uploadMultipart("node-m", new Blob([BODY]), {
      resume: { uploadToken: "signed-token", partSize: 4, parts: [{ part_number: 1, etag: "etag-1" }] },
      onProgress: (progress) => seen.push(progress),
    });

    expect(seen.map((entry) => entry.loaded)).toEqual([4, 8, 10]);
    expect(seen.every((entry) => entry.total === 10)).toBe(true);
    // Part 1 was not asked for again, and no new session was started.
    expect(calls.some((call) => call.path.endsWith("/multipart/start"))).toBe(false);
    expect((calls[0]?.body as { part_numbers: number[] }).part_numbers).toEqual([2, 3]);
  });
});

describe("upload progress", () => {
  test("counts the whole run and never reports one file's total as the run's", async () => {
    // The per-file drivers have an onProgress of their own. Forwarding the
    // run's callback to them made the bar report `3 of 3` between two `n of 9`
    // reports, which reads as a bar that finishes and then goes backwards.
    const { storage } = harness((call) => {
      if (call.path === "/fs_nodes/batch_upload_urls") {
        return json({
          parent_id: "home",
          directories: [],
          results: [
            {
              client_id: "0-a.txt",
              fs_node_id: "node-a",
              strategy: "direct",
              upload: { url: `${STORE_URL}/a`, headers: {}, blob_signed_id: "sa" },
            },
            {
              client_id: "1-b.txt",
              fs_node_id: "node-b",
              strategy: "direct",
              upload: { url: `${STORE_URL}/b`, headers: {}, blob_signed_id: "sb" },
            },
          ],
          errors: [],
        });
      }
      if (call.method === "PUT") return new Response(null, { status: 200 });
      if (call.path === "/fs_nodes/batch_attach_blobs") {
        return json({
          results: [
            { fs_node_id: "node-a", attached: true },
            { fs_node_id: "node-b", attached: true },
          ],
        });
      }
      return json([]);
    });

    const seen: Progress[] = [];
    await storage.upload(
      {
        parentId: "home",
        files: [file(new Uint8Array(3), "a.txt"), file(new Uint8Array(6), "b.txt")],
        verify: false,
      },
      { onProgress: (progress) => seen.push(progress) },
    );

    expect(seen.every((entry) => entry.total === 9)).toBe(true);
    expect(seen.every((entry) => entry.phase === "upload")).toBe(true);
    expect(seen[0]?.loaded).toBe(0);
    expect(seen.at(-1)?.loaded).toBe(9);
    // Monotonic, which is the property a bar actually depends on.
    expect(seen.map((entry) => entry.loaded)).toEqual([...seen.map((entry) => entry.loaded)].sort((a, b) => a - b));
  });
});

describe("the low-level primitives a caller builds its own bar out of", () => {
  test("createBatch refuses a manifest the server would 400 anyway", async () => {
    const { uploads } = harness(() => json({}));

    await expect(uploads.createBatch({ parentId: "home", files: [] })).rejects.toThrow(/empty/i);
    await expect(
      uploads.createBatch({
        parentId: "home",
        files: Array.from({ length: 101 }, (_, i) => ({ client_id: `c${i}`, name: `f${i}`, size: 1 })),
      }),
    ).rejects.toThrow(/100/);
  });

  test("createBatch is never retried, because a replay mints a second set of nodes", async () => {
    let attempts = 0;
    const { uploads } = harness(() => {
      attempts += 1;
      return json({ error: "boom" }, 500);
    });

    await expect(uploads.createBatch({ parentId: "home", files: [{ client_id: "c", name: "f", size: 1 }] })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test("putDirect reports once, at the end, with loaded === total", async () => {
    const { uploads } = harness(() => new Response(null, { status: 200, headers: { etag: '"e"' } }));
    const seen: Progress[] = [];

    const etag = await uploads.putDirect(
      { url: `${STORE_URL}/x`, headers: { "Content-MD5": "m" }, blob_signed_id: "s" },
      new Blob(["hello"]),
      { onProgress: (progress) => seen.push(progress) },
    );

    expect(etag).toBe('"e"');
    expect(seen).toEqual([{ phase: "upload", loaded: 5, total: 5 }]);
  });

  test("attachBlobs answers per item, so success is read off `attached` and not off the status", async () => {
    const { uploads } = harness(() =>
      json({
        results: [
          { fs_node_id: "a", attached: true },
          { fs_node_id: "b", attached: false, code: "already_attached" },
        ],
      }),
    );

    const results = await uploads.attachBlobs([
      { fs_node_id: "a", blob_signed_id: "sa" },
      { fs_node_id: "b", blob_signed_id: "sb" },
    ]);

    expect(results.map((entry) => entry.attached)).toEqual([true, false]);
    expect(results[1]?.code).toBe("already_attached");
  });

  test("multipartPartUrls refuses more than the server presigns in one call", async () => {
    const { uploads } = harness(() => json({ part_urls: [] }));

    expect(await uploads.multipartPartUrls("n", { uploadToken: "t", partNumbers: [] })).toEqual([]);
    await expect(
      uploads.multipartPartUrls("n", { uploadToken: "t", partNumbers: Array.from({ length: 101 }, (_, i) => i + 1) }),
    ).rejects.toThrow(/100/);
  });

  test("multipartComplete sorts the parts, because S3 assembles in the order it is given", async () => {
    const { uploads, calls } = harness(() => json({ attached: true, byte_size: 3 }));

    await uploads.multipartComplete("n", {
      uploadToken: "t",
      parts: [
        { part_number: 3, etag: "c" },
        { part_number: 1, etag: "a" },
        { part_number: 2, etag: "b" },
      ],
    });

    expect((calls[0]?.body as { parts: { part_number: number }[] }).parts.map((part) => part.part_number)).toEqual([
      1, 2, 3,
    ]);
  });

  test("multipartComplete refuses an empty part list rather than assembling nothing", async () => {
    const { uploads } = harness(() => json({}));

    await expect(uploads.multipartComplete("n", { uploadToken: "t", parts: [] })).rejects.toThrow(/no parts/i);
  });
});

describe("the bulk endpoints share one twelve-a-minute bucket", () => {
  test("copy and trash refuse an empty selection, which the server would read as `everything`", async () => {
    // The endpoints run the same filters the index does, so a call with no
    // selection resolves to the caller's entire listable tree.
    const { storage } = harness(() => json({ job_id: "j" }));

    await expect(storage.copy({ ids: [], newParentId: "home" })).rejects.toThrow(/whole tree/);
    await expect(storage.trash([])).rejects.toThrow(/whole tree/);
  });

  test("a selection is sent as an explicit id list and answers with a job id", async () => {
    const { storage, calls } = harness(() => json({ job_id: "job-1" }));

    const job = await storage.trash(["a", "b"]);

    expect(calls[0]?.path).toBe("/fs_nodes/move_to_trash");
    expect(calls[0]?.body).toEqual({ exact_search: { id: ["a", "b"] } });
    expect(job.jobId).toBe("job-1");
  });
});
