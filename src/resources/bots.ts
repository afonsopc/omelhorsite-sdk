/**
 * The `bots` namespace: messaging channels (Telegram bots for now), the
 * contacts who talk to them and the conversations, plus sending.
 *
 * A channel is a bot token the account connected; the server validates it,
 * registers a webhook and from then on every message the bot receives lands
 * here as a {@link BotContact} and a {@link BotMessage}. Sending is
 * {@link BotMessagesNamespace.send}: the server talks to Telegram and records
 * the outgoing message with its source, so an inbox shows what went where.
 *
 * Needs the `bots:read` scope to read and `bots:write` to send or connect.
 */

import { Resource } from "../http";
import type { ApiClient } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../listing";
import type { Id, JsonObject, Paginated, RequestOptions, Timestamp } from "../types";

export const BOT_CHANNEL_KINDS = Object.freeze(["telegram"] as const);
export type BotChannelKind = (typeof BOT_CHANNEL_KINDS)[number];

export const BOT_CHANNEL_HEALTHS = Object.freeze(["unknown", "ok", "error"] as const);
export type BotChannelHealth = (typeof BOT_CHANNEL_HEALTHS)[number];

/** What the bot does: `inbox` keeps the conversations and lets the API send; `responder` answers on the owner's behalf. */
export const BOT_PLUGINS = Object.freeze(["inbox", "responder"] as const);
export type BotPlugin = (typeof BOT_PLUGINS)[number];

/** Telegram's own cap on a message's text. Longer is a `400`. */
export const BOT_MESSAGE_MAX_TEXT = 4096;

/** A connected bot. The token never comes back: only whether one is stored. */
export interface BotChannel {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly name: string;
  readonly kind: BotChannelKind;
  readonly plugin: BotPlugin;
  /** The bot's own handle on the platform, filled from the token. */
  readonly username: string | null;
  /** The bot's own id on the platform. */
  readonly external_id: string | null;
  readonly enabled: boolean;
  readonly health: BotChannelHealth;
  readonly last_error: string | null;
  readonly last_message_at: Timestamp | null;
  readonly token_set: boolean;
  /** Where the platform delivers the bot's updates. */
  readonly webhook_url: string;
}

/** `GET /bot_channels/:id` adds two counters. */
export interface BotChannelDetail extends BotChannel {
  readonly contacts_count: number;
  readonly unread_count: number;
}

export interface CreateBotChannelInput {
  readonly name: string;
  /** The token the platform's bot factory gave you (Telegram: @BotFather). */
  readonly token: string;
  readonly kind?: BotChannelKind;
  /** Defaults to `inbox`. */
  readonly plugin?: BotPlugin;
  readonly enabled?: boolean;
}

/** A new `token` reconnects the channel; omit it to keep the stored one. */
export type UpdateBotChannelInput = Partial<CreateBotChannelInput>;

/** What the platform reports about the bot and its webhook. */
export type BotChannelStatus =
  | {
      readonly ok: true;
      readonly username: string | null;
      readonly webhook_url: string;
      readonly webhook_set: boolean;
      readonly pending_updates: number;
      readonly last_error: string | null;
    }
  | { readonly ok: false; readonly error: string };

export const BOT_CHANNEL_FILTER_COLUMNS = Object.freeze(["name", "kind", "enabled"] as const);
export interface ListBotChannelsParams extends ListParams<(typeof BOT_CHANNEL_FILTER_COLUMNS)[number]> {}

export const BOT_CONTACT_KINDS = Object.freeze(["private", "group", "supergroup", "channel"] as const);
export type BotContactKind = (typeof BOT_CONTACT_KINDS)[number];

/** Someone (or some group) that talked to a channel. */
export interface BotContact {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly bot_channel_id: Id;
  /** The chat id on the platform. */
  readonly external_id: string;
  readonly kind: BotContactKind;
  readonly name: string | null;
  readonly username: string | null;
  readonly tags: string[];
  /** The contact blocked the bot or left the group: sending is refused. */
  readonly blocked: boolean;
  readonly last_message_at: Timestamp | null;
  readonly last_direction: "in" | "out" | null;
  readonly last_text: string | null;
  readonly messages_count: number;
  readonly unread_count: number;
  /** The responder could not answer; `note` says what was missing. */
  readonly needs_human: boolean;
  readonly note: string | null;
  readonly handled_until: Timestamp | null;
  /** The name, or `@username`, or the chat id. */
  readonly display_name: string;
}

export interface UpdateBotContactInput {
  readonly name?: string | null;
  readonly tags?: readonly string[];
  readonly needs_human?: boolean;
  readonly note?: string | null;
}

