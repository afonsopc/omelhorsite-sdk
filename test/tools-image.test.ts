/**
 * `bun test` coverage for the two job-backed tools, background removal and
 * upscale.
 *
 * They are the only tools whose create call answers with a `job_id` plus a
 * `watch_token`, so they are the only ones whose `run()` goes through
 * `oms.jobs.wait`. What is asserted here is precisely that: that the tool
 * modules delegate rather than growing a second polling loop, and that the
 * three-way outcome (finished / failed / gave up) survives the delegation.
 *
 * The artefact download is asserted too, because it is the one request in the
 * SDK that must NOT carry the bearer token: `result_url` is a signed
 * ActiveStorage link that redirects to the object store, and the store rejects
 * a request arriving with two authentication schemes.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsError, OmsTimeoutError } from "../src/errors";
import { ApiClient } from "../src/http";
import { BackgroundRemovalNamespace } from "../src/resources/tools/backgroundRemoval";
import { UpscaleNamespace } from "../src/resources/tools/upscale";
import { isToolTerminal, requireToolArtifact, toolProgress } from "../src/resources/tools/index";
import { file } from "../src/types";
import type { Progress } from "../src/types";

const BASE_URL = "https://api.test";
const RUN_ID = "aa11bb22-0000-4000-8000-00000000cc33";
const JOB_ID = "6f1b0a3e-0000-4000-8000-000000000001";
const WATCH_TOKEN = "eyJfcmFpbHMiOnsibWVzc2FnZSI6ImFiYyJ9fQ";
const RESULT_URL = `${BASE_URL}/rails/active_storage/blobs/redirect/sig/out.png`;

interface RecordedCall {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly form: FormData | undefined;
}

interface Harness {
  readonly rmbg: BackgroundRemovalNamespace;
  readonly upscale: UpscaleNamespace;
  readonly calls: RecordedCall[];
}

/** Builds both namespaces over one scripted transport, so calls interleave in one log. */
function harness(handler: (call: RecordedCall, index: number) => Response | Promise<Response>): Harness {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url: input,
      path: new URL(input).pathname,
      method: init?.method ?? "GET",
      headers,
      form: init?.body instanceof FormData ? init.body : undefined,
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
  });
  return { rmbg: new BackgroundRemovalNamespace(http), upscale: new UpscaleNamespace(http), calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A tool row, as `BackgroundRemovalBlueprint` renders one. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    status: "pending",
    error: null,
    finished_at: null,
    user_id: null,
    ip_address: "203.0.113.7",
    result_url: null,
    ...overrides,
  };
}

/** The create response: the row, plus the two tracking fields. */
function created(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...row(), job_id: JOB_ID, watch_token: WATCH_TOKEN, ...overrides };
}

function jobRow(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:01Z",
    job_type: "unknown",
    status,
    progress: status === "complete" ? 100 : 0,
    error: null,
    ...overrides,
  };
}

function png(bytes = 4): { data: Uint8Array; filename: string } {
  return { data: new Uint8Array(bytes).fill(7), filename: "praia.jpg" };
}

function image(bytes = 4) {
  const { data, filename } = png(bytes);
  return file(data, filename, { contentType: "image/jpeg" });
}

