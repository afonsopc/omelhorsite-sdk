/**
 * `bun test` coverage for the captions chunked upload.
 *
 * This is the one place in the SDK where a single logical call - "step 1,
 * upload the video" - becomes three requests plus a pool, and where the wire
 * format is raw bytes rather than JSON or a form. So the assertions are about
 * the things a reader of the code cannot check by reading it:
 *
 *  - the switch: which of the two paths a given file takes, and that the
 *    boundary is `>` rather than `>=` so a file exactly on the threshold still
 *    goes in one request, as the web tool does it;
 *  - the wire: raw octet-stream bodies, the offset in the query string, the
 *    token in `X-Upload-Token` on the two calls that need it and NOT on the one
 *    that mints it;
 *  - the slicing: parts sized by what the SERVER reported, every byte sent
 *    exactly once and at the right offset, the last part being the remainder;
 *  - the retry asymmetry, which is the subtle half. A part is offset-addressed
 *    and therefore safe to replay, and is the only writing method in the SDK
 *    that retries by default; `uploads` and `uploads/finish` both mint
 *    something and must not.
 *  - React Native, which cannot slice a `{ uri, name, type }` descriptor and
 *    has to be told so before anything is uploaded rather than after.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { OmsApiError, OmsError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  CAPTION_CHUNKED_THRESHOLD,
  CAPTION_PART_SIZE,
  CaptionsNamespace,
  captionUploadSize,
  resolveCaptionPartSize,
} from "../src/resources/tools/captions";
import { file } from "../src/types";
import type { Progress } from "../src/types";

const BASE_URL = "https://api.test";
const JOB_ID = "aa11bb22-0000-4000-8000-00000000cc33";
const TOKEN = "signed.upload.token";

interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  /** Parsed JSON body, for the calls that send one. */
  readonly json: unknown;
  /** Raw body bytes, for the part uploads. */
  readonly bytes: Uint8Array<ArrayBuffer> | undefined;
  readonly form: FormData | undefined;
}

interface Harness {
  readonly captions: CaptionsNamespace;
  readonly calls: RecordedCall[];
  readonly paths: string[];
}

type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