export const BOT_CONTACT_FILTER_COLUMNS = Object.freeze(["bot_channel_id", "external_id", "username", "kind", "blocked"] as const);
export interface ListBotContactsParams extends ListParams<(typeof BOT_CONTACT_FILTER_COLUMNS)[number]> {
  /** Only contacts of one channel. */
  readonly channelId?: Id;
}

export type BotMessageDirection = "in" | "out";
/** `contact` came in; `human` was sent from the inbox; `api` by a token (a script, the CLI); `bot` by the responder. */
export type BotMessageSource = "contact" | "human" | "api" | "bot";

export interface BotMessage {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly bot_channel_id: Id;
  readonly bot_contact_id: Id;
  readonly direction: BotMessageDirection;
  readonly source: BotMessageSource;
  readonly text: string;
  readonly external_id: string | null;
  readonly sent_at: Timestamp;
  /** Set when the platform refused the send; the row stays so the thread shows it. */
  readonly error: string | null;
}

export const BOT_MESSAGE_FILTER_COLUMNS = Object.freeze(["bot_channel_id", "bot_contact_id", "direction", "source"] as const);
export interface ListBotMessagesParams extends ListParams<(typeof BOT_MESSAGE_FILTER_COLUMNS)[number]> {
  readonly contactId?: Id;
  readonly channelId?: Id;
}

/** `text` for the text as typed; `html` for Telegram's HTML subset (bold, links, blockquote). */
export type BotMessageFormat = "text" | "html";

export type SendBotMessageInput = (
  | { readonly contactId: Id; readonly channelId?: undefined; readonly externalId?: undefined }
  | {
      /** A contact that has not written yet, by channel and chat id. */
      readonly channelId: Id;
      readonly externalId: string;
      readonly contactId?: undefined;
    }
) & {
  readonly text: string;
  readonly format?: BotMessageFormat;
};

/** The responder of a channel whose plugin is `responder`. `id` is null until it is first saved. */
export interface BotResponder {
  readonly id: Id | null;
  readonly created_at: Timestamp | null;
  readonly updated_at: Timestamp | null;
  readonly bot_channel_id: Id;
  readonly enabled: boolean;
  readonly system_prompt: string;
  readonly knowledge: string;
  readonly signature: string;
  /** An LLM model id or model_id; null for the account's default. */
  readonly model: string | null;
  /** Runs per day, at hours drawn inside the window. */
  readonly slots_per_day: number;
  readonly window_start: string;
  readonly window_end: string;
  readonly timezone: string;
  readonly history_limit: number;
  readonly language: string;
  readonly facts_count: number;
  readonly sources_count: number;
  readonly waiting_count: number;
}

export type UpdateBotResponderInput = Partial<
  Pick<BotResponder, "enabled" | "system_prompt" | "knowledge" | "signature" | "model" | "slots_per_day" | "window_start" | "window_end" | "timezone" | "history_limit" | "language">
>;

export type BotFactSource = "manual" | "chat" | "learned";

export interface BotFact {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly bot_channel_id: Id;
  readonly text: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly source: BotFactSource;
  readonly bot_contact_id: Id | null;
  readonly active: boolean;
}

export interface CreateBotFactInput {
  readonly channelId: Id;
  readonly text: string;
  readonly valid_from?: string | null;
  readonly valid_until?: string | null;
}
export type UpdateBotFactInput = Partial<Omit<CreateBotFactInput, "channelId">>;

export const BOT_FACT_FILTER_COLUMNS = Object.freeze(["bot_channel_id", "source", "bot_contact_id"] as const);
export interface ListBotFactsParams extends ListParams<(typeof BOT_FACT_FILTER_COLUMNS)[number]> {
  readonly channelId?: Id;
}

export interface BotSource {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly bot_channel_id: Id;
  readonly name: string;
  readonly url: string;
  readonly description: string | null;
}

export interface CreateBotSourceInput {
  readonly channelId: Id;
  readonly name: string;
  readonly url: string;
  readonly description?: string | null;
}
export type UpdateBotSourceInput = Partial<Omit<CreateBotSourceInput, "channelId">>;

export const BOT_SOURCE_FILTER_COLUMNS = Object.freeze(["bot_channel_id"] as const);
export interface ListBotSourcesParams extends ListParams<(typeof BOT_SOURCE_FILTER_COLUMNS)[number]> {
  readonly channelId?: Id;
}

