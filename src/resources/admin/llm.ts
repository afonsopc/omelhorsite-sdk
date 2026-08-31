/**
 * `oms.admin.llmProviders`, `oms.admin.llmModels`, `oms.admin.llmAssignments`
 * and `oms.admin.llmUsage` - the language-model configuration. Administrators
 * only; everything below answers `403` to anybody else.
 *
 * A provider is an OpenAI-compatible endpoint plus its key. A model belongs to
 * one provider. An assignment says which models, in order, answer a named
 * feature of the site (`"chat"`, `"translate"`, ...): the second model is the
 * fallback of the first, and may sit on another provider. Usage is one record
 * per call, aggregated here.
 */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { ListParams } from "../../listing";
import type { Id, JsonObject, Paginated, QueryParams, RequestOptions, Timestamp } from "../../types";
import type { LlmCapabilities, LlmLimits, LlmUsageByUser, LlmUsageQuery, LlmUsageSummary } from "../llm";

/**
 * `openai_compatible` is any server speaking the OpenAI chat API (vLLM, LM
 * Studio, Ollama's `/v1`, a self-hosted sidecar); `openrouter` and `ollama`
 * get provider-specific error and model-list handling.
 */
export const LLM_PROVIDER_KINDS = Object.freeze(["openai_compatible", "openrouter", "ollama"] as const);
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

/**
 * Provider switches. `models_param` sends the ordered fallback list in one
 * request so the provider falls back itself (at most three models per
 * request) - what OpenRouter expects; a local server wants it off.
 */
export interface LlmProviderOptions {
  readonly models_param?: boolean;
}

/** The key never comes back: `api_key_set` says whether one is stored. */
export interface LlmProvider {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Lowercase letters, digits and dashes; unique. */
  readonly slug: string;
  readonly name: string;
  readonly kind: LlmProviderKind | string;
  /** Root of the OpenAI-compatible API, without a trailing slash: `/chat/completions` is appended. */
  readonly base_url: string;
  /** Extra request headers, sent with every call. */
  readonly headers: Record<string, string>;
  readonly options: LlmProviderOptions;
  readonly enabled: boolean;
  /** Calls allowed in flight at once on this provider; the next one answers `503`. */
  readonly max_concurrency: number;
  /** Whether the hourly sync refreshes this provider's models from its `/models`. */
  readonly sync_models: boolean;
  readonly last_synced_at: Timestamp | null;
  readonly last_sync_error: string | null;
  /** Seconds. */
  readonly open_timeout: number;
  /** Seconds, per read: a long generation is fine while tokens keep arriving. */
  readonly read_timeout: number;
  readonly api_key_set: boolean;
  readonly models_count: number;
}

export interface CreateLlmProviderInput {
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Stored encrypted; never readable again through the API. */
  readonly apiKey?: string;
  readonly kind?: LlmProviderKind;
  readonly headers?: Record<string, string>;
  readonly options?: LlmProviderOptions;
  readonly enabled?: boolean;
  /** 1 to 64. */
  readonly maxConcurrency?: number;
  readonly syncModels?: boolean;
  /** 1 to 60 seconds. */
  readonly openTimeout?: number;
  /** 5 to 600 seconds. */
  readonly readTimeout?: number;
}

/** Omitting `apiKey`, or sending an empty string, keeps the stored key. */
export type UpdateLlmProviderInput = Partial<CreateLlmProviderInput>;

/** Filter columns of `GET /admin/llm_providers`. */
export const ADMIN_LLM_PROVIDER_FILTER_COLUMNS = Object.freeze([
  "slug",
  "name",
  "kind",
  "enabled",
  "sync_models",
] as const);

export interface ListAdminLlmProvidersParams
  extends ListParams<(typeof ADMIN_LLM_PROVIDER_FILTER_COLUMNS)[number]> {}

export interface LlmProviderSyncResult extends LlmProvider {
  readonly sync: {
    readonly created: number;
    readonly updated: number;
    /** Synced models the provider no longer lists, switched off. */
    readonly disabled: number;
  };
}

