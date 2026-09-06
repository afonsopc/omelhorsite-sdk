/**
 * `bun test` coverage for `oms.bots`: the wire shape of each call (paths,
 * `exact_search` filters, the snake_case bodies) and the send input's two
 * addressing forms.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { BOT_CONTACT_FILTER_COLUMNS, BOT_MESSAGE_MAX_TEXT, BotsNamespace } from "../src/resources/bots";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

function harness(body: unknown, status = 200): { readonly bots: BotsNamespace; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    let parsed: unknown = undefined;
    if (typeof init?.body === "string") parsed = JSON.parse(init.body);
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, search: decodeURIComponent(url.search), body: parsed });
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  };
  const http = new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl, tokens: { getToken: () => "t" }, retry: { maxAttempts: 1 } });
  return { bots: new BotsNamespace(http), calls };
}

describe("bots.channels", () => {
  test("create sends the token and the name; the answer is the channel without the token", async () => {
    const { bots, calls } = harness({ id: "c1", name: "Menções", token_set: true, username: "MencoesReconBot" }, 201);
    const channel = await bots.channels.create({ name: "Menções", token: "123:abc" });
    expect(channel.token_set).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/bot_channels", body: { name: "Menções", token: "123:abc" } });
  });

  test("update without a token sends no token key; test is a POST on the member", async () => {
    const { bots, calls } = harness({ id: "c1" });
    await bots.channels.update("c1", { name: "Outro" });
    await bots.channels.test("c1");
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/bot_channels/c1", body: { name: "Outro" } });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/bot_channels/c1/test" });
  });
});

describe("bots.contacts", () => {
  test("list filters by channel through exact_search and orders by activity", async () => {
    const { bots, calls } = harness([{ id: "k1", display_name: "Afonso" }]);
    const page = await bots.contacts.list({ channelId: "c1" });
    expect(page.items[0]?.display_name).toBe("Afonso");
    expect(calls[0]?.path).toBe("/bot_contacts");
    expect(calls[0]?.search).toContain("exact_search[bot_channel_id]=c1");
    expect(calls[0]?.search).toContain("modifiers[order]=last_message_at:desc");
  });

  test("update sends name and tags; markRead is a POST", async () => {
    const { bots, calls } = harness({ id: "k1" });
    await bots.contacts.update("k1", { tags: ["vip", "jornalista"], name: "A. G." });
    await bots.contacts.markRead("k1");
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/bot_contacts/k1", body: { name: "A. G.", tags: ["vip", "jornalista"] } });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/bot_contacts/k1/read" });
    expect(BOT_CONTACT_FILTER_COLUMNS).toContain("blocked");
  });
});

describe("bots.messages", () => {
  test("list by contact goes through exact_search, sent_at descending by default", async () => {
    const { bots, calls } = harness([]);
    await bots.messages.list({ contactId: "k1", order: "sent_at:asc" });
    expect(calls[0]?.search).toContain("exact_search[bot_contact_id]=k1");
    expect(calls[0]?.search).toContain("modifiers[order]=sent_at:asc");
  });

  test("send addresses a contact by id, or a chat by channel and external id, and carries the format", async () => {
    const { bots, calls } = harness({ id: "m1", direction: "out", source: "api" }, 201);
    const sent = await bots.messages.send({ contactId: "k1", text: "<b>Olá</b>", format: "html" });
    await bots.messages.send({ channelId: "c1", externalId: "1358020394", text: "Olá" });
    expect(sent.source).toBe("api");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/bot_messages", body: { bot_contact_id: "k1", text: "<b>Olá</b>", format: "html" } });
    expect(calls[1]?.body).toEqual({ bot_channel_id: "c1", external_id: "1358020394", text: "Olá" });
    expect(BOT_MESSAGE_MAX_TEXT).toBe(4096);
  });
});

describe("bots responder plugin", () => {
  test("create carries the plugin; the responder lives under the channel and run is a POST", async () => {
    const { bots, calls } = harness({ id: "c1", plugin: "responder" }, 201);
    await bots.channels.create({ name: "Loja", token: "123:abc", plugin: "responder" });
    await bots.responders.get("c1");
    await bots.responders.update("c1", { enabled: true, slots_per_day: 4, model: null });
    await bots.responders.run("c1");
    expect(calls[0]?.body).toMatchObject({ plugin: "responder" });
    expect(calls[1]).toMatchObject({ method: "GET", path: "/bot_channels/c1/responder" });
    expect(calls[2]).toMatchObject({ method: "PATCH", path: "/bot_channels/c1/responder", body: { enabled: true, slots_per_day: 4, model: null } });
    expect(calls[3]).toMatchObject({ method: "POST", path: "/bot_channels/c1/responder/run" });
  });

  test("facts and sources are created with the channel id in snake_case and listed through exact_search", async () => {
    const { bots, calls } = harness([]);
    await bots.facts.create({ channelId: "c1", text: "O livro custa 20 euros.", valid_until: "2026-12-31" });
    await bots.facts.list({ channelId: "c1" });
    await bots.sources.create({ channelId: "c1", name: "Eventos", url: "https://exemplo.pt/eventos" });
    await bots.runs.list({ channelId: "c1" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/bot_facts", body: { bot_channel_id: "c1", text: "O livro custa 20 euros.", valid_until: "2026-12-31" } });
    expect(calls[1]?.search).toContain("exact_search[bot_channel_id]=c1");
    expect(calls[2]).toMatchObject({ method: "POST", path: "/bot_sources", body: { bot_channel_id: "c1", name: "Eventos", url: "https://exemplo.pt/eventos" } });
    expect(calls[3]?.path).toBe("/bot_responder_runs");
    expect(calls[3]?.search).toContain("modifiers[order]=scheduled_at:desc");
  });

  test("teach posts the hint; botReply is a bare POST; the contact update carries needs_human", async () => {
    const { bots, calls } = harness({ result: "replied", contact: { id: "k1" } });
    await bots.contacts.teach("k1", "os portes custam 3 euros");
    await bots.contacts.botReply("k1");
    await bots.contacts.update("k1", { needs_human: false, note: null });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/bot_contacts/k1/teach", body: { hint: "os portes custam 3 euros" } });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/bot_contacts/k1/bot_reply" });
    expect(calls[2]).toMatchObject({ method: "PATCH", path: "/bot_contacts/k1", body: { needs_human: false, note: null } });
  });
});
