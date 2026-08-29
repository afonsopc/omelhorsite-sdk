/**
 * The `storage` namespace: the virtual filesystem.
 *
 * A node is a file or a directory, identified by an opaque id. Since the ltree
 * migration the id IS the address: there is no `path` column any more, and
 * navigation goes parent id -> children, with `ancestors()` for a breadcrumb.
 * Never build or parse a path string.
 *
 * {@link StorageNamespace.resolvePath} exists for humans typing `docs/a.pdf`,
 * and it is exactly what it looks like: one request per segment, walking
 * `name` + `parent_id` down the filtered index. It memoises what it learns per
 * client instance so a CLI session does not re-walk the same prefix, but the
 * cheap call is always the one that already has an id.
 *
 * Uploads do NOT stream through this namespace. Bytes go straight to object
 * storage with a presigned URL; Rails only mints the plan and, at the end,
 * binds the blob. That whole dance lives in `storage/upload.ts` and is reached
 * through {@link StorageNamespace.upload}.
 *
 * Four throttles bound what this namespace can do, and they are far tighter
 * than the API's general ceiling:
 *
 * - `fs_upload` - 300/min for the whole upload control plane. Paced by
 *   {@link UploadManager}.
 * - `fs_bulk_job` - TWELVE a minute for `copy`, `createDirectories`,
 *   `emptyTrash` and `trash` together. Paced by {@link StorageNamespace.bulkGate}.
 * - the general 600/min for everything else.
 * - the direct PUTs at the object store, which rack-attack never sees at all.
 */

/**
 * The server's null sentinel: U+0008, a literal backspace.
 *
 * `CrudActions` rewrites any filter value equal to it before the query layer
 * ever sees it - `transform_values! { |v| v == "\b" ? nil : v }`, applied to
 * every option bag, not just to `exact_search`. Through `exact_search` that is
 * exactly what is wanted: `where(parent_id: nil)`, the root nodes.
 *
 * Through `extra_options` the same rewrite is a trap, because
 * `QueryExtraOptions::FsNodes` opens with
 * `return unless params[:parent_id].present?` and `nil` is not present, so the
 * filter is dropped without a word. {@link StorageNamespace.list} is built
 * around that difference; do not collapse the two filters back together.
 */
import { type ApiClient, filenameFromDisposition, NULL_SENTINEL, pageModifier, Resource } from "../http";
import { OmsApiError, OmsError } from "../errors";
import { createPage } from "../types";
import type {
  BaseRecord,
  FetchLike,
  FileOutput,
  Id,
  OperationOptions,
  Paginated,
  PageParams,
  QueryValue,
  RequestOptions,
} from "../types";
import type { User } from "./account";
import { FS_BULK_JOB_RATE_LIMIT, StorageRateGate, UploadManager, objectStoreFetch } from "./storage/upload";
import type { UploadInput } from "./storage/upload";

/** What a node is. */
export type FsNodeKind = "file" | "directory";

/**
 * A node in the virtual filesystem.
 *
 * This is the WHOLE record, and it was checked against the blueprint CHAIN
 * rather than against the table, because those two disagree.
 * `FsNodeBlueprint` declares `name`, `parent_id`, `kind`, `size`,
 * `max_size`; it extends `ApplicationBlueprint`, which contributes `id`,
 * `created_at` and `updated_at`; and its `:extended` view has an EMPTY body,
 * which in Blueprinter inherits the base fields rather than emitting nothing.
 * So `list`, `get`, `create` and `update` all answer the same eight fields.
 * Reading a view name and assuming it adds something has already produced bugs
 * in this repo - follow the `<` before deciding a field does or does not exist.
 *
 * The `fs_nodes` TABLE is wider than that, and the difference is never sent:
 * `creator_id`, `updater_id`, `destroyer_id`, `signed_url_generated`,
 * `is_vault_root` and the `id_path` ltree are all real columns that appear in
 * no view. Declaring them client-side is worse than leaving them out, because
 * every later reader then believes they arrive.
 *
 * There is no `data` and no `url` field either: bytes are reached through
 * {@link StorageNamespace.download}, {@link StorageNamespace.downloadStream} or
 * {@link StorageNamespace.downloadUrl}, never off the record. And no
 * `content_type` and no `path` - the type is decided from the name at download
 * time, and the `path` column was dropped in the ltree migration.
 */
export interface FsNode extends BaseRecord {
  readonly name: string;
  readonly kind: FsNodeKind;
  /** `null` only for a root (home, trash, vault). */
  readonly parent_id: Id | null;
  /** Bytes. For a directory, the recursive total. */
  readonly size: number;
  /** Quota ceiling. Set on roots only; `null` means no ceiling. */
  readonly max_size: number | null;
}

/** One link in a breadcrumb chain. */
export interface FsBreadcrumb {
  readonly id: Id;
  readonly name: string;
  readonly kind: FsNodeKind;
}

