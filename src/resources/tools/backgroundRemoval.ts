/**
 * Background removal: cuts the subject out of an image.
 *
 * `POST /background_removals` enqueues a job and answers immediately with a
 * row plus a `job_id` and, for an anonymous caller, a `watch_token`. Poll
 * through `oms.jobs` with that handle, or use {@link BackgroundRemovalNamespace.run}.
 *
 * Limits: 15 MiB, and an image bomb (absurd pixel count for its byte size) is
 * rejected with a 400 before any work starts.
 *
 * This tool has no daily quota, so there is no `quota()` here to call first.
 */

import { Resource } from "../../http";
import type { FileInput, Id, RequestOptions } from "../../types";
import { JobsNamespace } from "../jobs";
import {
  awaitToolJob,
  fetchToolArtifact,
  requireToolArtifact,
  toolCaptchaFields,
  type ToolCaptcha,
  type ToolJobHandle,
  type ToolRecord,
  type ToolRunOptions,
} from "./index";

/**
 * A background removal run.
 *
 * Both routes that answer with one - `POST /background_removals` and
 * `GET /background_removals/:id` - answer the same shape, so `result_url` is
 * always PRESENT and simply `null` until the run completes.
 *
 * `progress_percent`, inherited from {@link ToolRecord}, is never sent for this
 * tool. Progress lives on the {@link Job} row that
 * {@link BackgroundRemovalCreated.job_id} names.
 */
export interface BackgroundRemoval extends ToolRecord {
  /**
   * Signed URL of the cut-out PNG, or `null` - for the run not having
   * finished, for it having failed, or for the 24-hour sweep having taken the
   * attachment. {@link BackgroundRemovalNamespace.resultUrl} tells the three
   * apart.
   */
  readonly result_url: string | null;
}

/** What `POST /background_removals` answers with. */
export type BackgroundRemovalCreated = BackgroundRemoval & ToolJobHandle;

/** Arguments for starting a run. */
export interface CreateBackgroundRemovalInput extends ToolCaptcha {
  /** The image. Cap: 15 MiB. */
  readonly file: FileInput;
}

/** The `backgroundRemoval` tool, reachable as `oms.tools.backgroundRemoval`. */
export class BackgroundRemovalNamespace extends Resource {
  /**
   * The one polling loop, reached through the jobs namespace.
   *
   * Built here rather than injected so every namespace keeps the same
   * one-argument constructor `client.ts` relies on. It is a stateless wrapper
   * over the same transport, so there is nothing to share.
   */
  private readonly jobs = new JobsNamespace(this.http);

  /**
   * `POST /background_removals` - enqueues a run and returns straight away.
   *
   * NOT retried by default, unlike most of the SDK. The transport's policy
   * replays a `POST` that died with a 502, and here that would re-upload the
   * image and start a second run. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 400 when the image is too large or looks like a bomb.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   */
  async create(input: CreateBackgroundRemovalInput, options: RequestOptions = {}): Promise<BackgroundRemovalCreated> {
    return this.http.postForm<BackgroundRemovalCreated>(
      "/background_removals",
      { file: input.file, ...toolCaptchaFields(input) },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `GET /background_removals/:id` - one poll.
   *
   * Ownership is the caller's session, or - for an anonymous run - the IP the
   * run was started from. Reading someone else's run is a 401, not a 404.
   *
   * @throws {OmsApiError} 404 once the 24-hour retention sweep has taken it.
   * @throws {OmsAuthError} 401 when the run belongs to someone else, which
   *   includes an anonymous run being read from a different address.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<BackgroundRemoval> {
    return this.http.get<BackgroundRemoval>(`/background_removals/${encodeURIComponent(id)}`, options);
  }

  /**
   * Creates a run and waits for it, reporting progress along the way.
   *
   * Delegates the polling to `oms.jobs.wait` with the handle the create call
   * returned; it does not open a second polling loop.
   *
   * Resolves with a `"failed"` row rather than throwing when the work failed -
   * the request cycle worked, the work did not, and only the caller knows
   * whether that is an exception. Pass `waitTimeoutMs` (or a `signal`) to bound
   * the wait; there is no default deadline.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the run: pick it
   *   up later with {@link get}.
   */
  async run(input: CreateBackgroundRemovalInput, options: ToolRunOptions = {}): Promise<BackgroundRemoval> {
    const created = await this.create(input, options);
    return awaitToolJob<BackgroundRemoval>(
      this.jobs,
      created,
      (request) => this.get(created.id, request),
      options,
      "the background removal",
    );
  }

  /**
   * Downloads the cut-out image of a finished run.
   *
   * Two calls: one to read the row for its `result_url`, one to fetch the
   * signed URL itself with no credential attached. Pass the row you already
   * have to {@link resultUrl} plus {@link fetchToolArtifact} if you would
   * rather not pay for the first.
   *
   * @throws {OmsError} `conflict` when the run has not finished,
   *   `invalid_request` when it failed, `not_found` when the artefact is gone.
   */
  async download(id: Id, options: RequestOptions = {}): Promise<Blob> {
    const record = await this.get(id, options);
    return fetchToolArtifact(this.http, this.resultUrl(record), options);
  }

  /**
   * The signed URL of a finished run's PNG, from a row you already hold.
   *
   * Good for handing to a browser or a player instead of moving the bytes. It
   * is a credential: anyone holding it can read the image.
   *
   * @throws {OmsError} explaining which of the three reasons there is no URL.
   */
  resultUrl(record: BackgroundRemoval): string {
    return requireToolArtifact(record, record.result_url, "result");
  }
}
