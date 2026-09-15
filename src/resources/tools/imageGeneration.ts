/**
 * Image generation: a prompt in, a PNG out.
 *
 * Same shape as the other async tools - `POST /image_generations` enqueues a
 * job and answers with a row plus a `job_id` and, when anonymous, a
 * `watch_token`.
 *
 * What is different here is that the work can run in two places, and the
 * caller picks: a model on the server itself, which is free, or a model at a
 * paid provider, which is not. {@link ImageGenerationNamespace.models} lists
 * the ones the CURRENT caller may actually use, so an anonymous caller never
 * sees a model they would be refused for.
 *
 * Two daily quotas apply, not one: a count of images, which every model
 * consumes, and a spend ceiling in USD, which only the paid ones touch.
 */

import { Resource } from "../../http";
import type { Id, RequestOptions } from "../../types";
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

/** Where a model runs. `"local"` is the server itself and always free. */
export type ImageProvider = "local" | "fal";

/** One model the caller may pick, as `GET /image_generations/models` lists it. */
export interface ImageModel {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly provider: ImageProvider;
  /** True when a run costs money and counts against the spend ceiling. */
  readonly billable: boolean;
  /** True on models kept behind an account flag. */
  readonly adult: boolean;
  /** `width * height` may not exceed this. */
  readonly max_pixels: number;
  readonly default_width: number;
  readonly default_height: number;
  readonly default_steps: number;
  readonly max_steps: number;
  /** False on models that ignore `negative_prompt` entirely, such as FLUX. */
  readonly supports_negative_prompt: boolean;
  /** Millionths of a USD per megapixel, rounded up. Zero on local models. */
  readonly cost_per_megapixel_microusd: number;
}

/**
 * One generation.
 *
 * Both routes that answer with one - `POST /image_generations` and
 * `GET /image_generations/:id` - answer the same shape, so `result_url` is
 * always PRESENT and simply `null` until the run completes.
 */
export interface ImageGeneration extends ToolRecord {
  readonly model_key: string;
  readonly provider: ImageProvider;
  readonly prompt: string;
  readonly negative_prompt: string | null;
  readonly width: number;
  readonly height: number;
  readonly steps: number;
  /**
   * The seed the image was made with. Null only while the run is still
   * pending: a caller that sent none gets the one the server picked, which is
   * what makes the image reproducible.
   */
  readonly seed: number | null;
  readonly guidance: string | null;
  /** What this run costs, in millionths of a USD. Zero on local models. */
  readonly cost_microusd: number;
  /**
   * Signed URL of the PNG, or `null`. `null` covers three different
   * situations - the run has not finished, it failed, or the 24-hour sweep
   * took the attachment - which is why {@link ImageGenerationNamespace.resultUrl}
   * exists rather than a bare read of this field.
   */
  readonly result_url: string | null;
}

/** What `POST /image_generations` answers with. */
export type ImageGenerationCreated = ImageGeneration & ToolJobHandle;

/** Arguments for starting a run. */
export interface CreateImageGenerationInput extends ToolCaptcha {
  /** What to draw. Cap: 2000 characters. */
  readonly prompt: string;
  /** Defaults to the server's own default model when omitted. */
  readonly model?: string;
  /** Ignored by models whose `supports_negative_prompt` is false. */
  readonly negativePrompt?: string;
  /** Must be a multiple of 8, at least 256. Defaults to the model's own. */
  readonly width?: number;
  /** Must be a multiple of 8, at least 256. Defaults to the model's own. */
  readonly height?: number;
  readonly steps?: number;
  /** Pass the seed of an earlier run to reproduce its image. */
  readonly seed?: number;
  readonly guidance?: number;
}

/** The `imageGeneration` tool, reachable as `oms.tools.imageGeneration`. */
export class ImageGenerationNamespace extends Resource {
  private readonly jobs = new JobsNamespace(this.http);

  /**
   * `GET /image_generations/models` - the models THIS caller may use.
   *
   * The list is already filtered by session and by account flags, so it is
   * safe to render straight into a picker: everything in it is something
   * {@link create} would accept.
   */
  async models(options: RequestOptions = {}): Promise<ImageModel[]> {
    const body = await this.http.get<{ models: ImageModel[] }>("/image_generations/models", options);
    return body.models;
  }

  /**
   * `POST /image_generations` - enqueues a run and returns straight away.
   *
   * Every optional field is omitted from the body when the caller did not set
   * it, so the server applies the chosen model's own defaults rather than the
   * SDK guessing at them.
   *
   * NOT retried by default: replaying this `POST` after a 502 starts a second
   * run, and on a paid model bills for it. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsApiError} 400 for an unknown model, a blank prompt, or
   *   dimensions outside the model's limits; 403 for a model this caller may
   *   not use; 429 once either daily quota is spent.
   * @throws {OmsAuthError} 401 when anonymous and the captcha is missing or bad.
   */
  async create(
    input: CreateImageGenerationInput,
    options: RequestOptions = {},
  ): Promise<ImageGenerationCreated> {
    return this.http.post<ImageGenerationCreated>(
      "/image_generations",
      {
        prompt: input.prompt,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.negativePrompt === undefined ? {} : { negative_prompt: input.negativePrompt }),
        ...(input.width === undefined ? {} : { width: input.width }),
        ...(input.height === undefined ? {} : { height: input.height }),
        ...(input.steps === undefined ? {} : { steps: input.steps }),
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
        ...toolCaptchaFields(input),
      },
      { ...options, retry: options.retry ?? false },
    );
  }

  /**
   * `GET /image_generations/:id` - one poll.
   *
   * @throws {OmsApiError} 404 once the 24-hour retention sweep has taken it.
   * @throws {OmsAuthError} 401 when the run belongs to someone else, which
   *   includes an anonymous run being read from a different address.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<ImageGeneration> {
    return this.http.get<ImageGeneration>(`/image_generations/${encodeURIComponent(id)}`, options);
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
  async run(
    input: CreateImageGenerationInput,
    options: ToolRunOptions = {},
  ): Promise<ImageGeneration> {
    const created = await this.create(input, options);
    return awaitToolJob<ImageGeneration>(
      this.jobs,
      created,
      (request) => this.get(created.id, request),
      options,
      "the image generation",
    );
  }

  /**
   * Downloads the PNG of a finished run.
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
  resultUrl(record: ImageGeneration): string {
    return requireToolArtifact(record, record.result_url, "result");
  }
}
