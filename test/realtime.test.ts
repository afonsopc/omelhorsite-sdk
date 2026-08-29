/**
 * `bun test` coverage for the `realtime` namespace.
 *
 * This is the one transport in the SDK that is not HTTP, so there is no fake
 * `fetch` to mount: the double is a fake WebSocket, injected through
 * `connect({ socket })`, plus a fake clock injected through `connect({ timers })`
 * so the backoff and the ping watchdog are assertions rather than sleeps.
 *
 * What is actually being defended here, in the order the module docs raise it:
 *
 * - the identifier is a STRING that has to match byte for byte, so the tests
 *   compare literals rather than re-parsing;
 * - the credential goes in the QUERY and nothing else goes anywhere else;
 * - nothing may be sent before `welcome`, and everything must be re-sent after
 *   the next one;
 * - a rejection is per channel, not per connection - an anonymous socket looks
 *   perfectly healthy and only the channels complain;
 * - `state.song_id` is a number and `position_tick.song_id` is a string, which
 *   is the divergence from `oms-music/docs/API.md` that this SDK types honestly.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import {
  RealtimeNamespace,
  SOCKET_OPEN,
  cableEndpoint,
  handshakeUrl,
  type CableConnection,
  type CableSocket,
  type CableTimers,
  type FriendListeningMessage,
  type JamMessage,
  type NotificationsMessage,
  type PlaybackMessage,
} from "../src/resources/realtime";

const BASE_URL = "https://api.test";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A WebSocket that records what was written and lets a test drive the reads. */
class FakeSocket implements CableSocket {
  readyState = SOCKET_OPEN;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /** Raw frames written by the SDK, in order. */
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  // --- test-side drivers ---

  open(): void {
    this.onopen?.({});
  }

  /** Delivers one server frame. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Delivers a frame that is not JSON at all. */
  deliverRaw(data: string): void {
    this.onmessage?.({ data });
  }

  /** Parsed view of everything the SDK wrote. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** A clock the test advances by hand. */
class FakeClock implements CableTimers {
  private millis = 1_000_000;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; run: () => void }>();

  setTimeout(handler: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.millis + ms, run: handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.millis;
  }

  /** Moves time forward, firing every timer that comes due, in due order. */
  advance(ms: number): void {
    const target = this.millis + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.pending) {
        if (entry.at <= target && entry.at < nextAt) {
          nextAt = entry.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const entry = this.pending.get(nextId);
      this.pending.delete(nextId);
      this.millis = nextAt;
      entry?.run();
    }
    this.millis = target;
  }

  /** Delays of every timer still armed, for asserting the backoff. */
  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.at - this.millis);
  }
}

interface Harness {
  readonly cable: CableConnection;
  readonly clock: FakeClock;
  /** Every socket the factory built, oldest first. */
  readonly sockets: FakeSocket[];
  /** The socket currently in use. */
  latest(): FakeSocket;
  /** Opens and welcomes the latest socket, the normal happy path. */
  welcome(): FakeSocket;
}

function harness(
  options: { token?: string | (() => string | Promise<string>) | null; staleAfterMs?: number } = {},
): Harness {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const realtime = new RealtimeNamespace(new ApiClient({ baseUrl: BASE_URL, fetch: notCalled }));
  const cable = realtime.connect({
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    timers: clock,
  });
  const latest = (): FakeSocket => {
    const socket = sockets[sockets.length - 1];
    if (socket === undefined) throw new Error("no socket was built");
    return socket;
  };
  return {
    cable,
    clock,
    sockets,
    latest,
    welcome(): FakeSocket {
      const socket = latest();
      socket.open();
      socket.deliver({ type: "welcome" });
      return socket;
    },
  };
}

const notCalled = async (): Promise<Response> => {
  throw new Error("the realtime namespace must not make HTTP requests");
};

/**
 * The socket is built after an awaited token resolution, so every test yields
 * once before touching it. Awaiting a resolved promise is enough - the SDK
 * resolves the credential in a single `then`.
 */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// ---------------------------------------------------------------------------