/** `GET /fs_nodes/roots` - the ids a client needs to bootstrap navigation. */
export interface FsRoots {
  readonly home: Id | null;
  readonly trash: Id | null;
  /** `null` until the encrypted vault is used for the first time. */
  readonly vault: Id | null;
}

/**
 * A bulk operation the server runs in the background.
 *
 * `copy`, `createDirectories`, `trash` and `emptyTrash` all answer with nothing
 * but a job id: the work happens in a worker and the response says only that it
 * was enqueued. Poll it with `oms.jobs.wait(jobId)`; this namespace has no
 * access to the jobs namespace and deliberately does not grow a second polling
 * loop.
 */
export interface FsBulkJob {
  /** Feed this to `oms.jobs.get` / `oms.jobs.wait`. */
  readonly jobId: Id;
}

/**
 * A response body streamed rather than buffered.
 *
 * The zip endpoint has no `Content-Length` (it is generated as it is sent) and
 * a stored file can be larger than any sane heap, so both are handed over as a
 * stream. The caller owns it and must consume or cancel it.
 */
export interface FsStream {
  readonly stream: ReadableStream<Uint8Array>;
  /** Filename the server suggested, from `Content-Disposition`. */
  readonly filename: string | undefined;
  readonly contentType: string | undefined;
  /** Byte length when the server sent one. Always `undefined` for a zip. */
  readonly size: number | undefined;
}

/** Filters for {@link StorageNamespace.list}. */
export interface ListFsNodesParams extends PageParams {
  /**
   * Directory to list. `null` lists the caller's ROOT nodes (home, trash,
   * vault), which the server selects through its `\b` null sentinel.
   */
  readonly parentId: Id | null;
  /**
   * Include nodes whose bytes never landed. Off by default, because a
   * half-finished upload is not something a user wants to see - and because a
   * node's absence from a normal listing is the only proof its blob is bound.
   */
  readonly includePending?: boolean;
  /**
   * Also return the parent itself, so one call gets both the folder's metadata
   * and its children. It occupies a slot on the page like any other row.
   *
   * IGNORED when `parentId` is `null`, and that is a correction rather than a
   * convenience: the server-side filter behind this flag cannot express "no
   * parent" at all, and asking it to used to answer with the caller's whole
   * tree. The roots have no folder to fold in anyway. The detail is on
   * {@link StorageNamespace.list}.
   */
  readonly includeSelf?: boolean;
}

/** Arguments for creating directories. */
export interface CreateDirectoriesInput {
  /** Directory to create under. */
  readonly parentId: Id;
  /**
   * Relative paths, e.g. `["fotos", "fotos/2024"]`. Intermediate levels are
   * created as needed and an existing level is reused, so this is idempotent.
   * A `..` segment is rejected by the server.
   */
  readonly paths: string[];
}

/** Arguments for copying nodes. */
export interface CopyFsNodesInput {
  readonly ids: Id[];
  readonly newParentId: Id;
}

/**
 * A sharing grant on a node.
 *
 * There is no expiry and no read/write enum: access is the single `editable`
 * boolean, and a grant lives until someone deletes it.
 */
export interface FsGrant extends BaseRecord {
  readonly fs_node_id: Id;
  /** Who issued it. Always a real user. */
  readonly grantor_id: Id;
  /** Grantee, or `null` for a public link grant that anyone with the URL may read. */
  readonly grantee_id: Id | null;
  /** Write access. Always `false` on a public grant - the server validates it. */
  readonly editable: boolean;
  /** Only on the `:extended` view, i.e. from `get`, `create` and `update`. */
  readonly fs_node?: FsNode;
  readonly grantor?: User;
  readonly grantee?: User | null;
}

/** Arguments for sharing a node. */
export interface CreateFsGrantInput {
  readonly fsNodeId: Id;
  /**
   * Grantee's user id. Omit it (or pass `null`) for a public link grant, which
   * must be read-only.
   */
  readonly granteeId?: Id | null;
  /** Write access. Rejected with `editable` on a public grant. */
  readonly editable?: boolean;
}

/** The scoped view behind a share link, from `GET /fs_nodes/:id/shared`. */
export interface SharedFsNodeView {
  readonly node: FsNode;
  /** Every descendant when `node` is a directory, and nothing else - never siblings, never ancestors. */
  readonly descendants: FsNode[];
  /** The grant that authorised the view, when one was found. */
  readonly grant: {
    readonly id: Id;
    readonly editable: boolean;
    readonly grantor_id: Id;
    readonly public: boolean;
  } | null;
  readonly scope_root_id: Id;
}

/**
 * Sharing grants, reachable as `oms.storage.grants`.
 *
 * Creating one with a `granteeId` notifies that user. Creating one WITHOUT a
 * grantee mints a public link: the server also creates a short link in the `ss`
 * namespace whose endpoint is the grant's own id, pointing at the frontend's
 * `/storage/shared?id=<node>` page. Deleting the grant deletes that link.
 */
