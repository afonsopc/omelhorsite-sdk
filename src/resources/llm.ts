/**
 * The `llm` namespace: the language models a signed-in person may pick, and
 * what they have used.
 *
 * Which models exist, what they cost and who may use how much of them is
 * administered on the server; this surface only reads. The administrator
 * side lives under `oms.admin.llmProviders`, `oms.admin.llmModels`,
 * `oms.admin.llmAssignments` and `oms.admin.llmUsage`.
 */

import { Resource } from "../http";
import type { Id, QueryParams, RequestOptions } from "../types";

/** What a model can do. Absent keys mean "unknown", not "no". */
export const LLM_CAPABILITY_KEYS = Object.freeze([
  "vision",
  "audio",
  "tools",
  "json",
  "reasoning",
  "streaming",
] as const);
export type LlmCapabilityKey = (typeof LLM_CAPABILITY_KEYS)[number];
export type LlmCapabilities = { readonly [K in LlmCapabilityKey]?: boolean };

/**
 * Per-model ceilings. `rpm` is informational; the two `*_per_day_per_user`
 * keys are enforced per calendar day (server time) and answer `429` when hit.
 * A missing key or `0` means no ceiling.
 */
export const LLM_LIMIT_KEYS = Object.freeze([
  "rpm",
  "requests_per_day_per_user",
  "tokens_per_day_per_user",
] as const);
export type LlmLimitKey = (typeof LLM_LIMIT_KEYS)[number];
export type LlmLimits = { readonly [K in LlmLimitKey]?: number };

/** How much of a model's daily ceilings the caller has used today. `null` remaining means no ceiling. */
export interface LlmModelUsageToday {
  readonly requests_today: number;
  readonly tokens_today: number;
  readonly requests_remaining: number | null;
  readonly tokens_remaining: number | null;
}

/** One model the caller may choose. Prices are per million tokens, `null` when unknown. */
export interface LlmModelChoice {
  readonly id: Id;
  /** The provider's own identifier, e.g. `"qwen/qwen3.7-flash"`. */
  readonly model_id: string;
  readonly name: string;
  readonly provider_slug: string;
  readonly free: boolean;
  readonly context_window: number | null;
  readonly max_output_tokens: number | null;
  readonly input_price_per_million: number | null;
  readonly output_price_per_million: number | null;
  readonly capabilities: LlmCapabilities;
  readonly limits: LlmLimits;
  readonly usage: LlmModelUsageToday;
}

/** Cost is in the provider's currency (USD for the hosted ones), already summed. */
export interface LlmUsageTotals {
  readonly requests: number;
  readonly tokens: number;
  readonly cost: number;
  readonly errors: number;
}

/** One day of a series. `date` is `YYYY-MM-DD`; days without calls carry zeros. */
export interface LlmUsageDay {
  readonly date: string;
  readonly requests: number;
  readonly tokens: number;
  readonly cost: number;
}

export interface LlmUsageByFeature {
  readonly feature: string;
  readonly requests: number;
  readonly tokens: number;
  readonly cost: number;
}

export interface LlmUsageByModel {
  /** `null` when the provider has since been deleted. */
  readonly provider_slug: string | null;
  readonly model_id: string;
  readonly requests: number;
  readonly tokens: number;
  readonly cost: number;
}

/** One person's share, on the administrator summary. `null` fields belong to calls made by background work. */
export interface LlmUsageByUser {
  readonly user_id: Id | null;
  readonly handle: string | null;
  readonly name: string | null;
  readonly requests: number;
  readonly tokens: number;
  readonly cost: number;
}

/**
 * Usage over a window of days. `daily` has exactly `days` entries, oldest
 * first, ending today. The breakdowns count successful calls only; `errors`
 * in the totals counts the failed ones.
 */
export interface LlmUsageSummary {
  readonly days: number;
  readonly totals: {
    readonly today: LlmUsageTotals;
    readonly last_7d: LlmUsageTotals;
    readonly last_30d: LlmUsageTotals;
    /** The requested window. */
    readonly window: LlmUsageTotals;
  };
  readonly daily: LlmUsageDay[];
  readonly by_feature: LlmUsageByFeature[];
  readonly by_model: LlmUsageByModel[];
}

/** Windows longer than this answer `400`. */
export const LLM_USAGE_MAX_DAYS = 90;

export interface LlmUsageQuery {
  /** 1 to {@link LLM_USAGE_MAX_DAYS}; defaults to 30. */
  readonly days?: number;
}

export class LlmNamespace extends Resource {
  /** The models the caller may choose, with today's remaining allowance on each. */
  async models(options: RequestOptions = {}): Promise<LlmModelChoice[]> {
    return this.http.get<LlmModelChoice[]>("/llm/models", options);
  }

  /** The caller's own usage. */
  async usage(input: LlmUsageQuery = {}, options: RequestOptions = {}): Promise<LlmUsageSummary> {
    const query: QueryParams = {};
    if (input.days !== undefined) query["days"] = input.days;
    return this.http.get<LlmUsageSummary>("/llm/usage", { ...options, query });
  }
}
