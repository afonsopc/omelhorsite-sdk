/**
 * `bun test` coverage for `oms.cron`: paths, the camelCase-to-wire renames
 * of a job, the run/test/check calls and the listing defaults of runs.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { CRON_JOB_SCOPES, CRON_RUN_STATUSES, CronNamespace } from "../src/resources/cron";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly body: unknown;
}

function harness(body: unknown, status = 200): { readonly cron: CronNamespace; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  };
  const http = new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl, tokens: { getToken: () => "t" }, retry: { maxAttempts: 1 } });
  return { cron: new CronNamespace(http), calls };
}

describe("cron.jobs", () => {
  test("create renames every key onto the wire and keeps secrets as given", async () => {
    const { cron, calls } = harness({ id: "job_1" });
    await cron.jobs.create({
      name: "Relatórios",
      schedule: "0 */6 * * *",
      code: "export default async function run() {}",
      scopes: ["news:read", "llm"],
      secrets: { discord: "hook", old: null },
      timeoutSeconds: 300,
      network: true,
      outputDirId: "dir_1",
      notifyOnSuccess: true,
      templateSlug: "intel",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/cron_jobs");
    expect(calls[0]?.body).toEqual({
      name: "Relatórios",
      schedule: "0 */6 * * *",
      code: "export default async function run() {}",
      scopes: ["news:read", "llm"],
      secrets: { discord: "hook", old: null },
      timeout_seconds: 300,
      network: true,
      output_dir_id: "dir_1",
      notify_on_success: true,
      template_slug: "intel",
    });
  });

  test("run, test and check hit their own paths", async () => {
    const { cron, calls } = harness({ id: "run_1", status: "queued" });
    await cron.jobs.run("job_1");
    await cron.jobs.test("job_1");
    await cron.jobs.check("x {");
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/cron_jobs/job_1/run"],
      ["POST", "/cron_jobs/job_1/test"],
      ["POST", "/cron_jobs/check"],
    ]);
    expect(calls[2]?.body).toEqual({ code: "x {" });
  });

  test("runs list newest first, narrowed by job and status", async () => {
    const { cron, calls } = harness([]);
    await cron.runs.list({ jobId: "job_1", status: "error" });
    const search = calls[0]?.search;
    expect(calls[0]?.path).toBe("/cron_runs");
    expect(search?.get("modifiers[order]")).toBe("created_at:desc");
    expect(search?.get("exact_search[cron_job_id]")).toBe("job_1");
    expect(search?.get("exact_search[status]")).toBe("error");
  });

  test("templates list without code and hand it out one by one", async () => {
    const { cron, calls } = harness({ slug: "intel", code: "..." });
    await cron.templates.list();
    const template = await cron.templates.get("intel");
    expect(calls.map((c) => c.path)).toEqual(["/cron_templates", "/cron_templates/intel"]);
    expect(template.code).toBe("...");
  });

  test("publishes the server's vocabulary", () => {
    expect(CRON_JOB_SCOPES).toContain("llm");
    expect(CRON_JOB_SCOPES).not.toContain("cron:write");
    expect([...CRON_RUN_STATUSES]).toEqual(["queued", "running", "ok", "error", "timeout", "skipped"]);
  });
});
