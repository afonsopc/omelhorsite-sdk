/**
 * `bun test` coverage for the two video tools, captions and jumpstyle.
 *
 * Captions are the odd shape of the family: three ordered steps on one row,
 * each of which must find the row idle. So what is asserted is the ordering
 * contract rather than a single run - that `transcribe` and `render` WAIT
 * instead of handing back a busy row whose only use is to cause the next call's
 * 409, that "terminal" for a step means "not busy" rather than "finished", and
 * that a render with no words asked for reads the row rather than sending a
 * request the endpoint refuses.
 *
 * Jumpstyle is asserted mostly on its form: it is the only tool whose create
 * carries more than one file, and the `clips[]` suffix is what Rails needs to
 * read a list.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsError, OmsTimeoutError } from "../src/errors";
import { ApiClient } from "../src/http";
import { CaptionsNamespace, captionProgress, isCaptionBusy } from "../src/resources/tools/captions";
import { JUMPSTYLE_DENSITIES, JumpstyleNamespace } from "../src/resources/tools/jumpstyle";
import { file } from "../src/types";
import type { Progress } from "../src/types";

const BASE_URL = "https://api.test";
const JOB_ID = "aa11bb22-0000-4000-8000-00000000cc33";
const OUTPUT_URL = `${BASE_URL}/rails/active_storage/blobs/redirect/sig/legendado.mp4`;

interface RecordedCall {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly form: FormData | undefined;
  readonly body: unknown;
}

interface Harness {
  readonly captions: CaptionsNamespace;
  readonly jumpstyle: JumpstyleNamespace;
  readonly calls: RecordedCall[];
}

function harness(handler: (call: RecordedCall, index: number) => Response | Promise<Response>): Harness {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const form = init?.body instanceof FormData ? init.body : undefined;
    const call: RecordedCall = {
      url: input,
      path: new URL(input).pathname,
      method: init?.method ?? "GET",
      headers,
      form,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
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
  return { captions: new CaptionsNamespace(http), jumpstyle: new JumpstyleNamespace(http), calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A caption job, as `CaptionJobBlueprint` renders one under `:extended`. */
function captionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    status: "uploaded",
    filename: "clip.mp4",
    width: 1080,
    height: 1920,
    fps: 30.0,
    duration: 61.5,
    language: null,
    window_start: null,
    window_end: null,
    transcribed_seconds: 0,
    error: null,
    finished_at: null,
    user_id: null,
    ip_address: "203.0.113.7",
    words: null,
    progress_percent: null,
    render_stage: null,
    output_url: null,
    ...overrides,
  };
}

/** The word shape the backend actually permits: text/t0/t1, not word/start/end. */
const WORDS = [
  { text: "bom", t0: 0.2, t1: 0.4 },
  { text: "dia", t0: 0.45, t1: 0.9 },
];

/** A jumpstyle edit, as `JumpstyleJobBlueprint` renders one under `:extended`. */
function jumpstyleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    // No "pending": the controller saves the row already processing.
    status: "processing",
    track_filename: "faixa.mp3",
    n_clips: 3,
    duration: 30.0,
    seed: 41823,
    density: "normal",
    rapid_fire: false,
    bpm: null,
    detected_bpm: 148,
    error: null,
    finished_at: null,
    user_id: null,
    ip_address: "203.0.113.7",
    stage: "cutting",
    progress_percent: 20,
    output_url: null,
    ...overrides,
  };
}

function video(name = "clip.mp4") {
  return file(new Uint8Array(8).fill(2), name, { contentType: "video/mp4" });
}

function track() {
  return file(new Uint8Array(4).fill(5), "faixa.mp3", { contentType: "audio/mpeg" });
}

function clip(name: string) {
  return file(new Uint8Array(4).fill(6), name, { contentType: "video/mp4" });
}

// ---------------------------------------------------------------------------
// Captions: the state machine
// ---------------------------------------------------------------------------

describe("caption statuses", () => {
  test("busy is the two states with a sidecar call in flight, and is NOT the complement of finished", () => {
    expect(isCaptionBusy("transcribing")).toBe(true);
    expect(isCaptionBusy("rendering")).toBe(true);
    // Idle but very much not finished - the whole point of a three-step tool.
    expect(isCaptionBusy("uploaded")).toBe(false);
    expect(isCaptionBusy("transcribed")).toBe(false);
    expect(isCaptionBusy("complete")).toBe(false);
    expect(isCaptionBusy("failed")).toBe(false);
  });

  test("the render stage is folded into the progress status", () => {
    expect(captionProgress(captionRow({ status: "rendering", render_stage: "encoding" }) as never).status).toBe(
      "rendering (encoding)",
    );
    expect(captionProgress(captionRow({ status: "transcribing" }) as never).status).toBe("transcribing");
  });
});

