/**
 * `bun test` coverage for the SDK's only polling loop.
 *
 * Four behaviours are load-bearing and each has its own test, because getting
 * any of them wrong is silent rather than loud:
 *
 * 1. polling to completion, with backoff and a progress callback;
 * 2. a job that FAILED on the server, which must resolve rather than throw -
 *    the request cycle worked, the work did not;
 * 3. the client's own deadline, which must be distinguishable from (2) by type;
 * 4. an `AbortSignal`, which must be distinguishable from (3) by `code`.
 *
 * The intervals are shrunk to tens of milliseconds so the loop runs in real
 * time rather than against a fake clock: a fake clock would not catch a `sleep`
 * that forgets to listen to the signal, which is the bug this file exists for.
 *
 * The one constant that is asserted rather than shrunk is the spelling of the
 * terminal statuses. `Job::STATUSES` says `"complete"` and `"canceled"`, and a
 * loop that waits for `"completed"` never ends.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsTimeoutError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  JOB_STATUS,
  JOB_TERMINAL_STATUSES,
  JobsNamespace,
  isJobTerminal,
  jobProgress,
  pollUntilTerminal,
  watchUntilTerminal,
  type Job,
} from "../src/resources/jobs";
import type { Progress } from "../src/types";

const BASE_URL = "https://api.test";
const JOB_ID = "6f1b0a3e-0000-4000-8000-000000000001";
const WATCH_TOKEN = "eyJfcmFpbHMiOnsibWVzc2FnZSI6ImFiYyJ9fQ";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly at: number;
}

/** An {@link ApiClient} whose transport is a handler plus a call log. */
function fakeClient(handler: (call: RecordedCall, index: number) => Response | Promise<Response>): {
  jobs: JobsNamespace;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = { url: input, method: init?.method ?? "GET", headers, at: Date.now() };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  };
  return { jobs: new JobsNamespace(new ApiClient({ baseUrl: BASE_URL, fetch: fetchImpl })), calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A `Job` row as the blueprint renders one. */
function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    job_type: "unknown",
    status: JOB_STATUS.pending,
    progress: 0,
    ...overrides,
  } as Job;
}

/** Serves a scripted sequence of rows, repeating the last one forever. */
function script(...rows: Job[]): (call: RecordedCall, index: number) => Response {
  return (_call, index) => json(200, rows[Math.min(index, rows.length - 1)]);
}

describe("the status constants", () => {
  test("spell the backend's five statuses, not the English ones", () => {
    // The whole point of the constants: `Job::STATUSES` is complete/canceled.
    expect(Object.values(JOB_STATUS)).toEqual(["pending", "processing", "complete", "failed", "canceled"]);
    expect(JOB_TERMINAL_STATUSES).toEqual(["complete", "failed", "canceled"]);
    expect(isJobTerminal("complete")).toBe(true);
    expect(isJobTerminal("canceled")).toBe(true);
    expect(isJobTerminal("completed")).toBe(false);
    expect(isJobTerminal("processing")).toBe(false);
  });

  test("progress is a percentage out of 100, because the column is NOT NULL DEFAULT 0", () => {
    expect(jobProgress(job({ progress: 42, status: JOB_STATUS.processing }))).toEqual({
      phase: "processing",
      loaded: 42,
      total: 100,
      status: "processing",
    });
    // `jobs.progress` is `integer NOT NULL DEFAULT 0`, so a null cannot come
    // off the wire and the type rightly forbids one. The cast is here to reach
    // the guard in `jobProgress` anyway: it defends against a malformed
    // payload (a proxy rewriting the body, a future column made nullable), and
    // a guard nothing exercises is a guard nobody knows is broken.
    expect(jobProgress(job({ progress: null as unknown as number })).loaded).toBe(0);
  });
});