describe("the handshake URL", () => {
  test("rewrites the API root to a websocket scheme and appends /cable", () => {
    expect(cableEndpoint("https://backend.omelhorsite.pt")).toBe("wss://backend.omelhorsite.pt/cable");
    expect(cableEndpoint("http://localhost:3000")).toBe("ws://localhost:3000/cable");
    // A trailing slash on the root must not produce a doubled one.
    expect(cableEndpoint("https://api.test/")).toBe("wss://api.test/cable");
  });

  test("carries the credential in the query and nowhere else", () => {
    // Trap 1: the server takes the FIRST non-blank candidate, header first, so
    // the token must be a query param. There is no header to assert on because
    // the SDK never offers one - the factory receives a URL and nothing else.
    expect(handshakeUrl("wss://api.test/cable", "tok en/1")).toBe(
      "wss://api.test/cable?token=tok%20en%2F1",
    );
  });

  test("sends no token at all for cookie auth", () => {
    // "" and null are the same thing on the wire: a bare handshake the browser
    // decorates with the httpOnly session cookie by itself.
    expect(handshakeUrl("wss://api.test/cable", null)).toBe("wss://api.test/cable");
    expect(handshakeUrl("wss://api.test/cable", "")).toBe("wss://api.test/cable");
  });

  test("the connection opens against that URL", async () => {
    const h = harness({ token: "secret-session-token" });
    await settle();
    expect(h.latest().url).toBe("wss://api.test/cable?token=secret-session-token");
  });

  test("a token thunk is resolved on every attempt, so rotation survives a drop", async () => {
    let issued = 0;
    const h = harness({ token: () => `token-${++issued}` });
    await settle();
    expect(h.latest().url).toBe("wss://api.test/cable?token=token-1");

    h.welcome();
    h.latest().close();
    h.clock.advance(1_000);
    await settle();

    expect(h.sockets).toHaveLength(2);
    expect(h.latest().url).toBe("wss://api.test/cable?token=token-2");
  });
});

describe("the identifier", () => {
  test("is the exact string the server will echo back", async () => {
    const h = harness({ token: "t" });
    await settle();
    h.welcome();

    const playback = h.cable.playback({ device_id: "tab-abcdefgh", device_label: "Laptop" }, { onMessage: () => {} });
    const jam = h.cable.jam(7, { onMessage: () => {} });
    const job = h.cable.job({ id: "job_1", token: "watch" }, { onMessage: () => {} });
    const friends = h.cable.friendListening({ onMessage: () => {} });
    const notifications = h.cable.notifications({ onMessage: () => {} });

    expect(playback.identifier).toBe(
      '{"channel":"PlaybackChannel","device_id":"tab-abcdefgh","device_label":"Laptop"}',
    );
    // A NUMBER: '{"id":7}' and '{"id":"7"}' are different subscriptions.
    expect(jam.identifier).toBe('{"channel":"JamChannel","id":7}');
    expect(job.identifier).toBe('{"channel":"JobChannel","id":"job_1","token":"watch"}');
    expect(friends.identifier).toBe('{"channel":"FriendListeningChannel"}');
    expect(notifications.identifier).toBe('{"channel":"NotificationsChannel"}');
  });

  test("omits params that were not given rather than sending nulls", async () => {
    const h = harness({ token: "t" });
    await settle();
    h.welcome();
    // A v1 subscribe with no device at all has to be exactly this string; a
    // `"device_id":null` would be a different identifier AND a different
    // meaning to the channel.
    expect(h.cable.playback({}, { onMessage: () => {} }).identifier).toBe(
      '{"channel":"PlaybackChannel"}',
    );
    expect(h.cable.job({ id: "job_2" }, { onMessage: () => {} }).identifier).toBe(
      '{"channel":"JobChannel","id":"job_2"}',
    );
  });

  test("refuses a duplicate rather than shadowing the first handler", async () => {
    const h = harness({ token: "t" });
    await settle();
    h.welcome();
    h.cable.notifications({ onMessage: () => {} });
    expect(() => h.cable.notifications({ onMessage: () => {} })).toThrow(/Already subscribed/);
  });
});

