/**
 * The direct-upload driver.
 *
 * Bytes never pass through Rails. The flow the backend implements, and the one
 * this module follows exactly:
 *
 * 1. `POST /fs_nodes/batch_upload_urls` with a manifest of up to 100 files
 *    (`client_id`, `name`, `size`, and optionally `relative_path`,
 *    `content_type`, `checksum`). ONE request does directory resolution, one
 *    quota reservation under a single lock, node creation and plan minting.
 * 2. Per file the server answers a {@link UploadPlan}:
 *    - `strategy: "direct"` below 32 MiB: PUT the whole body to a presigned URL
 *      with the exact headers returned, then remember `blob_signed_id`;
 *    - `strategy: "multipart"` at or above 32 MiB: drive
 *      `/fs_nodes/:id/multipart/{start,part_urls,complete}` in 32 MiB parts.
 * 3. `POST /fs_nodes/batch_attach_blobs` binds the direct-tier blobs to their
 *    nodes. Multipart finalises itself at `multipart/complete`.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 * - The direct tier REQUIRES a base64 MD5 `checksum`. It is bound into the
 *   presigned signature as `Content-MD5`, so a wrong or missing one makes the
 *   PUT fail at the object store with a signature error that says nothing
 *   about checksums. WebCrypto has no MD5, so {@link md5Base64} carries a
 *   self-contained implementation - see the note there.
 * - The presigned PUTs go to the object store, NOT to the API. They must be
 *   sent with the injected fetch but WITHOUT the `Authorization` header, or
 *   MinIO rejects the request for having two authentication schemes.
 *
 * A node whose bytes never landed is adopted on the next attempt rather than
 * failing, so a torn batch is simply retried with the same manifest.
 *
 * Multipart is not an optimisation. The object store sits behind Cloudflare on
 * a plan that caps a request body at roughly 100 MB, so anything larger has no
 * other way in.
 */

import { Resource, backoffDelay, resolveRetry, sleep, type ApiClient } from "../../http";
import { OmsApiError, OmsError, OmsNetworkError, toOmsError } from "../../errors";
import {
  readFileInput,
  type FetchLike,
  type FileInput,
  type Id,
  type OperationOptions,
  type ProgressCallback,
  type RequestOptions,
} from "../../types";
import type { FsNode } from "../storage";

/** Files at or above this size take the multipart path. Mirrors the backend. */
export const MULTIPART_THRESHOLD = 32 * 1024 * 1024;

/**
 * Part size for the multipart path. Mirrors the backend, but it is only a
 * fallback: the real part size is whatever `multipart/start` answered, and that
 * is the number the driver slices with.
 */
export const MULTIPART_PART_SIZE = 32 * 1024 * 1024;

/** Maximum files in one `batch_upload_urls` call. Mirrors the backend. */
export const MAX_BATCH = 100;

/**
 * Files sent in one `batch_upload_urls` call by default.
 *
 * Deliberately half of {@link MAX_BATCH}: a batch is one quota reservation
 * under one row lock, and a smaller batch narrows the window in which a torn
 * run leaves reserved-but-unused bytes behind.
 */
export const DEFAULT_BATCH_SIZE = 50;

/** Maximum part URLs requested in one call. Mirrors the backend. */
export const MAX_PART_URLS = 100;

/** Parts one multipart upload may have. Mirrors the backend's `MAX_PARTS`. */
export const MAX_PARTS = 10_000;

/** Part URLs asked for in one round trip. Below {@link MAX_PART_URLS} on purpose. */
export const PART_URL_WINDOW = 32;

/** Parallel presigned PUTs in flight by default. The store is a Pi behind Cloudflare. */
export const DEFAULT_UPLOAD_CONCURRENCY = 4;

/**
 * The `fs_upload/authed` throttle: `batch_upload_urls`, `batch_attach_blobs`
 * and every `multipart/*` call share 300 requests a minute, keyed by session.
 * {@link UploadManager} paces itself against this so a large run degrades into
 * waiting rather than into a wall of 429s.
 */
export const FS_UPLOAD_RATE_LIMIT = 300;

/**
 * The `fs_bulk_job/authed` throttle: `copy`, `create_directories`,
 * `empty_trash` and `move_to_trash` share TWELVE requests a minute. It is the
 * tightest limit in the API and the easiest one to trip by looping.
 */
export const FS_BULK_JOB_RATE_LIMIT = 12;

/** One entry of the manifest sent to `batch_upload_urls`. */
export interface UploadManifestEntry {
  /** Caller-chosen correlation key. The response is matched back on this. */
  readonly client_id: string;
  readonly name: string;
  readonly size: number;
  /**
   * Path INCLUDING the filename, e.g. `"fotos/2024/praia.jpg"`. Everything
   * before the last segment becomes directories. A `..` segment is rejected.
   */
  readonly relative_path?: string;
  readonly content_type?: string;
  /** Base64 MD5 of the whole file. Required below {@link MULTIPART_THRESHOLD}. */
  readonly checksum?: string;
}

