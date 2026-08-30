/**
 * The `chests` namespace: short-lived drop boxes for moving files and text
 * between two devices that share nothing else.
 *
 * Two secrets, and they are not the same thing:
 * - the chest NAME is the read capability. Anyone holding it opens the chest
 *   and lists its entries. It is the slug in the shareable link.
 * - the chest TOKEN is the owner capability, and it is handed out ONCE, in the
 *   201 that created the chest. Lose it and, unless the creator was signed in,
 *   the chest can never be managed again.
 *
 * Chests expire two hours after creation, so any read can legitimately 404 on
 * something that existed a minute ago. Creating one anonymously is throttled
 * to five an hour per IP and gated by a captcha.
 */

import { OmsApiError, OmsError } from "../errors";
import { type ApiClient, Resource, readJson } from "../http";
import { UploadManager, type DirectUploadTarget, md5Base64, objectStoreFetch } from "./storage/upload";
import type { BaseRecord, FileInput, Id, OperationOptions, RequestOptions, Timestamp } from "../types";
import { readFileInput } from "../types";

/** What an entry holds: a file's bytes, or a piece of text. */
export type ChestEntryKind = "file" | "note";

/** A drop box. */
export interface Chest extends BaseRecord {
  /** Human-readable read capability. Treat it as a secret. */
  readonly name: string;
  /** Whether anyone holding the name may add and remove entries. */
  readonly editable_by_others: boolean;
  /** Ceiling in bytes: 5 GB when created anonymously, 10 GB when signed in. */
  readonly max_size: number;
  /** Bytes already reserved by the entries. */
  readonly current_size: number;
  /** When the chest and everything in it is deleted. */
  readonly expires_at: Timestamp;
  /** Owner, when the chest was created by a signed-in user. */
  readonly creator_id?: Id | null;
  /** Present on every read. */
  readonly chest_entries?: ChestEntry[];
}

/** One item inside a chest: a note, or a file. */
export interface ChestEntry extends BaseRecord {
  readonly chest_id: Id;
  readonly kind: ChestEntryKind;
  /** Display name; the filename for a file entry. */
  readonly name: string;
  /** Text of a note. `null` on a file entry. */
  readonly content?: string | null;
  /** Bytes this entry reserves against the chest's ceiling. */
  readonly size: number;
  /** False while a file entry exists but its bytes have not landed yet. */
  readonly data_attached: boolean;
}

/** What {@link ChestsNamespace.open} answers with. */
export interface ChestOpenResult extends Chest {
  /** Endpoint of the `c/` short link pointing at this chest. */
  readonly short_link_endpoint: string | null;
  /**
   * The owner capability. Present ONLY on the call that created the chest.
   * Store it there and then, or lose the ability to manage this chest.
   */
  readonly chest_token?: string;
  /**
   * Whether this call minted the chest (HTTP 201) rather than finding one
   * (HTTP 200). Derived by the SDK from the status code; the body does not
   * say. It is also exactly when `chest_token` is present.
   */
  readonly created: boolean;
}

/** Arguments for {@link ChestsNamespace.open}. */
export interface OpenChestInput {
  /**
   * Name to open. Omit it to be handed your own active chest, minting one if
   * you have none - and that branch is what the throttle and the captcha
   * apply to.
   */
  readonly name?: string;
  /**
   * Turnstile token. Required to MINT a chest anonymously (no `name`, no
   * active chest of your own); ignored otherwise and never needed by a
   * signed-in caller.
   */
  readonly captchaToken?: string;
}

/** Arguments for adding an entry to a chest. */
export interface CreateChestEntryInput {
  readonly chestId: Id;
  /**
   * The owner capability. Not needed when the chest has `editable_by_others`
   * on, or when you are the signed-in creator.
   */
  readonly chestToken?: string;
  /** Display name. Required for a note; defaults to the file's own filename. */
  readonly name?: string;
  /** Text to store. Mutually exclusive with `file`. */
  readonly content?: string;
  /** File to store. Mutually exclusive with `content`. */
  readonly file?: FileInput;
}

/** Arguments for the explicit three-step file upload. */
export interface CreateChestFileInput {
  readonly chestId: Id;
  readonly file: FileInput;
  readonly chestToken?: string;
  /** Overrides the name stored for the entry. Defaults to the filename. */
  readonly name?: string;
}

/** Options for the calls that prove ownership of a chest. */
export interface ChestOwnerOptions extends RequestOptions {
  /** The owner capability, unless you are the signed-in creator. */
  readonly chestToken?: string;
}

/** Entries of a chest, reachable as `oms.chests.entries`. */
export class ChestEntriesNamespace extends Resource {
  private readonly uploads: UploadManager;

  constructor(http: ApiClient) {
    super(http);
    this.uploads = new UploadManager(http);
  }

