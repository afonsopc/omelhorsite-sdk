/**
 * `bun test` coverage for `oms.llm` and the four `oms.admin.llm*` namespaces.
 *
 * What can go quietly wrong here: an input key not renamed on the way to the
 * wire (`baseUrl` must travel as `base_url`, or the server ignores it and
 * answers `400` for a missing URL), an `apiKey` sent when the caller meant to
 * keep the stored one, and a filter that lands at the top level instead of
 * inside `exact_search`.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import {
  ADMIN_LLM_ASSIGNMENT_FILTER_COLUMNS,
  ADMIN_LLM_MODEL_FILTER_COLUMNS,
  ADMIN_LLM_PROVIDER_FILTER_COLUMNS,
  AdminNamespace,
} from "../src/resources/admin";
import { LLM_USAGE_MAX_DAYS, LlmNamespace } from "../src/resources/llm";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

function harness(body: unknown, status = 200): { readonly admin: AdminNamespace; readonly llm: LlmNamespace; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    let parsed: unknown = undefined;
    if (typeof init?.body === "string") parsed = JSON.parse(init.body);
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      search: decodeURIComponent(url.search),
      body: parsed,
    });
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
    retry: { maxAttempts: 1 },
  });
  return { admin: new AdminNamespace(http), llm: new LlmNamespace(http), calls };
}

describe("llm (any signed-in person)", () => {
  test("models is one GET with no parameters", async () => {
    const { llm, calls } = harness([]);
    await llm.models();
    expect(calls).toEqual([{ method: "GET", path: "/llm/models", search: "", body: undefined }]);
  });

  test("usage sends days only when given", async () => {
    const { llm, calls } = harness({ days: 30, totals: {}, daily: [], by_feature: [], by_model: [] });
    await llm.usage();
    await llm.usage({ days: 7 });
    expect(calls.map((call) => call.search)).toEqual(["", "?days=7"]);
    expect(LLM_USAGE_MAX_DAYS).toBe(90);
  });
});

describe("admin.llmProviders", () => {
  test("create renames every key to the wire form and carries the key", async () => {
    const { admin, calls } = harness({ id: "p1" });
    await admin.llmProviders.create({
      slug: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-secret",
      headers: { "X-Title": "site" },
      options: { models_param: true },
      maxConcurrency: 8,
      syncModels: true,
      openTimeout: 5,
      readTimeout: 120,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/admin/llm_providers");
    expect(calls[0]?.body).toEqual({
      slug: "openrouter",
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      api_key: "sk-secret",
      headers: { "X-Title": "site" },
      options: { models_param: true },
      max_concurrency: 8,
      sync_models: true,
      open_timeout: 5,
      read_timeout: 120,
    });
  });

  test("update without apiKey sends no api_key at all", async () => {
    const { admin, calls } = harness({ id: "p1" });
    await admin.llmProviders.update("p1", { name: "OR", enabled: false });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/admin/llm_providers/p1");
    expect(calls[0]?.body).toEqual({ name: "OR", enabled: false });
  });

  test("list filters ride inside exact_search", async () => {
    const { admin, calls } = harness([]);
    await admin.llmProviders.list({ exactSearch: { enabled: true }, page: 1, pageSize: 50 });
    expect(calls[0]?.path).toBe("/admin/llm_providers");
    expect(calls[0]?.search).toContain("exact_search[enabled]=true");
    expect(calls[0]?.search).toContain("modifiers[page]=1:50");
    expect(calls[0]?.search).toContain("modifiers[order]=name:asc");
  });

  test("sync and test are POSTs on the member", async () => {
    const { admin, calls } = harness({ ok: true, model_id: "a", reply: "ok", latency_ms: 12 });
    await admin.llmProviders.sync("p1");
    await admin.llmProviders.test("p1", { modelId: "a" });
    await admin.llmProviders.test("p1");
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/admin/llm_providers/p1/sync", undefined],
      ["POST", "/admin/llm_providers/p1/test", { model_id: "a" }],
      ["POST", "/admin/llm_providers/p1/test", {}],
    ]);
  });

  test("delete answers nothing", async () => {
    const { admin, calls } = harness(null, 204);
    await admin.llmProviders.delete("p1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/admin/llm_providers/p1");
  });
});

describe("admin.llmModels", () => {
  test("create and update rename keys; the provider and model_id only travel on create", async () => {
    const { admin, calls } = harness({ id: "m1" });
    await admin.llmModels.create({
      llmProviderId: "p1",
      modelId: "qwen/qwen3.7-flash",
      name: "Qwen",
      visibleInChat: true,
      contextWindow: 128000,
      inputPricePerMillion: 0.2,
      outputPricePerMillion: null,
      limits: { requests_per_day_per_user: 50 },
      capabilities: { vision: true },
    });
    await admin.llmModels.update("m1", { enabled: false, limits: {} });
    expect(calls[0]?.body).toEqual({
      llm_provider_id: "p1",
      model_id: "qwen/qwen3.7-flash",
      name: "Qwen",
      visible_in_chat: true,
      context_window: 128000,
      input_price_per_million: 0.2,
      output_price_per_million: null,
      limits: { requests_per_day_per_user: 50 },
      capabilities: { vision: true },
    });
    expect(calls[1]?.path).toBe("/admin/llm_models/m1");
    expect(calls[1]?.body).toEqual({ enabled: false, limits: {} });
  });

  test("list by provider", async () => {
    const { admin, calls } = harness([]);
    await admin.llmModels.list({ exactSearch: { llm_provider_id: "p1" } });
    expect(calls[0]?.search).toContain("exact_search[llm_provider_id]=p1");
  });
});

describe("admin.llmAssignments", () => {
  test("create carries the ordered ids; features is a plain GET", async () => {
    const { admin, calls } = harness({ id: "a1" });
    await admin.llmAssignments.create({ feature: "translate", llmModelIds: ["m2", "m1"], options: { temperature: 0.2 } });
    await admin.llmAssignments.update("a1", { llmModelIds: ["m1"] });
    await admin.llmAssignments.features();
    expect(calls[0]?.body).toEqual({ feature: "translate", llm_model_ids: ["m2", "m1"], options: { temperature: 0.2 } });
    expect(calls[1]?.body).toEqual({ llm_model_ids: ["m1"] });
    expect(calls[2]?.method).toBe("GET");
    expect(calls[2]?.path).toBe("/admin/llm_assignments/features");
  });
});

describe("admin.llmUsage", () => {
  test("summary is a GET with an optional window", async () => {
    const { admin, calls } = harness({ days: 30, by_user: [] });
    await admin.llmUsage.summary({ days: 14 });
    expect(calls[0]?.path).toBe("/admin/llm_usage");
    expect(calls[0]?.search).toBe("?days=14");
  });
});

describe("filter column tuples", () => {
  test("are frozen and name the columns the server accepts", () => {
    expect(Object.isFrozen(ADMIN_LLM_PROVIDER_FILTER_COLUMNS)).toBe(true);
    expect(ADMIN_LLM_MODEL_FILTER_COLUMNS).toContain("llm_provider_id");
    expect(ADMIN_LLM_ASSIGNMENT_FILTER_COLUMNS).toEqual(["feature"]);
  });
});

describe("llm.chats", () => {
  test("list, create and update speak the listing DSL and the wire names", async () => {
    const { llm, calls } = harness([]);
    await llm.chats.list({ exactSearch: { archived: false }, page: 2, pageSize: 20 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/llm_chats");
    expect(calls[0]?.search).toContain("exact_search[archived]=false");
    expect(calls[0]?.search).toContain("modifiers[page]=2:20");

    await llm.chats.create({ title: "Olá", llmModelId: "m1" });
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.body).toEqual({ title: "Olá", llm_model_id: "m1" });

    await llm.chats.update("c1", { pinned: true, llmModelId: null });
    expect(calls[2]?.method).toBe("PATCH");
    expect(calls[2]?.path).toBe("/llm_chats/c1");
    expect(calls[2]?.body).toEqual({ pinned: true, llm_model_id: null });

    await llm.chats.messages.delete("c1", "m9");
    expect(calls[3]?.method).toBe("DELETE");
    expect(calls[3]?.path).toBe("/llm_chats/c1/messages/m9");
  });

  test("send streams deltas then done, parsed out of the event stream", async () => {
    const frames = [
      'data: {"delta":"Olá"}\n\n',
      'data: {"delta":" mundo"}\n\ndata: {"done":true,"message_id":"a1","model_id":"qwen","input_tokens":10,"output_tokens":5,"cost":0.00002,"duration_ms":1840,"first_token_ms":310}\n\n',
    ];
    const calls: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method} ${new URL(input).pathname} ${init?.body}`);
      return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const http = new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl, tokens: { getToken: () => "t" }, retry: { maxAttempts: 1 } });
    const llm = new LlmNamespace(http);

    const events = [];
    for await (const event of llm.chats.messages.send("c1", { content: "Diz olá", llmModelId: "m1" })) events.push(event);

    expect(calls).toEqual(['POST /llm_chats/c1/messages {"content":"Diz olá","llm_model_id":"m1"}']);
    expect(events).toEqual([
      { type: "delta", delta: "Olá" },
      { type: "delta", delta: " mundo" },
      { type: "done", messageId: "a1", modelId: "qwen", inputTokens: 10, outputTokens: 5, cost: 0.00002, durationMs: 1840, firstTokenMs: 310 },
    ]);
  });

  test("tool frames come through as tool events, running first and then done", async () => {
    const frames = [
      'data: {"tool":{"name":"web_search","args":{"query":"cil"},"status":"running"}}\n\n',
      'data: {"tool":{"name":"web_search","args":{"query":"cil"},"status":"done","summary":"6 resultados","ms":812}}\n\n',
      'data: {"delta":"A CIL"}\n\ndata: {"done":true,"message_id":"a3","model_id":"qwen","input_tokens":1,"output_tokens":1,"cost":0}\n\n',
    ];
    const fetchImpl = async (): Promise<Response> =>
      new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    const http = new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl, tokens: { getToken: () => "t" }, retry: { maxAttempts: 1 } });
    const llm = new LlmNamespace(http);

    const events = [];
    for await (const event of llm.chats.messages.send("c1", { content: "Qual é o site da CIL?" })) events.push(event);

    expect(events.map((event) => event.type)).toEqual(["tool", "tool", "delta", "done"]);
    expect(events[0]).toEqual({ type: "tool", name: "web_search", args: { query: "cil" }, status: "running" });
    expect(events[1]).toEqual({ type: "tool", name: "web_search", args: { query: "cil" }, status: "done", summary: "6 resultados", ms: 812 });
  });

  test("toolsEnabled travels as tools_enabled on create and update", async () => {
    const { llm, calls } = harness([]);
    await llm.chats.create({ toolsEnabled: false });
    expect(calls[0]?.body).toEqual({ tools_enabled: false });
    await llm.chats.update("c1", { toolsEnabled: true });
    expect(calls[1]?.body).toEqual({ tools_enabled: true });
  });

  test("an error frame ends the stream and a cut stream reports interrupted", async () => {
    let body = 'data: {"delta":"x"}\n\ndata: {"error":"unavailable","message":"no model","message_id":"a2"}\n\n';
    const fetchImpl = async (): Promise<Response> => new Response(body, { status: 200 });
    const http = new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl, tokens: { getToken: () => "t" }, retry: { maxAttempts: 1 } });
    const llm = new LlmNamespace(http);

    const errored = [];
    for await (const event of llm.chats.messages.regenerate("c1", "a1")) errored.push(event);
    expect(errored).toEqual([
      { type: "delta", delta: "x" },
      { type: "error", error: "unavailable", message: "no model", messageId: "a2" },
    ]);

    body = 'data: {"delta":"meio"}\n\n';
    const cut = [];
    for await (const event of llm.chats.messages.send("c1", { content: "?" })) cut.push(event);
    expect(cut.map((event) => event.type)).toEqual(["delta", "error"]);
    expect(cut[1]).toMatchObject({ type: "error", error: "interrupted" });
  });
});