/** The presigned PUT for a small file. */
export interface DirectUploadTarget {
  readonly url: string;
  /** Send these verbatim. They include the `Content-MD5` the signature covers. */
  readonly headers: Record<string, string>;
  /** Hand this back to `batch_attach_blobs` once the PUT succeeds. */
  readonly blob_signed_id: string;
}

/** What the server decided for one manifest entry. */
export interface UploadPlan {
  readonly client_id: string;
  readonly fs_node_id: Id;
  readonly strategy: "direct" | "multipart";
  /** Present only for `strategy: "direct"`. */
  readonly upload?: DirectUploadTarget;
}

/**
 * One entry the server refused, with a machine-readable reason.
 *
 * The server names the entry by `client_id` only - it never echoes the
 * filename back - so correlate on that and look the name up yourself.
 */
export interface UploadPlanError {
  readonly client_id: string;
  /** `"quota_exceeded"`, `"invalid"`, `"mint_failed"`. */
  readonly code: string;
  readonly message: string;
}

/** The answer to `POST /fs_nodes/batch_upload_urls`. */
export interface UploadBatch {
  readonly parent_id: Id;
  /** Directories resolved or created while walking the relative paths. */
  readonly directories: Array<{ readonly path: string; readonly id: Id }>;
  readonly results: UploadPlan[];
  readonly errors: UploadPlanError[];
}

/** One entry of the answer to `POST /fs_nodes/batch_attach_blobs`. */
export interface AttachBlobResult {
  readonly fs_node_id: Id;
  readonly attached: boolean;
  /** `"not_found"`, `"already_attached"`, `"blob_not_found"`, `"attach_failed"`. */
  readonly code?: string;
  readonly message?: string;
}

/** The answer to `POST /fs_nodes/:id/multipart/start`. */
export interface MultipartSession {
  /** Signed `(key, upload_id)` pair. The server keeps no upload state. */
  readonly upload_token: string;
  readonly part_size: number;
  readonly part_count: number;
}

/** A presigned PUT for one part. */
export interface MultipartPartUrl {
  readonly part_number: number;
  readonly url: string;
}

/** A part that has landed, identified by the ETag the store returned. */
export interface MultipartPart {
  readonly part_number: number;
  readonly etag: string;
}

/** The answer to `POST /fs_nodes/:id/multipart/complete`. */
export interface MultipartCompletion {
  readonly attached: boolean;
  /** Size the store measured. Authoritative: the declared size is reconciled to it. */
  readonly byte_size: number;
}

/**
 * Computes the base64 MD5 of a blob.
 *
 * Supply one to replace the built-in {@link md5Base64} with a faster native or
 * WASM digest, on a host that has one.
 */
export type Md5Base64Fn = (data: Blob) => Promise<string>;

/** Arguments for {@link UploadManager.upload}. */
export interface UploadInput {
  /** Directory to upload into. */
  readonly parentId: Id;
  readonly files: FileInput[];
  /**
   * Relative path per file, parallel to `files`, when uploading a folder. Use
   * {@link FileInput.filename} alone for a flat upload.
   *
   * The path INCLUDES the filename (`"fotos/2024/praia.jpg"`); everything
   * before the last segment is created as directories in the same call, so a
   * folder upload costs no extra round trips. A `..` segment is a 400.
   */
  readonly relativePaths?: string[];
  /** Parallel PUTs in flight. Keep it modest: the store is a Pi behind Cloudflare. */
  readonly concurrency?: number;
  /** Files per `batch_upload_urls` call. Clamped to {@link MAX_BATCH}. */
  readonly batchSize?: number;
  /**
   * Read the finished nodes back with one extra listing per batch. On by
   * default, and worth it: a normal listing hides nodes whose bytes never
   * landed, so a node coming back at all is proof the blob is bound.
   */
  readonly verify?: boolean;
  /** Replacement for the built-in MD5. See {@link Md5Base64Fn}. */
  readonly md5?: Md5Base64Fn;
}

/** What one file's upload ended as. */
export interface UploadResult {
  readonly client_id: string;
  /** Name that was uploaded, echoed back so a caller can report on it. */
  readonly filename: string;
  /** The node the bytes belong to. `null` when the file never got a plan. */
  readonly fs_node_id: Id | null;
  /**
   * The finished node, when it was read back (see {@link UploadInput.verify}).
   * `null` when verification was off or the node did not come back.
   */
  readonly node: FsNode | null;
  /** Set when this file failed while the rest of the batch succeeded. */
  readonly error?: UploadPlanError;
}

/**
 * A sliding-window pacer for one throttle bucket.
 *
 * The API throttles by session, not by connection, so parallelism inside the
 * SDK is exactly what trips it. Requests wait their turn here instead of
 * racing into a 429 and paying the server's `Retry-After` afterwards.
 *
 * Isolate-safe: `Date.now` and `setTimeout`, nothing else. Per instance, so two
 * clients in the same isolate do not share (and must not share) a window.
 */
export class StorageRateGate {
  private readonly hits: number[] = [];

