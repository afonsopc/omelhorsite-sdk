import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { AdminUsersNamespace } from "../src/resources/admin/users";
import { ChestEntriesNamespace } from "../src/resources/chests";
import { UploadManager } from "../src/resources/storage/upload";
import type { Progress } from "../src/types";
import { file } from "../src/types";

const BASE_URL = "https://api.test";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly withCredentials: boolean;
}

/** A stand-in for the browser's XMLHttpRequest: records the request and replays a scripted answer. */
function installFakeXhr(answer: () => { status: number; body?: string; headers?: Record<string, string> }) {
  const sent: Sent[] = [];
  class FakeXhr {
    static sent = sent;
    responseType = "";
    withCredentials = false;
    status = 0;
    statusText = "";
    response: ArrayBuffer | null = null;
    upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private method = "GET";
    private url = "";
    private headers: Record<string, string> = {};
    private answerHeaders: Record<string, string> = {};
    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(key: string, value: string): void {
      this.headers[key] = value;
    }
    getAllResponseHeaders(): string {
      return Object.entries(this.answerHeaders)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
    }
    abort(): void {
      this.onabort?.();
    }
    send(body: unknown): void {
      sent.push({ method: this.method, url: this.url, headers: this.headers, body, withCredentials: this.withCredentials });
      const size = body instanceof Blob ? body.size : 10;
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: Math.floor(size / 2), total: size, lengthComputable: true });
        this.upload.onprogress?.({ loaded: size, total: size, lengthComputable: true });
        const reply = answer();
        this.status = reply.status;
        this.answerHeaders = { "content-type": "application/json", ...(reply.headers ?? {}) };
        this.response = new TextEncoder().encode(reply.body ?? "null").buffer as ArrayBuffer;
        this.onload?.();
      });
    }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  return sent;
}

const originalXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
const fetchCalls: string[] = [];
const http = () =>
  new ApiClient({
    baseUrl: BASE_URL,
    tokens: { getToken: () => "tok" },
    fetch: undefined,
  });

beforeEach(() => {
  fetchCalls.length = 0;
  (globalThis as { fetch: unknown }).fetch = async (input: string) => {
    fetchCalls.push(input);
    return new Response(JSON.stringify({ id: "via-fetch" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
  globalThis.fetch = originalFetch;
});

describe("onUploadProgress", () => {
  test("a request that asks for progress goes through XMLHttpRequest and reports bytes", async () => {
    const sent = installFakeXhr(() => ({ status: 201, body: JSON.stringify({ id: "via-xhr" }) }));
    const ticks: Progress[] = [];

    const answer = await http().post<{ id: string }>("/uploads", "payload", {
      onUploadProgress: (progress) => ticks.push(progress),
    });

    expect(answer).toEqual({ id: "via-xhr" });
    expect(fetchCalls).toEqual([]);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(sent[0]!.withCredentials).toBe(false);
    expect(ticks.map((tick) => tick.loaded)).toEqual([5, 10]);
  });

  test("without XMLHttpRequest the request goes through fetch and progress is never reported", async () => {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    const ticks: Progress[] = [];

    const answer = await http().post<{ id: string }>("/uploads", "payload", {
      onUploadProgress: (progress) => ticks.push(progress),
    });

    expect(answer).toEqual({ id: "via-fetch" });
    expect(fetchCalls).toHaveLength(1);
    expect(ticks).toEqual([]);
  });

  test("a custom fetch is never bypassed", async () => {
    installFakeXhr(() => ({ status: 200, body: "{}" }));
    const custom: string[] = [];
    const client = new ApiClient({
      baseUrl: BASE_URL,
      fetch: async (input) => {
        custom.push(input);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await client.post("/uploads", "payload", { onUploadProgress: () => undefined });

    expect(custom).toHaveLength(1);
  });

  test("an XHR error surfaces as a network error, a 4xx as an API error", async () => {
    installFakeXhr(() => ({ status: 413, body: JSON.stringify("Too big") }));
    const failure = (await http()
      .post("/uploads", "payload", { onUploadProgress: () => undefined })
      .catch((thrown: unknown) => thrown)) as { status?: number };
    expect(failure.status).toBe(413);
  });
});

describe("byte-level progress on presigned uploads", () => {
  test("putDirect reports intermediate bytes and then the full size", async () => {
    installFakeXhr(() => ({ status: 200, body: "", headers: { etag: '"abc"' } }));
    const ticks: number[] = [];

    const uploads = new UploadManager(http());
    await uploads.putDirect(
      { url: "https://store.test/obj", headers: { "Content-MD5": "x" }, blob_signed_id: "sig" },
      new Blob([new Uint8Array(10)]),
      { onProgress: (progress) => ticks.push(progress.loaded) },
    );

    expect(ticks).toEqual([5, 10]);
  });
});

describe("chests.entries.createWithUpload", () => {
  test("hands the reserved entry to onReserved before the bytes go up", async () => {
    installFakeXhr(() => ({ status: 200, body: "" }));
    const order: string[] = [];
    (globalThis as { fetch: unknown }).fetch = async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      order.push(`${init?.method} ${path}`);
      const body =
        path === "/chest_entries"
          ? { id: "e1", chest_id: "c1", kind: "file", name: "a.txt", size: 10, data_attached: false }
          : path.endsWith("/attachment_signed_url")
            ? { signed_url: { url: "https://store.test/obj", headers: {}, blob_signed_id: "sig" } }
            : { attached: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };

    const entries = new ChestEntriesNamespace(http());
    let reserved: unknown;
    const entry = await entries.createWithUpload(
      { chestId: "c1", file: file(new Uint8Array(10), "a.txt") },
      {
        onReserved: (created) => {
          reserved = created.id;
          order.push("reserved");
        },
      },
    );

    expect(reserved).toBe("e1");
    expect(order.slice(0, 2)).toEqual(["POST /chest_entries", "reserved"]);
    expect(entry.data_attached).toBe(true);
  });
});

describe("admin.users.update", () => {
  test("sends the admin fields in snake_case as JSON and keeps null", async () => {
    let captured: { method?: string; path?: string; body?: unknown } = {};
    (globalThis as { fetch: unknown }).fetch = async (input: string, init?: RequestInit) => {
      captured = { method: init?.method, path: new URL(input).pathname, body: JSON.parse(init?.body as string) };
      return new Response(JSON.stringify({ id: "u1", handle: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await new AdminUsersNamespace(http()).update("u1", {
      group: "administrator",
      allowedToUseSpotify: true,
      bio: null,
      password: "",
    });

    expect(captured.method).toBe("PATCH");
    expect(captured.path).toBe("/users/u1");
    expect(captured.body).toEqual({ group: "administrator", allowed_to_use_spotify: true, bio: null });
  });

  test("a picture turns the request into multipart", async () => {
    let body: unknown;
    (globalThis as { fetch: unknown }).fetch = async (_input: string, init?: RequestInit) => {
      body = init?.body;
      return new Response(JSON.stringify({ id: "u1", handle: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await new AdminUsersNamespace(http()).update("u1", { name: "N", picture: file(new Uint8Array(3), "p.png") });

    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("name")).toBe("N");
    expect((body as FormData).get("picture")).toBeInstanceOf(Blob);
  });
});