describe("welcome gating", () => {
  test("nothing is sent before welcome, and everything is sent after it", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.latest();
    socket.open();

    const sub = h.cable.notifications({ onMessage: () => {} });
    sub.perform("noop");
    // An open socket is not a welcomed one: the server discards early frames
    // without answering, so the SDK does not write them at all.
    expect(socket.sent).toEqual([]);
    expect(h.cable.state).toBe("connecting");

    socket.deliver({ type: "welcome" });
    expect(h.cable.state).toBe("connected");
    expect(socket.frames()).toEqual([
      { command: "subscribe", identifier: '{"channel":"NotificationsChannel"}' },
    ]);
  });

  test("perform wraps the action into a JSON STRING, not an object", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const playback = h.cable.playback({ device_id: "tab-abcdefgh" }, { onMessage: () => {} });

    playback.command("seek", { time: 42 });
    const frame = socket.frames().at(-1);
    expect(frame?.["command"]).toBe("message");
    // `data` is a string Rails parses a second time. An object here is ignored.
    expect(typeof frame?.["data"]).toBe("string");
    expect(JSON.parse(String(frame?.["data"]))).toEqual({
      action: "command",
      command: "seek",
      args: { time: 42 },
    });
  });

  test("the typed playback actions spell the server's vocabulary", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const playback = h.cable.playback({ device_id: "tab-abcdefgh" }, { onMessage: () => {} });

    playback.heartbeat();
    playback.requestSnapshot();
    playback.claimActive();
    playback.claimActive("steal");
    playback.transfer({ device_id: "sess:tab-other" });
    playback.publishState({ paused: true });
    playback.positionTick({ position: 12.5, paused: false, song_id: 991 });
    playback.activationBlocked();

    const actions = socket
      .frames()
      .filter((frame) => frame["command"] === "message")
      .map((frame) => JSON.parse(String(frame["data"])) as Record<string, unknown>);

    expect(actions.map((action) => action["action"])).toEqual([
      "heartbeat",
      "request_snapshot",
      "claim_active",
      "claim_active",
      "transfer",
      "state_changed",
      "position_tick",
      "activation_blocked",
    ]);
    expect(actions[2]).toEqual({ action: "claim_active", mode: "if_none" });
    expect(actions[3]).toEqual({ action: "claim_active", mode: "steal" });
    expect(actions[4]).toEqual({ action: "transfer", target_device_id: "sess:tab-other" });
    expect(actions[5]).toEqual({ action: "state_changed", payload: { paused: true } });
    // The tick's song id goes out as a STRING: the server matches it against
    // \A\d{1,18}\z and re-emits the string it matched.
    expect(actions[6]).toEqual({
      action: "position_tick",
      position: 12.5,
      paused: false,
      song_id: "991",
    });
  });
});

describe("routing", () => {
  test("a stream payload reaches only the subscription its identifier names", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();

    const notifications: NotificationsMessage[] = [];
    const jams: JamMessage[] = [];
    h.cable.notifications({ onMessage: (msg) => notifications.push(msg) });
    h.cable.jam(7, { onMessage: (msg) => jams.push(msg) });

    socket.deliver({
      identifier: '{"channel":"NotificationsChannel"}',
      message: { type: "unread_count", unread_count: 3 },
    });
    socket.deliver({
      identifier: '{"channel":"JamChannel","id":7}',
      message: { type: "ended" },
    });
    // An identifier nobody registered - a stale subscription, or a key order
    // that does not match - is dropped silently, exactly as the server does.
    socket.deliver({
      identifier: '{"id":7,"channel":"JamChannel"}',
      message: { type: "skipped" },
    });

    expect(notifications).toEqual([{ type: "unread_count", unread_count: 3 }]);
    expect(jams).toEqual([{ type: "ended" }]);
  });

  test("confirm and reject are per channel, not per connection", async () => {
    // Trap 2: an anonymous connection is ACCEPTED. It welcomes, it pings, and
    // it looks entirely healthy; only the channels say no.
    const h = harness({ token: "a-dead-token" });
    await settle();
    const socket = h.welcome();

    let rejected = 0;
    let confirmed = 0;
    h.cable.notifications({ onMessage: () => {}, onReject: () => rejected++ });
    h.cable.job({ id: "job_1", token: "watch" }, { onMessage: () => {}, onConfirm: () => confirmed++ });

    socket.deliver({ type: "reject_subscription", identifier: '{"channel":"NotificationsChannel"}' });
    socket.deliver({
      type: "confirm_subscription",
      identifier: '{"channel":"JobChannel","id":"job_1","token":"watch"}',
    });

    expect(rejected).toBe(1);
    // The watch token is the one credential that works on an anonymous socket.
    expect(confirmed).toBe(1);
    // And the connection itself still believes it is fine, because it is.
    expect(h.cable.state).toBe("connected");
  });

  test("ping is liveness only and a malformed frame is ignored", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const seen: unknown[] = [];
    h.cable.notifications({ onMessage: (msg) => seen.push(msg) });

    socket.deliver({ type: "ping", message: 1_700_000_000 });
    socket.deliverRaw("<html>a proxy error page</html>");
    expect(seen).toEqual([]);
    expect(socket.closed).toBe(false);
  });

  test("a throwing handler does not take down its neighbours", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const survived: unknown[] = [];
    h.cable.notifications({
      onMessage: () => {
        throw new Error("application bug");
      },
    });
    h.cable.friendListening({ onMessage: (msg) => survived.push(msg) });

    socket.deliver({
      identifier: '{"channel":"NotificationsChannel"}',
      message: { type: "unread_count", unread_count: 1 },
    });
    socket.deliver({
      identifier: '{"channel":"FriendListeningChannel"}',
      message: { type: "snapshot", friends: [] },
    });

    expect(survived).toEqual([{ type: "snapshot", friends: [] }]);
  });

  test("unsubscribe tells the server and stops delivery", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const seen: unknown[] = [];
    const sub = h.cable.notifications({ onMessage: (msg) => seen.push(msg) });

    sub.unsubscribe();
    expect(sub.active).toBe(false);
    expect(socket.frames().at(-1)).toEqual({
      command: "unsubscribe",
      identifier: '{"channel":"NotificationsChannel"}',
    });

    socket.deliver({
      identifier: '{"channel":"NotificationsChannel"}',
      message: { type: "unread_count", unread_count: 9 },
    });
    expect(seen).toEqual([]);
    // Idempotent: a second call writes nothing more.
    const before = socket.sent.length;
    sub.unsubscribe();
    expect(socket.sent.length).toBe(before);
  });
});

