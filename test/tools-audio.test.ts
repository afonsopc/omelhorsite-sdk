/**
 * `bun test` coverage for the two audio tools, transcription and vocal
 * separation.
 *
 * Neither of them enqueues through the generic `jobs` table, so neither has a
 * `job_id`: they are polled by re-reading their own row. That is the thing
 * most worth asserting here - that `run()` reaches for the tool's own `show`
 * and never for `/jobs/:id`, and that it still goes through the one shared
 * polling loop rather than growing a `while` of its own.
 *
 * The artefact downloads are asserted too, because they are among the requests
 * in this SDK that must NOT carry the bearer token: a stem URL and a subtitle
 * URL are signed ActiveStorage links that redirect to the object store, and the
 * store rejects a request arriving with two authentication schemes.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsError, OmsTimeoutError } from "../src/errors";
import { ApiClient } from "../src/http";
import { TranscriptionNamespace } from "../src/resources/tools/transcription";
import {
  VocalSeparationNamespace,
  vocalSeparationProgress,
} from "../src/resources/tools/vocalSeparation";
import { file } from "../src/types";
import type { Progress } from "../src/types";

const BASE_URL = "https://api.test";
const RUN_ID = "aa11bb22-0000-4000-8000-00000000cc33";
const SRT_URL = `${BASE_URL}/rails/active_storage/blobs/redirect/sig/legendas.srt`;
const VTT_URL = `${BASE_URL}/rails/active_storage/blobs/redirect/sig/legendas.vtt`;
const VOCALS_URL = `${BASE_URL}/rails/active_storage/blobs/redirect/sig/vocals.wav`;
const INSTRUMENTAL_URL = `${BASE_URL}/rails/active_storage/blobs/redirect/sig/instrumental.wav`;

interface RecordedCall {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly form: FormData | undefined;
}

interface Harness {
  readonly transcription: TranscriptionNamespace;
  readonly separation: VocalSeparationNamespace;
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
  return {
    transcription: new TranscriptionNamespace(http),
    separation: new VocalSeparationNamespace(http),
    calls,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A transcription row, as `TranscriptionBlueprint` renders one under `:extended`. */
function transcriptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    status: "pending",
    model_id: "whisper_large_v3_turbo",
    duration_seconds: 412,
    language: null,
    detected_language: null,
    error: null,
    finished_at: null,
    user_id: null,
    ip_address: "203.0.113.7",
    has_original: true,
    progress_percent: null,
    text: null,
    srt_url: null,
    vtt_url: null,
    ...overrides,
  };
}

/** A separation row, as `VocalSeparationBlueprint` renders one under `:extended`. */
function separationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    status: "pending",
    model_id: "bs_roformer",
    duration_seconds: 231,
    error: null,
    finished_at: null,
    song_id: null,
    song_title: null,
    user_id: null,
    ip_address: "203.0.113.7",
    has_vocals: false,
    has_instrumental: false,
    has_original: true,
    progress_percent: null,
    queue_position: null,
    vocals_url: null,
    instrumental_url: null,
    ...overrides,
  };
}

function audio(name = "entrevista.m4a") {
  return file(new Uint8Array(8).fill(3), name, { contentType: "audio/mp4" });
}

function bytes(size: number, contentType: string): Response {
  return new Response(new Uint8Array(size).fill(1), { status: 200, headers: { "content-type": contentType } });
}

// ---------------------------------------------------------------------------
// Preflight: the two calls an agent should make before spending anything
// ---------------------------------------------------------------------------

