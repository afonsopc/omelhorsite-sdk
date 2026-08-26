/**
 * `bun test` coverage for the unified `quotas` namespace.
 *
 * The point of the namespace is that ONE request answers "how much is left of
 * everything", so the first thing asserted is the request count: a client that
 * quietly fanned back out to the four per-tool endpoints would still return
 * the right numbers and would have thrown away the whole reason this exists.
 *
 * The rest is about the two ways a number here can lie: `null` read as zero
 * (an unlimited account is not an exhausted one), and an entry looked up by
 * position in an array whose length depends on whether the caller is signed
 * in.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import {
  QUOTA_RESOURCES,
  QuotasNamespace,
  quotaAffords,
  quotaExhausted,
  quotaFor,
  type QuotaEntry,
  type QuotaReport,
} from "../src/resources/quotas";

const BASE_URL = "https://api.test";

interface Harness {
  readonly quotas: QuotasNamespace;
  readonly paths: string[];
}

function harness(body: unknown, status = 200): Harness {
  const paths: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    paths.push(new URL(input).pathname);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
  });
  return { quotas: new QuotasNamespace(http), paths };
}

function entry(overrides: Partial<QuotaEntry> = {}): QuotaEntry {
  return {
    resource: "transcription_seconds",
    unit: "seconds",
    period: "daily",
    used: 600,
    limit: 3600,
    remaining: 3000,
    unlimited: false,
    ...overrides,
  };
}

/** The signed-in answer: the whole catalogue, in the server's own order. */
function fullReport(): Record<string, unknown> {
  return {
    authenticated: true,
    quotas: [
      entry({ resource: "vocal_separation_seconds", used: 0, limit: 1800, remaining: 1800 }),
      entry({ resource: "transcription_seconds" }),
      entry({ resource: "caption_seconds", used: 3600, limit: 3600, remaining: 0 }),
      entry({ resource: "jumpstyle_edits", unit: "count", used: 2, limit: 15, remaining: 13 }),
      entry({ resource: "storage_nodes", unit: "count", period: "total", used: 412, limit: 250_000, remaining: 249_588 }),
      entry({
        resource: "music_storage_bytes",
        unit: "bytes",
        period: "total",
        used: 1_073_741_824,
        limit: 107_374_182_400,
        remaining: 106_300_440_576,
      }),
    ],
  };
}

describe("quotas.list", () => {
  test("answers the whole catalogue in a single request", async () => {
    const { quotas, paths } = harness(fullReport());

    const report = await quotas.list();

    expect(paths).toEqual(["/quotas"]);
    expect(report.authenticated).toBe(true);
    expect(report.quotas.map((row) => row.resource)).toEqual([...QUOTA_RESOURCES]);
  });

  test("carries the unit and the period, not just the numbers", async () => {
    const { quotas } = harness(fullReport());

    const music = quotaFor(await quotas.list(), "music_storage_bytes");

    expect(music?.unit).toBe("bytes");
    expect(music?.period).toBe("total");
    expect(music?.used).toBe(1_073_741_824);
  });

  test("an anonymous answer is shorter, and lookups say so instead of guessing", async () => {
    const { quotas } = harness({
      authenticated: false,
      quotas: fullReport().quotas as QuotaEntry[],
    });
    const anonymous = harness({
      authenticated: false,
      quotas: (fullReport().quotas as QuotaEntry[]).filter((row) => row.period === "daily"),
    });

    const report = await anonymous.quotas.list();

    expect(report.authenticated).toBe(false);
    expect(report.quotas).toHaveLength(4);
    expect(quotaFor(report, "music_storage_bytes")).toBeUndefined();
    expect(await quotas.list()).toBeDefined();
  });

  test("survives a body with no quotas at all rather than throwing", async () => {
    const { quotas } = harness({});

    const report = await quotas.list();

    expect(report.authenticated).toBe(false);
    expect(report.quotas).toEqual([]);
  });
});

describe("quotas.get", () => {
  test("returns one entry off the same single request", async () => {
    const { quotas, paths } = harness(fullReport());

    const nodes = await quotas.get("storage_nodes");

    expect(paths).toEqual(["/quotas"]);
    expect(nodes?.limit).toBe(250_000);
  });

  test("returns null for a resource the caller cannot spend", async () => {
    const { quotas } = harness({
      authenticated: false,
      quotas: (fullReport().quotas as QuotaEntry[]).filter((row) => row.period === "daily"),
    });

    expect(await quotas.get("storage_nodes")).toBeNull();
  });
});

describe("the pure helpers", () => {
  test("an unlimited resource is never exhausted and always affords", () => {
    const unlimited = entry({ limit: null, remaining: null, unlimited: true });

    expect(quotaExhausted(unlimited)).toBe(false);
    expect(quotaAffords(unlimited, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("a spent resource is exhausted and affords nothing above zero", () => {
    const spent = entry({ used: 3600, remaining: 0 });

    expect(quotaExhausted(spent)).toBe(true);
    expect(quotaAffords(spent, 1)).toBe(false);
    expect(quotaAffords(spent, 0)).toBe(true);
  });

  test("affords falls back to limit minus used when remaining is missing", () => {
    const withoutRemaining = entry({ used: 3000, limit: 3600, remaining: null });

    expect(quotaAffords(withoutRemaining, 600)).toBe(true);
    expect(quotaAffords(withoutRemaining, 601)).toBe(false);
  });

  test("quotaFor tolerates a resource this build has never heard of", () => {
    const report: QuotaReport = {
      authenticated: true,
      quotas: [entry({ resource: "something_invented_later", unit: "count", period: "total" })],
    };

    expect(quotaFor(report, "something_invented_later")?.unit).toBe("count");
    expect(quotaFor(report, "storage_nodes")).toBeUndefined();
  });
});