function harness(handler: Handler): Harness {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const url = new URL(input);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const body = init?.body;
    const call: RecordedCall = {
      path: url.pathname,
      method: init?.method ?? "GET",
      query,
      headers,
      json: typeof body === "string" ? JSON.parse(body) : undefined,
      bytes: body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : undefined,
      form: body instanceof FormData ? body : undefined,
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
  const captions = new CaptionsNamespace(http);
  return {
    captions,
    calls,
    get paths() {
      return calls.map((call) => call.path);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A caption job in `"uploaded"`, as `finish` and `create` both render one. */
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

/**
 * Distinct, checkable bytes: `n` bytes whose value is their own index, so a
 * part that landed at the wrong offset is visible rather than plausible.
 *
 * Annotated `Uint8Array<ArrayBuffer>` and not the bare `Uint8Array`, which
 * widens to `ArrayBufferLike` and stops being a `BlobPart`.
 */
function bytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 1) out[at] = at % 251;
  return out;
}

/**
 * The default three-call handler: a session with `partSize`, `{ received }`
 * for every part, and the finished row.
 */
function chunkedHandler(partSize: number, partCount: number): Handler {
  return (call) => {
    if (call.path === "/caption_jobs/uploads") {
      return json(200, { upload_token: TOKEN, part_size: partSize, part_count: partCount });
    }
    if (call.path === "/caption_jobs/uploads/parts") {
      return json(200, { received: call.bytes?.length ?? 0 });
    }
    if (call.path === "/caption_jobs/uploads/finish") return json(201, captionRow());
    return json(404, "Not found");
  };
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * React Native's `FormData`, reduced to the one fact that matters here: it
 * keeps a value exactly as given and exposes `getParts()`, which is what marks
 * it as the native one. Same double as `test/react-native.test.ts` uses, kept
 * local rather than exported from there - a test helper shared across files is
 * a dependency between two suites that have no reason to move together.
 */
class ReactNativeFormData {
  readonly entries: Array<{ name: string; value: unknown }> = [];

  append(name: string, value: unknown): void {
    this.entries.push({ name, value });
  }

  getParts(): Array<{ name: string; value: unknown }> {
    return this.entries;
  }
}

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** Runs the rest of the test as though it were on a phone. */
function pretendReactNative(): void {
  const bag = globalThis as unknown as Record<string, unknown>;
  const previous = bag["FormData"];
  restores.push(() => {
    bag["FormData"] = previous;
  });
  bag["FormData"] = ReactNativeFormData;
}

describe("which path a video takes", () => {
  test("a file at the threshold goes in one request, one byte over it does not", async () => {
    const small = harness(() => json(201, captionRow()));
    await small.captions.upload({ video: file(bytes(8), "clip.mp4", { size: CAPTION_CHUNKED_THRESHOLD }) });
    expect(small.paths).toEqual(["/caption_jobs"]);
    expect(small.calls[0]?.form).toBeInstanceOf(FormData);

    const big = harness(chunkedHandler(4, 2));
    await big.captions.upload({ video: file(bytes(8), "clip.mp4", { size: CAPTION_CHUNKED_THRESHOLD + 1 }) });
    expect(big.paths[0]).toBe("/caption_jobs/uploads");
    expect(big.paths.at(-1)).toBe("/caption_jobs/uploads/finish");
  });

  test("chunkedThreshold overrides the default, so a tiny file can be chunked", async () => {
    const api = harness(chunkedHandler(4, 2));
    const job = await api.captions.upload({ video: file(bytes(8), "clip.mp4"), chunkedThreshold: 0 });
    expect(job.id).toBe(JOB_ID);
    expect(api.paths).toEqual([
      "/caption_jobs/uploads",
      "/caption_jobs/uploads/parts",
      "/caption_jobs/uploads/parts",
      "/caption_jobs/uploads/finish",
    ]);
  });

  test("a resume goes chunked whatever the size says, and does not open a session", async () => {
    const api = harness(chunkedHandler(4, 2));
    await api.captions.upload({
      video: file(bytes(8), "clip.mp4"),
      resume: { session: { upload_token: TOKEN, part_size: 4, part_count: 2 }, uploaded: [0] },
    });
    // No `uploads` call: the session was handed in. One part left, then finish.
    expect(api.paths).toEqual(["/caption_jobs/uploads/parts", "/caption_jobs/uploads/finish"]);
    expect(api.calls[0]?.query["offset"]).toBe("4");
  });

  test("captionUploadSize reads a size from every shape it can, and gives up honestly", () => {
    expect(captionUploadSize(file(bytes(9), "a.mp4"))).toBe(9);
    expect(captionUploadSize(file(new Blob([bytes(12)]), "a.mp4"))).toBe(12);
    // A declared size wins: it is what a caller knows and the data may be a stream.
    expect(captionUploadSize(file(bytes(9), "a.mp4", { size: 500 }))).toBe(500);
    expect(captionUploadSize({ data: { uri: "file:///v.mp4", name: "v.mp4", size: 77 }, filename: "v.mp4" })).toBe(77);
    // A picker that reported no size, and a stream: unknowable without reading.
    expect(captionUploadSize({ data: { uri: "file:///v.mp4", name: "v.mp4" }, filename: "v.mp4" })).toBeUndefined();
    const stream = new Blob([bytes(4)]).stream();
    expect(captionUploadSize({ data: stream, filename: "v.mp4" })).toBeUndefined();
  });
});

describe("the wire format of a chunked upload", () => {
  test("session, parts and finish carry exactly what the controller reads", async () => {
    const api = harness(chunkedHandler(4, 3));
    await api.captions.upload({
      video: file(bytes(10), "as legendas.mp4"),
      chunkedThreshold: 0,
      captchaToken: "turnstile-abc",
      concurrency: 1,
    });

    const [open, first, second, third, finish] = api.calls;

    // The session is opened with the REAL byte length and the filename, plus
    // the captcha under the name Rails reads.
    expect(open?.method).toBe("POST");
    expect(open?.json).toEqual({ size: 10, filename: "as legendas.mp4", cf_turnstile_token: "turnstile-abc" });
    // The token does not exist yet, so it cannot be on this call.
    expect(open?.headers["x-upload-token"]).toBeUndefined();

    // Parts: raw bytes, octet-stream, offset in the query, token in the header.
    for (const part of [first, second, third]) {
      expect(part?.path).toBe("/caption_jobs/uploads/parts");
      expect(part?.method).toBe("POST");
      expect(part?.headers["content-type"]).toBe("application/octet-stream");
      expect(part?.headers["x-upload-token"]).toBe(TOKEN);
      expect(part?.json).toBeUndefined();
    }
    expect([first, second, third].map((call) => call?.query["offset"])).toEqual(["0", "4", "8"]);
    // Sliced with the size the SERVER named, and the last part is the remainder.
    expect([first, second, third].map((call) => call?.bytes?.length)).toEqual([4, 4, 2]);

    expect(finish?.path).toBe("/caption_jobs/uploads/finish");
    expect(finish?.headers["x-upload-token"]).toBe(TOKEN);
    expect(finish?.json).toEqual({});
  });

  test("every byte is sent once, at its own offset, and reassembles the file", async () => {
    const source = bytes(37);
    const api = harness(chunkedHandler(8, 5));
    await api.captions.upload({ video: file(source, "clip.mp4"), chunkedThreshold: 0 });

    const assembled = new Uint8Array(source.length) as Uint8Array<ArrayBuffer>;
    let written = 0;
    for (const call of api.calls) {
      if (call.path !== "/caption_jobs/uploads/parts") continue;
      const offset = Number(call.query["offset"]);
      const part = call.bytes as Uint8Array<ArrayBuffer>;
      assembled.set(part, offset);
      written += part.length;
    }
    expect(written).toBe(source.length);
    expect(assembled).toEqual(source);
  });

  test("the captcha field is omitted rather than sent empty when there is none", async () => {
    const api = harness(chunkedHandler(16, 1));
    await api.captions.upload({ video: file(bytes(10), "clip.mp4"), chunkedThreshold: 0 });
    expect(api.calls[0]?.json).toEqual({ size: 10, filename: "clip.mp4" });
  });

  test("uploadPart hands back what the sidecar acknowledged, not what was sent", async () => {
    const api = harness(() => json(200, { received: 4 }));
    const received = await api.captions.uploadPart(TOKEN, 16, bytes(4));
    expect(received).toBe(4);
    expect(api.calls[0]?.query["offset"]).toBe("16");
    expect(api.calls[0]?.headers["x-upload-token"]).toBe(TOKEN);
  });

  test("a session with no token is refused here rather than by the server", async () => {
    const api = harness(() => json(200, { received: 0 }));
    await expect(api.captions.uploadPart({ upload_token: "", part_size: 4, part_count: 1 }, 0, bytes(4))).rejects.toThrow(
      OmsError,
    );
    await expect(api.captions.finishUpload("")).rejects.toThrow(OmsError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("part sizing", () => {
  test("resolveCaptionPartSize trusts the server downwards and never upwards", () => {
    expect(resolveCaptionPartSize(8)).toBe(8);
    expect(resolveCaptionPartSize(CAPTION_PART_SIZE)).toBe(CAPTION_PART_SIZE);
    // A server that reported a bigger part than its own validator accepts would
    // reject every part; capping only ever sends smaller ones, which is legal.
    expect(resolveCaptionPartSize(CAPTION_PART_SIZE * 2)).toBe(CAPTION_PART_SIZE);
    // Missing or nonsense falls back rather than dividing by zero forever.
    expect(resolveCaptionPartSize(undefined)).toBe(CAPTION_PART_SIZE);
    expect(resolveCaptionPartSize(0)).toBe(CAPTION_PART_SIZE);
    expect(resolveCaptionPartSize(Number.NaN)).toBe(CAPTION_PART_SIZE);
    expect(resolveCaptionPartSize(-1)).toBe(CAPTION_PART_SIZE);
  });

  test("a session reporting no part_size still slices, using the SDK's fallback", async () => {
    const api = harness((call) => {
      if (call.path === "/caption_jobs/uploads") return json(200, { upload_token: TOKEN, part_size: 0, part_count: 1 });
      if (call.path === "/caption_jobs/uploads/parts") return json(200, { received: call.bytes?.length ?? 0 });
      return json(201, captionRow());
    });
    await api.captions.upload({ video: file(bytes(20), "clip.mp4"), chunkedThreshold: 0 });
    // 32 MiB fallback, so the whole file is one part - and crucially not zero
    // parts, which is what dividing by the reported 0 would produce.
    const parts = api.calls.filter((call) => call.path === "/caption_jobs/uploads/parts");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.bytes?.length).toBe(20);
  });
});

describe("progress and resuming", () => {
  test("progress is cumulative, never overshoots, and lands exactly on the total", async () => {
    const api = harness(chunkedHandler(4, 3));
    const seen: Progress[] = [];
    await api.captions.upload(
      { video: file(bytes(10), "clip.mp4"), chunkedThreshold: 0, concurrency: 1 },
      { onProgress: (progress) => seen.push(progress) },
    );

    expect(seen.every((progress) => progress.phase === "upload")).toBe(true);
    expect(seen.every((progress) => progress.total === 10)).toBe(true);
    expect(seen.map((progress) => progress.loaded)).toEqual([0, 4, 8, 10]);
  });

  test("the direct path reports the same shape: nothing, then the whole file", async () => {
    const api = harness(() => json(201, captionRow()));
    const seen: Progress[] = [];
    await api.captions.upload({ video: file(bytes(10), "clip.mp4") }, { onProgress: (progress) => seen.push(progress) });
    expect(seen).toEqual([
      { phase: "upload", loaded: 0, total: 10 },
      { phase: "upload", loaded: 10, total: 10 },
    ]);
  });

  test("onPart reports the offsets a resume needs, and a resume skips exactly those", async () => {
    const first = harness((call, index) => {
      if (call.path === "/caption_jobs/uploads") return json(200, { upload_token: TOKEN, part_size: 4, part_count: 3 });
      // The third request is the second part: fail the run there.
      if (index === 2) return json(503, "Captions service unavailable");
      return json(200, { received: call.bytes?.length ?? 0 });
    });

    const landed: number[] = [];
    await expect(
      first.captions.upload(
        { video: file(bytes(10), "clip.mp4"), chunkedThreshold: 0, concurrency: 1 },
        { onPart: (offset) => landed.push(offset), retry: false },
      ),
    ).rejects.toThrow(OmsApiError);
    expect(landed).toEqual([0]);

    const second = harness(chunkedHandler(4, 3));
    const seen: Progress[] = [];
    await second.captions.upload(
      {
        video: file(bytes(10), "clip.mp4"),
        chunkedThreshold: 0,
        concurrency: 1,
        resume: { session: { upload_token: TOKEN, part_size: 4, part_count: 3 }, uploaded: landed },
      },
      { onProgress: (progress) => seen.push(progress) },
    );

    expect(second.calls.filter((call) => call.path === "/caption_jobs/uploads/parts").map((call) => call.query["offset"])).toEqual([
      "4",
      "8",
    ]);
    // The bar picks up where it stopped rather than restarting at zero.
    expect(seen.map((progress) => progress.loaded)).toEqual([4, 8, 10]);
  });

  test("resuming with no offsets re-sends everything, which is correct and only slower", async () => {
    const api = harness(chunkedHandler(4, 3));
    await api.captions.upload({
      video: file(bytes(10), "clip.mp4"),
      chunkedThreshold: 0,
      resume: { session: TOKEN },
    });
    expect(api.calls.filter((call) => call.path === "/caption_jobs/uploads/parts")).toHaveLength(1);
  });
});

describe("the pool", () => {
  test("concurrency bounds the parts in flight, and 1 makes them sequential", async () => {
    let inFlight = 0;
    let peak = 0;
    const handler: Handler = async (call) => {
      if (call.path === "/caption_jobs/uploads") return json(200, { upload_token: TOKEN, part_size: 4, part_count: 8 });
      if (call.path === "/caption_jobs/uploads/finish") return json(201, captionRow());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
      return json(200, { received: call.bytes?.length ?? 0 });
    };

    const parallel = harness(handler);
    await parallel.captions.upload({ video: file(bytes(32), "clip.mp4"), chunkedThreshold: 0 });
    expect(peak).toBe(3);

    peak = 0;
    const sequential = harness(handler);
    await sequential.captions.upload({ video: file(bytes(32), "clip.mp4"), chunkedThreshold: 0, concurrency: 1 });
    expect(peak).toBe(1);
    expect(
      sequential.calls.filter((call) => call.path === "/caption_jobs/uploads/parts").map((call) => Number(call.query["offset"])),
    ).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  });
});

describe("the retry asymmetry", () => {
  test("a part is replayed after a 5xx, because the offset makes it idempotent", async () => {
    let partAttempts = 0;
    const api = harness((call) => {
      if (call.path === "/caption_jobs/uploads") return json(200, { upload_token: TOKEN, part_size: 16, part_count: 1 });
      if (call.path === "/caption_jobs/uploads/parts") {
        partAttempts += 1;
        return partAttempts === 1 ? json(502, "Bad gateway") : json(200, { received: 10 });
      }
      return json(201, captionRow());
    });

    const job = await api.captions.upload({ video: file(bytes(10), "clip.mp4"), chunkedThreshold: 0 });
    expect(job.id).toBe(JOB_ID);
    expect(partAttempts).toBe(2);
    // The same bytes at the same offset both times: a replay here is a no-op
    // server-side, which is why it is allowed at all.
    const parts = api.calls.filter((call) => call.path === "/caption_jobs/uploads/parts");
    expect(parts.map((call) => call.query["offset"])).toEqual(["0", "0"]);
    expect(parts[0]?.bytes).toEqual(parts[1]?.bytes as Uint8Array<ArrayBuffer>);
  });

  test("opening a session is not replayed: a second one orphans the first upload", async () => {
    let attempts = 0;
    const api = harness(() => {
      attempts += 1;
      return json(502, "Bad gateway");
    });
    await expect(
      api.captions.startUpload({ size: 10 }),
    ).rejects.toThrow(OmsApiError);
    expect(attempts).toBe(1);
  });

  test("finishing is not replayed: the row is created under a fixed id", async () => {
    let attempts = 0;
    const api = harness(() => {
      attempts += 1;
      return json(502, "Bad gateway");
    });
    await expect(api.captions.finishUpload(TOKEN)).rejects.toThrow(OmsApiError);
    expect(attempts).toBe(1);
  });
});

describe("React Native", () => {
  test("a picked descriptor is refused before anything is uploaded, and says what to do", async () => {
    const api = harness(() => json(201, captionRow()));
    const picked = { data: { uri: "file:///var/mobile/v.mov", name: "v.mov", type: "video/quicktime", size: 200 * 1024 * 1024 }, filename: "v.mov" };

    let thrown: unknown;
    try {
      await api.captions.upload({ video: picked });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OmsError);
    expect((thrown as OmsError).code).toBe("invalid_request");
    expect((thrown as OmsError).message).toContain("create()");
    // Nothing was sent: the throw happens before the session is opened.
    expect(api.calls).toHaveLength(0);
  });

  test("a small pick still works, because the direct path appends the descriptor verbatim", async () => {
    pretendReactNative();
    const api = harness(() => json(201, captionRow()));
    const descriptor = { uri: "file:///var/mobile/v.mov", name: "v.mov", type: "video/quicktime", size: 1024 };

    const job = await api.captions.upload({ video: { data: descriptor, filename: "v.mov" } });
    expect(job.id).toBe(JOB_ID);
    expect(api.paths).toEqual(["/caption_jobs"]);

    // The platform gets a descriptor, not bytes, so its native layer can stream
    // the file off disk. Anything that tried to read the URI here would have
    // thrown instead. The wrapper rebuilds it from `filename` + `contentType`,
    // which is what the server should store, and drops the picker's `size` -
    // RN ignores it anyway.
    const parts = (api.calls[0]?.form as unknown as ReactNativeFormData).getParts();
    expect(parts).toEqual([{ name: "video", value: { uri: descriptor.uri, name: "v.mov", type: "video/quicktime" } }]);
  });

  test("an empty file is refused without a round trip", async () => {
    const api = harness(() => json(201, captionRow()));
    await expect(
      api.captions.createChunked({ video: file(new Uint8Array(0), "clip.mp4") }),
    ).rejects.toThrow(OmsError);
    expect(api.calls).toHaveLength(0);
  });
});
