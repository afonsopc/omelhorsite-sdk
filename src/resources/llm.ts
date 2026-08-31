/**
 * The `llm` namespace: the language models a signed-in person may pick, and
 * what they have used.
 *
 * Which models exist, what they cost and who may use how much of them is
 * administered on the server; this surface only reads. The administrator
 * side lives under `oms.admin.llmProviders`, `oms.admin.llmModels`,
 * `oms.admin.llmAssignments` and `oms.admin.llmUsage`.
 */

import { Resource, type ApiClient } from "../http";
import { listQuery, paginate } from "../listing";
import type { ListParams } from "../listing";
import type { Id, Paginated, QueryParams, RequestOptions, Timestamp } from "../types";

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

/** Filter columns of `GET /llm_chats`, on top of the base ones. */
export const LLM_CHAT_FILTER_COLUMNS = Object.freeze(["title", "pinned", "archived", "llm_model_id"] as const);

export interface ListLlmChatsParams extends ListParams<(typeof LLM_CHAT_FILTER_COLUMNS)[number]> {}

export const LLM_CHAT_ROLES = Object.freeze(["user", "assistant", "system", "tool"] as const);
export type LlmChatRole = (typeof LLM_CHAT_ROLES)[number];

/** `streaming` while the answer is still being written, then `done` or `error`. */
export const LLM_CHAT_MESSAGE_STATUSES = Object.freeze(["streaming", "done", "error"] as const);
export type LlmChatMessageStatus = (typeof LLM_CHAT_MESSAGE_STATUSES)[number];

/** One conversation with the assistant. Pinned chats list first, then by `last_message_at`. */
export interface LlmChat {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Taken from the first question when not set by the caller. */
  readonly title: string | null;
  /** The chosen model; `null` means the server's default for chats. */
  readonly llm_model_id: Id | null;
  /** The provider's identifier of the model that answered last. */
  readonly model_id: string | null;
  readonly pinned: boolean;
  /** An archived chat can be read but not written to. */
  readonly archived: boolean;
  readonly last_message_at: Timestamp;
  readonly message_count: number;
}

export interface LlmChatMessage {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly llm_chat_id: Id;
  readonly role: LlmChatRole;
  readonly content: string;
  readonly status: LlmChatMessageStatus;
  readonly model_id: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost: number | null;
  /** Why an answer ended in `error`, or `"interrupted"` on a `done` answer cut short by the reader. */
  readonly error: string | null;
  readonly tool_calls: readonly unknown[];
  /** The question this answer belongs to. */
  readonly parent_id: Id | null;
}

/** `GET /llm_chats/:id`: the chat plus its messages, oldest first. */
export interface LlmChatDetail extends LlmChat {
  readonly messages: LlmChatMessage[];
}

export interface CreateLlmChatInput {
  readonly title?: string;
  /** Must be a model the caller may choose (see {@link LlmNamespace.models}); the server answers `400` otherwise. */
  readonly llmModelId?: Id;
}

export interface UpdateLlmChatInput {
  readonly title?: string | null;
  readonly llmModelId?: Id | null;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export interface SendLlmChatMessageInput {
  /** At most 32,000 characters. */
  readonly content: string;
  /** Answer with this model and remember it on the chat. */
  readonly llmModelId?: Id;
}

/**
 * What a streamed answer yields, in order: any number of `delta` events, then
 * exactly one `done` or `error`. A refusal before the first token (the
 * provider is busy, the daily ceiling is reached, no model is available) is
 * not an event but a thrown `OmsApiError` with status `503`, `429` or `502`,
 * whose body carries `message_id` - the failed answer is kept on the chat so
 * it can be regenerated.
 */
export type LlmChatStreamEvent =
  | { readonly type: "delta"; readonly delta: string }
  | {
      readonly type: "done";
      readonly messageId: Id;
      readonly modelId: string | null;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cost: number | null;
    }
  | {
      readonly type: "error";
      /** `busy`, `limit`, `unavailable`, `unknown_model` or `interrupted`. */
      readonly error: string;
      readonly message: string;
      readonly messageId: Id | null;
    };

interface WireStreamFrame {
  readonly delta?: string;
  readonly done?: boolean;
  readonly message_id?: Id | null;
  readonly model_id?: string | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cost?: number | null;
  readonly error?: string;
  readonly message?: string;
}

function toEvent(frame: WireStreamFrame): LlmChatStreamEvent | undefined {
  if (typeof frame.error === "string") {
    return { type: "error", error: frame.error, message: frame.message ?? frame.error, messageId: frame.message_id ?? null };
  }
  if (frame.done === true) {
    return {
      type: "done",
      messageId: frame.message_id ?? "",
      modelId: frame.model_id ?? null,
      inputTokens: frame.input_tokens ?? null,
      outputTokens: frame.output_tokens ?? null,
      cost: frame.cost ?? null,
    };
  }
  if (typeof frame.delta === "string" && frame.delta.length > 0) return { type: "delta", delta: frame.delta };
  return undefined;
}

/** The messages of one chat: send, regenerate, delete. Reached through `oms.llm.chats.messages`. */
export class LlmChatMessagesNamespace extends Resource {
  /**
   * Sends a question and streams the answer. Consume with `for await`; stop
   * early by aborting `options.signal` - the server keeps what had arrived.
   * The chat's title is set from the first question.
   */
  send(chatId: Id, input: SendLlmChatMessageInput, options: RequestOptions = {}): AsyncGenerator<LlmChatStreamEvent, void, undefined> {
    const body: Record<string, unknown> = { content: input.content };
    if (input.llmModelId !== undefined) body["llm_model_id"] = input.llmModelId;
    return this.stream("POST", `/llm_chats/${encodeURIComponent(chatId)}/messages`, { ...options, body });
  }