describe("reconnection", () => {
  test("backs off by doubling to the cap, and resets on welcome", async () => {
    const h = harness({ token: "t" });
    await settle();
    h.welcome();
    h.cable.notifications({ onMessage: () => {} });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      h.latest().close();
      // One timer is armed: the reconnect. (The watchdog is disarmed on close.)
      delays.push(h.clock.delays()[0] ?? -1);
      h.clock.advance(60_000);
      await settle();
      h.latest().open();
    }

    // 1s doubling to a 30s ceiling. `/cable` is exempt from every rate limit,
    // so nothing on the server side would slow a runaway loop down for us.
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    h.latest().deliver({ type: "welcome" });
    h.latest().close();
    expect(h.clock.delays()[0]).toBe(1_000);
  });

  test("resubscribes every identifier on the next welcome, without the caller lifting a finger", async () => {
    const h = harness({ token: "t" });
    await settle();
    h.welcome();

    let disconnects = 0;
    let confirms = 0;
    const sub = h.cable.notifications({
      onMessage: () => {},
      onDisconnect: () => disconnects++,
      onConfirm: () => confirms++,
    });
    const jam = h.cable.jam(7, { onMessage: () => {} });
    h.latest().deliver({ type: "confirm_subscription", identifier: sub.identifier });
    expect(confirms).toBe(1);

    h.latest().close();
    expect(disconnects).toBe(1);
    // The handle stays valid across the drop; re-subscribing by hand here is
    // how you end up with the same identifier registered twice.
    expect(sub.active).toBe(true);
    expect(h.cable.subscriptionCount).toBe(2);

    h.clock.advance(1_000);
    await settle();
    const reborn = h.welcome();

    expect(reborn.frames()).toEqual([
      { command: "subscribe", identifier: '{"channel":"NotificationsChannel"}' },
      { command: "subscribe", identifier: '{"channel":"JamChannel","id":7}' },
    ]);
    // And subscribe-time work runs again server-side, so a second confirm is
    // normal rather than a duplicate to guard against.
    reborn.deliver({ type: "confirm_subscription", identifier: jam.identifier });
    reborn.deliver({ type: "confirm_subscription", identifier: sub.identifier });
    expect(confirms).toBe(2);
  });

  test("a socket that dies before welcome fires no onDisconnect", async () => {
    const h = harness({ token: "t" });
    await settle();
    let disconnects = 0;
    h.cable.notifications({ onMessage: () => {}, onDisconnect: () => disconnects++ });

    h.latest().open();
    h.latest().close();
    // Nothing was ever delivered, so there was nothing to interrupt.
    expect(disconnects).toBe(0);
  });

  test("a rejection that means give up is the caller's job to act on", async () => {
    const h = harness({ token: "a-dead-token" });
    await settle();
    h.welcome();

    const sub = h.cable.notifications({
      onMessage: () => {},
      onReject: () => {
        // Trap 2 again: the identifier stays registered otherwise, and the
        // next reconnect resubscribes it just to be rejected again.
        sub.unsubscribe();
      },
    });
    h.latest().deliver({ type: "reject_subscription", identifier: sub.identifier });
    expect(h.cable.subscriptionCount).toBe(0);

    h.latest().close();
    h.clock.advance(1_000);
    await settle();
    const reborn = h.welcome();
    expect(reborn.frames()).toEqual([]);
  });

  test("the watchdog cycles a socket the server stopped pinging", async () => {
    // The failure this exists for: a NAT rebind or a sleeping radio leaves
    // readyState === 1 forever and `onclose` never fires, so without a
    // watchdog the reconnect never starts.
    const h = harness({ token: "t", staleAfterMs: 25_000 });
    await settle();
    const dead = h.welcome();
    h.cable.notifications({ onMessage: () => {} });

    h.clock.advance(10_000);
    dead.deliver({ type: "ping", message: 1 });
    // A ping refreshed the deadline, so the socket survives past the original
    // 25s mark and the timer re-arms for the remainder instead of firing.
    h.clock.advance(20_000);
    expect(dead.closed).toBe(false);

    h.clock.advance(25_000);
    expect(dead.closed).toBe(true);

    h.clock.advance(1_000);
    await settle();
    expect(h.sockets).toHaveLength(2);
  });

  test("a disconnect frame with reconnect:false is final", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    h.cable.notifications({ onMessage: () => {} });

    socket.deliver({ type: "disconnect", reason: "unauthorized", reconnect: false });
    expect(socket.closed).toBe(true);
    h.clock.advance(120_000);
    await settle();
    // Retrying a connection the server refused can never succeed.
    expect(h.sockets).toHaveLength(1);
  });

  test("a disconnect frame without reconnect:false comes back", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    socket.deliver({ type: "disconnect", reason: "server_restart" });
    expect(socket.closed).toBe(true);
    h.clock.advance(1_000);
    await settle();
    expect(h.sockets).toHaveLength(2);
  });

  test("close() stops the socket, the timers and the subscriptions", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const sub = h.cable.notifications({ onMessage: () => {} });

    h.cable.close();
    expect(socket.closed).toBe(true);
    expect(sub.active).toBe(false);
    expect(h.cable.state).toBe("closed");
    expect(h.cable.subscriptionCount).toBe(0);

    h.clock.advance(120_000);
    await settle();
    expect(h.sockets).toHaveLength(1);
  });

  test("a socket factory that throws is retried rather than fatal", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const realtime = new RealtimeNamespace(new ApiClient({ baseUrl: BASE_URL, fetch: notCalled }));
    const cable = realtime.connect({
      token: "t",
      timers: clock,
      socket: (url) => {
        attempts++;
        if (attempts === 1) throw new Error("no WebSocket on this runtime yet");
        return new FakeSocket(url);
      },
    });
    await settle();
    expect(attempts).toBe(1);
    // A constructor that throws never produces an onclose, so the retry has to
    // be scheduled on the throw itself.
    clock.advance(1_000);
    await settle();
    expect(attempts).toBe(2);
    cable.close();
  });
});