/** Always `200`: a failed probe is `ok: false` with the reason, not an error. */
export interface LlmProviderTestResult {
  readonly ok: boolean;
  readonly model_id: string | null;
  readonly reply?: string;
  readonly latency_ms?: number;
  readonly error?: string;
}

export interface TestLlmProviderInput {
  /** A `model_id` of that provider; defaults to its first enabled model. */
  readonly modelId?: string;
}

/** Prices are per million tokens, `null` when unknown. */
export interface LlmModel {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly llm_provider_id: Id;
  readonly provider_slug: string | null;
  /** The provider's own identifier; unique per provider. */
  readonly model_id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** Whether signed-in people may pick it (see `oms.llm.models`). */
  readonly visible_in_chat: boolean;
  readonly context_window: number | null;
  readonly max_output_tokens: number | null;
  readonly input_price_per_million: number | null;
  readonly output_price_per_million: number | null;
  readonly free: boolean;
  readonly capabilities: LlmCapabilities;
  readonly limits: LlmLimits;
  /** `true` when it came from the provider's `/models`; the sync keeps it fresh and disables it if it vanishes. */
  readonly synced: boolean;
  readonly metadata: JsonObject;
  /** Enabled, on an enabled provider. */
  readonly usable: boolean;
}

export interface CreateLlmModelInput {
  readonly llmProviderId: Id;
  readonly modelId: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly visibleInChat?: boolean;
  readonly contextWindow?: number | null;
  readonly maxOutputTokens?: number | null;
  readonly inputPricePerMillion?: number | null;
  readonly outputPricePerMillion?: number | null;
  readonly free?: boolean;
  readonly capabilities?: LlmCapabilities;
  readonly limits?: LlmLimits;
}

/** The provider and the `model_id` are fixed after creation. */
export type UpdateLlmModelInput = Partial<Omit<CreateLlmModelInput, "llmProviderId" | "modelId">>;

/** Filter columns of `GET /admin/llm_models`. */
export const ADMIN_LLM_MODEL_FILTER_COLUMNS = Object.freeze([
  "llm_provider_id",
  "model_id",
  "name",
  "enabled",
  "visible_in_chat",
  "free",
  "synced",
] as const);

export interface ListAdminLlmModelsParams
  extends ListParams<(typeof ADMIN_LLM_MODEL_FILTER_COLUMNS)[number]> {}

/**
 * Defaults a feature applies when the call does not say otherwise.
 * `reasoning` is the request's `reasoning` object (e.g. `{ enabled: false }`:
 * a reasoning model otherwise spends the whole token budget thinking and
 * answers nothing). `num_ctx` goes to the provider verbatim (Ollama's context
 * size). `prefer_free` puts the provider's free `stealth/*` models, as synced,
 * in front of the list.
 */
export interface LlmAssignmentOptions {
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly reasoning?: JsonObject;
  readonly num_ctx?: number;
  readonly prefer_free?: boolean;
}

export interface LlmAssignmentModelRef {
  readonly id: Id;
  readonly model_id: string;
  readonly name: string;
  readonly provider_slug: string | null;
  readonly usable: boolean;
  readonly free: boolean;
}

/** A feature of the site and the ordered models that answer it. */
export interface LlmAssignment {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Lowercase letters, digits and underscores; unique. `"default"` answers features without one of their own. */
  readonly feature: string;
  /** Ordered: the second is the fallback of the first. */
  readonly llm_model_ids: Id[];
  readonly options: LlmAssignmentOptions;
  /** Human description for the features the site knows; `null` for a custom one. */
  readonly description: string | null;
  /** `llm_model_ids` resolved, in the same order. */
  readonly models: LlmAssignmentModelRef[];
}

/** One feature the site calls by name. */
export interface LlmFeature {
  readonly feature: string;
  readonly description: string;
}

export interface CreateLlmAssignmentInput {
  readonly feature: string;
  readonly llmModelIds: readonly Id[];
  readonly options?: LlmAssignmentOptions;
}

export interface UpdateLlmAssignmentInput {
  readonly llmModelIds?: readonly Id[];
  readonly options?: LlmAssignmentOptions;
}

/** Filter columns of `GET /admin/llm_assignments`. */
export const ADMIN_LLM_ASSIGNMENT_FILTER_COLUMNS = Object.freeze(["feature"] as const);