  /**
   * @param limit Requests allowed inside the window.
   * @param windowMs Length of the window in milliseconds.
   * @param headroom Fraction of the limit actually used, so the SDK is never
   *   the request that trips the bucket. `0.9` spends 270 of 300.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly headroom: number = 0.9,
  ) {}

  /** Resolves when another request may be sent. */
  async wait(signal?: AbortSignal): Promise<void> {
    const budget = Math.max(1, Math.floor(this.limit * this.headroom));
    for (;;) {
      const now = Date.now();
      while (this.hits.length > 0 && now - (this.hits[0] as number) >= this.windowMs) this.hits.shift();
      if (this.hits.length < budget) {
        this.hits.push(now);
        return;
      }
      await sleep(this.windowMs - (now - (this.hits[0] as number)) + 5, signal);
    }
  }
}

/** Constructor options for {@link UploadManager}. */
export interface UploadManagerOptions {
  /**
   * The fetch used for the presigned PUTs.
   *
   * Defaults to the one the {@link ApiClient} was built with, so bytes travel
   * on the same transport as everything else. Pass one only to send the object
   * store's traffic somewhere different from the API's.
   */
  readonly fetch?: FetchLike;
  /** Replacement for the built-in MD5. See {@link Md5Base64Fn}. */
  readonly md5?: Md5Base64Fn;
}

/**
 * Drives presigned uploads into the virtual filesystem.
 *
 * Reached as `oms.storage.uploads`, and wrapped by `oms.storage.upload()` for
 * the common case. Instantiate it directly only when you need the low-level
 * steps, for instance to resume a torn multipart.
 */
export class UploadManager extends Resource {
  /** Paces every control-plane call against the `fs_upload` throttle. */
  readonly gate: StorageRateGate;

  private readonly transport: FetchLike;
  private readonly md5: Md5Base64Fn;

  constructor(http: ApiClient, options: UploadManagerOptions = {}) {
    super(http);
    this.gate = new StorageRateGate(FS_UPLOAD_RATE_LIMIT);
    this.transport = options.fetch ?? objectStoreFetch(http);
    this.md5 = options.md5 ?? md5Base64;
  }