export type BotResponderRunStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface BotResponderRun {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly bot_channel_id: Id;
  readonly status: BotResponderRunStatus;
  readonly trigger: "schedule" | "manual";
  readonly scheduled_at: Timestamp;
  readonly started_at: Timestamp | null;
  readonly finished_at: Timestamp | null;
  readonly replied: number;
  readonly escalated: number;
  readonly error: string | null;
}

export const BOT_RUN_FILTER_COLUMNS = Object.freeze(["bot_channel_id", "status", "trigger"] as const);
export interface ListBotResponderRunsParams extends ListParams<(typeof BOT_RUN_FILTER_COLUMNS)[number]> {
  readonly channelId?: Id;
}

export type BotReplyOutcome = "replied" | "escalated" | "skipped";
export interface BotReplyResult {
  readonly result: BotReplyOutcome;
  readonly contact: BotContact;
}
export interface BotTeachResult {
  readonly learned: BotFact[];
  readonly contact: BotContact;
}

function responderBody(input: UpdateBotResponderInput): JsonObject {
  const body: JsonObject = {};
  for (const key of ["enabled", "system_prompt", "knowledge", "signature", "model", "slots_per_day", "window_start", "window_end", "timezone", "history_limit", "language"] as const) {
    if (input[key] !== undefined) body[key] = input[key] as JsonObject[string];
  }
  return body;
}

function channelBody(input: Partial<CreateBotChannelInput>): JsonObject {
  const body: JsonObject = {};
  if (input.name !== undefined) body["name"] = input.name;
  if (input.token !== undefined) body["token"] = input.token;
  if (input.kind !== undefined) body["kind"] = input.kind;
  if (input.plugin !== undefined) body["plugin"] = input.plugin;
  if (input.enabled !== undefined) body["enabled"] = input.enabled;
  return body;
}

/** `/bot_channels` - the connected bots. */
export class BotChannelsNamespace extends Resource {
  /** `GET /bot_channels` - your channels, oldest first. */
  async list(params: ListBotChannelsParams = {}, options: RequestOptions = {}): Promise<Paginated<BotChannel>> {
    const base = { order: "created_at:asc" };
    return paginate(params, 50, (at) => this.http.get<BotChannel[]>("/bot_channels", { ...options, query: listQuery(params, at, base) }));
  }