export interface ListAdminLlmAssignmentsParams
  extends ListParams<(typeof ADMIN_LLM_ASSIGNMENT_FILTER_COLUMNS)[number]> {}

/** Everybody's usage: {@link LlmUsageSummary} plus the top twenty people by cost. */
export interface LlmAdminUsageSummary extends LlmUsageSummary {
  readonly by_user: LlmUsageByUser[];
}

function providerBody(input: UpdateLlmProviderInput): JsonObject {
  const body: JsonObject = {};
  if (input.slug !== undefined) body["slug"] = input.slug;
  if (input.name !== undefined) body["name"] = input.name;
  if (input.baseUrl !== undefined) body["base_url"] = input.baseUrl;
  if (input.apiKey !== undefined) body["api_key"] = input.apiKey;
  if (input.kind !== undefined) body["kind"] = input.kind;
  if (input.headers !== undefined) body["headers"] = { ...input.headers };
  if (input.options !== undefined) body["options"] = { ...input.options } as JsonObject;
  if (input.enabled !== undefined) body["enabled"] = input.enabled;
  if (input.maxConcurrency !== undefined) body["max_concurrency"] = input.maxConcurrency;
  if (input.syncModels !== undefined) body["sync_models"] = input.syncModels;
  if (input.openTimeout !== undefined) body["open_timeout"] = input.openTimeout;
  if (input.readTimeout !== undefined) body["read_timeout"] = input.readTimeout;
  return body;
}

function modelBody(input: Partial<CreateLlmModelInput>): JsonObject {
  const body: JsonObject = {};
  if (input.llmProviderId !== undefined) body["llm_provider_id"] = input.llmProviderId;
  if (input.modelId !== undefined) body["model_id"] = input.modelId;
  if (input.name !== undefined) body["name"] = input.name;
  if (input.enabled !== undefined) body["enabled"] = input.enabled;
  if (input.visibleInChat !== undefined) body["visible_in_chat"] = input.visibleInChat;
  if (input.contextWindow !== undefined) body["context_window"] = input.contextWindow;
  if (input.maxOutputTokens !== undefined) body["max_output_tokens"] = input.maxOutputTokens;
  if (input.inputPricePerMillion !== undefined) body["input_price_per_million"] = input.inputPricePerMillion;
  if (input.outputPricePerMillion !== undefined) body["output_price_per_million"] = input.outputPricePerMillion;
  if (input.free !== undefined) body["free"] = input.free;
  if (input.capabilities !== undefined) body["capabilities"] = { ...input.capabilities } as JsonObject;
  if (input.limits !== undefined) body["limits"] = { ...input.limits } as JsonObject;
  return body;
}

function assignmentBody(input: Partial<CreateLlmAssignmentInput>): JsonObject {
  const body: JsonObject = {};
  if (input.feature !== undefined) body["feature"] = input.feature;
  if (input.llmModelIds !== undefined) body["llm_model_ids"] = [...input.llmModelIds];
  if (input.options !== undefined) body["options"] = { ...input.options } as JsonObject;
  return body;
}

export class AdminLlmProvidersNamespace extends Resource {
  async list(params: ListAdminLlmProvidersParams = {}, options: RequestOptions = {}): Promise<Paginated<LlmProvider>> {
    const base = { order: "name:asc" };
    return paginate(params, 100, (at) =>
      this.http.get<LlmProvider[]>("/admin/llm_providers", { ...options, query: listQuery(params, at, base) }),
    );
  }

  async get(id: Id, options: RequestOptions = {}): Promise<LlmProvider> {
    return this.http.get<LlmProvider>(`/admin/llm_providers/${encodeURIComponent(id)}`, options);
  }

  async create(input: CreateLlmProviderInput, options: RequestOptions = {}): Promise<LlmProvider> {
    return this.http.post<LlmProvider>("/admin/llm_providers", providerBody(input), { retry: false, ...options });
  }

  async update(id: Id, input: UpdateLlmProviderInput, options: RequestOptions = {}): Promise<LlmProvider> {
    return this.http.patch<LlmProvider>(
      `/admin/llm_providers/${encodeURIComponent(id)}`,
      providerBody(input),
      { retry: false, ...options },
    );
  }