  /**
   * Uploads files end to end: manifest, presign, transfer, bind, verify.
   *
   * Splits into batches of {@link UploadInput.batchSize}, picks the strategy
   * per file from the server's plan, and reports bytes moved through
   * `onProgress`.
   *
   * Per-file failures do NOT abort the run: they come back as
   * {@link UploadResult.error} with the rest of the batch intact, exactly as
   * the server reports them. Only a structural failure (bad parent, empty or
   * oversized batch) throws.
   *
   * Progress granularity is a whole direct PUT or a whole multipart part, not
   * a byte counter. `fetch` has no upload-progress event and a streamed request
   * body is neither universally supported nor usable against a presigned PUT,
   * which needs a `Content-Length`.
   *
   * Every multipart session this call opened is aborted before the error
   * leaves, so a torn run does not strand parts (and reserved quota) on the
   * store.
   */
  async upload(input: UploadInput, options: OperationOptions = {}): Promise<UploadResult[]> {
    if (input.files.length === 0) return [];
    if (input.relativePaths && input.relativePaths.length !== input.files.length) {
      throw new OmsError(
        "storage.upload: `relativePaths` must have exactly one entry per file, or be omitted.",
        "invalid_request",
      );
    }

    const prepared = await Promise.all(
      input.files.map(async (file, index) => {
        const { blob, filename, contentType } = await readFileInput(file);
        const relativePath = input.relativePaths?.[index];
        return {
          clientId: `${index}-${filename}`,
          blob,
          filename,
          contentType,
          ...(relativePath === undefined ? {} : { relativePath }),
        };
      }),
    );

    const total = prepared.reduce((sum, entry) => sum + entry.blob.size, 0);
    let loaded = 0;
    const report = (delta: number): void => {
      loaded += delta;
      options.onProgress?.({ phase: "upload", loaded, total });
    };
    report(0);

    const batchSize = Math.min(MAX_BATCH, Math.max(1, Math.trunc(input.batchSize ?? DEFAULT_BATCH_SIZE)));
    const concurrency = Math.max(1, Math.trunc(input.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY));
    const md5 = input.md5 ?? this.md5;
    const results: UploadResult[] = [];
    // Sessions still open. Aborting them is the only way to release the parts
    // already stored, and the node with them; the server's reaper is a backstop
    // measured in days, not a plan.
    const open = new Map<Id, string>();

    try {
      for (let offset = 0; offset < prepared.length; offset += batchSize) {
        const slice = prepared.slice(offset, offset + batchSize);

        const manifest: UploadManifestEntry[] = [];
        for (const entry of slice) {
          manifest.push(
            await buildManifestEntry(entry.blob, {
              clientId: entry.clientId,
              filename: entry.filename,
              contentType: entry.contentType,
              ...(entry.relativePath === undefined ? {} : { relativePath: entry.relativePath }),
              md5,
            }),
          );
        }

        const batch = await this.createBatch({ parentId: input.parentId, files: manifest }, options);
        const planFor = new Map(batch.results.map((plan) => [plan.client_id, plan]));
        const errorFor = new Map(batch.errors.map((error) => [error.client_id, error]));

        const attachments: Array<{ fs_node_id: Id; blob_signed_id: string }> = [];
        const failed = new Map<string, UploadPlanError>(errorFor);

        await runPool(
          slice.filter((entry) => planFor.has(entry.clientId)),
          concurrency,
          async (entry) => {
            const plan = planFor.get(entry.clientId) as UploadPlan;
            try {
              if (plan.strategy === "multipart") {
                await this.uploadMultipart(plan.fs_node_id, entry.blob, {
                  ...options,
                  onPart: (bytes) => report(bytes),
                  onSession: (token) => open.set(plan.fs_node_id, token),
                });
                open.delete(plan.fs_node_id);
              } else {
                if (!plan.upload) {
                  throw new OmsError(
                    `The server planned a direct upload for "${entry.filename}" but sent no presigned URL.`,
                    "api_error",
                  );
                }
                await this.putDirect(plan.upload, entry.blob, options);
                attachments.push({ fs_node_id: plan.fs_node_id, blob_signed_id: plan.upload.blob_signed_id });
                report(entry.blob.size);
              }
            } catch (thrown) {
              // A file that failed on its own does not take the batch with it:
              // it is reported like a server-side rejection so the caller sees
              // one uniform list.
              failed.set(entry.clientId, {
                client_id: entry.clientId,
                code: thrown instanceof OmsError ? thrown.code : "transfer_failed",
                message: thrown instanceof Error ? thrown.message : String(thrown),
              });
            }
          },
        );

        if (attachments.length > 0) {
          const attached = await this.attachBlobs(attachments, options);
          for (const result of attached) {
            if (result.attached) continue;
            const plan = batch.results.find((candidate) => candidate.fs_node_id === result.fs_node_id);
            if (!plan) continue;
            failed.set(plan.client_id, {
              client_id: plan.client_id,
              code: result.code ?? "attach_failed",
              message: result.message ?? "The blob could not be bound to its node",
            });
          }
        }

        const landed = batch.results
          .filter((plan) => !failed.has(plan.client_id))
          .map((plan) => plan.fs_node_id);
        const nodes = input.verify === false ? new Map<Id, FsNode>() : await this.readBack(landed, options);

        for (const entry of slice) {
          const plan = planFor.get(entry.clientId);
          const error = failed.get(entry.clientId);
          results.push({
            client_id: entry.clientId,
            filename: entry.filename,
            fs_node_id: plan?.fs_node_id ?? null,
            node: (plan && nodes.get(plan.fs_node_id)) ?? null,
            ...(error === undefined ? {} : { error }),
          });
        }
      }
    } catch (thrown) {
      await this.abortAll(open);
      throw toOmsError(thrown);
    }

    // A file whose transfer failed mid-multipart left its session open.
    await this.abortAll(open);
    return results;
  }

  /**
   * `POST /fs_nodes/batch_upload_urls` - step 1 on its own.
   *
   * One request buys directory resolution, a single quota reservation under one
   * lock, node creation and plan minting for the whole manifest. Per-file
   * rejections come back in `errors` with a 200; only a structural problem
   * (invalid parent, empty batch, over {@link MAX_BATCH}, a `..` segment)
   * is a 400.
   *
   * @throws {OmsApiError} 400 on a structural problem, 404 when the parent is
   *   not a directory the caller may write to.
   */
  async createBatch(
    input: { parentId: Id; files: UploadManifestEntry[] },
    options: RequestOptions = {},
  ): Promise<UploadBatch> {
    if (input.files.length === 0) {
      throw new OmsError("storage.uploads.createBatch: the manifest is empty.", "invalid_request");
    }
    if (input.files.length > MAX_BATCH) {
      throw new OmsError(
        `storage.uploads.createBatch: ${input.files.length} files exceeds the server's limit of ${MAX_BATCH}.`,
        "invalid_request",
      );
    }
    await this.gate.wait(options.signal);
    const batch = await this.http.post<UploadBatch>(
      "/fs_nodes/batch_upload_urls",
      { parent_id: input.parentId, files: input.files },
      // Replaying this POST would mint a second set of nodes and a second
      // reservation for the same manifest. Adoption makes that survivable but
      // not free, so it is never retried automatically.
      { ...options, retry: false },
    );
    return {
      parent_id: batch.parent_id,
      directories: batch.directories ?? [],
      results: batch.results ?? [],
      errors: batch.errors ?? [],
    };
  }