  /**
   * Adds an entry. A note is one request; a file goes through
   * {@link createWithUpload}, because a chest never takes bytes through the API.
   *
   * ```ts
   * await oms.chests.entries.create({ chestId, name: "notes", content: "..." });
   * await oms.chests.entries.create({ chestId, file: file(bytes, "clip.mov") });
   * ```
   */
  async create(input: CreateChestEntryInput, options: OperationOptions = {}): Promise<ChestEntry> {
    if (input.file && input.content !== undefined) {
      throw new OmsError("A chest entry carries either `content` or `file`, not both.", "invalid_request");
    }
    if (input.file) {
      return this.createWithUpload(
        {
          chestId: input.chestId,
          file: input.file,
          ...(input.chestToken === undefined ? {} : { chestToken: input.chestToken }),
          ...(input.name === undefined ? {} : { name: input.name }),
        },
        options,
      );
    }
    if (input.content === undefined) {
      throw new OmsError("A chest entry needs either `content` or `file`.", "invalid_request");
    }
    if (!input.name) {
      throw new OmsError("A note needs a `name`.", "invalid_request");
    }

    return this.http.post<ChestEntry>(
      "/chest_entries",
      {
        chest_id: input.chestId,
        kind: "note",
        name: input.name,
        content: input.content,
        chest_token: input.chestToken,
      },
      { retry: false, ...options },
    );
  }

  /**
   * Uploads a file the direct way, in four hops:
   *
   * 1. `POST /chest_entries` reserves the space (`kind: "file"`, `size`);
   * 2. `POST /chest_entries/:id/attachment_signed_url` presigns a PUT;
   * 3. the PUT goes straight to object storage, with no `Authorization`;
   * 4. `POST /chest_entries/:id/attach_blob` binds the bytes to the entry.
   *
   * Step 2 may be called ONCE per entry: a second call comes back as a 500, so
   * a naive retry is worse than useless. The SDK therefore treats the whole
   * thing as atomic -
   * anything that fails after step 1 destroys the half-built entry (releasing
   * the space it reserved) before rethrowing, so a retry starts clean.
   *
   * The file is buffered whole: the MD5 the presigned signature covers has to
   * be computed over all of it.
   */
  async createWithUpload(
    input: CreateChestFileInput,
    options: OperationOptions & { readonly onReserved?: (entry: ChestEntry) => void } = {},
  ): Promise<ChestEntry> {
    const { blob, filename } = await readFileInput(input.file);
    const name = input.name ?? filename;

    const { onReserved, ...operation } = options;
    const entry = await this.http.post<ChestEntry>(
      "/chest_entries",
      {
        chest_id: input.chestId,
        kind: "file",
        name,
        size: blob.size,
        chest_token: input.chestToken,
      },
      { retry: false, ...operation },
    );
    // The entry exists from here on, so a caller can offer a cancel that
    // deletes it while the bytes are still going up.
    onReserved?.(entry);

    try {
      const checksum = await md5Base64(blob);
      const { signed_url: target } = await this.http.post<{ signed_url: DirectUploadTarget }>(
        `/chest_entries/${encodeURIComponent(entry.id)}/attachment_signed_url`,
        { checksum },
        { retry: false, ...options },
      );

      await this.uploads.putDirect(target, blob, options);

      await this.http.post<{ attached: boolean }>(
        `/chest_entries/${encodeURIComponent(entry.id)}/attach_blob`,
        { blob_signed_id: target.blob_signed_id },
        { retry: false, ...options },
      );
    } catch (thrown) {
      // The entry holds reserved space and has burned its one presign. Leaving
      // it behind would eat the chest's ceiling until expiry and make a retry
      // fail with a 500 instead of working.
      await this.delete(entry.id, {
        ...options,
        ...(input.chestToken === undefined ? {} : { chestToken: input.chestToken }),
      }).catch(() => undefined);
      throw thrown;
    }

    // The record `create` returned predates the upload; the bytes have landed
    // now, and there is no show endpoint to re-read it from.
    return { ...entry, data_attached: true };
  }