  /** Also deletes its models and drops it from every assignment. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/admin/llm_providers/${encodeURIComponent(id)}`, options);
  }

  /** Refreshes the provider's models from its `/models` now. `502` when the provider does not answer. */
  async sync(id: Id, options: RequestOptions = {}): Promise<LlmProviderSyncResult> {
    return this.http.post<LlmProviderSyncResult>(
      `/admin/llm_providers/${encodeURIComponent(id)}/sync`,
      undefined,
      { retry: false, ...options },
    );
  }

  /** One tiny completion, to check the key, the URL and a model. */
  async test(id: Id, input: TestLlmProviderInput = {}, options: RequestOptions = {}): Promise<LlmProviderTestResult> {
    const body: JsonObject = {};
    if (input.modelId !== undefined) body["model_id"] = input.modelId;
    return this.http.post<LlmProviderTestResult>(
      `/admin/llm_providers/${encodeURIComponent(id)}/test`,
      body,
      { retry: false, ...options },
    );
  }
}

export class AdminLlmModelsNamespace extends Resource {
  async list(params: ListAdminLlmModelsParams = {}, options: RequestOptions = {}): Promise<Paginated<LlmModel>> {
    const base = { order: "name:asc" };
    return paginate(params, 100, (at) =>
      this.http.get<LlmModel[]>("/admin/llm_models", { ...options, query: listQuery(params, at, base) }),
    );
  }

  async get(id: Id, options: RequestOptions = {}): Promise<LlmModel> {
    return this.http.get<LlmModel>(`/admin/llm_models/${encodeURIComponent(id)}`, options);
  }

  async create(input: CreateLlmModelInput, options: RequestOptions = {}): Promise<LlmModel> {
    return this.http.post<LlmModel>("/admin/llm_models", modelBody(input), { retry: false, ...options });
  }

  async update(id: Id, input: UpdateLlmModelInput, options: RequestOptions = {}): Promise<LlmModel> {
    return this.http.patch<LlmModel>(`/admin/llm_models/${encodeURIComponent(id)}`, modelBody(input), {
      retry: false,
      ...options,
    });
  }

  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/admin/llm_models/${encodeURIComponent(id)}`, options);
  }
}

export class AdminLlmAssignmentsNamespace extends Resource {
  async list(
    params: ListAdminLlmAssignmentsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<LlmAssignment>> {
    return paginate(params, 100, (at) =>
      this.http.get<LlmAssignment[]>("/admin/llm_assignments", { ...options, query: listQuery(params, at) }),
    );
  }

  async get(id: Id, options: RequestOptions = {}): Promise<LlmAssignment> {
    return this.http.get<LlmAssignment>(`/admin/llm_assignments/${encodeURIComponent(id)}`, options);
  }

  async create(input: CreateLlmAssignmentInput, options: RequestOptions = {}): Promise<LlmAssignment> {
    return this.http.post<LlmAssignment>("/admin/llm_assignments", assignmentBody(input), {
      retry: false,
      ...options,
    });
  }

  async update(id: Id, input: UpdateLlmAssignmentInput, options: RequestOptions = {}): Promise<LlmAssignment> {
    return this.http.patch<LlmAssignment>(
      `/admin/llm_assignments/${encodeURIComponent(id)}`,
      assignmentBody(input),
      { retry: false, ...options },
    );
  }

  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/admin/llm_assignments/${encodeURIComponent(id)}`, options);
  }

  /** The features the site calls by name, with a description each. Any other slug is accepted too. */
  async features(options: RequestOptions = {}): Promise<LlmFeature[]> {
    return this.http.get<LlmFeature[]>("/admin/llm_assignments/features", options);
  }
}

export class AdminLlmUsageNamespace extends Resource {
  async summary(input: LlmUsageQuery = {}, options: RequestOptions = {}): Promise<LlmAdminUsageSummary> {
    const query: QueryParams = {};
    if (input.days !== undefined) query["days"] = input.days;
    return this.http.get<LlmAdminUsageSummary>("/admin/llm_usage", { ...options, query });
  }
}