describe("the payload shapes the wire actually uses", () => {
  test("state.song_id is a number while position_tick.song_id is a string", async () => {
    // `oms-music/docs/API.md` says "on the cable, song ids and queue entries
    // are STRINGS". Only half of that survives contact with the Rails source:
    // `playback_states.song_id` is a bigint COLUMN, so it comes back as a JSON
    // number, while `position_tick` re-emits the digit string it matched. The
    // SDK types both as the wire carries them, so `state.song_id === queue[i]`
    // is a compile error here instead of a comparison that never matches.
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const seen: PlaybackMessage[] = [];
    const sub = h.cable.playback({ device_id: "tab-abcdefgh" }, { onMessage: (msg) => seen.push(msg) });

    socket.deliver({
      identifier: sub.identifier,
      message: {
        type: "snapshot",
        v: 2,
        state: { song_id: 991, queue: ["991", "992"], queue_index: 0 },
        devices: [],
        active_device_id: "sess:tab-abcdefgh",
        your_device_id: "sess:tab-abcdefgh",
        active_session_id: null,
        your_session_id: "sess",
      },
    });
    socket.deliver({
      identifier: sub.identifier,
      message: { type: "position_tick", position: 3, paused: false, song_id: "991", server_time: 1 },
    });

    const snapshot = seen[0];
    const tick = seen[1];
    if (snapshot?.type !== "snapshot" || tick?.type !== "position_tick") throw new Error("bad fixture");
    expect(typeof snapshot.state.song_id).toBe("number");
    expect(typeof tick.song_id).toBe("string");
    // The comparison that has to be written deliberately, in either direction.
    expect(String(snapshot.state.song_id)).toBe(String(tick.song_id));
    expect(snapshot.state.queue[0]).toBe("991");
  });

  test("a slim state_changed omits queue_songs and must be merged, not replaced", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const seen: PlaybackMessage[] = [];
    const sub = h.cable.playback({}, { onMessage: (msg) => seen.push(msg) });

    socket.deliver({
      identifier: sub.identifier,
      message: {
        type: "state_changed",
        state: { song_id: 1, paused: false, queue: ["1"], queue_songs: [{ id: 1 }] },
        active_device_id: null,
        from_device_id: null,
        from_session_id: "sess",
      },
    });
    socket.deliver({
      identifier: sub.identifier,
      // A volume drag: full state, NO queue_songs. Replacing wholesale here is
      // what empties a client's own queue view on every pause.
      message: {
        type: "state_changed",
        state: { song_id: 1, paused: true, queue: ["1"] },
        active_device_id: null,
        from_device_id: null,
        from_session_id: "sess",
      },
    });

    const first = seen[0];
    const second = seen[1];
    if (first?.type !== "state_changed" || second?.type !== "state_changed") throw new Error("bad fixture");
    expect(first.state.queue_songs).toHaveLength(1);
    expect(second.state.queue_songs).toBeUndefined();
  });

  test("a listening_update spreads its row at the top level, unlike the snapshot", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const seen: FriendListeningMessage[] = [];
    const sub = h.cable.friendListening({ onMessage: (msg) => seen.push(msg) });

    const row = {
      user: { id: "usr_1", handle: "aluiz", name: "A" },
      song: null,
      paused: true,
      online: true,
      jam_id: null,
      updated_at: null,
    };
    socket.deliver({ identifier: sub.identifier, message: { type: "snapshot", friends: [row] } });
    socket.deliver({ identifier: sub.identifier, message: { type: "listening_update", ...row } });

    const snapshot = seen[0];
    const update = seen[1];
    if (snapshot?.type !== "snapshot" || update?.type !== "listening_update") throw new Error("bad fixture");
    // The snapshot nests; the update does not. Replace by user.id, append when new.
    expect(snapshot.friends[0]?.user.id).toBe("usr_1");
    expect(update.user.id).toBe("usr_1");
  });

  test("jam ids are integers on the wire, including inside skip_votes", async () => {
    const h = harness({ token: "t" });
    await settle();
    const socket = h.welcome();
    const seen: JamMessage[] = [];
    const sub = h.cable.jam(7, { onMessage: (msg) => seen.push(msg) });

    socket.deliver({
      identifier: sub.identifier,
      message: { type: "skip_votes", song_id: 991, count: 1, needed: 2 },
    });
    socket.deliver({
      identifier: sub.identifier,
      message: {
        type: "song_proposed",
        song: { id: 42, title: "T", artist_names: "A" },
        proposer: { id: "usr_1", handle: "aluiz", name: "A" },
      },
    });

    const votes = seen[0];
    const proposed = seen[1];
    if (votes?.type !== "skip_votes" || proposed?.type !== "song_proposed") throw new Error("bad fixture");
    // Both are built from integer columns by the controller, so neither is a
    // string despite what the app doc says about "cable song ids".
    expect(typeof votes.song_id).toBe("number");
    expect(typeof proposed.song.id).toBe("number");
  });
});

describe("the namespace", () => {
  test("makes no HTTP request and exposes the endpoint it would use", () => {
    // `notCalled` throws, so this passing is the assertion: opening a cable is
    // not an API call and must never spend a rate-limit budget.
    const realtime = new RealtimeNamespace(new ApiClient({ baseUrl: BASE_URL, fetch: notCalled }));
    expect(realtime.endpoint()).toBe("wss://api.test/cable");
    expect(realtime.endpoint("/cable?debug=1")).toBe("wss://api.test/cable?debug=1");
  });

  test("hands out independent connections rather than a hidden singleton", async () => {
    const first = harness({ token: "session-a" });
    const second = harness({ token: "session-b" });
    await settle();
    expect(first.latest().url).not.toBe(second.latest().url);
    first.cable.close();
    expect(second.cable.state).not.toBe("closed");
    second.cable.close();
  });

  test("cookie auth opens a bare handshake", async () => {
    const h = harness({});
    await settle();
    // Nothing to send: the browser attaches the httpOnly session cookie to a
    // same-site handshake by itself, and the server's third candidate reads it.
    expect(h.latest().url).toBe("wss://api.test/cable");
    h.cable.close();
  });
});
