/**
 * `bun test` coverage for the `music.social` namespace.
 *
 * The assertions are chosen around the ways THESE endpoints lie quietly, since
 * a type signature catches none of them:
 *
 * - `POST /jams/:id/join` refuses with `401`, not `403`, so the SDK's own error
 *   mapping reports `authenticationRequired: true` for a perfectly good
 *   credential. That is a trap for any host with a "401 means sign out"
 *   interceptor, and the test pins the behaviour so it cannot be discovered in
 *   production a second time.
 * - `GET /users/:id/music_profile` answers `{ "visible": false }` at status
 *   `200`. It must not raise, and it must narrow.
 * - `GET /music/storage` sends `limit_bytes: null` for an unlimited account -
 *   a state that did not exist while the ceiling was a `NOT NULL` column.
 *   Reading that `null` as zero is the specific bug the helpers exist to stop.
 * - `POST /music_dj*` counts every request against an hourly cap INCLUDING the
 *   ones it refuses, so a retried `429` can never succeed. The call must go out
 *   exactly once.
 * - `DELETE /jams/:id` answers `200` with a literal `null` body while
 *   `DELETE /music_assistant/chats/:id` answers `204`. Both are `void` here and
 *   neither may throw.
 * - the DJ's audio arrives base64 in the JSON body, and the decoder has to work
 *   on a runtime with no `atob` (a Worker isolate, an older React Native).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { OmsApiError, OmsAuthError } from "../src/errors";
import { ApiClient } from "../src/http";
import {
  JAM_QUEUE_MODES,
  JAM_SKIP_MODES,
  MUSIC_DJ_HOURLY_CAP,
  MusicAssistantNamespace,
  MusicDjNamespace,
  MusicJamsNamespace,
  MusicProfilesNamespace,
  MusicSocialNamespace,
  MusicStorageNamespace,
  isJamHost,
  isMusicProfileVisible,
  jamHost,
  jamMember,
  jamSkipVotesNeeded,
  jamStreamName,
  musicDjAudioBytes,
  musicDjAudioDataUrl,
  musicProfileArtistImage,
  musicStorageAffords,
  musicStorageRemaining,
  type Jam,
  type MusicProfile,
  type MusicProfileArtist,
  type MusicStorageUsage,
} from "../src/resources/music/social";

const BASE_URL = "https://api.test";

/** One recorded request, decomposed into what the assertions look at. */
interface Call {
  readonly method: string;
  readonly path: string;
  /** The raw query string, leading "?" included. Empty when there was none. */
  readonly search: string;
  readonly body: unknown;
}

type Reply = { body: unknown; status?: number; headers?: Record<string, string> };

interface Harness {
  readonly social: MusicSocialNamespace;
  readonly jams: MusicJamsNamespace;
  readonly profiles: MusicProfilesNamespace;
  readonly storage: MusicStorageNamespace;
  readonly assistant: MusicAssistantNamespace;
  readonly dj: MusicDjNamespace;
  readonly calls: Call[];
}

/**
 * A fetch double replaying a queue of canned answers and recording what it was
 * asked. The last answer repeats, so a one-call test passes one reply.
 *
 * `retry` is left OFF at the client by default so a stray `429` cannot sleep
 * out a `Retry-After` inside the run. The DJ test turns it back ON deliberately,
 * because the thing it is checking is that the CALL SITE overrides it.
 */
function harness(replies: Reply[], clientRetry: false | { maxAttempts: number } = false): Harness {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = init?.body;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.search,
      body: typeof body === "string" ? JSON.parse(body) : undefined,
    });

    const reply = replies[Math.min(index, replies.length - 1)] ?? { body: null };
    index += 1;
    const status = reply.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(reply.body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...(reply.headers ?? {}) },
    });
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
    retry: clientRetry === false ? false : { ...clientRetry, baseDelayMs: 1, maxDelayMs: 2, jitter: false },
  });

  const social = new MusicSocialNamespace(http);
  return {
    social,
    jams: social.jams,
    profiles: social.profiles,
    storage: social.storage,
    assistant: social.assistant,
    dj: social.dj,
    calls,
  };
}

