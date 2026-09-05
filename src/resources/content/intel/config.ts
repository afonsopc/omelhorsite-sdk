/** Intel config: the per-user pipeline settings. */

import { Resource } from "../../../http";
import type { Id, RequestOptions, Timestamp } from "../../../types";

/**
 * The only keys {@link IntelConfig.prompts} accepts.
 *
 * Any other key fails the whole `PATCH` with
 * `400 "Prompts unknown keys: <the offenders>"`. A key that is present but
 * empty is not the same as an absent one: absent means "use the platform
 * default", present-and-empty means the pipeline gets an empty prompt.
 */
export const INTEL_PROMPT_KEYS = ["build", "media", "enrich_plan", "enrich_actors", "enrich_synth", "report"] as const;

/** One overridable prompt in the analysis pipeline. */
export type IntelPromptKey = (typeof INTEL_PROMPT_KEYS)[number];

/**
 * The per-user knobs on the analysis pipeline. One row per user, created on
 * demand - see {@link IntelConfigNamespace.get}.
 */
export interface IntelConfig {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /**
   * Free text telling the classifier what "important" means for you. `null`
   * falls back to the platform default. This is the single highest-leverage
   * field here: everything else is a threshold applied to the score this
   * produces.
   */
  readonly rubric: string | null;
  /**
   * Prompt overrides, keyed by {@link IntelPromptKey}. `{}` means "platform
   * defaults everywhere"; a key present means that one stage is overridden.
   *
   * Nullable at the database level even though it defaults to `{}`.
   */
  readonly prompts: Partial<Record<IntelPromptKey, string>> | null;
  /** LLM for the story-building pass. `null` uses the platform default. */
  readonly build_model: string | null;
  /** LLM for report generation. `null` uses the platform default. */
  readonly report_model: string | null;
  /** Stories below this importance are left out of reports. 0-10, default 4. */
  readonly report_min_importance: number;
  /**
   * Stories below this importance are never web-enriched. 0-10, default 6.
   *
   * Lowering it does not enrich the backlog quickly: the job does three
   * stories per run, highest importance first.
   */
  readonly enrich_min_importance: number;
  /**
   * Master switch for the enrichment pass. `false` leaves every story at
   * `enriched: false` and `details: null` for ever.
   */
  readonly web_search: boolean;
  /**
   * How many {@link IntelSource} rows you may own. 1-500, default 50.
   *
   * Enforced on CREATE only (`validate :within_source_quota, on: :create`), so
   * lowering it below your current count does not delete anything - it just
   * stops the next create with `400 "Source limit reached (N)"`.
   */
  readonly max_sources: number;
}

/**
 * Arguments for {@link IntelConfigNamespace.update}.
 *
 * Every key is optional and only the keys you send are written -
 * `assign_attributes` over a permitted hash - so this is a genuine partial
 * update, unlike {@link UpdateIntelSourceInput.config}.
 */
export interface UpdateIntelConfigInput {
  readonly rubric?: string | null;
  /**
   * REPLACES the whole prompts object. Same trap as
   * {@link UpdateIntelSourceInput.config}: it is one JSON column, so a partial
   * object drops the keys you left out. Spread the current value.
   *
   * Only {@link INTEL_PROMPT_KEYS} are accepted; anything else fails the whole
   * request with a 400 naming the offenders.
   */
  readonly prompts?: Partial<Record<IntelPromptKey, string>>;
  readonly buildModel?: string | null;
  readonly reportModel?: string | null;
  /** 0-10. Outside the range is a 400, not a clamp. */
  readonly reportMinImportance?: number;
  /** 0-10. Outside the range is a 400, not a clamp. */
  readonly enrichMinImportance?: number;
  readonly webSearch?: boolean;
  /** 1-500. Outside the range is a 400, not a clamp. */
  readonly maxSources?: number;
}

/**
 * `/intel_config` - the per-user pipeline settings.
 *
 * A Rails SINGULAR resource (`resource :intel_config`), so the path has no id
 * and there is no listing: `GET /intel_config` and `PATCH /intel_config` are
 * the whole surface. Both act on the caller's own row and there is no way to
 * address anybody else's.
 */
export class IntelConfigNamespace extends Resource {
  /**
   * `GET /intel_config` - your settings.
   *
   * **This read WRITES.** The controller calls `IntelConfig.for(Current.user)`,
   * which is `find_or_create_by!`, so a first call inserts the row with the
   * column defaults and returns it. Consequences worth knowing: it is not safe
   * to fire at high frequency (two concurrent first calls race on the unique
   * index and one raises), the response is a `200` even when it just created
   * something, and `created_at` on a "read" can be now.
   *
   * @throws {OmsApiError} 403 `"Intel access is restricted."` outside the
   *   allowlist - checked before the row is created, so a refused caller does
   *   not leave a row behind.
   */
  async get(options: RequestOptions = {}): Promise<IntelConfig> {
    return this.http.get<IntelConfig>("/intel_config", options);
  }

  /**
   * `PATCH /intel_config` - changes settings. Answers with the whole row.
   *
   * A genuine partial update for the scalar fields, and a whole-object replace
   * for `prompts` - see {@link UpdateIntelConfigInput.prompts}.
   *
   * The route also accepts `PUT`, and it means exactly the same thing: Rails
   * maps both onto `update` and the controller does not read the verb. There is
   * no "replace the whole config" call.
   *
   * Failures are a `400` whose body is ONE sentence, not a field map:
   * `ApplicationRecord#error_messages` is `errors.full_messages.to_sentence`,
   * so several violations arrive joined by commas and "and". Parse it for
   * humans, not for code.
   *
   * @throws {OmsApiError} 400 for a threshold outside `0..10`, a `max_sources`
   *   outside `1..500`, or a `prompts` key outside {@link INTEL_PROMPT_KEYS}.
   */
  async update(input: UpdateIntelConfigInput, options: RequestOptions = {}): Promise<IntelConfig> {
    return this.http.patch<IntelConfig>(
      "/intel_config",
      {
        ...(input.rubric === undefined ? {} : { rubric: input.rubric }),
        ...(input.prompts === undefined ? {} : { prompts: input.prompts }),
        ...(input.buildModel === undefined ? {} : { build_model: input.buildModel }),
        ...(input.reportModel === undefined ? {} : { report_model: input.reportModel }),
        ...(input.reportMinImportance === undefined ? {} : { report_min_importance: input.reportMinImportance }),
        ...(input.enrichMinImportance === undefined ? {} : { enrich_min_importance: input.enrichMinImportance }),
        ...(input.webSearch === undefined ? {} : { web_search: input.webSearch }),
        ...(input.maxSources === undefined ? {} : { max_sources: input.maxSources }),
      },
      options,
    );
  }
}