  /** `GET /bot_channels/:id`. 404 when it is not yours. */
  async get(id: Id, options: RequestOptions = {}): Promise<BotChannelDetail> {
    return this.http.get<BotChannelDetail>(`/bot_channels/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /bot_channels` - connect a bot. The server checks the token with the
   * platform and registers the webhook before answering `201`.
   *
   * @throws {OmsApiError} 400 when the platform refuses the token, the name
   *   repeats, or the account is at its channel limit.
   */
  async create(input: CreateBotChannelInput, options: RequestOptions = {}): Promise<BotChannelDetail> {
    return this.http.post<BotChannelDetail>("/bot_channels", channelBody(input), { retry: false, ...options });
  }

  /** `PATCH /bot_channels/:id`. A new `token` reconnects; a blank one is ignored. */
  async update(id: Id, input: UpdateBotChannelInput, options: RequestOptions = {}): Promise<BotChannelDetail> {
    return this.http.patch<BotChannelDetail>(`/bot_channels/${encodeURIComponent(id)}`, channelBody(input), { retry: false, ...options });
  }

  /** `DELETE /bot_channels/:id` - unregisters the webhook, drops contacts and messages. `204`. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/bot_channels/${encodeURIComponent(id)}`, options);
  }

  /** `POST /bot_channels/:id/test` - what the platform says about the bot and the webhook. */
  async test(id: Id, options: RequestOptions = {}): Promise<BotChannelStatus> {
    return this.http.post<BotChannelStatus>(`/bot_channels/${encodeURIComponent(id)}/test`, {}, { retry: false, ...options });
  }
}

/** `/bot_contacts` - who talked to your channels. Read, tag, mark read. */
export class BotContactsNamespace extends Resource {
  /** `GET /bot_contacts` - most recently active first. */
  async list(params: ListBotContactsParams = {}, options: RequestOptions = {}): Promise<Paginated<BotContact>> {
    const base = { order: "last_message_at:desc", exactSearch: { bot_channel_id: params.channelId } };
    return paginate(params, 50, (at) => this.http.get<BotContact[]>("/bot_contacts", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<BotContact> {
    return this.http.get<BotContact>(`/bot_contacts/${encodeURIComponent(id)}`, options);
  }

  /** `PATCH /bot_contacts/:id` - the name you give them and the tags. */
  async update(id: Id, input: UpdateBotContactInput, options: RequestOptions = {}): Promise<BotContact> {
    const body: JsonObject = {};
    if (input.name !== undefined) body["name"] = input.name;
    if (input.tags !== undefined) body["tags"] = [...input.tags];
    if (input.needs_human !== undefined) body["needs_human"] = input.needs_human;
    if (input.note !== undefined) body["note"] = input.note;
    return this.http.patch<BotContact>(`/bot_contacts/${encodeURIComponent(id)}`, body, options);
  }

  /** `POST /bot_contacts/:id/read` - the unread counter to zero. */
  async markRead(id: Id, options: RequestOptions = {}): Promise<BotContact> {
    return this.http.post<BotContact>(`/bot_contacts/${encodeURIComponent(id)}/read`, {}, options);
  }

  /**
   * `POST /bot_contacts/:id/bot_reply` - the responder handles this conversation now.
   *
   * @throws {OmsApiError} 400 when the channel's plugin is not the responder or it was never saved; 502 when the model or the platform failed.
   */
  async botReply(id: Id, options: RequestOptions = {}): Promise<BotReplyResult> {
    return this.http.post<BotReplyResult>(`/bot_contacts/${encodeURIComponent(id)}/bot_reply`, {}, { retry: false, ...options });
  }

  /**
   * `POST /bot_contacts/:id/teach` - give the responder what it was missing: the general
   * part is kept as facts, the contact gets an answer, the others waiting are retried.
   */
  async teach(id: Id, hint: string, options: RequestOptions = {}): Promise<BotTeachResult> {
    return this.http.post<BotTeachResult>(`/bot_contacts/${encodeURIComponent(id)}/teach`, { hint }, { retry: false, ...options });
  }

  /** `DELETE /bot_contacts/:id` - the contact and its messages. `204`. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/bot_contacts/${encodeURIComponent(id)}`, options);
  }
}

/** `/bot_messages` - the conversations, and sending. */
export class BotMessagesNamespace extends Resource {
  /** `GET /bot_messages` - newest first; pass `order: "sent_at:asc"` for a thread top-down. */
  async list(params: ListBotMessagesParams = {}, options: RequestOptions = {}): Promise<Paginated<BotMessage>> {
    const base = { order: "sent_at:desc", exactSearch: { bot_contact_id: params.contactId, bot_channel_id: params.channelId } };
    return paginate(params, 100, (at) => this.http.get<BotMessage[]>("/bot_messages", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<BotMessage> {
    return this.http.get<BotMessage>(`/bot_messages/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /bot_messages` - send. The server talks to the platform and records
   * the message with source `api` (a token) or `human` (a session).
   *
   * @throws {OmsApiError} 422 when the contact blocked the bot; 429 at the daily
   *   limit; 502 when the platform refused (the row is kept with `error`).
   */
  async send(input: SendBotMessageInput, options: RequestOptions = {}): Promise<BotMessage> {
    const body: JsonObject = { text: input.text };
    if (input.contactId !== undefined) body["bot_contact_id"] = input.contactId;
    if (input.channelId !== undefined) body["bot_channel_id"] = input.channelId;
    if (input.externalId !== undefined) body["external_id"] = input.externalId;
    if (input.format !== undefined) body["format"] = input.format;
    return this.http.post<BotMessage>("/bot_messages", body, { retry: false, ...options });
  }

  /** `DELETE /bot_messages/:id` - one row out of the thread. `204`. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/bot_messages/${encodeURIComponent(id)}`, options);
  }
}

/** `/bot_channels/:id/responder` - the responder plugin of a channel. */
export class BotRespondersNamespace extends Resource {
  /** @throws {OmsApiError} 400 when the channel's plugin is not the responder. */
  async get(channelId: Id, options: RequestOptions = {}): Promise<BotResponder> {
    return this.http.get<BotResponder>(`/bot_channels/${encodeURIComponent(channelId)}/responder`, options);
  }

  /** `PATCH /bot_channels/:id/responder` - creates it on first save. */
  async update(channelId: Id, input: UpdateBotResponderInput, options: RequestOptions = {}): Promise<BotResponder> {
    return this.http.patch<BotResponder>(`/bot_channels/${encodeURIComponent(channelId)}/responder`, responderBody(input), { retry: false, ...options });
  }

  /**
   * `POST /bot_channels/:id/responder/run` - answer the pending conversations now, outside the schedule.
   *
   * @throws {OmsApiError} 400 when a run is already open or the responder was never saved.
   */
  async run(channelId: Id, options: RequestOptions = {}): Promise<BotResponderRun> {
    return this.http.post<BotResponderRun>(`/bot_channels/${encodeURIComponent(channelId)}/responder/run`, {}, { retry: false, ...options });
  }
}

/** `/bot_facts` - what the responder knows, with optional validity dates. */
export class BotFactsNamespace extends Resource {
  async list(params: ListBotFactsParams = {}, options: RequestOptions = {}): Promise<Paginated<BotFact>> {
    const base = { order: "created_at:desc", exactSearch: { bot_channel_id: params.channelId } };
    return paginate(params, 100, (at) => this.http.get<BotFact[]>("/bot_facts", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<BotFact> {
    return this.http.get<BotFact>(`/bot_facts/${encodeURIComponent(id)}`, options);
  }

  /** @throws {OmsApiError} 400 when the channel's plugin is not the responder. */
  async create(input: CreateBotFactInput, options: RequestOptions = {}): Promise<BotFact> {
    const body: JsonObject = { bot_channel_id: input.channelId, text: input.text };
    if (input.valid_from !== undefined) body["valid_from"] = input.valid_from;
    if (input.valid_until !== undefined) body["valid_until"] = input.valid_until;
    return this.http.post<BotFact>("/bot_facts", body, { retry: false, ...options });
  }

  async update(id: Id, input: UpdateBotFactInput, options: RequestOptions = {}): Promise<BotFact> {
    const body: JsonObject = {};
    if (input.text !== undefined) body["text"] = input.text;
    if (input.valid_from !== undefined) body["valid_from"] = input.valid_from;
    if (input.valid_until !== undefined) body["valid_until"] = input.valid_until;
    return this.http.patch<BotFact>(`/bot_facts/${encodeURIComponent(id)}`, body, { retry: false, ...options });
  }

  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/bot_facts/${encodeURIComponent(id)}`, options);
  }
}

/** `/bot_sources` - pages the responder may read when a question calls for it. */
export class BotSourcesNamespace extends Resource {
  async list(params: ListBotSourcesParams = {}, options: RequestOptions = {}): Promise<Paginated<BotSource>> {
    const base = { order: "created_at:asc", exactSearch: { bot_channel_id: params.channelId } };
    return paginate(params, 100, (at) => this.http.get<BotSource[]>("/bot_sources", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<BotSource> {
    return this.http.get<BotSource>(`/bot_sources/${encodeURIComponent(id)}`, options);
  }

  async create(input: CreateBotSourceInput, options: RequestOptions = {}): Promise<BotSource> {
    const body: JsonObject = { bot_channel_id: input.channelId, name: input.name, url: input.url };
    if (input.description !== undefined) body["description"] = input.description;
    return this.http.post<BotSource>("/bot_sources", body, { retry: false, ...options });
  }

  async update(id: Id, input: UpdateBotSourceInput, options: RequestOptions = {}): Promise<BotSource> {
    const body: JsonObject = {};
    if (input.name !== undefined) body["name"] = input.name;
    if (input.url !== undefined) body["url"] = input.url;
    if (input.description !== undefined) body["description"] = input.description;
    return this.http.patch<BotSource>(`/bot_sources/${encodeURIComponent(id)}`, body, { retry: false, ...options });
  }

  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/bot_sources/${encodeURIComponent(id)}`, options);
  }
}

/** `/bot_responder_runs` - the responder's passes over the conversations, newest first. */
export class BotResponderRunsNamespace extends Resource {
  async list(params: ListBotResponderRunsParams = {}, options: RequestOptions = {}): Promise<Paginated<BotResponderRun>> {
    const base = { order: "scheduled_at:desc", exactSearch: { bot_channel_id: params.channelId } };
    return paginate(params, 50, (at) => this.http.get<BotResponderRun[]>("/bot_responder_runs", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<BotResponderRun> {
    return this.http.get<BotResponderRun>(`/bot_responder_runs/${encodeURIComponent(id)}`, options);
  }
}

export class BotsNamespace extends Resource {
  readonly channels: BotChannelsNamespace;
  readonly contacts: BotContactsNamespace;
  readonly messages: BotMessagesNamespace;
  readonly responders: BotRespondersNamespace;
  readonly facts: BotFactsNamespace;
  readonly sources: BotSourcesNamespace;
  readonly runs: BotResponderRunsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.channels = new BotChannelsNamespace(http);
    this.contacts = new BotContactsNamespace(http);
    this.messages = new BotMessagesNamespace(http);
    this.responders = new BotRespondersNamespace(http);
    this.facts = new BotFactsNamespace(http);
    this.sources = new BotSourcesNamespace(http);
    this.runs = new BotResponderRunsNamespace(http);
  }
}