describe("jobs.get", () => {
  test("sends a watch token as a query parameter, which is the anonymous door", async () => {
    const { jobs, calls } = fakeClient(() => json(200, job()));

    await jobs.get({ id: JOB_ID, watchToken: WATCH_TOKEN });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/jobs/${JOB_ID}?watch_token=${encodeURIComponent(WATCH_TOKEN)}`);
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  test("takes a bare id too, and then sends no token at all", async () => {
    const { jobs, calls } = fakeClient(() => json(200, job()));

    await jobs.get(JOB_ID);

    expect(calls[0]!.url).toBe(`${BASE_URL}/jobs/${JOB_ID}`);
  });
});

describe("jobs.list", () => {
  test("encodes the filters the controller allows and asks for a page", async () => {
    const { jobs, calls } = fakeClient(() => json(200, [job(), job()]));

    const page = await jobs.list({ status: ["complete", "failed"], jobType: "omsvs", pageSize: 2 });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/jobs");
    expect(url.searchParams.getAll("exact_search[status][]")).toEqual(["complete", "failed"]);
    expect(url.searchParams.get("exact_search[job_type]")).toBe("omsvs");
    expect(url.searchParams.get("modifiers[page]")).toBe("1:2");
    // The index is conditional-GET aware; a 304 would arrive here as a failure.
    expect(calls[0]!.headers["cache-control"]).toBe("no-cache");
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});

describe("jobs.wait - polling to completion", () => {
  test("polls until the job is complete and reports every step", async () => {
    const { jobs, calls } = fakeClient(
      script(
        job({ status: JOB_STATUS.pending, progress: 0 }),
        job({ status: JOB_STATUS.processing, progress: 40 }),
        job({ status: JOB_STATUS.complete, progress: 100, result: { result_url: "https://cdn.test/x.png" } }),
      ),
    );

    const seen: Progress[] = [];
    const finished = await jobs.wait(JOB_ID, { pollIntervalMs: 20, onProgress: (p) => seen.push(p) });

    expect(finished.status).toBe("complete");
    expect(calls).toHaveLength(3);
    expect(seen.map((p) => p.status)).toEqual(["pending", "processing", "complete"]);
    expect(seen.map((p) => p.loaded)).toEqual([0, 40, 100]);
    expect(seen.every((p) => p.phase === "processing" && p.total === 100)).toBe(true);
  });

  test("does not pause before the first poll", async () => {
    const started = Date.now();
    const { jobs } = fakeClient(script(job({ status: JOB_STATUS.complete })));

    await jobs.wait(JOB_ID, { pollIntervalMs: 5_000 });

    expect(Date.now() - started).toBeLessThan(200);
  });

  test("backs off: each pause is longer than the one before", async () => {
    const rows = [
      job({ status: JOB_STATUS.pending }),
      job({ status: JOB_STATUS.processing }),
      job({ status: JOB_STATUS.processing }),
      job({ status: JOB_STATUS.processing }),
      job({ status: JOB_STATUS.complete }),
    ];
    const { jobs, calls } = fakeClient(script(...rows));

    await jobs.wait(JOB_ID, { pollIntervalMs: 30 });

    expect(calls).toHaveLength(5);
    const gaps = calls.slice(1).map((call, index) => call.at - calls[index]!.at);
    // 30, 45, 68, 101 in theory. Asserting the shape rather than the numbers,
    // because a real timer under a loaded CI box is not a metronome.
    expect(gaps[gaps.length - 1]!).toBeGreaterThan(gaps[0]!);
  });

  test("stops on `canceled`, which no tool row can hold but a job can", async () => {
    const { jobs, calls } = fakeClient(script(job({ status: JOB_STATUS.canceled, error: "worker drained" })));

    const finished = await jobs.wait(JOB_ID, { pollIntervalMs: 10 });

    expect(finished.status).toBe("canceled");
    expect(calls).toHaveLength(1);
  });
});

describe("jobs.wait - the work failed on the server", () => {
  test("resolves with the failed job rather than throwing", async () => {
    const { jobs } = fakeClient(
      script(
        job({ status: JOB_STATUS.processing }),
        job({ status: JOB_STATUS.failed, error: "Upscaler said no", finished_at: "2026-08-25T10:00:09Z" }),
      ),
    );

    const finished = await jobs.wait(JOB_ID, { pollIntervalMs: 10 });

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("Upscaler said no");
  });
});

describe("jobs.wait - the request itself failed", () => {
  test("lets a 404 out, because a swept job is not something a loop can fix", async () => {
    const { jobs } = fakeClient((_call, index) =>
      index === 0 ? json(200, job({ status: JOB_STATUS.processing })) : json(404, "Resource not found"),
    );

    const failure = await jobs.wait(JOB_ID, { pollIntervalMs: 10 }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
    expect((failure as OmsApiError).code).toBe("not_found");
  });

  test("lets a 500 out once the transport has spent its attempts", async () => {
    const { jobs, calls } = fakeClient(() => json(500, "boom"));

    const failure = await jobs
      .wait(JOB_ID, { pollIntervalMs: 10, retry: { maxAttempts: 1 } })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(500);
    expect(calls).toHaveLength(1);
  });
});

describe("jobs.wait - the client gave up first", () => {
  test("throws a timeout that names the last status and says the run is still going", async () => {
    const { jobs, calls } = fakeClient(script(job({ status: JOB_STATUS.processing, progress: 10 })));

    const failure = await jobs
      .wait(JOB_ID, { pollIntervalMs: 20, waitTimeoutMs: 80 })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    const error = failure as OmsTimeoutError;
    // "timeout", not "aborted": the deadline was ours, the caller said nothing.
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
    expect(error.timeoutMs).toBe(80);
    expect(error.message).toContain('"processing"');
    expect(error.message).toContain("still working on it");
    expect(calls.length).toBeGreaterThan(1);
  });

  test("a zero deadline means no deadline, not an instant one", async () => {
    const { jobs } = fakeClient(script(job({ status: JOB_STATUS.processing }), job({ status: JOB_STATUS.complete })));

    const finished = await jobs.wait(JOB_ID, { pollIntervalMs: 10, waitTimeoutMs: 0 });

    expect(finished.status).toBe("complete");
  });
});

describe("jobs.wait - the caller aborted", () => {
  test("throws `aborted`, not `timeout`, and stops polling", async () => {
    const { jobs, calls } = fakeClient(script(job({ status: JOB_STATUS.processing })));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const failure = await jobs
      .wait(JOB_ID, { pollIntervalMs: 1_000, signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    const error = failure as OmsTimeoutError;
    expect(error.code).toBe("aborted");
    // An abort is the caller's decision, so retrying it is not "plausible".
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(`job ${JOB_ID}`);
    expect(calls).toHaveLength(1);

    // And nothing keeps polling after the rejection.
    const after = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(after);
  });

  test("a signal that is already aborted costs no request at all", async () => {
    const { jobs, calls } = fakeClient(script(job({ status: JOB_STATUS.complete })));

    const failure = await jobs
      .wait(JOB_ID, { signal: AbortSignal.abort() })
      .catch((thrown: unknown) => thrown);

    expect((failure as OmsTimeoutError).code).toBe("aborted");
    expect(calls).toHaveLength(0);
  });
});

describe("jobs.watch", () => {
  test("yields every state including the terminal one, and returns it", async () => {
    const { jobs } = fakeClient(
      script(
        job({ status: JOB_STATUS.pending }),
        job({ status: JOB_STATUS.processing }),
        job({ status: JOB_STATUS.complete }),
      ),
    );

    const iterator = jobs.watch(JOB_ID, { pollIntervalMs: 10 });
    const yielded: string[] = [];
    let returned: Job | undefined;
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) {
        returned = step.value;
        break;
      }
      yielded.push(step.value.status);
    }

    expect(yielded).toEqual(["pending", "processing", "complete"]);
    expect(returned?.status).toBe("complete");
  });

  test("breaking out of the loop stops the polling", async () => {
    const { jobs, calls } = fakeClient(script(job({ status: JOB_STATUS.processing })));

    for await (const state of jobs.watch(JOB_ID, { pollIntervalMs: 10 })) {
      expect(state.status).toBe("processing");
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toHaveLength(1);
  });
});

describe("the loop is generic, which is why there is only one of them", () => {
  test("pollUntilTerminal drives anything with a state and a terminal test", async () => {
    const states = ["uploaded", "transcribing", "transcribed", "complete"];
    let index = 0;

    const finished = await pollUntilTerminal<{ status: string }>({
      pollIntervalMs: 5,
      poll: async () => ({ status: states[Math.min(index++, states.length - 1)]! }),
      terminal: (state) => state.status === "complete",
    });

    expect(finished.status).toBe("complete");
    expect(index).toBe(4);
  });

  test("watchUntilTerminal honours the same deadline as the job flavour", async () => {
    const failure = await (async () => {
      try {
        for await (const _state of watchUntilTerminal<{ status: string }>({
          pollIntervalMs: 5,
          waitTimeoutMs: 40,
          label: "the caption render",
          poll: async () => ({ status: "rendering" }),
          terminal: () => false,
          progress: (state) => ({ phase: "processing", loaded: 0, total: undefined, status: state.status }),
        })) {
          // Consuming, not asserting: the deadline is the subject.
        }
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).code).toBe("timeout");
    expect((failure as OmsTimeoutError).message).toContain("the caption render");
    expect((failure as OmsTimeoutError).message).toContain('"rendering"');
  });
});
