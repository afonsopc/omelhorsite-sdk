/**
 * `bun test` coverage for the three places the transport stops being the same
 * on React Native, plus the one place iOS breaks a URL that every other client
 * accepts.
 *
 * The theme is the same as `wire-format.test.ts`: none of these failures throw
 * on their own. A native file descriptor handed to a web `FormData` uploads the
 * text `"[object Object]"` and gets a `200`. A streaming reader that RN cannot
 * provide leaves a chat panel spinning rather than erroring. A raw `[` in a
 * query comes back as an empty list on iPhones and a correct list everywhere
 * the developer is looking. Only a test that reads the wire notices any of it.
 *
 * The reference points are the app's own code, not a guess about RN:
 * `oms-music/src/features/settings/pickers.ts` and
 * `features/playlist/artworkPicker.ts` for the picked shape,
 * `src/api/endpoints/artists.ts` for how it is uploaded today, and
 * `src/api/retryPolicy.ts` for the rule the app retries by. RN's own
 * `FormData` is stubbed here rather than imported, because a package that has
 * to load in a Cloudflare isolate cannot depend on `react-native`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  ApiClient,
  buildFormData,
  encodeQuery,
  isFileInput,
  supportsNativeFormDataFiles,
  supportsResponseStreaming,
  supportsUploadProgress,
  transportCapabilities,
} from "../src/http";
import { OmsApiError, OmsTimeoutError } from "../src/errors";
import { file, isNativeFile, readFileInput, type NativeFile } from "../src/types";

const BASE_URL = "https://api.test";

/**
 * React Native's `FormData`, reduced to the two facts the SDK depends on: it
 * keeps a value exactly as it was given, and it exposes `getParts()`, which is
 * what marks it as the native one.
 *
 * The web `FormData` differs on both counts, and that difference is the entire
 * bug this file exists to pin: `append(name, {uri, name, type})` on the web
 * stores the string `"[object Object]"`.
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

/** Globals swapped for one test, restored whatever happens. */
const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function swapGlobal(name: string, value: unknown): void {
  const bag = globalThis as unknown as Record<string, unknown>;
  const had = name in bag;
  const previous = bag[name];
  restores.push(() => {
    if (had) bag[name] = previous;
    else delete bag[name];
  });
  bag[name] = value;
}

/** Runs the rest of the test as though it were on a phone. */
function pretendReactNative(): void {
  swapGlobal("FormData", ReactNativeFormData);
}

/** A file as `expo-file-system`'s picker hands it over. */
function pickedImage(overrides: Partial<NativeFile> = {}): NativeFile {
  return { uri: "file:///var/mobile/Containers/Data/tmp/artwork.jpg", name: "artwork.jpg", type: "image/jpeg", ...overrides };
}