describe("create", () => {
  test("posts multipart with the file field the controller reads, and the captcha", async () => {
    const { rmbg, calls } = harness(() => json(201, created()));

    const answer = await rmbg.create({ file: image(), captchaToken: "0.turnstile" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/background_removals");
    // The runtime must own Content-Type so the multipart boundary matches.
    expect(call.headers["content-type"]).toBeUndefined();
    expect(call.headers["authorization"]).toBe("Bearer secret-session-token");

    const form = call.form!;
    const sent = form.get("file");
    expect(sent).toBeInstanceOf(Blob);
    expect((sent as File).name).toBe("praia.jpg");
    expect(form.get("cf_turnstile_token")).toBe("0.turnstile");

    expect(answer.job_id).toBe(JOB_ID);
    expect(answer.watch_token).toBe(WATCH_TOKEN);
  });

  test("omits the captcha field entirely when there is none, rather than sending an empty one", async () => {
    const { rmbg, calls } = harness(() => json(201, created()));

    await rmbg.create({ file: image() });

    expect(calls[0]!.form!.has("cf_turnstile_token")).toBe(false);
  });

  test("upscale sends `scale` only when the caller picked one", async () => {
    const { upscale, calls } = harness(() => json(201, created({ scale: "4" })));

    await upscale.create({ file: image(), scale: "2" });
    await upscale.create({ file: image() });

    expect(calls[0]!.path).toBe("/upscales");
    expect(calls[0]!.form!.get("scale")).toBe("2");
    expect(calls[1]!.form!.has("scale")).toBe(false);
  });

  test("is not retried by default: a 502 must not start a second run", async () => {
    const { rmbg, calls } = harness(() => json(502, "upstream is having a day"));

    const failure = await rmbg.create({ file: image() }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  test("but retrying can be asked for explicitly", async () => {
    const { rmbg, calls } = harness((_call, index) => (index < 1 ? json(502, "blip") : json(201, created())));

    const answer = await rmbg.create({ file: image() }, { retry: { maxAttempts: 2, baseDelayMs: 5, jitter: false } });

    expect(answer.id).toBe(RUN_ID);
    expect(calls).toHaveLength(2);
  });
});

describe("run - the happy path", () => {
  test("waits on the JOB with its watch token, then reads the TOOL row back", async () => {
    const { rmbg, calls } = harness((call, index) => {
      if (index === 0) return json(201, created());
      if (call.path === `/jobs/${JOB_ID}`) {
        return json(200, jobRow(index < 2 ? "processing" : "complete"));
      }
      return json(200, row({ status: "complete", result_url: RESULT_URL, finished_at: "2026-08-25T10:00:09Z" }));
    });

    const seen: Progress[] = [];
    const finished = await rmbg.run(
      { file: image() },
      { pollIntervalMs: 10, onProgress: (progress) => seen.push(progress) },
    );

    expect(finished.status).toBe("complete");
    expect(finished.result_url).toBe(RESULT_URL);

    // POST, two job polls, one row re-read. The job polls carry the token, so
    // the same call works for an anonymous caller.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /background_removals",
      `GET /jobs/${JOB_ID}`,
      `GET /jobs/${JOB_ID}`,
      `GET /background_removals/${RUN_ID}`,
    ]);
    expect(new URL(calls[1]!.url).searchParams.get("watch_token")).toBe(WATCH_TOKEN);

    // First report is the created row, then one per job poll.
    expect(seen.map((progress) => progress.status)).toEqual(["pending", "processing", "complete"]);
  });

  test("falls back to polling the tool's own row when no tracking row was minted", async () => {
    const { upscale, calls } = harness((_call, index) => {
      if (index === 0) return json(201, { ...row({ scale: "4" }) });
      return json(200, row({ scale: "4", status: index < 2 ? "processing" : "complete", result_url: RESULT_URL }));
    });

    const finished = await upscale.run({ file: image() }, { pollIntervalMs: 10 });

    expect(finished.status).toBe("complete");
    expect(calls.map((call) => call.path)).toEqual([
      "/upscales",
      `/upscales/${RUN_ID}`,
      `/upscales/${RUN_ID}`,
    ]);
  });
});

describe("run - the work failed", () => {
  test("resolves with the failed row, because a failure is an answer", async () => {
    const { rmbg } = harness((call, index) => {
      if (index === 0) return json(201, created());
      if (call.path === `/jobs/${JOB_ID}`) return json(200, jobRow("failed", { error: "RuntimeError: no subject" }));
      return json(200, row({ status: "failed", error: "RuntimeError: no subject" }));
    });

    const finished = await rmbg.run({ file: image() }, { pollIntervalMs: 10 });

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("RuntimeError: no subject");
  });

  test("throws when the worker died without ever touching the run's row", async () => {
    const { rmbg } = harness((call, index) => {
      if (index === 0) return json(201, created());
      if (call.path === `/jobs/${JOB_ID}`) return json(200, jobRow("canceled", { error: "queue drained" }));
      return json(200, row({ status: "pending" }));
    });

    const failure = await rmbg.run({ file: image() }, { pollIntervalMs: 10 }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsError);
    expect((failure as OmsError).code).toBe("server_error");
    expect((failure as OmsError).message).toContain("canceled");
    expect((failure as OmsError).message).toContain("queue drained");
  });
});

describe("run - the client stopped waiting", () => {
  test("a deadline throws a timeout and leaves the run alone", async () => {
    const { rmbg } = harness((call, index) =>
      index === 0 ? json(201, created()) : json(200, jobRow("processing")),
    );

    const failure = await rmbg
      .run({ file: image() }, { pollIntervalMs: 15, waitTimeoutMs: 60 })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).code).toBe("timeout");
    expect((failure as OmsTimeoutError).message).toContain("still working on it");
  });

  test("an abort throws `aborted` and stops the polling", async () => {
    const { rmbg, calls } = harness((call, index) =>
      index === 0 ? json(201, created()) : json(200, jobRow("processing")),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const failure = await rmbg
      .run({ file: image() }, { pollIntervalMs: 1_000, signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).code).toBe("aborted");

    const after = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(after);
  });
});

describe("download", () => {
  test("reads the row, then fetches the signed URL with NO Authorization header", async () => {
    const { upscale, calls } = harness((call) => {
      if (call.path.startsWith("/upscales/")) {
        return json(200, row({ scale: "4", status: "complete", result_url: RESULT_URL }));
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const blob = await upscale.download(RUN_ID);

    expect(blob.size).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer secret-session-token");
    expect(calls[1]!.url).toBe(RESULT_URL);
    // The signature in the URL is the credential; a bearer token alongside it
    // is what makes the object store refuse.
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
  });

  test("says which of the three reasons there is no artefact", async () => {
    const pending = harness(() => json(200, row({ status: "processing" })));
    const stillRunning = await pending.rmbg.download(RUN_ID).catch((thrown: unknown) => thrown);
    expect((stillRunning as OmsError).code).toBe("conflict");
    expect((stillRunning as OmsError).message).toContain("not ready");
    // The URL was never fetched.
    expect(pending.calls).toHaveLength(1);

    const broken = harness(() => json(200, row({ status: "failed", error: "sidecar refused" })));
    const failed = await broken.rmbg.download(RUN_ID).catch((thrown: unknown) => thrown);
    expect((failed as OmsError).code).toBe("invalid_request");
    expect((failed as OmsError).message).toContain("sidecar refused");

    const swept = harness(() => json(200, row({ status: "complete", result_url: null })));
    const gone = await swept.rmbg.download(RUN_ID).catch((thrown: unknown) => thrown);
    expect((gone as OmsError).code).toBe("not_found");
    expect((gone as OmsError).message).toContain("swept");
  });

  test("surfaces the store's own refusal with its status", async () => {
    const { rmbg } = harness((call) =>
      call.path.startsWith("/background_removals/")
        ? json(200, row({ status: "complete", result_url: RESULT_URL }))
        : new Response("expired", { status: 403 }),
    );

    const failure = await rmbg.download(RUN_ID).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(403);
  });
});

describe("the shared tool helpers", () => {
  test("a tool row is terminal at complete or failed, and has no `canceled`", () => {
    expect(isToolTerminal("complete")).toBe(true);
    expect(isToolTerminal("failed")).toBe(true);
    expect(isToolTerminal("pending")).toBe(false);
    expect(isToolTerminal("processing")).toBe(false);
    // A job has this state; a tool row never does.
    expect(isToolTerminal("canceled")).toBe(false);
  });

  test("progress leaves `total` undefined while the sidecar has not reported one", () => {
    expect(toolProgress({ ...row(), status: "pending" } as never)).toEqual({
      phase: "processing",
      loaded: 0,
      total: undefined,
      status: "pending",
    });
    expect(toolProgress({ ...row(), status: "processing", progress_percent: 63 } as never)).toEqual({
      phase: "processing",
      loaded: 63,
      total: 100,
      status: "processing",
    });
  });

  test("requireToolArtifact hands a good URL straight back", () => {
    const record = { ...row(), status: "complete", result_url: RESULT_URL } as never;
    expect(requireToolArtifact(record, RESULT_URL, "result")).toBe(RESULT_URL);
  });
});