function jam(overrides: Partial<Jam> = {}): Jam {
  return {
    id: 42,
    host_id: "u_host",
    queue_mode: "everyone",
    skip_mode: "majority",
    created_at: "2026-08-29T10:00:00.000Z",
    ended_at: null,
    members: [
      { id: "u_host", handle: "afonso", name: "Afonso", is_host: true, joined_at: "2026-08-29T10:00:00.000Z" },
      { id: "u_two", handle: "biraj", name: "Biraj", is_host: false, joined_at: "2026-08-29T10:01:00.000Z" },
    ],
    ...overrides,
  };
}

function storage(overrides: Partial<MusicStorageUsage> = {}): MusicStorageUsage {
  return { used_bytes: 40_000_000_000, limit_bytes: 107_374_182_400, unlimited: false, ...overrides };
}

/* -------------------------------------------------------------------------- *
 * Jams
 * -------------------------------------------------------------------------- */

describe("jams.list", () => {
  test("normalises a body missing either key rather than handing back undefined", async () => {
    const { jams, calls } = harness([{ body: {} }]);

    const index = await jams.list();

    expect(calls[0]).toMatchObject({ method: "GET", path: "/jams" });
    expect(index.current).toBeNull();
    expect(index.joinable).toEqual([]);
  });

  test("sends no list-DSL parameters: this is not a CRUD index", async () => {
    const { jams, calls } = harness([{ body: { current: null, joinable: [] } }]);

    await jams.list();

    // JamsController#index is hand-written and takes no filters and no paging.
    // Sending modifiers[page] here would not be clamped or rejected the way a
    // real index would - it would simply be ignored, which is the worst of the
    // three outcomes, so the SDK sends nothing at all.
    expect(calls[0]?.search).toBe("");
  });

  test("current() reads the caller's jam off the same single request", async () => {
    const { jams, calls } = harness([{ body: { current: jam(), joinable: [jam({ id: 43 })] } }]);

    const mine = await jams.current();

    expect(calls).toHaveLength(1);
    expect(mine?.id).toBe(42);
  });
});

describe("jams write paths", () => {
  test("create posts to /jams with no body at all", async () => {
    const { jams, calls } = harness([{ body: jam(), status: 201 }]);

    const created = await jams.create();

    expect(calls[0]).toMatchObject({ method: "POST", path: "/jams" });
    expect(calls[0]?.body).toBeUndefined();
    expect(created.id).toBe(42);
  });

  test("leave accepts the 200-with-a-null-body that Rails' bare ok! produces", async () => {
    const { jams, calls } = harness([{ body: null }]);

    await expect(jams.leave(42)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "POST", path: "/jams/42/leave" });
  });

  test("end is a DELETE and also answers 200 null, not the usual 204", async () => {
    const { jams, calls } = harness([{ body: null, status: 200 }]);

    await expect(jams.end(42)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/jams/42" });
  });

  test("updateRules sends exactly the subset it was given", async () => {
    const { jams, calls } = harness([{ body: jam({ skip_mode: "anyone" }) }]);

    await jams.updateRules(42, { skip_mode: "anyone" });

    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/jams/42" });
    expect(calls[0]?.body).toEqual({ skip_mode: "anyone" });
  });

  test("invite and propose use the server's own parameter names and types", async () => {
    const { jams, calls } = harness([{ body: null }]);

    await jams.invite(42, "u_three");
    await jams.propose(42, 991);

    expect(calls[0]?.path).toBe("/jams/42/invite");
    expect(calls[0]?.body).toEqual({ user_id: "u_three" });
    expect(calls[1]?.path).toBe("/jams/42/propose");
    // A song id is an INTEGER on this API. A numeric string would still 200
    // and would still find the row, but it is not what the wire format says.
    expect(calls[1]?.body).toEqual({ song_id: 991 });
    expect(typeof (calls[1]?.body as { song_id: unknown }).song_id).toBe("number");
  });

  test("skipVote returns the tally the server computed", async () => {
    const { jams, calls } = harness([{ body: { skipped: false, count: 1, needed: 2 } }]);

    const result = await jams.skipVote(42);

    expect(calls[0]).toMatchObject({ method: "POST", path: "/jams/42/skip_vote" });
    expect(result).toEqual({ skipped: false, count: 1, needed: 2 });
  });
});

