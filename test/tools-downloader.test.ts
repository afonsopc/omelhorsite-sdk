/**
 * `bun test` coverage for the downloader.
 *
 * The tool that agrees with the rest of the SDK about the least, so most of
 * this file is about the seams:
 *
 * - the sidecar's create answer is `{ request_id, target }` and its progress
 *   answer is a bare `{ status, message, progress }` with no identifier in it
 *   at all, so the namespace stamps an `id` on both. If that ever stops
 *   happening, every caller loses the ability to pass a job around as one
 *   object;
 * - it finishes on `"complete"` and fails on `"failed"`, not on `"done"` and
 *   `"error"` as an earlier draft of this SDK claimed. A wait written against
 *   the wrong pair never ends;
 * - its `progress` is a FRACTION, where every other tool reports a percentage;
 * - the file download is ONE SHOT - the sidecar deletes the file as it streams
 *   it - which is why nothing here may be retried.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsTimeoutError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  DownloaderNamespace,
  downloaderProgress,
  isDownloaderTerminal,
} from "../src/resources/tools/downloader";
import type { Progress } from "../src/types";

const BASE_URL = "https://api.test";
const REQUEST_ID = "7c2f1e40-0000-4000-8000-0000000000ab";

interface RecordedCall {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface Harness {
  readonly downloader: DownloaderNamespace;
  readonly calls: RecordedCall[];
}

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
  return { downloader: new DownloaderNamespace(http), calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** What the sidecar answers a create with. Note: no id field, no status. */
function createdBody(): Record<string, unknown> {
  return { request_id: REQUEST_ID, target: "https://example.test/watch?v=abc" };
}

/** What the sidecar answers a progress poll with. Note: no id field. */
function progressBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "downloading", message: "42.0% of 4.20MiB", progress: 0.42, ...overrides };
}

// ---------------------------------------------------------------------------
// The status strings, which are the thing most easily got wrong
// ---------------------------------------------------------------------------