describe("native file descriptors", () => {
  test("a picked file is appended to the form as the very same object", async () => {
    pretendReactNative();
    const picked = pickedImage({ size: 84_213 });

    const form = (await buildFormData({ image: picked })) as unknown as ReactNativeFormData;

    expect(form.entries).toHaveLength(1);
    expect(form.entries[0]?.name).toBe("image");
    // Identity, not equality. Anything that rebuilt the object - a spread, a
    // Blob conversion, a "normalisation" - would pass a deep-equal check and
    // still risk dropping the field RN reads.
    expect(form.entries[0]?.value).toBe(picked);
  });

  test("size and any other picker field survive, because RN spreads the object", async () => {
    pretendReactNative();
    const form = (await buildFormData({ image: pickedImage({ size: 12 }) })) as unknown as ReactNativeFormData;
    expect(form.entries[0]?.value).toEqual({
      uri: "file:///var/mobile/Containers/Data/tmp/artwork.jpg",
      name: "artwork.jpg",
      type: "image/jpeg",
      size: 12,
    });
  });

  test("a content:// pick with no mime type is still accepted", async () => {
    pretendReactNative();
    const picked = { uri: "content://media/external/audio/media/1042", name: "take-3.m4a" };
    const form = (await buildFormData({ audio: picked })) as unknown as ReactNativeFormData;
    expect(form.entries[0]?.value).toBe(picked);
  });

  test("array fields keep the [] suffix Rails reads, one part per file", async () => {
    pretendReactNative();
    const first = pickedImage({ name: "a.jpg" });
    const second = pickedImage({ name: "b.jpg" });

    const form = (await buildFormData({ clips: [first, second] })) as unknown as ReactNativeFormData;

    expect(form.entries.map((entry) => entry.name)).toEqual(["clips[]", "clips[]"]);
    expect(form.entries[0]?.value).toBe(first);
    expect(form.entries[1]?.value).toBe(second);
  });

  test("wrapping one in a FileInput renames it, and does NOT turn it into bytes", async () => {
    pretendReactNative();
    const form = (await buildFormData({
      image: file(pickedImage({ name: "IMG_0421.HEIC", type: "image/heic" }), "cover.jpg", {
        contentType: "image/jpeg",
      }),
    })) as unknown as ReactNativeFormData;

    expect(form.entries[0]?.value).toEqual({
      uri: "file:///var/mobile/Containers/Data/tmp/artwork.jpg",
      name: "cover.jpg",
      type: "image/jpeg",
    });
  });

  test("an empty mime type on a wrapped descriptor is dropped, not sent as \"\"", async () => {
    pretendReactNative();
    const form = (await buildFormData({
      audio: file({ uri: "content://x/1", name: "x", type: "" }, "take.m4a"),
    })) as unknown as ReactNativeFormData;
    expect(form.entries[0]?.value).toEqual({ uri: "content://x/1", name: "take.m4a" });
  });

  test("postForm carries it through the transport with no Content-Type of ours", async () => {
    pretendReactNative();
    const picked = pickedImage();
    let sent: RequestInit | undefined;

    const http = new ApiClient({
      baseUrl: BASE_URL,
      tokens: { getToken: () => "t" },
      fetch: async (_input, init) => {
        sent = init;
        return new Response(JSON.stringify({ id: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await http.postForm("/artists/7/upload_image", { image: picked });

    const body = sent?.body as unknown as ReactNativeFormData;
    expect(body).toBeInstanceOf(ReactNativeFormData);
    expect(body.entries[0]?.value).toBe(picked);
    // The runtime writes the boundary. A Content-Type of ours would not match it.
    const headers = sent?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
    expect(headers["Authorization"]).toBe("Bearer t");
  });

  test("off React Native it is refused rather than uploaded as \"[object Object]\"", async () => {
    // No swap: this runtime has the web FormData, like the browser and the CLI.
    expect(supportsNativeFormDataFiles()).toBe(false);
    await expect(buildFormData({ image: pickedImage() })).rejects.toThrow(TypeError);
    await expect(buildFormData({ image: pickedImage() })).rejects.toThrow(/\[object Object\]/);
  });

  test("bytes still take the Blob path on React Native", async () => {
    pretendReactNative();
    const form = (await buildFormData({
      audio: file(new Uint8Array([1, 2, 3]), "take.wav", { contentType: "audio/wav" }),
      title: "Take 3",
      retries: 2,
    })) as unknown as ReactNativeFormData;

    expect(form.entries[0]?.value).toBeInstanceOf(Blob);
    expect(form.entries[1]?.value).toBe("Take 3");
    expect(form.entries[2]?.value).toBe("2");
  });

  test("an object that is neither a file nor a primitive throws instead of stringifying", async () => {
    pretendReactNative();
    // A descriptor that lost its `name` on the way in: the shape RN would
    // accept as an entry and then send as a nameless part.
    await expect(buildFormData({ image: { uri: "file:///x.jpg" } as never })).rejects.toThrow(TypeError);
  });

  test("null and undefined fields are still omitted, on every runtime", async () => {
    pretendReactNative();
    const form = (await buildFormData({ image: null, banner: undefined })) as unknown as ReactNativeFormData;
    expect(form.entries).toHaveLength(0);
  });
});

describe("recognising a descriptor", () => {
  test("isNativeFile wants a uri AND a name, and tolerates a missing type", () => {
    expect(isNativeFile(pickedImage())).toBe(true);
    expect(isNativeFile({ uri: "file:///x", name: "x" })).toBe(true);
    expect(isNativeFile({ uri: "file:///x", name: "x", type: 7 })).toBe(false);
    expect(isNativeFile({ uri: "file:///x" })).toBe(false);
    expect(isNativeFile({ name: "x" })).toBe(false);
    expect(isNativeFile({ uri: "", name: "x" })).toBe(false);
    expect(isNativeFile(null)).toBe(false);
    expect(isNativeFile("file:///x")).toBe(false);
    expect(isNativeFile(new Blob(["x"]))).toBe(false);
  });

  test("a FileInput wrapping a descriptor is still a FileInput", () => {
    expect(isFileInput(file(pickedImage(), "cover.jpg"))).toBe(true);
    expect(isFileInput(pickedImage())).toBe(false);
    expect(isFileInput(file(new Uint8Array([1]), "a.bin"))).toBe(true);
  });

  test("readFileInput refuses a descriptor and says where the bytes come from", async () => {
    const wrapped = file(pickedImage(), "cover.jpg");
    await expect(readFileInput(wrapped)).rejects.toThrow(TypeError);
    // The message has to name the way out, because the caller that hits this is
    // the storage direct-upload driver and its alternative is a native uploader.
    await expect(readFileInput(wrapped)).rejects.toThrow(/bytes\(\)|native uploader/);
  });

  test("readFileInput is unchanged for real bytes", async () => {
    const { blob, filename, contentType } = await readFileInput(
      file(new Uint8Array([1, 2, 3]), "take.wav", { contentType: "audio/wav" }),
    );
    expect(await blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    expect(filename).toBe("take.wav");
    expect(contentType).toBe("audio/wav");
  });
});

describe("capability detection", () => {
  test("this runtime (Bun) streams responses and cannot report upload bytes", () => {
    expect(transportCapabilities()).toEqual({
      responseStreaming: true,
      uploadProgress: typeof (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest === "function",
      nativeFormDataFiles: false,
    });
  });

  test("no ReadableStream means no streaming, which is React Native's answer", () => {
    swapGlobal("ReadableStream", undefined);
    expect(supportsResponseStreaming()).toBe(false);
  });

  test("no TextDecoder means no streaming either: chunks could not be decoded", () => {
    swapGlobal("TextDecoder", undefined);
    expect(supportsResponseStreaming()).toBe(false);
  });

  test("XHR is what upload progress needs, and it is the host's, never ours", () => {
    swapGlobal("XMLHttpRequest", function FakeXhr(): void {});
    expect(supportsUploadProgress()).toBe(true);
    swapGlobal("XMLHttpRequest", undefined);
    expect(supportsUploadProgress()).toBe(false);
  });

  test("navigator.product is honoured as the second opinion on RN", () => {
    expect(supportsNativeFormDataFiles()).toBe(false);
    swapGlobal("navigator", { product: "ReactNative" });
    expect(supportsNativeFormDataFiles()).toBe(true);
  });

  test("a getParts on FormData.prototype is the first opinion", () => {
    pretendReactNative();
    expect(supportsNativeFormDataFiles()).toBe(true);
  });
});

/** A client whose fetch answers with one prepared response. */
function streaming(response: Response | (() => Response)): ApiClient {
  return new ApiClient({
    baseUrl: BASE_URL,
    fetch: async () => (typeof response === "function" ? response() : response),
  });
}

/** Collects everything a generator yields. */
async function drain(chunks: AsyncGenerator<string, void, undefined>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

describe("streamText", () => {
  test("yields each network chunk as it lands where the runtime can", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"Ol"}\n'));
        controller.enqueue(new TextEncoder().encode('data: {"delta":"a"}\n'));
        controller.close();
      },
    });
    const http = streaming(new Response(body, { status: 200 }));

    const chunks = await drain(http.streamText("POST", "/books/1/chat", { body: { messages: [] } }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe('data: {"delta":"Ol"}\ndata: {"delta":"a"}\n');
  });

  test("a multi-byte character split across two chunks decodes once, not twice", async () => {
    const bytes = new TextEncoder().encode("café");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // The two bytes of "é" land in different network chunks.
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });

    const chunks = await drain(streaming(new Response(body)).streamText("GET", "/x"));

    expect(chunks.join("")).toBe("café");
    expect(chunks.join("")).not.toContain("�");
  });

  test("falls back to one whole-body yield when the runtime cannot stream", async () => {
    const http = streaming(new Response('data: {"delta":"tudo de uma vez"}\n', { status: 200 }));
    // What a phone has: no ReadableStream anywhere in the runtime.
    swapGlobal("ReadableStream", undefined);

    const chunks = await drain(http.streamText("POST", "/books/1/chat", { body: {} }));

    expect(chunks).toEqual(['data: {"delta":"tudo de uma vez"}\n']);
  });

  test("a response with no readable body takes the same buffered path", async () => {
    const fake = {
      ok: true,
      status: 200,
      body: null,
      headers: new Headers(),
      text: async () => "everything",
    } as unknown as Response;

    const chunks = await drain(streaming(fake).streamText("GET", "/x"));

    expect(chunks).toEqual(["everything"]);
  });

  test("an empty body yields nothing at all rather than one empty string", async () => {
    const fake = {
      ok: true,
      status: 200,
      body: null,
      headers: new Headers(),
      text: async () => "",
    } as unknown as Response;

    expect(await drain(streaming(fake).streamText("GET", "/x"))).toEqual([]);
  });

  test("silence has a limit: a server that answers 200 and then stops is a timeout", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first token, then nothing\n"));
        // Never closed. This is the stalled sidecar.
      },
    });
    const http = streaming(new Response(body, { status: 200 }));

    const run = drain(http.streamText("GET", "/books/1/chat", { silenceTimeoutMs: 25 }));

    await expect(run).rejects.toThrow(OmsTimeoutError);
    await expect(run).rejects.toThrow(/went quiet/);
  });

  test("the reader is released when the caller walks away mid-stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one"));
        controller.enqueue(new TextEncoder().encode("two"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const chunk of streaming(new Response(body)).streamText("GET", "/x")) {
      expect(chunk).toBe("one");
      break; // an abandoned reader holds the connection open
    }

    expect(cancelled).toBe(true);
  });

  test("a failed request throws before anything is yielded", async () => {
    const http = streaming(
      new Response(JSON.stringify("Rate limit exceeded"), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(drain(http.streamText("POST", "/books/1/chat", { retry: false }))).rejects.toThrow(OmsApiError);
  });
});