describe("a refused jam action wears a 401", () => {
  test("join refused by authorization is an auth error, credential or not", async () => {
    const { jams } = harness([{ body: "Only friends of a jam member can join", status: 401 }]);

    const thrown = await jams.join(42).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(OmsAuthError);
    expect((thrown as OmsApiError).status).toBe(401);
    expect((thrown as Error).message).toBe("Only friends of a jam member can join");
    // The trap: the SDK reads 401 as "the credential is missing or blown",
    // because that is what 401 means everywhere else. Here it means "you are
    // not friends with anybody in that jam". A host that signs the user out on
    // this flag will sign them out for tapping the wrong Join button.
    expect((thrown as OmsAuthError).authenticationRequired).toBe(true);
  });

  test("an ended jam is a 404 with a bare string, not an object", async () => {
    const { jams } = harness([{ body: "Jam not found", status: 404 }]);

    const thrown = await jams.propose(42, 1).catch((error: unknown) => error);

    expect((thrown as OmsApiError).status).toBe(404);
    expect((thrown as Error).message).toBe("Jam not found");
  });
});

describe("jam helpers", () => {
  test("the stream name matches Jam.stream_for", () => {
    expect(jamStreamName(42)).toBe("jam:42");
  });

  test("the host is found by host_id, not by is_host or by position", () => {
    const scrambled = jam({
      members: [
        { id: "u_two", handle: "biraj", name: "Biraj", is_host: true, joined_at: "2026-08-29T10:01:00.000Z" },
        { id: "u_host", handle: "afonso", name: "Afonso", is_host: false, joined_at: "2026-08-29T10:00:00.000Z" },
      ],
    });

    expect(jamHost(scrambled)?.handle).toBe("afonso");
    expect(isJamHost(scrambled, "u_host")).toBe(true);
    expect(isJamHost(scrambled, "u_two")).toBe(false);
    expect(jamMember(scrambled, "u_two")?.name).toBe("Biraj");
    expect(jamMember(scrambled, "u_nobody")).toBeUndefined();
  });

  test("the skip threshold is the server's arithmetic, including its rounding", () => {
    expect(jamSkipVotesNeeded(jam({ skip_mode: "anyone" }))).toBe(1);
    // Two members: floor(2 / 2) + 1 = 2, so both have to vote.
    expect(jamSkipVotesNeeded(jam())).toBe(2);
    // Three members: floor(3 / 2) + 1 = 2, a real majority.
    expect(
      jamSkipVotesNeeded(
        jam({
          members: [...jam().members, { id: "u_three", handle: "c", name: "C", is_host: false, joined_at: "x" }],
        }),
      ),
    ).toBe(2);
  });

  test("the mode constants are the server's, spelled the server's way", () => {
    expect([...JAM_QUEUE_MODES]).toEqual(["everyone", "host"]);
    expect([...JAM_SKIP_MODES]).toEqual(["majority", "host", "anyone"]);
  });
});

/* -------------------------------------------------------------------------- *
 * Music profile
 * -------------------------------------------------------------------------- */

describe("profiles.get", () => {
  test("percent-encodes the handle into the path", async () => {
    const { profiles, calls } = harness([{ body: { visible: false } }]);

    await profiles.get("someone with a space");

    expect(calls[0]?.path).toBe("/users/someone%20with%20a%20space/music_profile");
  });

  test("a hidden profile is a 200 and must not raise", async () => {
    const { profiles } = harness([{ body: { visible: false } }]);

    const profile = await profiles.get("u_stranger");

    expect(isMusicProfileVisible(profile)).toBe(false);
    expect(profile).toEqual({ visible: false });
  });

  test("a visible profile narrows to non-optional fields", async () => {
    const body = {
      visible: true,
      now_playing: {
        user: { id: "u_host", handle: "afonso", name: "Afonso" },
        song: {
          id: 991,
          title: "Construção",
          album: null,
          duration: 380,
          owner_id: "u_host",
          artist_names: "Chico Buarque",
          artwork_url: "https://minio.test/signed",
        },
        paused: false,
        online: true,
        jam_id: 42,
        updated_at: "2026-08-29T10:00:00.000Z",
      },
      top_artists: [],
      top_songs: [],
      recent: [],
      plays_30d: 17,
    };
    const { profiles } = harness([{ body }]);

    const profile: MusicProfile = await profiles.get("afonso");

    expect(isMusicProfileVisible(profile)).toBe(true);
    if (!isMusicProfileVisible(profile)) throw new Error("unreachable");
    expect(profile.plays_30d).toBe(17);
    // The three shipped clients type this id as a string. Rails sends the
    // bigint primary key, so it is a number, and comparing it to a real song id
    // with === only works if the SDK says so.
    expect(typeof profile.now_playing.song?.id).toBe("number");
    expect(profile.now_playing.jam_id).toBe(42);
  });
});