describe("models and quota", () => {
  test("models unwraps the controller's one-key envelope", async () => {
    const { transcription, calls } = harness(() =>
      json(200, {
        models: [
          { id: "whisper_large_v3_turbo", translation_key: "whisperLargeV3Turbo", default: true },
          { id: "whisper_large_v3", translation_key: "whisperLargeV3" },
        ],
      }),
    );

    const models = await transcription.models();

    expect(calls[0]!.path).toBe("/transcriptions/models");
    expect(models).toHaveLength(2);
    expect(models[0]!.id).toBe("whisper_large_v3_turbo");
    expect(models.find((model) => model.default === true)?.id).toBe("whisper_large_v3_turbo");
  });

  test("models answers an empty list rather than undefined when the envelope is bare", async () => {
    const { separation } = harness(() => json(200, {}));
    expect(await separation.models()).toEqual([]);
  });

  test("the separator's models come from its own path, not the transcriber's", async () => {
    const { separation, calls } = harness(() => json(200, { models: [{ id: "bs_roformer", default: true }] }));
    await separation.models();
    expect(calls[0]!.path).toBe("/vocal_separations/models");
  });

  test("quota reports seconds, and nulls mean unlimited rather than zero", async () => {
    const { transcription, calls } = harness(() =>
      json(200, {
        authenticated: true,
        used_seconds: 400,
        limit_seconds: null,
        remaining_seconds: null,
        unlimited: true,
      }),
    );

    const quota = await transcription.quota();

    expect(calls[0]!.path).toBe("/transcriptions/quota");
    expect(quota.unlimited).toBe(true);
    expect(quota.used_seconds).toBe(400);
    // The distinction the whole preflight rests on: null is "no ceiling", not "nothing left".
    expect(quota.limit_seconds).toBeNull();
    expect(quota.remaining_seconds).toBeNull();
  });

  test("a bounded quota carries real numbers on all three fields", async () => {
    const { separation } = harness(() =>
      json(200, {
        authenticated: false,
        used_seconds: 300,
        limit_seconds: 720,
        remaining_seconds: 420,
        unlimited: false,
      }),
    );

    const quota = await separation.quota();

    expect(quota.authenticated).toBe(false);
    expect(quota.remaining_seconds).toBe(420);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  test("transcription posts multipart under the `audio` field the controller reads", async () => {
    const { transcription, calls } = harness(() => json(201, transcriptionRow()));

    await transcription.create({
      audio: audio(),
      modelId: "whisper_large_v3",
      language: "pt",
      captchaToken: "0.turnstile",
    });

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/transcriptions");
    // The runtime must own Content-Type so the multipart boundary matches.
    expect(call.headers["content-type"]).toBeUndefined();

    const form = call.form!;
    const sent = form.get("audio");
    expect(sent).toBeInstanceOf(Blob);
    expect((sent as File).name).toBe("entrevista.m4a");
    expect(form.get("model_id")).toBe("whisper_large_v3");
    expect(form.get("language")).toBe("pt");
    expect(form.get("cf_turnstile_token")).toBe("0.turnstile");
  });

  test("optional fields are omitted, not sent empty, so the server applies its own defaults", async () => {
    const { transcription, calls } = harness(() => json(201, transcriptionRow()));

    await transcription.create({ audio: audio() });

    const form = calls[0]!.form!;
    expect(form.has("model_id")).toBe(false);
    expect(form.has("language")).toBe(false);
    expect(form.has("cf_turnstile_token")).toBe(false);
  });

  test("separation posts to its own path with `audio` too", async () => {
    const { separation, calls } = harness(() => json(201, separationRow({ queue_position: 2 })));

    const created = await separation.create({ audio: audio("musica.flac"), modelId: "mel_band_roformer" });

    expect(calls[0]!.path).toBe("/vocal_separations");
    expect(calls[0]!.form!.get("model_id")).toBe("mel_band_roformer");
    expect(created.queue_position).toBe(2);
  });

  test("neither create is retried by default: a 502 must not start a second run", async () => {
    const one = harness(() => json(502, "upstream is having a day"));
    const failure = await one.transcription.create({ audio: audio() }).catch((thrown: unknown) => thrown);
    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(502);
    expect(one.calls).toHaveLength(1);

    const two = harness(() => json(502, "same"));
    await two.separation.create({ audio: audio() }).catch(() => undefined);
    expect(two.calls).toHaveLength(1);
  });

  test("but retrying can be asked for explicitly", async () => {
    const { transcription, calls } = harness((_call, index) =>
      index < 1 ? json(502, "blip") : json(201, transcriptionRow()),
    );

    const created = await transcription.create(
      { audio: audio() },
      { retry: { maxAttempts: 2, baseDelayMs: 5, jitter: false } },
    );

    expect(created.id).toBe(RUN_ID);
    expect(calls).toHaveLength(2);
  });

  test("a spent daily quota arrives as a quota error, not a generic 4xx", async () => {
    const { transcription } = harness(() =>
      json(429, { error: "Daily quota would be exceeded. Remaining: 2.5 minutes" }),
    );

    const failure = await transcription.create({ audio: audio() }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe("run", () => {
  test("polls the tool's OWN row and never touches /jobs, because there is no job id", async () => {
    const { transcription, calls } = harness((_call, index) => {
      if (index === 0) return json(201, transcriptionRow());
      if (index < 3) return json(200, transcriptionRow({ status: "processing", progress_percent: 40 }));
      return json(
        200,
        transcriptionRow({ status: "complete", text: "bom dia", srt_url: SRT_URL, vtt_url: VTT_URL }),
      );
    });

    const seen: Progress[] = [];
    const finished = await transcription.run(
      { audio: audio() },
      { pollIntervalMs: 5, onProgress: (progress) => seen.push(progress) },
    );

    expect(finished.status).toBe("complete");
    expect(finished.text).toBe("bom dia");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /transcriptions",
      `GET /transcriptions/${RUN_ID}`,
      `GET /transcriptions/${RUN_ID}`,
      `GET /transcriptions/${RUN_ID}`,
    ]);
    expect(calls.some((call) => call.path.startsWith("/jobs"))).toBe(false);

    // One report for the created row, then one per poll.
    expect(seen.map((progress) => progress.status)).toEqual([
      "pending",
      "processing",
      "processing",
      "complete",
    ]);
    // `total` is undefined until the sidecar reports a percentage.
    expect(seen[0]!.total).toBeUndefined();
    expect(seen[1]!).toMatchObject({ loaded: 40, total: 100 });
  });

  test("resolves with the failed row, because a failure is an answer", async () => {
    const { separation } = harness((_call, index) =>
      index === 0
        ? json(201, separationRow())
        : json(200, separationRow({ status: "failed", error: "sidecar ran out of memory" })),
    );

    const finished = await separation.run({ audio: audio() }, { pollIntervalMs: 5 });

    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("sidecar ran out of memory");
  });

  test("a deadline throws a timeout that says the run is still going", async () => {
    const { separation } = harness((_call, index) =>
      index === 0 ? json(201, separationRow()) : json(200, separationRow({ status: "processing" })),
    );

    const failure = await separation
      .run({ audio: audio() }, { pollIntervalMs: 15, waitTimeoutMs: 60 })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).code).toBe("timeout");
    expect((failure as OmsTimeoutError).message).toContain("still working on it");
    expect((failure as OmsTimeoutError).message).toContain("the vocal separation");
  });

  test("an abort stops the polling rather than leaving a loop running", async () => {
    const { transcription, calls } = harness((_call, index) =>
      index === 0 ? json(201, transcriptionRow()) : json(200, transcriptionRow({ status: "processing" })),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const failure = await transcription
      .run({ audio: audio() }, { pollIntervalMs: 1_000, signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).code).toBe("aborted");

    const after = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(after);
  });

  test("a 404 from the retention sweep is not swallowed by the loop", async () => {
    const { transcription } = harness((_call, index) =>
      index === 0 ? json(201, transcriptionRow()) : json(404, { error: "Transcription not found" }),
    );

    const failure = await transcription.run({ audio: audio() }, { pollIntervalMs: 5 }).catch((t: unknown) => t);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The queue position, which is the whole reason separation reports progress
// ---------------------------------------------------------------------------

describe("queue position", () => {
  test("is folded into the progress status, because that is the only field a host renders", () => {
    expect(vocalSeparationProgress(separationRow({ queue_position: 3 }) as never).status).toBe(
      "pending (3 ahead in the queue)",
    );
    expect(vocalSeparationProgress(separationRow({ queue_position: 0 }) as never).status).toBe(
      "pending (next up)",
    );
  });

  test("is left alone once the run is processing and the position is null", () => {
    const progress = vocalSeparationProgress(
      separationRow({ status: "processing", queue_position: null, progress_percent: 12 }) as never,
    );
    expect(progress.status).toBe("processing");
    expect(progress).toMatchObject({ loaded: 12, total: 100 });
  });

  test("reaches the caller through run()", async () => {
    const { separation } = harness((_call, index) => {
      if (index === 0) return json(201, separationRow({ queue_position: 1 }));
      return json(200, separationRow({ status: "complete", vocals_url: VOCALS_URL }));
    });

    const seen: Progress[] = [];
    await separation.run({ audio: audio() }, { pollIntervalMs: 5, onProgress: (p) => seen.push(p) });

    expect(seen[0]!.status).toBe("pending (1 ahead in the queue)");
  });
});

// ---------------------------------------------------------------------------
// Artefacts
// ---------------------------------------------------------------------------

describe("subtitles", () => {
  test("reads the row, then fetches the signed URL with NO Authorization header", async () => {
    const { transcription, calls } = harness((call) => {
      if (call.path.startsWith("/transcriptions/")) {
        return json(200, transcriptionRow({ status: "complete", srt_url: SRT_URL, vtt_url: VTT_URL }));
      }
      return bytes(9, "application/x-subrip");
    });

    const blob = await transcription.subtitles(RUN_ID, "srt");

    expect(blob.size).toBe(9);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer secret-session-token");
    expect(calls[1]!.url).toBe(SRT_URL);
    // The signature in the URL is the credential; a bearer token alongside it
    // is what makes the object store refuse.
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
  });

  test("picks the format asked for", async () => {
    const { transcription, calls } = harness((call) =>
      call.path.startsWith("/transcriptions/")
        ? json(200, transcriptionRow({ status: "complete", srt_url: SRT_URL, vtt_url: VTT_URL }))
        : bytes(4, "text/vtt"),
    );

    await transcription.subtitles(RUN_ID, "vtt");

    expect(calls[1]!.url).toBe(VTT_URL);
  });

  test("says which of the three reasons there is no subtitle file", async () => {
    const running = harness(() => json(200, transcriptionRow({ status: "processing" })));
    const early = await running.transcription.subtitles(RUN_ID, "srt").catch((t: unknown) => t);
    expect((early as OmsError).code).toBe("conflict");
    expect((early as OmsError).message).toContain("SRT subtitles");
    // The URL was never fetched.
    expect(running.calls).toHaveLength(1);

    const broken = harness(() => json(200, transcriptionRow({ status: "failed", error: "no speech" })));
    const failed = await broken.transcription.subtitles(RUN_ID, "srt").catch((t: unknown) => t);
    expect((failed as OmsError).code).toBe("invalid_request");
    expect((failed as OmsError).message).toContain("no speech");

    const swept = harness(() => json(200, transcriptionRow({ status: "complete", srt_url: null })));
    const gone = await swept.transcription.subtitles(RUN_ID, "srt").catch((t: unknown) => t);
    expect((gone as OmsError).code).toBe("not_found");
    expect((gone as OmsError).message).toContain("swept");
  });

  test("surfaces the store's own refusal with its status", async () => {
    const { transcription } = harness((call) =>
      call.path.startsWith("/transcriptions/")
        ? json(200, transcriptionRow({ status: "complete", srt_url: SRT_URL }))
        : new Response("expired", { status: 403 }),
    );

    const failure = await transcription.subtitles(RUN_ID, "srt").catch((t: unknown) => t);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(403);
  });
});

describe("stems", () => {
  test("downloads the stem asked for, with no Authorization header", async () => {
    const { separation, calls } = harness((call) =>
      call.path.startsWith("/vocal_separations/")
        ? json(200, separationRow({ status: "complete", vocals_url: VOCALS_URL, instrumental_url: INSTRUMENTAL_URL }))
        : bytes(6, "audio/wav"),
    );

    const blob = await separation.download(RUN_ID, "instrumental");

    expect(blob.size).toBe(6);
    expect(calls[1]!.url).toBe(INSTRUMENTAL_URL);
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
  });

  test("a song-owned separation is refused with its own message, not blamed on the sweep", async () => {
    const { separation, calls } = harness(() =>
      json(
        200,
        separationRow({
          status: "complete",
          song_id: "5a0d1c9e-0000-4000-8000-0000000000ff",
          song_title: "Homem do Leme",
          vocals_url: null,
          instrumental_url: null,
        }),
      ),
    );

    const failure = await separation.download(RUN_ID, "vocals").catch((t: unknown) => t);

    expect(failure).toBeInstanceOf(OmsError);
    expect((failure as OmsError).code).toBe("not_found");
    expect((failure as OmsError).message).toContain("music library");
    // Crucially NOT the retention-sweep message, which would be a lie here.
    expect((failure as OmsError).message).not.toContain("swept");
    expect(calls).toHaveLength(1);
  });

  test("stemUrl hands a good URL straight back, for a row already in hand", () => {
    const { separation } = harness(() => json(200, {}));
    const record = separationRow({ status: "complete", vocals_url: VOCALS_URL }) as never;
    expect(separation.stemUrl(record, "vocals")).toBe(VOCALS_URL);
  });
});