describe("query encoding survives Apple's URL stack", () => {
  test("brackets are percent-encoded", () => {
    expect(encodeQuery({ search: { title: "coisa" } })).toBe("search%5Btitle%5D=coisa");
    expect(encodeQuery({ ids: [1, 2] })).toBe("ids%5B%5D=1&ids%5B%5D=2");
    expect(encodeQuery({ modifiers: { page: "2:100" } })).toBe("modifiers%5Bpage%5D=2%3A100");
  });

  test("no raw bracket reaches the wire, at any nesting depth", () => {
    const encoded = encodeQuery({
      search: { title: "café" },
      exact_search: { parent_id: null, tags: ["a", "b"] },
      modifiers: { page: "1:50", order: "created_at:desc" },
    });

    // NSURL re-encodes the WHOLE query when it finds a character that is not
    // legal there, turning every % already in it into %25. One raw bracket is
    // enough to corrupt every other value on the way past.
    expect(encoded).not.toContain("[");
    expect(encoded).not.toContain("]");
    expect(encoded).toContain("search%5Btitle%5D=caf%C3%A9");
  });

  test("an already-encoded value is not double-encoded on the way out", () => {
    // What a re-encoding pass would produce: %C3%A9 becoming %25C3%25A9, which
    // the server then searches for as the literal text "caf%C3%A9".
    expect(encodeQuery({ search: { title: "café" } })).not.toContain("%25");
  });

  test("the assembled URL is bracket-free too, not just the query fragment", () => {
    const http = new ApiClient({ baseUrl: BASE_URL, fetch: async () => new Response("[]") });
    const url = http.url("/songs", { search: { title: "a" }, ids: [1] });
    expect(url).toBe(`${BASE_URL}/songs?search%5Btitle%5D=a&ids%5B%5D=1`);
    expect(url.slice(BASE_URL.length)).not.toMatch(/[[\]]/);
  });
});

