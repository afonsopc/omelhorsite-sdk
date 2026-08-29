/**
 * `bun test` coverage for the `media` namespace.
 *
 * Four things here are load-bearing, and all four have burned a client before:
 *
 *  1. **the canonical route is `/media/*`.** The SDK used to expose only
 *     `/fs_nodes/:id/data_url`, which the backend's own comment calls "a
 *     temporary numeric-id alias for the web frontend". The native app has
 *     always called `/media/*`, so the SDK could not serve it. Every method is
 *     asserted on the exact path it produces.
 *  2. **`data` is rate-limit exempt, `data_url` is not.** That is a property of
 *     a regex in `rack_attack.rb`, so the regex itself is copied in here and
 *     the paths the SDK builds are run against it. A path shape that stops
 *     matching stops being exempt in silence.
 *  3. **404 never means 401 on these routes.** `isMediaMissing` must not be
 *     usable as "this file is gone", because a lapsed session produces the
 *     identical answer.
 *  4. **the token-mode URL carries a live credential** and the cookie-mode one
 *     must not carry anything at all.
 */

import { describe, expect, test } from "bun:test";

import { OmsApiError, OmsAuthError, OmsError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  MEDIA_REDIRECT_CACHE_TTL_MS,
  MEDIA_URL_TTL_MS,
  MediaNamespace,
  firstMediaId,
  isMediaId,
  isMediaMissing,
} from "../src/resources/media";

const BASE_URL = "https://api.test";
const MEDIA_ID = "48211";
const PRESIGNED = "https://minio.test/oms/48211?X-Amz-Signature=deadbeef";

interface Harness {
  readonly media: MediaNamespace;
  /** Pathname of every request, in order. */
  readonly paths: string[];
  /** Full URL of every request, in order - the query string matters here. */
  readonly urls: string[];
  /** `Authorization` header of every request, in order. */
  readonly auth: (string | null)[];
}

interface HarnessOptions {
  /** `null` builds a cookie-mode client (no token provider at all). */
  readonly token?: string | null;
  /** Answer for each request, in order; the last one repeats. */
  readonly responses?: (() => Response)[];
}