export class FsGrantsNamespace extends Resource {
  /**
   * `GET /fs_grants` - the grants you hold: issued by you, or issued to you.
   *
   * There is no server-side filter for the node. The controller allows only
   * `id`, `created_at` and `updated_at` as search keys, and an unknown key is a
   * 400, not a wider result - so narrowing to one node is a client-side filter
   * over this listing. {@link StorageNamespace.shared} is the cheap way to ask
   * "how is THIS node shared".
   *
   * @throws {OmsAuthError} 401 when anonymous.
   */
  async list(params: PageParams = {}, options: RequestOptions = {}): Promise<Paginated<FsGrant>> {
    const pageSize = params.pageSize ?? 100;
    const load = async (page: { page: number; pageSize: number }): Promise<FsGrant[]> =>
      (await this.http.get<FsGrant[]>("/fs_grants", {
        ...options,
        query: {
          modifiers: {
            page: pageModifier(page.page, page.pageSize),
            ...(params.order === undefined ? {} : { order: params.order }),
          },
        },
        headers: noRevalidate(options.headers),
      })) ?? [];

    const first = params.page ?? 1;
    return createPage(await load({ page: first, pageSize }), first, pageSize, load);
  }

  /** `GET /fs_grants/:id` - one grant, with its node, grantor and grantee expanded. */
  async get(id: Id, options: RequestOptions = {}): Promise<FsGrant> {
    return this.http.get<FsGrant>(`/fs_grants/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /fs_grants` - shares a node.
   *
   * @throws {OmsApiError} 400 when a public grant asks for `editable: true`,
   *   401 when the caller cannot edit the node.
   */
  async create(input: CreateFsGrantInput, options: RequestOptions = {}): Promise<FsGrant> {
    return this.http.post<FsGrant>(
      "/fs_grants",
      {
        fs_node_id: input.fsNodeId,
        grantee_id: input.granteeId ?? null,
        editable: input.editable ?? false,
      },
      options,
    );
  }

  /**
   * `PATCH /fs_grants/:id` - changes the grantee or the write flag.
   *
   * Only the grantor may do this. There is nothing else to change: a grant has
   * no expiry.
   */
  async update(
    id: Id,
    input: { granteeId?: Id | null; editable?: boolean },
    options: RequestOptions = {},
  ): Promise<FsGrant> {
    return this.http.patch<FsGrant>(
      `/fs_grants/${encodeURIComponent(id)}`,
      {
        ...(input.granteeId === undefined ? {} : { grantee_id: input.granteeId }),
        ...(input.editable === undefined ? {} : { editable: input.editable }),
      },
      options,
    );
  }

  /** `DELETE /fs_grants/:id` - revokes a share and destroys its short link. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/fs_grants/${encodeURIComponent(id)}`, options);
  }
}

/** The `storage` namespace, reachable as `oms.storage`. */
export class StorageNamespace extends Resource {
  /** The presigned direct-upload driver. */
  readonly uploads: UploadManager;
  /** Sharing grants. */
  readonly grants: FsGrantsNamespace;
  /**
   * Paces the four bulk-job endpoints against the `fs_bulk_job` throttle, which
   * is twelve requests a minute for all of them together. A loop that trashes
   * files one at a time waits here rather than collecting 429s.
   */
  readonly bulkGate: StorageRateGate;

  /**
   * Memoised `(parentId, name) -> id` lookups, plus the roots.
   *
   * Positive results only: caching a miss would hide a file created a second
   * later. Invalidated whenever this client moves, renames, trashes or deletes
   * a node - never when ANOTHER client does, which is the cache's one real
   * limitation and the reason {@link clearCache} is public.
   */
  private readonly children = new Map<string, Id>();
  private rootsCache: FsRoots | undefined;
  private readonly transport: FetchLike;

  /** Entries kept before the oldest is evicted. Bounds a long-lived isolate. */
  private static readonly CACHE_LIMIT = 2048;

  constructor(http: ApiClient) {
    super(http);
    this.uploads = new UploadManager(http);
    this.grants = new FsGrantsNamespace(http);
    this.bulkGate = new StorageRateGate(FS_BULK_JOB_RATE_LIMIT);
    this.transport = objectStoreFetch(http);
  }

  /**
   * `GET /fs_nodes/roots` - the home, trash and vault node ids. Call this once
   * and navigate from there; there is no path to build.
   *
   * Memoised, because roots do not move. `vault` is `null` until the encrypted
   * vault is used for the first time - {@link vaultRoot} creates it.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   */
  async roots(options: RequestOptions = {}): Promise<FsRoots> {
    if (this.rootsCache) return this.rootsCache;
    const roots = await this.http.get<FsRoots>("/fs_nodes/roots", {
      ...options,
      headers: noRevalidate(options.headers),
    });
    this.rootsCache = roots;
    return roots;
  }

  /**
   * `GET /fs_nodes` - the children of a directory, or the roots when
   * `parentId` is `null`.
   *
   * Anonymous callers get an empty listing, always: the listing scope is the
   * caller's own tree plus what was explicitly shared with them, and a public
   * grant is deliberately NOT enumerable. Reach a publicly-shared node by id
   * with {@link get} or {@link shared} instead.
   *
   * TWO server-side filters address a directory and they are NOT
   * interchangeable. That asymmetry is the whole subtlety of this method:
   *
   * - `exact_search[parent_id]` reaches `Searchable.exact_search`, which is a
   *   bare `where(params)`. The controller has already rewritten a `\b` value
   *   to `nil` by then, so the sentinel lands as `WHERE parent_id IS NULL` -
   *   and since `FsNode.root_nodes` is exactly `where(parent_id: nil)`, this is
   *   the only filter in the API that can say "the roots". The ltree
   *   `id_path` is the source of truth for ANCESTRY, but rootness is still a
   *   null `parent_id`.
   * - `extra_options[parent_id]` reaches `QueryExtraOptions::FsNodes`, which
   *   runs `where(parent_id: x).or(where(id: x))` and so folds the folder
   *   itself back into its own listing. Convenient - and guarded by
   *   `return unless params[:parent_id].present?`, with that same `\b` -> `nil`
   *   rewrite happening first. Hand it the sentinel and the guard drops the
   *   filter IN SILENCE. The request still answers 200; it just answers with
   *   the caller's ENTIRE listable tree, page after page, instead of three
   *   rows. It is the same failure shape as the `inside_path` incident that
   *   `reject_unknown_filter_keys!` was written for, except this key IS known,
   *   so nothing rejects it.
   *
   * Hence `includeSelf` is honoured under a real directory and ignored at the
   * top of the tree. Not client-side taste: it is the only combination the
   * server can actually express.
   *
   * The endpoint is conditional-GET aware and answers 304 to a matching
   * `If-None-Match`. The SDK never sends one, and asks the runtime not to
   * revalidate on its own, because a 304 has no body and would surface here as
   * an error rather than as an empty page.
   */
  async list(params: ListFsNodesParams, options: RequestOptions = {}): Promise<Paginated<FsNode>> {
    const pageSize = params.pageSize ?? 200;
    const parentId = params.parentId ?? null;
    // See the note above: only exact_search can express "no parent", so at the
    // top of the tree the request is built as though includeSelf were off.
    const foldSelfIn = parentId !== null && params.includeSelf === true;

    const extraOptions: Record<string, QueryValue> = {};
    if (foldSelfIn) extraOptions["parent_id"] = parentId;
    if (params.includePending) extraOptions["include_pending"] = true;

    const load = async (page: { page: number; pageSize: number }): Promise<FsNode[]> =>
      (await this.http.get<FsNode[]>("/fs_nodes", {
        ...options,
        query: {
          // The sentinel travels as a literal string rather than as `null`, so
          // this call does not depend on how the encoder treats null.
          ...(foldSelfIn ? {} : { exact_search: { parent_id: parentId ?? NULL_SENTINEL } }),
          ...(Object.keys(extraOptions).length > 0 ? { extra_options: extraOptions } : {}),
          modifiers: {
            page: pageModifier(page.page, page.pageSize),
            ...(params.order === undefined ? {} : { order: params.order }),
          },
        },
        headers: noRevalidate(options.headers),
      })) ?? [];

    const first = params.page ?? 1;
    return createPage(await load({ page: first, pageSize }), first, pageSize, load);
  }

  /**
   * `GET /fs_nodes/:id` - one node.
   *
   * Resolves against the broader `viewable_by` scope, so a node reached through
   * a public share link answers here even though it never appears in
   * {@link list}.
   *
   * @throws {OmsApiError} 404 when the node does not exist or is not visible.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<FsNode> {
    return this.http.get<FsNode>(`/fs_nodes/${encodeURIComponent(id)}`, options);
  }

  /** Alias for {@link get}, for callers who think in filesystem verbs. */
  async stat(id: Id, options: RequestOptions = {}): Promise<FsNode> {
    return this.get(id, options);
  }

  /**
   * `GET /fs_nodes/:id/ancestors` - the breadcrumb chain, root first, the node
   * itself last. Ancestors the caller may not list are omitted, so a shared
   * node never leaks the names of its parents - which also means the chain can
   * be shorter than the real depth, and its first entry is not necessarily a
   * root.
   */
  async ancestors(id: Id, options: RequestOptions = {}): Promise<FsBreadcrumb[]> {
    const answer = await this.http.get<{ items: FsBreadcrumb[] }>(
      `/fs_nodes/${encodeURIComponent(id)}/ancestors`,
      { ...options, headers: noRevalidate(options.headers) },
    );
    return answer?.items ?? [];
  }

  /**
   * Resolves a slash-separated path under a starting node, walking children one
   * level at a time.
   *
   * A convenience for humans and CLIs, NOT how the API works. The `path` column
   * was dropped in the ltree migration and nothing on the server accepts a path
   * string, so each segment costs one filtered listing. Results are memoised
   * per client instance, which makes a second walk down the same prefix free,
   * but the cheap call is always the one that already has an id.
   *
   * `.` is skipped and `..` climbs to the parent. A leading `/` means "from the
   * home root" and ignores `from`.
   *
   * @param options.from Node to start at. Defaults to the home root.
   * @param options.includePending Resolve through nodes whose bytes never
   *   landed. Off by default.
   * @throws {OmsApiError} 404 naming the segment that did not resolve.
   */
  async resolvePath(
    path: string,
    options: RequestOptions & { from?: Id; includePending?: boolean } = {},
  ): Promise<FsNode> {
    const absolute = path.startsWith("/");
    const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");

    let currentId: Id;
    if (absolute || !options.from) {
      const roots = await this.roots(options);
      if (!roots.home) {
        throw new OmsError("storage.resolvePath: this account has no home root to resolve from.", "not_found");
      }
      currentId = roots.home;
    } else {
      currentId = options.from;
    }

    // The listing that resolves the LAST segment already carries the whole node
    // - the index view and the :extended view of an FsNode are the same fields -
    // so holding on to it saves a final `GET /fs_nodes/:id`. It is dropped
    // whenever a segment came from the cache or from a climb, where all we have
    // is an id.
    let resolved: FsNode | undefined;

    let walked = "";
    for (const segment of segments) {
      walked = walked.length === 0 ? segment : `${walked}/${segment}`;
      resolved = undefined;

      if (segment === "..") {
        const parent = (await this.get(currentId, options)).parent_id;
        if (!parent) {
          throw new OmsError(`storage.resolvePath: "${walked}" climbs above a root.`, "invalid_request");
        }
        currentId = parent;
        continue;
      }

      const cached = this.children.get(cacheKey(currentId, segment));
      if (cached !== undefined) {
        currentId = cached;
        continue;
      }

      const matches = await this.http.get<FsNode[]>("/fs_nodes", {
        ...options,
        query: {
          exact_search: { parent_id: currentId, name: segment },
          ...(options.includePending ? { extra_options: { include_pending: true } } : {}),
          modifiers: { page: "1:2" },
        },
        headers: noRevalidate(options.headers),
      });

      const match = matches?.[0];
      if (!match) {
        throw new OmsError(`storage.resolvePath: no node named "${segment}" under "${walked}".`, "not_found");
      }
      this.remember(currentId, match);
      currentId = match.id;
      resolved = match;
    }

    return resolved ?? this.get(currentId, options);
  }

  /**
   * Uploads files. Delegates to {@link UploadManager}, which batches the
   * intake, presigns, sends the bytes straight to object storage, binds the
   * blobs and reads the finished nodes back.
   *
   * Files at or above `MULTIPART_THRESHOLD` (32 MiB, exported from this
   * package) take the multipart path automatically, and that is not tuning:
   * the object store sits behind Cloudflare with a request-body cap around
   * 100 MB, so it is the only way a large file gets in at all.
   *
   * A per-file rejection - a quota that ran out, a name that collides with a
   * directory - does not throw. It comes back in
   * {@link UploadManager.upload}'s results, which is why that method is the one
   * to call when partial success matters; this wrapper returns only the nodes
   * that landed, and throws only when EVERY file was refused.
   *
   * `options.onProgress` counts bytes across the whole run and only ever
   * climbs. It ticks once per finished direct PUT and once per finished
   * multipart part, never per byte - `fetch` has no upload-progress event, and
   * the alternatives are argued out in `storage/upload.ts`. A caller that needs
   * true byte granularity in a browser builds an `UploadManager` with an
   * XHR-backed transport; a caller that wants to drive the three phases itself
   * has {@link UploadManager.createBatch}, {@link UploadManager.putDirect},
   * {@link UploadManager.attachBlobs} and the `multipart*` methods, all public
   * for that purpose.
   */
  async upload(input: UploadInput, options: OperationOptions = {}): Promise<FsNode[]> {
    const results = await this.uploads.upload(input, options);
    const failures = results.filter((result) => result.error);
    if (failures.length > 0 && failures.length === results.length) {
      const first = failures[0]?.error;
      throw new OmsError(
        `storage.upload: every file was refused. First reason (${first?.code}): ${first?.message}`,
        first?.code === "quota_exceeded" ? "quota_exceeded" : "invalid_request",
      );
    }
    return results.flatMap((result) => (result.node ? [result.node] : []));
  }

  /**
   * `POST /fs_nodes/create_directories` - creates a subtree in one call.
   *
   * Asynchronous like every bulk operation: the answer is a job id, and the
   * job's result is the list of directories that were created. Existing levels
   * are reused, so re-running the same paths is a no-op that creates nothing.
   *
   * Costs one of the twelve `fs_bulk_job` requests a minute. Pass every path in
   * one call rather than looping.
   *
   * @throws {OmsApiError} 400 when `paths` is empty or the parent is not a
   *   writable directory.
   */
  async createDirectories(input: CreateDirectoriesInput, options: RequestOptions = {}): Promise<FsBulkJob> {
    if (input.paths.length === 0) {
      throw new OmsError("storage.createDirectories: no paths given.", "invalid_request");
    }
    await this.bulkGate.wait(options.signal);
    const answer = await this.http.post<{ job_id: Id }>(
      "/fs_nodes/create_directories",
      { paths: input.paths, parent_id: input.parentId },
      options,
    );
    return { jobId: answer.job_id };
  }

  /** Alias for {@link createDirectories}, for callers who think in filesystem verbs. */
  async mkdir(input: CreateDirectoriesInput, options: RequestOptions = {}): Promise<FsBulkJob> {
    return this.createDirectories(input, options);
  }

  /**
   * `POST /fs_nodes` - creates ONE empty directory, synchronously, and returns
   * it.
   *
   * The counterpart to {@link createDirectories}: that one is a bulk job on the
   * twelve-a-minute bucket and answers with a job id, this one is a plain
   * create on the general bucket and answers with the node. Use this when you
   * want the id back immediately; use the other one for a subtree.
   *
   * @throws {OmsApiError} 400 when the name collides with a sibling or contains
   *   a `/`.
   */
  async createDirectory(input: { name: string; parentId: Id }, options: RequestOptions = {}): Promise<FsNode> {
    const node = await this.http.post<FsNode>(
      "/fs_nodes",
      { name: input.name, parent_id: input.parentId, kind: "directory" },
      // Replaying this would collide with the node the first attempt created.
      { ...options, retry: false },
    );
    this.remember(input.parentId, node);
    return node;
  }

  /**
   * Downloads a file's bytes into memory.
   *
   * Goes through `data_url` and NOT through `GET /fs_nodes/:id/data`, on
   * purpose. `data` answers 302 to the object store, and that redirect cannot
   * be followed with a credential attached: the store answers
   * `Access-Control-Allow-Origin: *`, which is illegal for a credentialed
   * request, while dropping the credential makes `data` 404 before it ever
   * redirects. Asking for the URL and fetching it anonymously separates the two
   * concerns and works in every runtime.
   *
   * Buffers the whole file. Use {@link downloadStream} for anything that should
   * not sit in memory.
   *
   * @throws {OmsApiError} 404 when the node has no data attached - which
   *   includes a directory and an upload whose bytes never landed.
   */
  async download(id: Id, options: RequestOptions = {}): Promise<FileOutput> {
    const url = await this.downloadUrl(id, options);
    const response = await this.fetchObject(url, options);
    const blob = await response.blob();
    return {
      data: blob,
      filename: filenameOf(url, response),
      contentType: response.headers.get("content-type") ?? undefined,
      size: blob.size,
    };
  }

  /**
   * Streams a file's bytes without buffering them.
   *
   * Same `data_url` hop as {@link download} and the same reason for it. The
   * caller owns the stream and must consume or cancel it.
   */
  async downloadStream(id: Id, options: RequestOptions = {}): Promise<FsStream> {
    const url = await this.downloadUrl(id, options);
    const response = await this.fetchObject(url, options);
    if (!response.body) {
      throw new OmsError("storage.downloadStream: this runtime gave no response body to stream.", "unsupported");
    }
    const length = response.headers.get("content-length");
    return {
      stream: response.body,
      filename: filenameOf(url, response),
      contentType: response.headers.get("content-type") ?? undefined,
      size: length === null ? undefined : Number(length),
    };
  }

  /**
   * `GET /fs_nodes/:id/data_url` - a short-lived signed URL for the bytes, for
   * a host that would rather hand the URL to a player or a browser than move
   * the bytes itself.
   *
   * Good for six hours. That window is not generous, it is necessary: a media
   * element re-requests the object on every seek, and a five-minute URL dies
   * mid-playback with no way to recover.
   *
   * The URL is a credential. Anyone holding it can read the bytes until it
   * expires, so do not log it or put it somewhere durable.
   */
  async downloadUrl(id: Id, options: RequestOptions = {}): Promise<string> {
    const answer = await this.http.get<{ url: string }>(`/fs_nodes/${encodeURIComponent(id)}/data_url`, options);
    return answer.url;
  }

  /**
   * `GET /fs_nodes/:id/zip` - a directory and every file under it that the
   * caller can see, as a zip archive.
   *
   * Streamed, and streamed for real: the server generates it with
   * `ActionController::Live`, so there is no `Content-Length` and no way to
   * know the size in advance. Never retried automatically either - a retry
   * restarts the whole archive from zero.
   *
   * @throws {OmsApiError} 400 when the node is not a directory, 404 when it is
   *   not visible.
   */
  async zip(id: Id, options: RequestOptions = {}): Promise<FsStream> {
    const response = await this.http.raw("GET", `/fs_nodes/${encodeURIComponent(id)}/zip`, {
      ...options,
      headers: { Accept: "application/zip", ...(options.headers ?? {}) },
      retry: false,
    });
    if (!response.body) {
      throw new OmsError("storage.zip: this runtime gave no response body to stream.", "unsupported");
    }
    return {
      stream: response.body,
      filename: filenameFromDisposition(response.headers.get("content-disposition")),
      contentType: response.headers.get("content-type") ?? undefined,
      size: undefined,
    };
  }

  /**
   * `PATCH /fs_nodes/:id` with a new name.
   *
   * The returned node is checked against what was asked for. The controller
   * silently drops any field outside its update allowlist, so a 200 alone
   * proves nothing about the write having happened.
   *
   * @throws {OmsApiError} 400 when the name collides with a sibling or contains
   *   a `/`; 401 when the caller cannot edit the node.
   */
  async rename(id: Id, name: string, options: RequestOptions = {}): Promise<FsNode> {
    const node = await this.http.patch<FsNode>(`/fs_nodes/${encodeURIComponent(id)}`, { name }, options);
    this.forget(id);
    if (node.name !== name) {
      throw new OmsError(
        `storage.rename: the server kept the name "${node.name}" instead of "${name}". The field was ignored, not rejected.`,
        "api_error",
      );
    }
    if (node.parent_id) this.remember(node.parent_id, node);
    return node;
  }

  /**
   * `PATCH /fs_nodes/:id` with a new parent.
   *
   * The server refuses a move that would make a node its own ancestor; that
   * cycle check is the fix for the 2026-07-27 copy outage and must not be
   * second-guessed client-side.
   *
   * Like {@link rename}, the answer is verified rather than assumed.
   *
   * @throws {OmsApiError} 400 on a cycle or a name collision in the target;
   *   401 when the caller cannot edit both ends.
   */
  async move(id: Id, newParentId: Id, options: RequestOptions = {}): Promise<FsNode> {
    const node = await this.http.patch<FsNode>(
      `/fs_nodes/${encodeURIComponent(id)}`,
      { parent_id: newParentId },
      options,
    );
    this.forget(id);
    if (node.parent_id !== newParentId) {
      throw new OmsError(
        `storage.move: the node is still under "${node.parent_id}" instead of "${newParentId}". The field was ignored, not rejected.`,
        "api_error",
      );
    }
    this.remember(newParentId, node);
    return node;
  }

  /**
   * `POST /fs_nodes/copy` - copies nodes into another directory.
   *
   * Asynchronous: the answer is a job id. Copying a directory copies its whole
   * subtree, so this is the operation most worth watching to completion.
   *
   * The selection is sent as an explicit id list and this method refuses an
   * empty one. That is not defensive tidiness: the endpoint runs the same
   * filters the index does, so a copy with NO selection would resolve to the
   * caller's entire listable tree and duplicate it.
   *
   * Costs one of the twelve `fs_bulk_job` requests a minute.
   */
  async copy(input: CopyFsNodesInput, options: RequestOptions = {}): Promise<FsBulkJob> {
    if (input.ids.length === 0) {
      throw new OmsError(
        "storage.copy: no ids given. An unfiltered copy would select the whole tree, so it is refused here.",
        "invalid_request",
      );
    }
    await this.bulkGate.wait(options.signal);
    const answer = await this.http.post<{ job_id: Id }>(
      "/fs_nodes/copy",
      { exact_search: { id: input.ids }, new_parent_id: input.newParentId },
      options,
    );
    return { jobId: answer.job_id };
  }

  /**
   * `POST /fs_nodes/move_to_trash` - the reversible delete. Prefer it over
   * {@link delete}.
   *
   * Asynchronous: the answer is a job id. The nodes move into the trash root,
   * keep their bytes and keep spending quota until {@link emptyTrash} runs.
   *
   * Refuses an empty id list for the same reason {@link copy} does: with no
   * selection the endpoint resolves to the caller's whole listable tree.
   *
   * Costs one of the twelve `fs_bulk_job` requests a minute, so trash the whole
   * selection in one call.
   */
  async trash(ids: Id[], options: RequestOptions = {}): Promise<FsBulkJob> {
    if (ids.length === 0) {
      throw new OmsError(
        "storage.trash: no ids given. An unfiltered move_to_trash would select the whole tree, so it is refused here.",
        "invalid_request",
      );
    }
    await this.bulkGate.wait(options.signal);
    const answer = await this.http.post<{ job_id: Id }>(
      "/fs_nodes/move_to_trash",
      { exact_search: { id: ids } },
      options,
    );
    for (const id of ids) this.forget(id);
    return { jobId: answer.job_id };
  }

  /**
   * `POST /fs_nodes/empty_trash` - permanent, and it frees the quota.
   *
   * Asynchronous: the answer is a job id. Nothing survives it.
   */
  async emptyTrash(options: RequestOptions = {}): Promise<FsBulkJob> {
    await this.bulkGate.wait(options.signal);
    const answer = await this.http.post<{ job_id: Id }>("/fs_nodes/empty_trash", undefined, options);
    this.clearCache();
    return { jobId: answer.job_id };
  }

  /**
   * `DELETE /fs_nodes/:id` - permanent, skipping the trash, and synchronous.
   *
   * Destroys the whole subtree under a directory. {@link trash} is the
   * reversible one; reach for this only when the caller asked for exactly this.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/fs_nodes/${encodeURIComponent(id)}`, options);
    this.forget(id);
  }

  /**
   * `GET /fs_nodes/:id/shared` - the scoped view behind a share link: the node,
   * its descendants when it is a directory, and the grant that authorised the
   * view. Never siblings, never ancestors, never the rest of the owner's tree.
   *
   * Works anonymously for a public grant, which is what makes it the right call
   * for "what is behind this share link" - {@link list} would answer nothing.
   *
   * @throws {OmsApiError} 404 both when the node does not exist and when no
   *   grant covers it, on purpose: existence is not leaked.
   */
  async shared(id: Id, options: RequestOptions = {}): Promise<SharedFsNodeView> {
    return this.http.get<SharedFsNodeView>(`/fs_nodes/${encodeURIComponent(id)}/shared`, {
      ...options,
      headers: noRevalidate(options.headers),
    });
  }

  /**
   * `GET /fs_nodes/vault_root` - the encrypted vault root, created on first
   * use. The SDK does no cryptography: the vault's manifest and its contents
   * are the host's to encrypt and decrypt.
   *
   * Unlike {@link roots}, this one creates the root if it is missing, which is
   * why `roots().vault` can be `null` while this still succeeds.
   *
   * @throws {OmsAuthError} 401 when anonymous.
   */
  async vaultRoot(options: RequestOptions = {}): Promise<FsNode> {
    const node = await this.http.get<FsNode>("/fs_nodes/vault_root", {
      ...options,
      headers: noRevalidate(options.headers),
    });
    // The memoised roots predate the vault existing; drop them so the next
    // roots() call reports the id this just created.
    this.rootsCache = undefined;
    return node;
  }

  /**
   * Empties the path cache and the memoised roots.
   *
   * The cache only knows about changes THIS client made. Call this when
   * something else may have moved things - another session, a share that was
   * revoked, a bulk job that has just finished.
   */
  clearCache(): void {
    this.children.clear();
    this.rootsCache = undefined;
  }

  /** Records a resolved child, evicting the oldest entry when the cache is full. */
  private remember(parentId: Id, node: FsNode): void {
    if (this.children.size >= StorageNamespace.CACHE_LIMIT) {
      const oldest = this.children.keys().next();
      if (!oldest.done) this.children.delete(oldest.value);
    }
    this.children.set(cacheKey(parentId, node.name), node.id);
  }

  /**
   * Drops everything the cache knows about a node: the entry pointing AT it,
   * and - since it may have been a directory - every entry that resolved
   * THROUGH it.
   */
  private forget(id: Id): void {
    const prefix = `${id}/`;
    for (const [key, value] of this.children) {
      if (value === id || key.startsWith(prefix)) this.children.delete(key);
    }
  }

  /**
   * Fetches an object-storage URL on the injected transport with no credential
   * of ours attached. The presigned signature in the URL IS the credential, and
   * a bearer header alongside it is what makes MinIO reject the request.
   */
  private async fetchObject(url: string, options: RequestOptions): Promise<Response> {
    const response = await this.transport(url, {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
      credentials: "omit",
      redirect: "follow",
    });
    if (!response.ok) {
      throw new OmsApiError(
        `Object storage refused the download (${response.status}). A signed URL is good for six hours; ask for a fresh one if it expired.`,
        { status: response.status, method: "GET", url, attempts: 1 },
      );
    }
    return response;
  }
}

/** `parentId` and `name` joined. A node name can never contain a `/`, so this is unambiguous. */
function cacheKey(parentId: Id, name: string): string {
  return `${parentId}/${name}`;
}

/**
 * Asks the runtime not to revalidate from its own cache.
 *
 * The listing endpoints are conditional-GET aware and answer 304 to a matching
 * `If-None-Match`. A browser that revalidates behind our back would get that
 * 304, and the transport - which treats anything outside 2xx as a failure -
 * would raise on a body that was simply not resent. With this header the
 * browser revalidates and hands us its cached body as a 200 instead.
 */
function noRevalidate(headers: Record<string, string> | undefined): Record<string, string> {
  return { "Cache-Control": "no-cache", ...(headers ?? {}) };
}

/**
 * The real filename behind a presigned object URL.
 *
 * The last path segment is NOT it: ActiveStorage keys an object by a random
 * token, so the URL path says `k7f2...` where the user expects `relatorio.pdf`.
 * The name travels in `response-content-disposition`, which the store echoes
 * back as the response's own `Content-Disposition`. Read the header first, fall
 * back to the query parameter that asked for it, and only then give up and use
 * the key.
 */
function filenameOf(url: string, response: Response): string | undefined {
  const fromHeader = filenameFromDisposition(response.headers.get("content-disposition"));
  if (fromHeader) return fromHeader;

  try {
    const asked = new URL(url).searchParams.get("response-content-disposition");
    const fromQuery = filenameFromDisposition(asked);
    if (fromQuery) return fromQuery;
  } catch {
    // Not a URL this runtime can parse; fall through to the key.
  }

  const last = (url.split("?")[0] ?? "").split("/").pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