  /**
   * PUTs one whole body to a presigned URL.
   *
   * Sends the plan's headers verbatim and NO `Authorization`: this request goes
   * to the object store, not to the API. MinIO refuses a request that carries
   * both a presigned signature and a bearer header.
   *
   * Retries a network fault or a 5xx from the store. A 4xx is never retried: an
   * expired signature or a checksum mismatch is deterministic and a retry only
   * costs the bytes again.
   *
   * @returns The ETag the store reported, or `null` when it was not readable -
   *   which happens in a browser whose bucket CORS policy does not expose
   *   `ETag`. The direct tier does not need it; multipart does.
   */
  async putDirect(
    target: DirectUploadTarget,
    body: Blob,
    options: RequestOptions & { onProgress?: ProgressCallback } = {},
  ): Promise<string | null> {
    const etag = await this.putBytes(target.url, target.headers, body, options);
    options.onProgress?.({ phase: "upload", loaded: body.size, total: body.size });
    return etag;
  }

  /**
   * `POST /fs_nodes/batch_attach_blobs` - binds finished direct uploads to
   * their nodes. Until this lands the node exists with no bytes and is hidden
   * from every listing.
   *
   * Answers 200 with per-item results even when every item failed. Read
   * `attached` on each one; do not infer success from the status.
   */
  async attachBlobs(
    attachments: Array<{ fs_node_id: Id; blob_signed_id: string }>,
    options: RequestOptions = {},
  ): Promise<AttachBlobResult[]> {
    const out: AttachBlobResult[] = [];
    for (let offset = 0; offset < attachments.length; offset += MAX_BATCH) {
      const slice = attachments.slice(offset, offset + MAX_BATCH);
      await this.gate.wait(options.signal);
      const answer = await this.http.post<{ results: AttachBlobResult[] }>(
        "/fs_nodes/batch_attach_blobs",
        { attachments: slice },
        options,
      );
      out.push(...(answer?.results ?? []));
    }
    return out;
  }

  /**
   * `POST /fs_nodes/:id/multipart/start`.
   *
   * The server keeps no upload state: the `(key, upload_id)` pair lives signed
   * inside `upload_token`, which is good for 48 hours. Persist it and a torn
   * upload can be resumed later with {@link uploadMultipart}'s `resume`.
   *
   * @throws {OmsApiError} 400 when the node already has data, is a directory,
   *   or has no size set.
   */
  async multipartStart(fsNodeId: Id, options: RequestOptions = {}): Promise<MultipartSession> {
    await this.gate.wait(options.signal);
    return this.http.post<MultipartSession>(`/fs_nodes/${encodeURIComponent(fsNodeId)}/multipart/start`, undefined, {
      ...options,
      // Starting twice leaves the first multipart upload orphaned on the store
      // with no token to abort it by.
      retry: false,
    });
  }

  /**
   * `POST /fs_nodes/:id/multipart/part_urls` - presigns up to
   * {@link MAX_PART_URLS} parts at a time. The URLs live one hour.
   */
  async multipartPartUrls(
    fsNodeId: Id,
    input: { uploadToken: string; partNumbers: number[] },
    options: RequestOptions = {},
  ): Promise<MultipartPartUrl[]> {
    if (input.partNumbers.length === 0) return [];
    if (input.partNumbers.length > MAX_PART_URLS) {
      throw new OmsError(
        `storage.uploads.multipartPartUrls: ${input.partNumbers.length} parts exceeds the server's limit of ${MAX_PART_URLS}.`,
        "invalid_request",
      );
    }
    await this.gate.wait(options.signal);
    const answer = await this.http.post<{ part_urls: MultipartPartUrl[] }>(
      `/fs_nodes/${encodeURIComponent(fsNodeId)}/multipart/part_urls`,
      { upload_token: input.uploadToken, part_numbers: input.partNumbers },
      options,
    );
    return answer?.part_urls ?? [];
  }

  /**
   * `POST /fs_nodes/:id/multipart/complete` - assembles the parts. This is what
   * creates the blob row; there is no separate attach step.
   *
   * `byte_size` is what the store measured, and it wins: the node's declared
   * size and the root's quota counter are reconciled to it server-side.
   */
  async multipartComplete(
    fsNodeId: Id,
    input: { uploadToken: string; parts: MultipartPart[] },
    options: RequestOptions = {},
  ): Promise<MultipartCompletion> {
    if (input.parts.length === 0) {
      throw new OmsError("storage.uploads.multipartComplete: no parts to assemble.", "invalid_request");
    }
    await this.gate.wait(options.signal);
    return this.http.post<MultipartCompletion>(
      `/fs_nodes/${encodeURIComponent(fsNodeId)}/multipart/complete`,
      {
        upload_token: input.uploadToken,
        parts: [...input.parts].sort((a, b) => a.part_number - b.part_number),
      },
      options,
    );
  }

  /**
   * `POST /fs_nodes/:id/multipart/abort` - releases the parts already stored
   * and, when no blob was ever bound, destroys the node and refunds its quota
   * reservation.
   *
   * Call it whenever an upload fails or is cancelled. {@link upload} does; a
   * caller driving the steps by hand must too. Skipping it leaves the bytes
   * charged against the quota until a server-side reaper notices, which is a
   * schedule, not a promise.
   */
  async multipartAbort(fsNodeId: Id, input: { uploadToken: string }, options: RequestOptions = {}): Promise<void> {
    await this.gate.wait(options.signal);
    await this.http.post<{ aborted: boolean }>(
      `/fs_nodes/${encodeURIComponent(fsNodeId)}/multipart/abort`,
      { upload_token: input.uploadToken },
      options,
    );
  }