  /**
   * `GET /chest_entries/:id/data` - the entry's bytes.
   *
   * SENT WITH NO CREDENTIAL, deliberately. The endpoint checks only that the
   * entry exists and has bytes attached - never the chest name, the chest
   * token, or who is asking. The ENTRY ID IS THE WHOLE CAPABILITY - which is
   * worth knowing for its own sake, and which also means a credential on this
   * request could not possibly change the answer.
   *
   * That matters because sending one breaks the call in a browser. The
   * endpoint answers `302` to the object store, and following that hop
   * replaces the request's origin with an opaque one (Fetch standard: a
   * cross-origin redirect of a CORS request whose origin already differs from
   * the current URL's origin), so the store sees `Origin: null` and answers
   * `Access-Control-Allow-Origin: *`. Wildcard plus credentials is illegal, so
   * a client built with `sessionCookie: true` would have the browser reject
   * the bytes with an opaque "Failed to fetch". Asking anonymously sidesteps
   * it: `*` is fine for an uncredentialed request.
   *
   * Two shapes come back and both are handled here: the `302` to the object
   * store, or the bytes inline with a `Content-Disposition`. Either way this
   * returns the bytes.
   *
   * Going around the transport costs the usual thing: no retry, no per-call
   * deadline, only the caller's `signal`. Use {@link downloadUrl} when the
   * destination is an `<a download>` or a media element rather than memory.
   *
   * @throws {OmsApiError} 404 when the entry is unknown, its bytes never
   *   landed, or the chest has passed its two-hour expiry and been swept.
   */
  async download(id: Id, options: RequestOptions = {}): Promise<Blob> {
    const url = this.downloadUrl(id);
    const response = await objectStoreFetch(this.http)(url, {
      method: "GET",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // Never "include": see the note above.
      credentials: "omit",
      redirect: "follow",
    });
    if (!response.ok) {
      throw new OmsApiError(
        response.status === 404
          ? "No bytes for that entry: it is unknown, its upload never completed, or the chest expired. Chests live two hours."
          : `The chest entry download failed (${response.status}).`,
        { status: response.status, method: "GET", url, attempts: 1 },
      );
    }
    return response.blob();
  }

  /**
   * Absolute URL for an entry's bytes, for an `<a download>`, a `<video>`, or a
   * new tab.
   *
   * Synchronous and credential-free, because the endpoint is: the entry id is
   * the only thing it checks. No `?token=` is appended, because a session
   * token in a URL that ends up in markup, in a shared link and in an access
   * log buys precisely nothing on a route that never reads it.
   *
   * Treat the URL as a bearer capability all the same. Anyone holding it can
   * pull the file until the chest expires, so it is exactly as shareable as the
   * chest name and no more.
   *
   * ```tsx
   * <a href={oms.chests.entries.downloadUrl(entry.id)} download={entry.name}>
   *   {entry.name}
   * </a>
   * ```
   *
   * A link is also the better answer for a large entry: the browser streams it
   * straight to disk, where {@link download} would buffer the whole file in
   * memory first.
   */
  downloadUrl(id: Id): string {
    return this.http.url(`/chest_entries/${encodeURIComponent(id)}/data`);
  }

  /**
   * `DELETE /chest_entries/:id` - removes an entry and gives its bytes back to
   * the chest's ceiling.
   *
   * Accepts the owner token, and also accepts ANY caller when the chest has
   * `editable_by_others` on.
   */
  async delete(id: Id, options: ChestOwnerOptions = {}): Promise<void> {
    await this.http.delete<void>(`/chest_entries/${encodeURIComponent(id)}`, {
      ...options,
      query: { chest_token: options.chestToken },
    });
  }
}

/** The `chests` namespace, reachable as `oms.chests`. */
export class ChestsNamespace extends Resource {
  /** Items inside a chest. */
  readonly entries: ChestEntriesNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.entries = new ChestEntriesNamespace(http);
  }

  /**
   * `GET /chests/find_or_create` - opens a chest by name, or hands you your
   * own, minting one if you have none.
   *
   * Read {@link ChestOpenResult.chest_token} on the way past: when `created`
   * is true that field is the only copy of the owner capability you will ever
   * be given.
   *
   * ```ts
   * const mine = await oms.chests.open();               // yours, or a new one
   * const theirs = await oms.chests.open({ name });     // someone's, by name
   * ```
   *
   * @throws {OmsApiError} 404 when a named chest is unknown or has expired.
   * @throws {OmsQuotaError} 429 when the global ceiling of 30 live chests is
   *   full, or when an anonymous caller has spent the hourly budget of five.
   */
  async open(input: OpenChestInput = {}, options: RequestOptions = {}): Promise<ChestOpenResult> {
    const response = await this.http.raw("GET", "/chests/find_or_create", {
      ...options,
      query: { name: input.name, cf_turnstile_token: input.captchaToken },
    });
    const body = (await readJson(response)) as Omit<ChestOpenResult, "created">;
    return { ...body, created: response.status === 201 };
  }

  /**
   * `PATCH /chests/:id/toggle_editable` - flips whether holders of the name
   * may write, or only read.
   *
   * Turning it OFF destroys every file entry in the chest. Notes survive.
   */
  async toggleEditable(id: Id, options: ChestOwnerOptions = {}): Promise<Chest> {
    return this.http.patch<Chest>(
      `/chests/${encodeURIComponent(id)}/toggle_editable`,
      { chest_token: options.chestToken },
      options,
    );
  }

  /**
   * `DELETE /chests/:id/owner_destroy` - destroys the chest and its entries
   * before the expiry. Owner only, proved by the token or by being the
   * signed-in creator.
   */
  async delete(id: Id, options: ChestOwnerOptions = {}): Promise<void> {
    await this.http.delete<void>(`/chests/${encodeURIComponent(id)}/owner_destroy`, {
      ...options,
      query: { chest_token: options.chestToken },
    });
  }
}