describe("captions: quota and upload", () => {
  test("quota comes from the collection route", async () => {
    const { captions, calls } = harness(() =>
      json(200, {
        authenticated: true,
        used_seconds: 120,
        limit_seconds: 3600,
        remaining_seconds: 3480,
        unlimited: false,
      }),
    );

    const quota = await captions.quota();

    expect(calls[0]!.path).toBe("/caption_jobs/quota");
    expect(quota.remaining_seconds).toBe(3480);
  });

  test("create posts multipart under the `video` field and does not wait", async () => {
    const { captions, calls } = harness(() => json(201, captionRow()));

    const job = await captions.create({ video: video(), captchaToken: "0.turnstile" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/caption_jobs");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
    const sent = calls[0]!.form!.get("video");
    expect(sent).toBeInstanceOf(Blob);
    expect((sent as File).name).toBe("clip.mp4");
    expect(calls[0]!.form!.get("cf_turnstile_token")).toBe("0.turnstile");
    // Nothing is running after an upload, so there is nothing to poll.
    expect(job.status).toBe("uploaded");
    expect(job.duration).toBe(61.5);
  });

  test("create is not retried by default", async () => {
    const { captions, calls } = harness(() => json(503, { error: "Captions service unavailable" }));

    await captions.create({ video: video() }).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });
});

describe("captions: transcribe", () => {
  test("posts the window, then waits until the row is no longer busy", async () => {
    const { captions, calls } = harness((_call, index) => {
      if (index === 0) return json(200, captionRow({ status: "transcribing", window_start: 0, window_end: 30 }));
      if (index < 3) return json(200, captionRow({ status: "transcribing", progress_percent: 55 }));
      return json(200, captionRow({ status: "transcribed", words: WORDS, transcribed_seconds: 30 }));
    });

    const seen: Progress[] = [];
    const job = await captions.transcribe(
      JOB_ID,
      { start: 0, end: 30, language: "pt" },
      { pollIntervalMs: 5, onProgress: (progress) => seen.push(progress) },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(`/caption_jobs/${JOB_ID}/transcribe`);
    expect(calls[0]!.body).toEqual({ start: 0, end: 30, language: "pt" });
    expect(calls.slice(1).every((c) => c.method === "GET" && c.path === `/caption_jobs/${JOB_ID}`)).toBe(true);

    // "Terminal" for a step means idle, not finished: transcribed is both.
    expect(job.status).toBe("transcribed");
    expect(job.words).toEqual(WORDS);
    expect(seen[0]!.status).toBe("transcribing");
  });

  test("omits `language` rather than sending an empty one, so the server picks auto", async () => {
    const { captions, calls } = harness(() => json(200, captionRow({ status: "transcribed", words: WORDS })));

    await captions.transcribe(JOB_ID, { start: 5, end: 10 }, { pollIntervalMs: 5 });

    expect(calls[0]!.body).toEqual({ start: 5, end: 10 });
  });

  test("resolves with a failed row - a window with no speech in it is an answer", async () => {
    const { captions } = harness((_call, index) =>
      index === 0
        ? json(200, captionRow({ status: "transcribing" }))
        : json(200, captionRow({ status: "failed", error: "Nao detectei fala nesta janela" })),
    );

    const job = await captions.transcribe(JOB_ID, { start: 0, end: 30 }, { pollIntervalMs: 5 });

    expect(job.status).toBe("failed");
    expect(job.error).toContain("fala");
  });

  test("a 409 on a busy job is raised, not polled around", async () => {
    const { captions, calls } = harness(() => json(409, { error: "Job is busy" }));

    const failure = await captions
      .transcribe(JOB_ID, { start: 0, end: 30 })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  test("a deadline gives up on the wait without cancelling the step", async () => {
    const { captions } = harness(() => json(200, captionRow({ status: "transcribing" })));

    const failure = await captions
      .transcribe(JOB_ID, { start: 0, end: 30 }, { pollIntervalMs: 15, waitTimeoutMs: 60 })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).code).toBe("timeout");
  });
});

describe("captions: render", () => {
  test("sends the words given, plus the style, and waits for the burn", async () => {
    const { captions, calls } = harness((_call, index) =>
      index === 0
        ? json(200, captionRow({ status: "rendering", words: WORDS }))
        : json(200, captionRow({ status: "complete", words: WORDS, output_url: OUTPUT_URL })),
    );

    const job = await captions.render(
      JOB_ID,
      { words: WORDS, style: { pos: 0.75, max_words: 3 } },
      { pollIntervalMs: 5 },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(`/caption_jobs/${JOB_ID}/render`);
    expect(calls[0]!.body).toEqual({ words: WORDS, style: { pos: 0.75, max_words: 3 } });
    expect(job.status).toBe("complete");
    expect(job.output_url).toBe(OUTPUT_URL);
  });

  test("omitting the words reads them off the row, because the endpoint has no fallback", async () => {
    const { captions, calls } = harness((call, index) => {
      if (index === 0) return json(200, captionRow({ status: "transcribed", words: WORDS }));
      if (call.method === "POST") return json(200, captionRow({ status: "rendering", words: WORDS }));
      return json(200, captionRow({ status: "complete", words: WORDS, output_url: OUTPUT_URL }));
    });

    await captions.render(JOB_ID, {}, { pollIntervalMs: 5 });

    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.method).toBe("POST");
    // The row's own words went back up, rather than an empty list the server
    // would refuse.
    expect(calls[1]!.body).toEqual({ words: WORDS });
  });

  test("a row with no words at all is refused before the request, with a message that says why", async () => {
    const { captions, calls } = harness(() => json(200, captionRow({ status: "uploaded", words: null })));

    const failure = await captions.render(JOB_ID).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsError);
    expect((failure as OmsError).code).toBe("conflict");
    expect((failure as OmsError).message).toContain("Transcribe a window first");
    // Only the read happened: no render was ever started.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });

  test("resolves with a failed row when the burn itself failed", async () => {
    const { captions } = harness((_call, index) =>
      index === 0
        ? json(200, captionRow({ status: "rendering" }))
        : json(200, captionRow({ status: "failed", error: "ffmpeg exited 1" })),
    );

    const job = await captions.render(JOB_ID, { words: WORDS }, { pollIntervalMs: 5 });

    expect(job.status).toBe("failed");
  });
});

describe("captions: artefacts and cleanup", () => {
  test("download reads the row then fetches the signed URL with NO Authorization", async () => {
    const { captions, calls } = harness((call) =>
      call.path.startsWith("/caption_jobs/")
        ? json(200, captionRow({ status: "complete", output_url: OUTPUT_URL }))
        : new Response(new Uint8Array(12), { status: 200, headers: { "content-type": "video/mp4" } }),
    );

    const blob = await captions.download(JOB_ID);

    expect(blob.size).toBe(12);
    expect(calls[1]!.url).toBe(OUTPUT_URL);
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
  });

  test("a job that is merely transcribed is a conflict, not a missing artefact", async () => {
    const { captions } = harness(() => json(200, captionRow({ status: "transcribed", words: WORDS })));

    const failure = await captions.download(JOB_ID).catch((thrown: unknown) => thrown);

    expect((failure as OmsError).code).toBe("conflict");
    expect((failure as OmsError).message).toContain("rendered video");
  });

  test("delete sends DELETE and returns nothing", async () => {
    const { captions, calls } = harness(() => json(200, { deleted: JOB_ID }));

    await expect(captions.delete(JOB_ID)).resolves.toBeUndefined();

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe(`/caption_jobs/${JOB_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Jumpstyle
// ---------------------------------------------------------------------------

describe("jumpstyle", () => {
  test("the densities are the sidecar's own three words", () => {
    // The controller replaces an unrecognised density with "normal" instead of
    // refusing it, so a plausible synonym - "sparse", "dense" - is a silent
    // no-op that costs a whole edit to discover. This is the only guard.
    expect([...JUMPSTYLE_DENSITIES]).toEqual(["chill", "normal", "hyper"]);
  });

  test("quota is counted in edits, not seconds", async () => {
    const { jumpstyle, calls } = harness(() =>
      json(200, { authenticated: true, used_edits: 2, limit_edits: 15, remaining_edits: 13, unlimited: false }),
    );

    const quota = await jumpstyle.quota();

    expect(calls[0]!.path).toBe("/jumpstyle_jobs/quota");
    expect(quota.used_edits).toBe(2);
    expect(quota.remaining_edits).toBe(13);
  });

  test("create sends the track once and every clip under the `clips[]` suffix Rails reads", async () => {
    const { jumpstyle, calls } = harness(() => json(201, jumpstyleRow()));

    await jumpstyle.create({
      track: track(),
      clips: [clip("um.mp4"), clip("dois.mp4"), clip("tres.mp4")],
      duration: 30,
      seed: 41823,
      density: "hyper",
      rapidFire: true,
      bpm: 150,
    });

    const form = calls[0]!.form!;
    expect(calls[0]!.path).toBe("/jumpstyle_jobs");
    expect((form.get("track") as File).name).toBe("faixa.mp3");
    expect(form.getAll("clips[]")).toHaveLength(3);
    expect((form.getAll("clips[]")[2] as File).name).toBe("tres.mp4");
    // Every option goes up snake_cased, the way the controller reads it.
    expect(form.get("duration")).toBe("30");
    expect(form.get("seed")).toBe("41823");
    expect(form.get("density")).toBe("hyper");
    expect(form.get("rapid_fire")).toBe("true");
    expect(form.get("bpm")).toBe("150");
  });

  test("options the caller left out are omitted, not sent as the string `undefined`", async () => {
    const { jumpstyle, calls } = harness(() => json(201, jumpstyleRow()));

    await jumpstyle.create({ track: track(), clips: [clip("um.mp4")] });

    const form = calls[0]!.form!;
    for (const key of ["duration", "seed", "density", "rapid_fire", "bpm", "cf_turnstile_token"]) {
      expect(form.has(key)).toBe(false);
    }
  });

  test("create is not retried by default: a replay spends a second edit", async () => {
    const { jumpstyle, calls } = harness(() => json(502, "sidecar died"));

    await jumpstyle.create({ track: track(), clips: [clip("um.mp4")] }).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  test("run polls the job's own row and carries the sidecar's percentage", async () => {
    const { jumpstyle, calls } = harness((_call, index) => {
      if (index === 0) return json(201, jumpstyleRow());
      if (index < 2) return json(200, jumpstyleRow({ progress_percent: 70 }));
      return json(200, jumpstyleRow({ status: "complete", stage: null, progress_percent: null, output_url: OUTPUT_URL, detected_bpm: 148 }));
    });

    const seen: Progress[] = [];
    const finished = await jumpstyle.run(
      { track: track(), clips: [clip("um.mp4")], duration: 30 },
      { pollIntervalMs: 5, onProgress: (progress) => seen.push(progress) },
    );

    expect(finished.status).toBe("complete");
    expect(finished.seed).toBe(41823);
    expect(finished.detected_bpm).toBe(148);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /jumpstyle_jobs",
      `GET /jumpstyle_jobs/${JOB_ID}`,
      `GET /jumpstyle_jobs/${JOB_ID}`,
    ]);
    expect(seen.map((progress) => progress.status)).toEqual(["processing", "processing", "complete"]);
  });

  test("a spent edit quota is a 429 the caller can tell apart", async () => {
    const { jumpstyle } = harness(() => json(429, { error: "Daily edit quota reached (15/day)" }));

    const failure = await jumpstyle
      .create({ track: track(), clips: [clip("um.mp4")] })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(429);
  });

  test("download reads the row then the signed URL, with no bearer token on the second", async () => {
    const { jumpstyle, calls } = harness((call) =>
      call.path.startsWith("/jumpstyle_jobs/")
        ? json(200, jumpstyleRow({ status: "complete", output_url: OUTPUT_URL }))
        : new Response(new Uint8Array(5), { status: 200, headers: { "content-type": "video/mp4" } }),
    );

    const blob = await jumpstyle.download(JOB_ID);

    expect(blob.size).toBe(5);
    expect(calls[1]!.url).toBe(OUTPUT_URL);
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
  });

  test("delete sends DELETE", async () => {
    const { jumpstyle, calls } = harness(() => json(200, { deleted: JOB_ID }));

    await jumpstyle.delete(JOB_ID);

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.path).toBe(`/jumpstyle_jobs/${JOB_ID}`);
  });
});