  /**
   * Answers the same question again. Only the chat's last message qualifies,
   * and it must be an answer; the old answer is discarded, the new one takes
   * its place with the same `parent_id`.
   */
  regenerate(chatId: Id, messageId: Id, options: RequestOptions = {}): AsyncGenerator<LlmChatStreamEvent, void, undefined> {
    return this.stream(
      "POST",
      `/llm_chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/regenerate`,
      options,
    );
  }

  /**
   * Removes a message from the end of the chat. Deleting a question also
   * removes the answers to it; anything earlier answers `400`.
   */
  async delete(chatId: Id, messageId: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(
      `/llm_chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      options,
    );
  }

  private async *stream(
    method: string,
    path: string,
    options: RequestOptions & { body?: unknown },
  ): AsyncGenerator<LlmChatStreamEvent, void, undefined> {
    let buffer = "";
    for await (const chunk of this.http.streamText(method, path, options)) {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data.length === 0) continue;
        let frame: WireStreamFrame;
        try {
          frame = JSON.parse(data) as WireStreamFrame;
        } catch {
          continue;
        }
        const event = toEvent(frame);
        if (event === undefined) continue;
        yield event;
        if (event.type !== "delta") return;
      }
    }
    // The connection ended before the frame that says the answer finished.
    yield { type: "error", error: "interrupted", message: "The answer was cut short.", messageId: null };
  }
}

/** The caller's conversations with the assistant. Reached through `oms.llm.chats`. */
export class LlmChatsNamespace extends Resource {
  readonly messages: LlmChatMessagesNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.messages = new LlmChatMessagesNamespace(http);
  }

  /** Pinned first, then most recently active. Archived chats are included; filter with `exactSearch: { archived: false }`. */
  async list(params: ListLlmChatsParams = {}, options: RequestOptions = {}): Promise<Paginated<LlmChat>> {
    return paginate(params, 50, (at) => this.http.get<LlmChat[]>("/llm_chats", { ...options, query: listQuery(params, at) }));
  }

  /** The chat with all its messages, oldest first. */
  async get(id: Id, options: RequestOptions = {}): Promise<LlmChatDetail> {
    return this.http.get<LlmChatDetail>(`/llm_chats/${encodeURIComponent(id)}`, options);
  }

  async create(input: CreateLlmChatInput = {}, options: RequestOptions = {}): Promise<LlmChatDetail> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body["title"] = input.title;
    if (input.llmModelId !== undefined) body["llm_model_id"] = input.llmModelId;
    return this.http.post<LlmChatDetail>("/llm_chats", body, options);
  }

  async update(id: Id, input: UpdateLlmChatInput, options: RequestOptions = {}): Promise<LlmChatDetail> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body["title"] = input.title;
    if (input.llmModelId !== undefined) body["llm_model_id"] = input.llmModelId;
    if (input.pinned !== undefined) body["pinned"] = input.pinned;
    if (input.archived !== undefined) body["archived"] = input.archived;
    return this.http.patch<LlmChatDetail>(`/llm_chats/${encodeURIComponent(id)}`, body, options);
  }

  /** Removes the chat and every message in it. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/llm_chats/${encodeURIComponent(id)}`, options);
  }
}

export class LlmNamespace extends Resource {
  /** Conversations with the assistant. */
  readonly chats: LlmChatsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.chats = new LlmChatsNamespace(http);
  }

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