/** A fetch double that answers from a script and refuses an unscripted attempt. */
function scripted(script: Array<() => Response>): { http: ApiClient; calls: () => number } {
  let calls = 0;
  const http = new ApiClient({
    baseUrl: BASE_URL,
    retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    fetch: async () => {
      const step = script[calls];
      calls += 1;
      if (step === undefined) throw new Error(`Unscripted attempt #${calls}`);
      return step();
    },
  });
  return { http, calls: () => calls };
}

const boom = (): Response => {
  throw new TypeError("Network request failed");
};

const serverError = (): Response => new Response(JSON.stringify("boom"), { status: 503 });

describe("retry policy against the app's rule", () => {
  test("a 4xx is never repeated, which is the half both policies agree on", async () => {
    const { http, calls } = scripted([() => new Response(JSON.stringify("Song not found"), { status: 404 })]);
    await expect(http.get("/songs/1")).rejects.toThrow(OmsApiError);
    expect(calls()).toBe(1);
  });

  test("a transport failure on a READ is repeated, as the app does", async () => {
    const { http, calls } = scripted([boom, () => new Response("[]", { headers: { "content-type": "application/json" } })]);
    expect(await http.get<string[]>("/songs")).toEqual([]);
    expect(calls()).toBe(2);
  });

  test("a transport failure on a WRITE is NOT repeated, which is where we diverge", async () => {
    // The app's predicate would retry this: it only ever guards react-query
    // reads, so "any transport error" is safe there and would duplicate a
    // record here.
    const { http, calls } = scripted([boom]);
    await expect(http.post("/songs", { name: "x" })).rejects.toThrow();
    expect(calls()).toBe(1);
  });

  test("a 5xx on a read is repeated; on a write it is not", async () => {
    const read = scripted([serverError, () => new Response("[]", { headers: { "content-type": "application/json" } })]);
    expect(await read.http.get<string[]>("/songs")).toEqual([]);
    expect(read.calls()).toBe(2);

    const write = scripted([serverError]);
    await expect(write.http.post("/songs", {})).rejects.toThrow(OmsApiError);
    expect(write.calls()).toBe(1);
  });

  test("maxAttempts 2 reproduces the app's shape: one extra go, reads only", async () => {
    let calls = 0;
    const http = new ApiClient({
      baseUrl: BASE_URL,
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      fetch: async () => {
        calls += 1;
        return serverError();
      },
    });

    await expect(http.get("/songs")).rejects.toThrow(OmsApiError);
    expect(calls).toBe(2);
  });

  test("a 429 IS repeated on a write, and that is the deliberate divergence", async () => {
    // Safe because this backend produces a 429 from Rack::Attack or from a
    // too_many_requests! guard placed ahead of the write, so the request
    // provably did not happen. The app declines the retry for a UI reason, not
    // a correctness one.
    const { http, calls } = scripted([
      () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "retry-after": "0" } }),
      () => new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { "content-type": "application/json" } }),
    ]);

    expect(await http.post<{ id: number }>("/songs", {})).toEqual({ id: 1 });
    expect(calls()).toBe(2);
  });
});