describe("statuses", () => {
  test("terminal is complete or failed - not `done`, not `error`", () => {
    expect(isDownloaderTerminal("complete")).toBe(true);
    expect(isDownloaderTerminal("failed")).toBe(true);
    expect(isDownloaderTerminal("queued")).toBe(false);
    expect(isDownloaderTerminal("fetching")).toBe(false);
    expect(isDownloaderTerminal("downloading")).toBe(false);
    // The two spellings an earlier draft of this SDK used. A loop that waits
    // for either of these never ends.
    expect(isDownloaderTerminal("done")).toBe(false);
    expect(isDownloaderTerminal("error")).toBe(false);
  });

  test("progress is scaled from the sidecar's fraction to the SDK's percentage", () => {
    expect(downloaderProgress({ id: REQUEST_ID, status: "downloading", progress: 0.42 })).toEqual({
      phase: "download",
      loaded: 42,
      total: 100,
      status: "downloading",
    });
  });

  test("a job with no numbers yet reports no denominator, and reads as queued", () => {
    expect(downloaderProgress({ id: REQUEST_ID })).toEqual({
      phase: "download",
      loaded: 0,
      total: undefined,
      status: "queued",
    });
  });
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

describe("preview", () => {
  test("posts the URL and hands the sidecar's payload straight back", async () => {
    const { downloader, calls } = harness(() =>
      json(200, {
        kind: "track",
        title: "Homem do Leme",
        artist: "Xutos & Pontapes",
        duration_s: 241,
        webpage_url: "https://example.test/watch?v=abc",
        formats: [{ format_id: "137", ext: "mp4", height: 1080, has_audio: false }],
      }),
    );

    const preview = await downloader.preview("https://example.test/watch?v=abc");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/tools_downloader/preview");
    expect(calls[0]!.body).toEqual({ url: "https://example.test/watch?v=abc" });
    expect(preview.kind).toBe("track");
    // `duration_s`, not `duration`: the payload has no `duration` on it at all.
    expect(preview.duration_s).toBe(241);
    expect(preview.formats).toHaveLength(1);
  });

  test("a playlist comes back as its own shape, told apart by `kind`", async () => {
    const { downloader } = harness(() =>
      json(200, {
        kind: "playlist",
        title: "Melhores de sempre",
        count: 2,
        tracks: [
          { title: "Um", webpage_url: "https://example.test/1" },
          { title: "Dois", webpage_url: "https://example.test/2" },
        ],
      }),
    );

    const preview = await downloader.preview("https://example.test/list");

    expect(preview.kind).toBe("playlist");
    expect(preview.count).toBe(2);
    expect(preview.tracks).toHaveLength(2);
    expect(preview.formats).toBeUndefined();
  });

  test("is NOT retried: a 502 here means the source refused, which no replay fixes", async () => {
    const { downloader, calls } = harness(() => json(502, { error: "Unsupported URL" }));

    const failure = await downloader.preview("https://example.test/nope").catch((t: unknown) => t);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  test("the SSRF guard's refusal arrives as a plain 400", async () => {
    const { downloader } = harness(() => json(400, { error: "url is not allowed" }));

    const failure = await downloader.preview("http://127.0.0.1:8080/admin").catch((t: unknown) => t);

    expect((failure as OmsApiError).status).toBe(400);
  });

  test("carries the bearer token: this tool has no anonymous door", async () => {
    const { downloader, calls } = harness(() => json(200, { kind: "track" }));

    await downloader.preview("https://example.test/x");

    expect(calls[0]!.headers["authorization"]).toBe("Bearer secret-session-token");
  });
});

describe("artworkSearch", () => {
  test("unwraps the `items` envelope and omits the keys the caller left out", async () => {
    const { downloader, calls } = harness(() =>
      json(200, {
        items: [
          { url: "https://cdn.test/a.jpg", thumb_url: "https://cdn.test/a-300.jpg", source: "itunes", width: 3000 },
          { url: "https://cdn.test/b.jpg", source: "deezer", width: null, height: null },
        ],
      }),
    );

    const found = await downloader.artworkSearch({ artist: "Xutos", title: "Homem do Leme" });

    expect(calls[0]!.path).toBe("/tools_downloader/artwork_search");
    expect(calls[0]!.body).toEqual({ artist: "Xutos", title: "Homem do Leme" });
    expect(found).toHaveLength(2);
    expect(found[0]!.thumb_url).toBe("https://cdn.test/a-300.jpg");
    // A source that will not state its dimensions says null, which is not zero.
    expect(found[1]!.width).toBeNull();
  });

  test("an empty answer is an empty list, not undefined", async () => {
    const { downloader } = harness(() => json(200, { items: [] }));
    expect(await downloader.artworkSearch({ query: "algo que nao existe" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The job, and the id the sidecar does not send
// ---------------------------------------------------------------------------

describe("createJob", () => {
  test("maps the sidecar's `request_id` onto `id`, keeping both keys", async () => {
    const { downloader, calls } = harness(() => json(200, createdBody()));

    const job = await downloader.createJob({ sourceUrl: "https://example.test/watch?v=abc", kind: "audio" });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/tools_downloader/jobs");
    // Without this the record has no id at all and cannot be polled or downloaded.
    expect(job.id).toBe(REQUEST_ID);
    expect(job.request_id).toBe(REQUEST_ID);
    expect(job.target).toBe("https://example.test/watch?v=abc");
  });

  test("sends every option snake_cased, the way the controller permits them", async () => {
    const { downloader, calls } = harness(() => json(200, createdBody()));

    await downloader.createJob({
      artist: "Xutos",
      title: "Homem do Leme",
      album: "Circo de Feras",
      source: "youtube",
      kind: "video",
      formatId: "137",
      overrideTitle: "Homem do Leme (ao vivo)",
      overrideArtist: "Xutos & Pontapes",
      overrideAlbum: "Ao Vivo",
      artworkUrl: "https://cdn.test/a.jpg",
      artworkDataB64: "aGVsbG8=",
    });

    expect(calls[0]!.body).toEqual({
      artist: "Xutos",
      title: "Homem do Leme",
      album: "Circo de Feras",
      source: "youtube",
      kind: "video",
      format_id: "137",
      override_title: "Homem do Leme (ao vivo)",
      override_artist: "Xutos & Pontapes",
      override_album: "Ao Vivo",
      artwork_url: "https://cdn.test/a.jpg",
      artwork_data_b64: "aGVsbG8=",
    });
  });

  test("omits what was not given, so a URL job sends only the URL", async () => {
    const { downloader, calls } = harness(() => json(200, createdBody()));

    await downloader.createJob({ sourceUrl: "https://example.test/x" });

    expect(calls[0]!.body).toEqual({ source_url: "https://example.test/x" });
  });

  test("is NOT retried: a replay starts a second download whose id is unreachable", async () => {
    const { downloader, calls } = harness(() => json(502, { error: "sidecar refused" }));

    await downloader.createJob({ sourceUrl: "https://example.test/x" }).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  test("the hourly ceiling arrives as a 429", async () => {
    const { downloader } = harness(() => json(429, { error: "rate limited" }));

    const failure = await downloader.createJob({ sourceUrl: "https://example.test/x" }).catch((t: unknown) => t);

    expect((failure as OmsApiError).status).toBe(429);
  });
});

describe("getJob", () => {
  test("stamps the id back on, because the sidecar's progress payload has none", async () => {
    const { downloader, calls } = harness(() => json(200, progressBody()));

    const job = await downloader.getJob(REQUEST_ID);

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.path).toBe(`/tools_downloader/jobs/${REQUEST_ID}`);
    expect(job.id).toBe(REQUEST_ID);
    expect(job.status).toBe("downloading");
    expect(job.progress).toBe(0.42);
  });

  test("a swept job is a 404, not an empty record", async () => {
    const { downloader } = harness(() => json(404, { error: "unknown job" }));

    const failure = await downloader.getJob(REQUEST_ID).catch((t: unknown) => t);

    expect((failure as OmsApiError).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// run and wait
// ---------------------------------------------------------------------------

describe("run", () => {
  test("creates, then polls the sidecar directly - never /jobs", async () => {
    const { downloader, calls } = harness((_call, index) => {
      if (index === 0) return json(200, createdBody());
      if (index < 3) return json(200, progressBody());
      return json(200, {
        status: "complete",
        message: "saved Xutos - Homem do Leme.mp3",
        progress: 1.0,
        title: "Homem do Leme",
        uploader: "Xutos & Pontapes",
        duration_s: 241,
      });
    });

    const seen: Progress[] = [];
    const job = await downloader.run(
      { sourceUrl: "https://example.test/watch?v=abc" },
      { pollIntervalMs: 5, onProgress: (progress) => seen.push(progress) },
    );

    expect(job.status).toBe("complete");
    expect(job.id).toBe(REQUEST_ID);
    expect(job.title).toBe("Homem do Leme");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /tools_downloader/jobs",
      `GET /tools_downloader/jobs/${REQUEST_ID}`,
      `GET /tools_downloader/jobs/${REQUEST_ID}`,
      `GET /tools_downloader/jobs/${REQUEST_ID}`,
    ]);
    expect(calls.some((call) => call.path.startsWith("/jobs"))).toBe(false);

    // The create answer has no status, so the first report reads as queued.
    expect(seen[0]!.status).toBe("queued");
    expect(seen.at(-1)!).toMatchObject({ loaded: 100, total: 100, status: "complete" });
  });

  test("resolves with the failed job, because a source that refuses is an answer", async () => {
    const { downloader } = harness((_call, index) =>
      index === 0
        ? json(200, createdBody())
        : json(200, { status: "failed", message: "Sign in to confirm you are not a bot", progress: 0.0 }),
    );

    const job = await downloader.run({ sourceUrl: "https://example.test/x" }, { pollIntervalMs: 5 });

    expect(job.status).toBe("failed");
    // The reason lives in `message`, not in `error`.
    expect(job.message).toContain("not a bot");
  });

  test("a deadline gives up without cancelling the download", async () => {
    const { downloader } = harness((_call, index) =>
      index === 0 ? json(200, createdBody()) : json(200, progressBody()),
    );

    const failure = await downloader
      .run({ sourceUrl: "https://example.test/x" }, { pollIntervalMs: 15, waitTimeoutMs: 60 })
      .catch((t: unknown) => t);

    expect(failure).toBeInstanceOf(OmsTimeoutError);
    expect((failure as OmsTimeoutError).code).toBe("timeout");
    expect((failure as OmsTimeoutError).message).toContain(REQUEST_ID);
  });

  test("wait picks up a job started elsewhere without spending another of the 30", async () => {
    const { downloader, calls } = harness((_call, index) =>
      index < 1 ? json(200, progressBody()) : json(200, { status: "complete", progress: 1.0 }),
    );

    const job = await downloader.wait(REQUEST_ID, { pollIntervalMs: 5 });

    expect(job.status).toBe("complete");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The one-shot file
// ---------------------------------------------------------------------------

describe("download", () => {
  test("fetches through Rails WITH the bearer token: this is not a signed store link", async () => {
    const { downloader, calls } = harness(
      () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "content-disposition": 'attachment; filename="Xutos - Homem do Leme.mp3"',
          },
        }),
    );

    const blob = await downloader.download(REQUEST_ID);

    expect(blob.size).toBe(16);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/tools_downloader/jobs/${REQUEST_ID}/file`);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer secret-session-token");
  });

  test("downloadFile keeps the filename, which the job record never carries", async () => {
    const { downloader } = harness(
      () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "content-disposition": 'attachment; filename="Xutos - Homem do Leme.mp3"',
          },
        }),
    );

    const output = await downloader.downloadFile(REQUEST_ID);

    expect(output.filename).toBe("Xutos - Homem do Leme.mp3");
    expect(output.contentType).toBe("audio/mpeg");
    expect(output.size).toBe(16);
  });

  test("a job that is not finished is a 409, raised rather than waited on", async () => {
    const { downloader } = harness(() => json(409, { error: "not ready" }));

    const failure = await downloader.download(REQUEST_ID).catch((t: unknown) => t);

    expect((failure as OmsApiError).status).toBe(409);
  });

  test("is NOT retried: the sidecar deletes the file as it streams it, so a replay finds nothing", async () => {
    const { downloader, calls } = harness(() => json(502, { error: "upstream 410" }));

    await downloader.download(REQUEST_ID).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  test("a second call after a successful one is the 404 the one-shot rule predicts", async () => {
    const { downloader } = harness((_call, index) =>
      index === 0
        ? new Response(new Uint8Array(4), { status: 200, headers: { "content-type": "audio/mpeg" } })
        : json(404, { error: "unknown or expired job" }),
    );

    await downloader.download(REQUEST_ID);
    const failure = await downloader.download(REQUEST_ID).catch((t: unknown) => t);

    expect((failure as OmsApiError).status).toBe(404);
  });
});
