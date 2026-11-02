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
  /** `0` everyone, `1` trusted accounts, `2` administrators. Only models at or below the account's tier are listed. */
  readonly tier: number;
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

/**
 * The tools a model may have used. A completion offers only `web_search` and
 * `read_url` ({@link LLM_COMPLETION_TOOLS}); `search` and `execute` were the
 * account tools of the assistant chat, which is gone.
 */
export const LLM_TOOL_NAMES = Object.freeze(["web_search", "read_url", "search", "execute"] as const);
export type LlmToolName = (typeof LLM_TOOL_NAMES)[number] | (string & {});

/** `running` only ever appears in the stream; a stored call is `done` or `error`. */
export const LLM_TOOL_CALL_STATUSES = Object.freeze(["running", "done", "error"] as const);
export type LlmToolCallStatus = (typeof LLM_TOOL_CALL_STATUSES)[number];

/**
 * One use of a tool: what was asked (`args`), a one-line `summary` for people, how long it took.
 * `args` is the tool's input: `{ query }` for `web_search` and `search`, `{ url }` for `read_url`,
 * and for `execute` `{ code, code_chars }` - the head of the program (2,000 characters at most)
 * and the full length it had.
 */
export interface LlmToolCall {
  readonly name: LlmToolName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: LlmToolCallStatus;
  readonly summary?: string;
  readonly ms?: number;
  readonly error?: string;
}

/** The tools a completion may hand the model. Each call the model makes counts as one search or one page read. */
export const LLM_COMPLETION_TOOLS = Object.freeze(["web_search", "read_url"] as const);
export type LlmCompletionTool = (typeof LLM_COMPLETION_TOOLS)[number];

/** At most this many messages in one completion. */
export const LLM_COMPLETION_MAX_MESSAGES = 200;
/** Longer contents answer `400`. */
export const LLM_COMPLETION_MAX_MESSAGE_CHARS = 100_000;
/** All contents together. */
export const LLM_COMPLETION_MAX_TOTAL_CHARS = 400_000;
/** `maxTokens` above this answers `400`. */
export const LLM_COMPLETION_MAX_OUTPUT_TOKENS = 16_000;
/** How many tool calls one completion may make before the model is told to answer with what it has. */
export const LLM_COMPLETION_MAX_TOOL_CALLS = 6;

export type LlmCompletionRole = "system" | "user" | "assistant";

export interface LlmCompletionMessage {
  readonly role: LlmCompletionRole;
  /** Plain text. Images and audio are not accepted here. */
  readonly content: string;
}

export interface LlmCompletionInput {
  /** In order. At least one `user` or `assistant` turn; `system` turns alone are a `400`. */
  readonly messages: readonly LlmCompletionMessage[];
  /**
   * A model the caller may choose (an `id` or a `model_id` from {@link LlmNamespace.models}).
   * Omitted, the server's own choice for API completions answers, with its fallbacks.
   */
  readonly model?: string;
  /** Ask for a JSON object. A request, not a guarantee: parse defensively. */
  readonly json?: boolean;
  /** `0` to `2`. */
  readonly temperature?: number;
  /** `1` to {@link LLM_COMPLETION_MAX_OUTPUT_TOKENS}. */
  readonly maxTokens?: number;
  /** Tools the model may use while answering. Their calls come back in {@link LlmCompletion.tool_calls}. */
  readonly tools?: readonly LlmCompletionTool[];
  /** Language of the web searches the model runs (`"pt-PT"`, `"en"`); defaults to Portuguese. */
  readonly language?: string;
}

/** One finished completion. Tokens and cost are `null` when the provider did not report them. */
export interface LlmCompletion {
  readonly text: string;
  /** The provider's identifier of the model that answered (a fallback may differ from the one asked for). */
  readonly model_id: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  /** In the provider's currency (USD for the hosted ones). */
  readonly cost: number | null;
  /** What the model did with its tools, in order. Empty without `tools`. */
  readonly tool_calls: readonly LlmToolCall[];
  /** From the request to the answer, in milliseconds. */
  readonly duration_ms: number;
}

export class LlmNamespace extends Resource {
  /** The models the caller may choose, with today's remaining allowance on each. */
  async models(options: RequestOptions = {}): Promise<LlmModelChoice[]> {
    return this.http.get<LlmModelChoice[]>("/llm/models", options);
  }

  /**
   * `POST /llm/completions` - one answer to a list of messages, with nothing
   * remembered between calls.
   *
   * Every completion counts on the account's daily ceilings (`llm_requests`
   * and `llm_cost_microusd` in `oms.quotas.list()`) and on the chosen model's
   * own daily limits. Needs the `llm` scope on an OAuth token.
   *
   * @throws {OmsApiError} 400 for malformed messages, an unknown model
   *   (`error: "unknown_model"`) or an unknown tool; 403 `error: "model_not_allowed"`
   *   for a model above the account's tier; 429 `error: "limit"` when a
   *   daily ceiling is reached, or above 30 completions a minute; 502
   *   `error: "unavailable"` when no model answered; 503 `error: "busy"`
   *   when the provider has no free slot, worth a retry in a moment.
   */
  async complete(input: LlmCompletionInput, options: RequestOptions = {}): Promise<LlmCompletion> {
    const body: Record<string, unknown> = {
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    };
    if (input.model !== undefined) body["model"] = input.model;
    if (input.json !== undefined) body["json"] = input.json;
    if (input.temperature !== undefined) body["temperature"] = input.temperature;
    if (input.maxTokens !== undefined) body["max_tokens"] = input.maxTokens;
    if (input.tools !== undefined) body["tools"] = [...input.tools];
    if (input.language !== undefined) body["language"] = input.language;
    return this.http.post<LlmCompletion>("/llm/completions", body, options);
  }

  /** The caller's own usage. */
  async usage(input: LlmUsageQuery = {}, options: RequestOptions = {}): Promise<LlmUsageSummary> {
    const query: QueryParams = {};
    if (input.days !== undefined) query["days"] = input.days;
    return this.http.get<LlmUsageSummary>("/llm/usage", { ...options, query });
  }
}