  /**
   * Drives one file through the multipart flow: start, presign a window of
   * parts, PUT them in parallel, complete.
   *
   * Parts are sliced with the size the SERVER reported, never with
   * {@link MULTIPART_PART_SIZE}, so a change on the backend does not silently
   * corrupt an upload here.
   *
   * @param options.resume A session from a previous attempt plus the parts that
   *   already landed. The matching parts are skipped.
   * @param options.onSession Called with the upload token as soon as there is
   *   one, so a caller can persist it and abort later.
   * @param options.onPart Called with the byte count of each finished part.
   */
  async uploadMultipart(
    fsNodeId: Id,
    body: Blob,
    options: RequestOptions & {
      concurrency?: number;
      resume?: { uploadToken: string; partSize: number; parts: MultipartPart[] };
      onSession?: (uploadToken: string, partSize: number) => void;
      onPart?: (bytes: number, part: MultipartPart) => void;
    } = {},
  ): Promise<MultipartCompletion> {
    let uploadToken = options.resume?.uploadToken;
    let partSize = options.resume?.partSize ?? 0;
    const done = new Map<number, MultipartPart>(
      (options.resume?.parts ?? []).map((part) => [part.part_number, part]),
    );

    if (!uploadToken) {
      const session = await this.multipartStart(fsNodeId, options);
      uploadToken = session.upload_token;
      partSize = session.part_size > 0 ? session.part_size : MULTIPART_PART_SIZE;
    }
    if (partSize <= 0) partSize = MULTIPART_PART_SIZE;
    options.onSession?.(uploadToken, partSize);

    const partCount = Math.max(1, Math.ceil(body.size / partSize));
    if (partCount > MAX_PARTS) {
      throw new OmsError(
        `storage: ${body.size} bytes needs ${partCount} parts of ${partSize}, over the server's limit of ${MAX_PARTS}.`,
        "invalid_request",
      );
    }

    const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY));

    for (let start = 1; start <= partCount; start += PART_URL_WINDOW) {
      const numbers: number[] = [];
      for (let n = start; n < start + PART_URL_WINDOW && n <= partCount; n += 1) {
        if (!done.has(n)) numbers.push(n);
      }
      if (numbers.length === 0) continue;

      const urls = await this.multipartPartUrls(fsNodeId, { uploadToken, partNumbers: numbers }, options);
      const urlFor = new Map(urls.map((entry) => [entry.part_number, entry.url]));

      await runPool(numbers, concurrency, async (partNumber) => {
        const url = urlFor.get(partNumber);
        if (!url) throw new OmsError(`storage: the server presigned no URL for part ${partNumber}.`, "api_error");

        const from = (partNumber - 1) * partSize;
        const chunk = body.slice(from, Math.min(from + partSize, body.size));
        // No headers: the presigned upload_part signature covers the query
        // string, and an unexpected header is at best ignored and at worst a
        // signature mismatch.
        const etag = await this.putBytes(url, {}, chunk, options);
        if (!etag) {
          throw new OmsError(
            "storage: the object store did not expose the part ETag. In a browser this means the bucket's CORS policy is missing ETag in Access-Control-Expose-Headers.",
            "unsupported",
          );
        }
        const part: MultipartPart = { part_number: partNumber, etag: etag.replaceAll('"', "") };
        done.set(partNumber, part);
        options.onPart?.(chunk.size, part);
      });
    }

    return this.multipartComplete(fsNodeId, { uploadToken, parts: [...done.values()] }, options);
  }

  /**
   * PUTs bytes at the object store on the injected transport, with no
   * `Authorization` header and a bounded retry.
   */
  private async putBytes(
    url: string,
    headers: Record<string, string>,
    body: Blob,
    options: RequestOptions,
  ): Promise<string | null> {
    const retry = options.retry === false ? false : resolveRetry(options.retry ?? { maxAttempts: 4 });
    const maxAttempts = retry === false ? 1 : Math.max(1, retry.maxAttempts);

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.transport(url, {
          method: "PUT",
          headers,
          body,
          ...(options.signal ? { signal: options.signal } : {}),
          // The presigned signature IS the credential. A cookie or a bearer
          // header alongside it makes MinIO reject the request for carrying
          // two authentication schemes.
          credentials: "omit",
          redirect: "follow",
        });
      } catch (thrown) {
        if (options.signal?.aborted) throw toOmsError(thrown);
        if (attempt >= maxAttempts || retry === false) {
          throw new OmsNetworkError(
            `Upload to object storage failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
            { method: "PUT", url, attempts: attempt, cause: thrown },
          );
        }
        await sleep(backoffDelay(attempt, retry), options.signal);
        continue;
      }

      if (response.ok) return response.headers.get("etag");

      const detail = await readStoreError(response);
      // A 4xx from the store is deterministic - an expired signature, a
      // checksum that does not match - and retrying only spends the bytes
      // again.
      if (response.status < 500 || attempt >= maxAttempts || retry === false) {
        throw new OmsApiError(`Object storage refused the upload (${response.status}): ${detail}`, {
          status: response.status,
          body: detail,
          method: "PUT",
          url,
          attempts: attempt,
        });
      }
      await sleep(backoffDelay(attempt, retry), options.signal);
    }
  }

  /**
   * Reads finished nodes back in ONE listing.
   *
   * A normal listing hides files whose bytes never landed, so a node coming
   * back is proof the blob is bound - which is why this is a verification and
   * not just a convenience.
   */
  private async readBack(ids: Id[], options: RequestOptions): Promise<Map<Id, FsNode>> {
    const out = new Map<Id, FsNode>();
    if (ids.length === 0) return out;
    for (let offset = 0; offset < ids.length; offset += MAX_BATCH) {
      const slice = ids.slice(offset, offset + MAX_BATCH);
      const nodes = await this.http.get<FsNode[]>("/fs_nodes", {
        ...options,
        query: { exact_search: { id: slice }, modifiers: { page: `1:${slice.length}` } },
        headers: { "Cache-Control": "no-cache", ...(options.headers ?? {}) },
      });
      for (const node of nodes ?? []) out.set(node.id, node);
    }
    return out;
  }

  /** Best-effort abort of every session still open. Never throws. */
  private async abortAll(open: Map<Id, string>): Promise<void> {
    if (open.size === 0) return;
    const pending = [...open.entries()];
    open.clear();
    await Promise.all(
      pending.map(async ([fsNodeId, uploadToken]) => {
        try {
          // Deliberately without the caller's signal: an abort triggered BY a
          // cancellation must still reach the server, or the parts stay
          // charged against the quota.
          await this.multipartAbort(fsNodeId, { uploadToken }, { retry: false, timeoutMs: 15_000 });
        } catch {
          // Nothing useful to do: the server's reaper is the backstop.
        }
      }),
    );
  }
}

/**
 * Base64 MD5 of a blob, in the exact form `Content-MD5` wants.
 *
 * The algorithm is not negotiable: the backend binds this digest into the
 * presigned PUT signature as `Content-MD5`, so anything else makes the object
 * store reject the upload with a signature error that never mentions checksums.
 *
 * WebCrypto implements SHA only, so this cannot be done with platform APIs, and
 * the core carries no runtime dependencies - it has to run in an isolate where
 * a Node-flavoured hashing package is not an option. Hence the implementation
 * below: small, streaming, and self-contained. A host that already owns a
 * faster digest can replace it through {@link UploadManagerOptions.md5} or
 * {@link UploadInput.md5}.
 *
 * Streams the blob rather than materialising it, so hashing a 31 MiB file costs
 * one 64 KiB window and not 31 MiB of extra heap.
 */
export async function md5Base64(data: Blob): Promise<string> {
  const hash = new Md5();
  const stream = typeof data.stream === "function" ? data.stream() : undefined;

  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) hash.update(value as Uint8Array);
    }
  } else {
    hash.update(new Uint8Array(await data.arrayBuffer()));
  }

  return base64(hash.digest());
}

/**
 * Builds a manifest entry from a {@link FileInput}, computing the checksum only
 * when the file is below {@link MULTIPART_THRESHOLD} and therefore needs one.
 *
 * Buffers a `ReadableStream` input: the manifest needs an exact byte count up
 * front, and the direct tier needs a digest of the whole body. Prefer handing
 * in a `Blob` when you have one.
 */
export async function manifestEntryFor(
  file: FileInput,
  input: { clientId: string; relativePath?: string; md5?: Md5Base64Fn },
): Promise<UploadManifestEntry> {
  const { blob, filename, contentType } = await readFileInput(file);
  return buildManifestEntry(blob, {
    clientId: input.clientId,
    filename,
    contentType,
    ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
    ...(input.md5 === undefined ? {} : { md5: input.md5 }),
  });
}

/** Shared by {@link manifestEntryFor} and the batching loop, which already has the blob. */
async function buildManifestEntry(
  blob: Blob,
  input: { clientId: string; filename: string; contentType: string; relativePath?: string; md5?: Md5Base64Fn },
): Promise<UploadManifestEntry> {
  if (input.relativePath?.split("/").includes("..")) {
    throw new OmsError(
      `storage: "${input.relativePath}" contains a ".." segment, which the server rejects.`,
      "invalid_request",
    );
  }

  // The server picks the strategy, but the checksum has to be in the manifest
  // BEFORE it decides, so the threshold is evaluated here too. Same comparison
  // as NodeBatchCreator: at or above the threshold is multipart, and multipart
  // verifies per-part ETags instead of a whole-file digest.
  const checksum = blob.size < MULTIPART_THRESHOLD ? await (input.md5 ?? md5Base64)(blob) : undefined;

  return {
    client_id: input.clientId,
    name: input.filename,
    size: blob.size,
    ...(input.relativePath === undefined ? {} : { relative_path: input.relativePath }),
    ...(input.contentType === undefined ? {} : { content_type: input.contentType }),
    ...(checksum === undefined ? {} : { checksum }),
  };
}

/**
 * The `fetch` a request to the object store should travel on.
 *
 * It has to be the one the host injected into the {@link ApiClient} - a
 * Worker's proxy, a test double, a policy wrapper - or the bytes silently
 * escape whatever the host put around its network. `ApiClient` keeps that
 * function private and `http.ts` is shared, so it is read here through a
 * defensive probe instead of by growing the transport a new public member.
 *
 * When the probe finds nothing (a hand-built stub, a future refactor) the
 * ambient `fetch` is used, and when there is none either the failure is loud
 * rather than an upload sent through something unexpected.
 */
export function objectStoreFetch(http: ApiClient): FetchLike {
  const injected = (http as unknown as { fetchImpl?: unknown }).fetchImpl;
  if (typeof injected === "function") return injected as FetchLike;

  const ambient = globalThis.fetch as FetchLike | undefined;
  if (typeof ambient === "function") return (input, init) => ambient(input, init);

  return () => {
    throw new OmsNetworkError(
      "No fetch implementation available for the object-store upload. Pass one to the Oms constructor: new Oms({ fetch }).",
    );
  };
}

/** Runs `worker` over `items` with at most `limit` in flight, in order. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
}

/** Reads whatever the object store said, without ever throwing on the body. */
async function readStoreError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // S3 and MinIO answer XML. One line of it is all a caller needs.
    const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
    return (message ?? text).slice(0, 400);
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

// ---------------------------------------------------------------------------
// MD5. See the note on md5Base64 for why this is here rather than in a package.

/** Per-round left-rotation amounts, RFC 1321 section 3.4. */
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** `K[i] = floor(2^32 * abs(sin(i + 1)))`, RFC 1321 section 3.4. */
const MD5_K = (() => {
  const table = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  return table;
})();

/** Incremental MD5 over arbitrary chunks. */
class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;

  private readonly block = new Uint8Array(64);
  private readonly words = new Int32Array(16);
  private filled = 0;
  private length = 0;

  update(chunk: Uint8Array): void {
    this.length += chunk.length;
    let offset = 0;

    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, chunk.length);
      this.block.set(chunk.subarray(0, take), this.filled);
      this.filled += take;
      offset = take;
      if (this.filled < 64) return;
      this.compress(this.block, 0);
      this.filled = 0;
    }

    for (; offset + 64 <= chunk.length; offset += 64) this.compress(chunk, offset);

    if (offset < chunk.length) {
      this.block.set(chunk.subarray(offset), 0);
      this.filled = chunk.length - offset;
    }
  }

  /** Finishes the hash and returns the 16 raw digest bytes. */
  digest(): Uint8Array {
    const bits = this.length * 8;
    const tail = new Uint8Array(this.filled < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.filled), 0);
    tail[this.filled] = 0x80;

    // 64-bit little-endian bit length. Split without ever exceeding 2^32 so the
    // arithmetic stays exact for a blob of any size a runtime can hold.
    const low = bits % 4294967296;
    const high = Math.floor(this.length / 0x20000000);
    const at = tail.length - 8;
    tail[at] = low & 0xff;
    tail[at + 1] = (low >>> 8) & 0xff;
    tail[at + 2] = (low >>> 16) & 0xff;
    tail[at + 3] = (low >>> 24) & 0xff;
    tail[at + 4] = high & 0xff;
    tail[at + 5] = (high >>> 8) & 0xff;
    tail[at + 6] = (high >>> 16) & 0xff;
    tail[at + 7] = (high >>> 24) & 0xff;

    for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail, offset);

    const out = new Uint8Array(16);
    for (const [index, word] of [this.a, this.b, this.c, this.d].entries()) {
      out[index * 4] = word & 0xff;
      out[index * 4 + 1] = (word >>> 8) & 0xff;
      out[index * 4 + 2] = (word >>> 16) & 0xff;
      out[index * 4 + 3] = (word >>> 24) & 0xff;
    }
    return out;
  }

  private compress(source: Uint8Array, offset: number): void {
    const m = this.words;
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      m[i] =
        (source[at] as number) |
        ((source[at + 1] as number) << 8) |
        ((source[at + 2] as number) << 16) |
        ((source[at + 3] as number) << 24);
    }

    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const sum = (f + a + (MD5_K[i] as number) + (m[g] as number)) | 0;
      const shift = MD5_SHIFTS[i] as number;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    }

    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 of raw bytes.
 *
 * Written out rather than reaching for `btoa`, which is a DOM API: it happens
 * to exist in Workers and in Node, but the core does not get to assume any
 * global beyond what it declares it needs.
 */
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >>> 18) & 63];
    out += BASE64_ALPHABET[(triple >>> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >>> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return out;
}