function harness(options: HarnessOptions = {}): Harness {
  const paths: string[] = [];
  const urls: string[] = [];
  const auth: (string | null)[] = [];
  const responses = options.responses ?? [() => json({ url: PRESIGNED })];
  let call = 0;

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    urls.push(input);
    paths.push(new URL(input).pathname);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    auth.push(headers.get("authorization"));
    const responder = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return responder!();
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    retry: false,
    ...(options.token === null
      ? { sessionCookie: true }
      : { tokens: { getToken: () => options.token ?? "sess-token" } }),
  });
  return { media: new MediaNamespace(http), paths, urls, auth };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("the canonical routes", () => {
  test("url is /media/:id/data and carries no credential", () => {
    const { media } = harness();

    expect(media.url(MEDIA_ID)).toBe(`${BASE_URL}/media/48211/data`);
  });

  test("dataUrl asks /media/:id/data_url, not the fs_nodes alias", async () => {
    const { media, paths } = harness();

    expect(await media.dataUrl(MEDIA_ID)).toBe(PRESIGNED);
    expect(paths).toEqual(["/media/48211/data_url"]);
  });

  test("a fresh signature comes back on every resolve, so callers must key by id", async () => {
    const { media } = harness({
      responses: [() => json({ url: `${PRESIGNED}-first` }), () => json({ url: `${PRESIGNED}-second` })],
    });

    expect(await media.dataUrl(MEDIA_ID)).not.toBe(await media.dataUrl(MEDIA_ID));
  });

  test("an id is encoded rather than pasted into the path", () => {
    const { media } = harness();

    expect(media.url("../fs_nodes/other")).toBe(`${BASE_URL}/media/..%2Ffs_nodes%2Fother/data`);
  });

  test("the six-hour and five-minute windows are the backend's, not a guess", () => {
    expect(MEDIA_URL_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(MEDIA_REDIRECT_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    // The cached redirect must always point at a signature with life left.
    expect(MEDIA_REDIRECT_CACHE_TTL_MS).toBeLessThan(MEDIA_URL_TTL_MS);
  });
});

describe("the temporary /fs_nodes alias", () => {
  test("aliasUrl and aliasDataUrl keep the old spelling exactly", async () => {
    const { media, paths } = harness();

    expect(media.aliasUrl(MEDIA_ID)).toBe(`${BASE_URL}/fs_nodes/48211/data`);
    expect(await media.aliasDataUrl(MEDIA_ID)).toBe(PRESIGNED);
    expect(paths).toEqual(["/fs_nodes/48211/data_url"]);
  });

  test("the alias is a different path from the canonical route, never a rewrite of it", () => {
    const { media } = harness();

    expect(media.aliasUrl(MEDIA_ID)).not.toBe(media.url(MEDIA_ID));
  });

  test("isMediaId matches the digits-only branch the alias controller takes", () => {
    // Digits reach MusicMediaServing through FsNodesController#data.
    expect(isMediaId("48211")).toBe(true);
    expect(isMediaId("0")).toBe(true);
    // Everything else is looked up as a storage node instead.
    expect(isMediaId("8b1f0c0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e")).toBe(false);
    expect(isMediaId("48211 ")).toBe(false);
    expect(isMediaId("-1")).toBe(false);
    expect(isMediaId("")).toBe(false);
    expect(isMediaId(48211)).toBe(false);
    expect(isMediaId(null)).toBe(false);
  });
});

describe("the rate ceilings", () => {
  /**
   * `Rack::Attack::GENERAL_EXEMPT_PATHS`, transliterated from
   * `config/initializers/rack_attack.rb` (Ruby's start/end anchors become
   * `^` and `$`). It is matched against a NORMALISED path with the format
   * suffix stripped, so the query string never enters into it.
   */
  const EXEMPT =
    /^\/(cable|up)\b|^\/rails\/active_storage\/|^\/fs_nodes\/[^/]+\/(data|zip)$|^\/media\/[^/]+\/data$|^\/books\/[^/]+\/file$|^\/assistant\/auth\//;

  const pathOf = (url: string): string => new URL(url).pathname;

  test("the bytes routes are exempt from the 600/min and 120/min ceilings", async () => {
    const { media } = harness();

    expect(EXEMPT.test(pathOf(media.url(MEDIA_ID)))).toBe(true);
    expect(EXEMPT.test(pathOf(await media.authenticatedUrl(MEDIA_ID)))).toBe(true);
    expect(EXEMPT.test(pathOf(media.aliasUrl(MEDIA_ID)))).toBe(true);
  });

  test("BOTH data_url routes count against the ceiling", async () => {
    const { media, urls } = harness({ responses: [() => json({ url: PRESIGNED })] });

    await media.dataUrl(MEDIA_ID);
    await media.aliasDataUrl(MEDIA_ID);

    for (const url of urls) expect(EXEMPT.test(pathOf(url))).toBe(false);
    expect(urls).toHaveLength(2);
  });
});

describe("authenticatedUrl", () => {
  test("token mode puts the live session token in the query string", async () => {
    const { media } = harness({ token: "sess-token" });

    expect(await media.authenticatedUrl(MEDIA_ID)).toBe(`${BASE_URL}/media/48211/data?token=sess-token`);
  });

  test("a token with URL-significant characters is encoded", async () => {
    const { media } = harness({ token: "a+b/c=d&e" });

    const url = await media.authenticatedUrl(MEDIA_ID);

    expect(new URL(url).searchParams.get("token")).toBe("a+b/c=d&e");
    expect(url).not.toContain("&e=");
  });

  test("cookie mode adds nothing: the browser attaches oms_session itself", async () => {
    const { media } = harness({ token: null });

    expect(await media.authenticatedUrl(MEDIA_ID)).toBe(`${BASE_URL}/media/48211/data`);
  });

  test("a token provider that throws degrades to a bare URL rather than to a wrong one", async () => {
    const http = new ApiClient({
      baseUrl: BASE_URL,
      fetch: async () => json({}),
      tokens: {
        getToken: () => {
          throw new Error("keychain locked");
        },
      },
    });

    expect(await new MediaNamespace(http).authenticatedUrl(MEDIA_ID)).toBe(`${BASE_URL}/media/48211/data`);
  });

  test("the JSON call still authenticates by header, not by query string", async () => {
    const { media, urls, auth } = harness({ token: "sess-token" });

    await media.dataUrl(MEDIA_ID);

    expect(auth).toEqual(["Bearer sess-token"]);
    expect(urls[0]).not.toContain("token=");
  });
});

describe("404 is not the same claim as gone", () => {
  test("an unknown, a foreign and an unauthenticated id are one indistinguishable 404", async () => {
    for (const body of ["Not found", null]) {
      const { media } = harness({ responses: [() => json(body, 404)] });

      const thrown = await media.dataUrl(MEDIA_ID).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(OmsApiError);
      expect((thrown as OmsApiError).status).toBe(404);
      expect(isMediaMissing(thrown)).toBe(true);
    }
  });

  test("the routes never answer 401, so a 401 from elsewhere is not a media miss", () => {
    const unauthorized = new OmsAuthError("Session required to access this resource.", {
      status: 401,
      body: "Session required to access this resource.",
      method: "GET",
      url: `${BASE_URL}/account`,
      attempts: 1,
    });

    expect(isMediaMissing(unauthorized)).toBe(false);
  });

  test("an OAuth token is refused with 403 insufficient_scope, which is not a miss either", async () => {
    const { media } = harness({
      responses: [
        () =>
          json(
            {
              error: "insufficient_scope",
              message: "This endpoint is not reachable with an OAuth access token.",
            },
            403,
          ),
      ],
    });

    const thrown = await media.dataUrl(MEDIA_ID).catch((error: unknown) => error);

    expect((thrown as OmsApiError).status).toBe(403);
    expect(isMediaMissing(thrown)).toBe(false);
  });

  test("isMediaMissing says nothing about a network fault or a random value", () => {
    expect(isMediaMissing(new Error("offline"))).toBe(false);
    expect(isMediaMissing(undefined)).toBe(false);
    expect(isMediaMissing(404)).toBe(false);
  });
});

describe("download", () => {
  test("reads the bytes the redirect (or the dev-mode fallback) produced", async () => {
    const { media, paths } = harness({
      responses: [
        () =>
          new Response("ID3-and-then-some-bytes", {
            status: 200,
            headers: {
              "content-type": "audio/mpeg",
              "content-disposition": 'attachment; filename="track.mp3"',
            },
          }),
      ],
    });

    const file = await media.download(MEDIA_ID);

    expect(paths).toEqual(["/media/48211/data"]);
    expect(file.filename).toBe("track.mp3");
    expect(file.contentType).toBe("audio/mpeg");
    expect(file.size).toBeGreaterThan(0);
  });

  test("a browser in cookie mode gets the CORS explanation, not a bare network error", async () => {
    const http = new ApiClient({
      baseUrl: BASE_URL,
      sessionCookie: true,
      retry: false,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const thrown = await new MediaNamespace(http).download(MEDIA_ID).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(OmsError);
    expect((thrown as OmsError).code).toBe("unsupported");
    expect((thrown as OmsError).message).toContain("oms.media.dataUrl");
  });

  test("a token client keeps the real network error instead of blaming CORS", async () => {
    const http = new ApiClient({
      baseUrl: BASE_URL,
      retry: false,
      tokens: { getToken: () => "sess-token" },
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const thrown = await new MediaNamespace(http).download(MEDIA_ID).catch((error: unknown) => error);

    expect((thrown as OmsError).code).not.toBe("unsupported");
  });
});

describe("firstMediaId", () => {
  test("prefers the compressed twin and falls back to the original", () => {
    expect(firstMediaId("101", "202")).toBe("101");
    expect(firstMediaId(null, "202")).toBe("202");
  });

  test("treats an empty string as absent, so no request is built for a bare /media//data", () => {
    expect(firstMediaId("", "202")).toBe("202");
    expect(firstMediaId("", null, undefined)).toBeNull();
  });

  test("answers null rather than undefined when a record carries no artwork at all", () => {
    expect(firstMediaId(null, null)).toBeNull();
    expect(firstMediaId()).toBeNull();
  });
});