describe("musicProfileArtistImage", () => {
  const artist = (overrides: Partial<MusicProfileArtist> = {}): MusicProfileArtist => ({
    id: 3,
    name: "Chico Buarque",
    slug: "chico-buarque",
    picture: "https://cdn/small",
    picture_medium: "https://cdn/medium",
    picture_big: "https://cdn/big",
    picture_xl: "https://cdn/xl",
    external_image_url: "https://lastfm/img",
    image_url: "https://minio.test/upload",
    play_count: 12,
    ...overrides,
  });

  test("prefers the upload, then big, then xl - the order both clients use", () => {
    expect(musicProfileArtistImage(artist())).toBe("https://minio.test/upload");
    expect(musicProfileArtistImage(artist({ image_url: null }))).toBe("https://cdn/big");
    expect(musicProfileArtistImage(artist({ image_url: null, picture_big: null }))).toBe("https://cdn/xl");
  });

  test("returns undefined rather than an empty string when there is nothing", () => {
    expect(
      musicProfileArtistImage(
        artist({
          image_url: null,
          picture_big: null,
          picture_xl: null,
          picture_medium: null,
          picture: null,
          external_image_url: null,
        }),
      ),
    ).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- *
 * Music storage
 * -------------------------------------------------------------------------- */

describe("storage.get", () => {
  test("reads /music/storage and keeps the nullable limit as it arrived", async () => {
    const { storage: meter, calls } = harness([{ body: storage() }]);

    const usage = await meter.get();

    expect(calls[0]).toMatchObject({ method: "GET", path: "/music/storage" });
    expect(usage.limit_bytes).toBe(107_374_182_400);
    expect(usage.unlimited).toBe(false);
  });

  test("an unlimited account really does send limit_bytes: null", async () => {
    const { storage: meter } = harness([{ body: storage({ limit_bytes: null, unlimited: true }) }]);

    const usage = await meter.get();

    expect(usage.limit_bytes).toBeNull();
    expect(usage.unlimited).toBe(true);
  });
});

describe("the storage helpers exist to stop null being read as zero", () => {
  test("unlimited means no ceiling, never a full bar", () => {
    const unlimited = storage({ limit_bytes: null, unlimited: true });

    expect(musicStorageRemaining(unlimited)).toBeNull();
    expect(musicStorageAffords(unlimited, Number.MAX_SAFE_INTEGER)).toBe(true);
    // The bug this replaces, spelled out. JavaScript coerces `null` to 0 in
    // arithmetic rather than to NaN, so the naive expressions do not blow up
    // where somebody would notice - they quietly produce a NEGATIVE remaining
    // and an INFINITE percentage, and both render as a full bar to precisely
    // the accounts that were given no ceiling at all.
    const naiveRemaining = (unlimited.limit_bytes as unknown as number) - unlimited.used_bytes;
    expect(naiveRemaining).toBeLessThan(0);
    expect(unlimited.used_bytes / (unlimited.limit_bytes as unknown as number)).toBe(Number.POSITIVE_INFINITY);
  });

  test("a normal account gets real arithmetic", () => {
    const usage = storage({ used_bytes: 100, limit_bytes: 250 });

    expect(musicStorageRemaining(usage)).toBe(150);
    expect(musicStorageAffords(usage, 150)).toBe(true);
    expect(musicStorageAffords(usage, 151)).toBe(false);
  });

  test("an account over a lowered ceiling reports zero left, not a negative", () => {
    const usage = storage({ used_bytes: 400, limit_bytes: 250 });

    expect(musicStorageRemaining(usage)).toBe(0);
    expect(musicStorageAffords(usage, 1)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * Assistant
 * -------------------------------------------------------------------------- */

describe("assistant.send", () => {
  test("sends only the new message, and omits chat_id on a first turn", async () => {
    const { assistant, calls } = harness([{ body: { reply: "Olá", chat_id: 9 } }]);

    const answer = await assistant.send({ message: "toca algo calmo" });

    expect(calls[0]).toMatchObject({ method: "POST", path: "/music_assistant" });
    expect(calls[0]?.body).toEqual({ message: "toca algo calmo" });
    expect(answer.chat_id).toBe(9);
  });

  test("carries chat_id and the player snapshot when it has them", async () => {
    const { assistant, calls } = harness([{ body: { reply: "feito", chat_id: 9 } }]);

    await assistant.send({
      message: "pausa",
      chatId: 9,
      player: { song_id: 991, playing: true, volume: 0.4 },
    });

    expect(calls[0]?.body).toEqual({
      message: "pausa",
      chat_id: 9,
      player: { song_id: 991, playing: true, volume: 0.4 },
    });
  });

  test("a sealed chat is a 423 carrying the server's own sentence", async () => {
    const { assistant } = harness([{ body: "Este chat é só de leitura.", status: 423 }]);

    const thrown = await assistant.send({ message: "olá", chatId: 9 }).catch((error: unknown) => error);

    expect((thrown as OmsApiError).status).toBe(423);
    expect((thrown as Error).message).toBe("Este chat é só de leitura.");
  });

  test("the answer's optional keys are absent, not null, when nothing happened", async () => {
    const { assistant } = harness([{ body: { reply: "Não percebi." } }]);

    const answer = await assistant.send({ message: "?" });

    expect("playlist" in answer).toBe(false);
    expect("actions" in answer).toBe(false);
  });
});

describe("assistant.ask (stateless)", () => {
  test("sends the whole transcript, stripped down to role and content", async () => {
    const { assistant, calls } = harness([{ body: { reply: "ok" } }]);

    await assistant.ask([
      { role: "user", content: "olá", created_at: "2026-08-29T10:00:00.000Z" },
      { role: "assistant", content: "olá!" },
    ]);

    expect(calls[0]?.body).toEqual({
      messages: [
        { role: "user", content: "olá" },
        { role: "assistant", content: "olá!" },
      ],
    });
  });

  test("never sends a `message` key, which would switch the server to the other mode", async () => {
    const { assistant, calls } = harness([{ body: { reply: "ok" } }]);

    await assistant.ask([{ role: "user", content: "olá" }]);

    expect(Object.keys(calls[0]?.body as object)).toEqual(["messages"]);
  });
});

describe("assistant.chats", () => {
  test("list survives a null body and returns an array", async () => {
    const { assistant, calls } = harness([{ body: null }]);

    await expect(assistant.chats.list()).resolves.toEqual([]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/music_assistant/chats" });
  });

  test("delete is the one real 204 in this file", async () => {
    const { assistant, calls } = harness([{ body: null, status: 204 }]);

    await expect(assistant.chats.delete(9)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/music_assistant/chats/9" });
  });

  test("somebody else's chat is a 404, never a 403", async () => {
    const { assistant } = harness([{ body: "Chat not found", status: 404 }]);

    const thrown = await assistant.chats.get(9).catch((error: unknown) => error);

    expect((thrown as OmsApiError).status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- *
 * DJ
 * -------------------------------------------------------------------------- */

describe("dj.next", () => {
  const turn = { session_id: 7, song: { id: 991 }, theme: "Late night" };

  test("an empty input sends an empty body, which is a valid cold start", async () => {
    const { dj, calls } = harness([{ body: turn }]);

    await dj.next();

    expect(calls[0]).toMatchObject({ method: "POST", path: "/music_dj/next" });
    expect(calls[0]?.body).toEqual({});
  });

  test("maps the camelCase input onto the server's snake_case names", async () => {
    const { dj, calls } = harness([{ body: turn }]);

    await dj.next({ sessionId: 7, request: "algo calmo", skippedSongId: 3, restart: true, speak: true });

    expect(calls[0]?.body).toEqual({
      session_id: 7,
      request: "algo calmo",
      skipped_song_id: 3,
      restart: true,
      speak: true,
    });
  });

  test("a quiet turn carries no words and is not an error", async () => {
    const { dj } = harness([{ body: turn }]);

    const answer = await dj.next();

    expect(answer.song.id).toBe(991);
    expect(answer.text).toBeUndefined();
    expect(answer.audio_base64).toBeUndefined();
  });

  test("a 429 is NOT retried, because every attempt burns one of the ninety", async () => {
    // The client is told to retry twice; the call site must still win. The
    // server increments its counter before it decides to refuse, so a second
    // attempt pushes the count further past the cap and can never pass.
    const { dj, calls } = harness([{ body: "DJ limit reached, try again later", status: 429 }], { maxAttempts: 3 });

    const thrown = await dj.next().catch((error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect((thrown as OmsApiError).status).toBe(429);
    expect(MUSIC_DJ_HOURLY_CAP).toBe(90);
  });

  test("a caller who insists can opt retrying back in", async () => {
    const { dj, calls } = harness([{ body: "DJ limit reached, try again later", status: 429 }], { maxAttempts: 2 });

    await dj.next({}, { retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false } }).catch(() => undefined);

    expect(calls.length).toBeGreaterThan(1);
  });
});

describe("dj.session", () => {
  test("unwraps the envelope and hands back the session itself", async () => {
    const session = { id: 7, request: "fados", turns: [], songs: [] };
    const { dj, calls } = harness([{ body: { session } }]);

    expect(await dj.session()).toEqual(session);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/music_dj/session" });
  });

  test("nothing on air is null, not an error", async () => {
    const { dj } = harness([{ body: { session: null } }]);

    expect(await dj.session()).toBeNull();
  });

  test("end() closes the session", async () => {
    const { dj, calls } = harness([{ body: "", status: 204 }]);

    await dj.end();

    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/music_dj/session" });
  });
});

describe("the DJ audio decoder", () => {
  const platformAtob = globalThis.atob;

  afterEach(() => {
    (globalThis as { atob?: unknown }).atob = platformAtob;
  });

  test("decodes with the platform's atob when there is one", () => {
    expect(typeof globalThis.atob).toBe("function");
    expect([...musicDjAudioBytes({ audio_base64: "UklGRg==" })]).toEqual([0x52, 0x49, 0x46, 0x46]);
  });

  test("decodes identically with no atob at all", () => {
    const expected = [...musicDjAudioBytes({ audio_base64: "SGVsbG8sIHdvcmxkIQ==" })];
    (globalThis as { atob?: unknown }).atob = undefined;

    // Same input, no platform decoder: a Worker isolate, or an older React
    // Native. The bytes have to match exactly, padding and all.
    expect([...musicDjAudioBytes({ audio_base64: "SGVsbG8sIHdvcmxkIQ==" })]).toEqual(expected);
    expect([...musicDjAudioBytes({ audio_base64: "UklGRg==" })]).toEqual([0x52, 0x49, 0x46, 0x46]);
  });

  test("tolerates the newlines a wrapped base64 payload can carry", () => {
    (globalThis as { atob?: unknown }).atob = undefined;

    expect([...musicDjAudioBytes({ audio_base64: "UklG\nRg==" })]).toEqual([0x52, 0x49, 0x46, 0x46]);
  });

  test("an empty clip decodes to no bytes rather than throwing mid-playback", () => {
    expect(musicDjAudioBytes({ audio_base64: "" })).toHaveLength(0);
  });

  test("the data URL names the container the server reported", () => {
    expect(musicDjAudioDataUrl({ audio_base64: "AAA=", format: "wav" })).toBe("data:audio/wav;base64,AAA=");
    expect(musicDjAudioDataUrl({ audio_base64: "AAA=", format: "mp3" })).toBe("data:audio/mpeg;base64,AAA=");
    expect(musicDjAudioDataUrl({ audio_base64: "AAA=", format: "" })).toBe("data:audio/wav;base64,AAA=");
  });
});

/* -------------------------------------------------------------------------- *
 * Wiring
 * -------------------------------------------------------------------------- */

describe("MusicSocialNamespace", () => {
  test("hands every sub-namespace the same client", async () => {
    const { social, calls } = harness([{ body: { current: null, joinable: [] } }, { body: { visible: false } }]);

    expect(social.jams).toBeInstanceOf(MusicJamsNamespace);
    expect(social.profiles).toBeInstanceOf(MusicProfilesNamespace);
    expect(social.storage).toBeInstanceOf(MusicStorageNamespace);
    expect(social.assistant).toBeInstanceOf(MusicAssistantNamespace);
    expect(social.dj).toBeInstanceOf(MusicDjNamespace);

    await social.jams.list();
    await social.profiles.get("afonso");

    expect(calls.map((call) => call.path)).toEqual(["/jams", "/users/afonso/music_profile"]);
  });
});
