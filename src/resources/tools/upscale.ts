/**
 * Upscaling: enlarges an image without turning it to mush.
 *
 * Same shape as background removal: `POST /upscales` enqueues a job and
 * answers with a row plus a `job_id` and, when anonymous, a `watch_token`.
 *
 * Limits: 20 MiB, and the scale must be one of `"2"`, `"3"`, `"4"`.
 *
 * Like background removal, this tool has no daily quota, so there is no
 * `quota()` to call first.
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
 * Enlargement factor, as the string the API expects.
 *
 * A string and not a number because the server compares it against an
 * allow-list of strings; `4` and `"4"` are not the same request.
 */
export type UpscaleScale = "2" | "3" | "4";

/**
 * An upscale run.
 *
 * Both routes that answer with one - `POST /upscales` and `GET /upscales/:id` -
 * answer the same shape, so `result_url` is always PRESENT and simply `null`
 * until the run completes.
 *
 * `progress_percent`, inherited from {@link ToolRecord}, is never sent for this
 * tool. Progress for an upscale lives on the {@link Job} row that
 * {@link UpscaleCreated.job_id} names.
 */
export interface Upscale extends ToolRecord {
  /** One of `"2"`, `"3"`, `"4"` - a string. Never `null`; defaults to `"4"`. */
  readonly scale: string;
  /**
   * Signed URL of the enlarged PNG, or `null`. `null` covers three different
   * situations - the run has not finished, it failed, or the 24-hour sweep
   * took the attachment - which is why {@link UpscaleNamespace.resultUrl}
   * exists rather than a bare read of this field.
   */
  readonly result_url: string | null;
}

/** What `POST /upscales` answers with. */
export type UpscaleCreated = Upscale & ToolJobHandle;

/** Arguments for starting a run. */
export interface CreateUpscaleInput extends ToolCaptcha {
  /** The image. Cap: 20 MiB. */
  readonly file: FileInput;
  /** Defaults to `"4"`, which is what the server picks when none is sent. */
  readonly scale?: UpscaleScale;
}

/** The `upscale` tool, reachable as `oms.tools.upscale`. */
export class UpscaleNamespace extends Resource {
  /**
   * The one polling loop, reached through the jobs namespace. Built here for
   * the same reason as in every other tool: the constructor stays
   * one-argument, and the wrapper is stateless.
   */
  private readonly jobs = new JobsNamespace(this.http);

  /**
   * `POST /upscales` - enqueues a run and returns straight away.
   *
   * `scale` is omitted from the form when the caller did not pick one, so the
   * server applies its own default rather than the SDK guessing at it.
   *
   * NOT retried by default: replaying this `POST` after a 502 re-uploads the
   * image and starts a second run. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 400 for an oversized image, an image bomb, or a
   *   scale outside the allow-list.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   */
  async create(input: CreateUpscaleInput, options: RequestOptions = {}): Promise<UpscaleCreated> {
    return this.http.postForm<UpscaleCreated>(
      "/upscales",
      {
        file: input.file,
        ...(input.scale === undefined ? {} : { scale: input.scale }),
        ...toolCaptchaFields(input),
      },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `GET /upscales/:id` - one poll.
   *
   * @throws {OmsApiError} 404 once the 24-hour retention sweep has taken it.
   * @throws {OmsAuthError} 401 when the run belongs to someone else, which
   *   includes an anonymous run being read from a different address.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<Upscale> {
    return this.http.get<Upscale>(`/upscales/${encodeURIComponent(id)}`, options);
  }

  /**
   * Creates a run and waits for it, through `oms.jobs.wait`.
   *
   * Resolves with a `"failed"` row rather than throwing when the work failed.
   * Pass `waitTimeoutMs` (or a `signal`) to bound the wait; there is no default
   * deadline.
   *
   * @throws {OmsTimeoutError} `code: "timeout"` when `waitTimeoutMs` elapses,
   *   `code: "aborted"` when the signal fires. Neither cancels the run: pick it
   *   up later with {@link get}.
   */
  async run(input: CreateUpscaleInput, options: ToolRunOptions = {}): Promise<Upscale> {
    const created = await this.create(input, options);
    return awaitToolJob<Upscale>(
      this.jobs,
      created,
      (request) => this.get(created.id, request),
      options,
      "the upscale",
    );
  }

  /**
   * Downloads the enlarged image of a finished run.
   *
   * @throws {OmsError} `conflict` when the run has not finished,
   *   `invalid_request` when it failed, `not_found` when the artefact is gone.
   */
  async download(id: Id, options: RequestOptions = {}): Promise<Blob> {
    const record = await this.get(id, options);
    return fetchToolArtifact(this.http, this.resultUrl(record), options);
  }

  /**
   * The signed URL of a finished run's image, from a row you already hold.
   *
   * It is a credential: anyone holding it can read the image.
   *
   * @throws {OmsError} explaining which of the three reasons there is no URL.
   */
  resultUrl(record: Upscale): string {
    return requireToolArtifact(record, record.result_url, "result");
  }
}
