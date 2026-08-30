/**
 * The `realtime` namespace: Action Cable over a raw WebSocket.
 *
 * This is the only transport in the SDK that is not HTTP. Everything else
 * talks to `/`-rooted JSON endpoints through {@link ApiClient}; this talks the
 * Action Cable v1 wire protocol to `/cable`, and it deliberately does NOT
 * depend on `@rails/actioncable` - that package assumes a browser, pulls in
 * its own global logger, and is bigger than the eighty lines of protocol it
 * implements.
 *
 * ## The protocol, in full
 *
 * Server to client, one JSON object per frame:
 *
 * - `{"type":"welcome"}` - the connection is live. NOTHING may be sent before
 *   this arrives; the server drops earlier frames on the floor without an
 *   error, so a client that subscribes on `open` subscribes to nothing;
 * - `{"type":"ping","message":<epoch seconds>}` - every ~3 s, unconditionally,
 *   even on an idle connection. This is the only liveness signal there is;
 * - `{"type":"confirm_subscription","identifier":"..."}`;
 * - `{"type":"reject_subscription","identifier":"..."}`;
 * - `{"type":"disconnect","reason":"...","reconnect":true|false}`;
 * - `{"identifier":"...","message":<payload>}` for everything a channel
 *   actually streams. This frame has no `type` of its own - the `type` you
 *   read in application code lives one level down, inside `message`.
 *
 * Client to server:
 *
 * - `{"command":"subscribe","identifier":"..."}`;
 * - `{"command":"unsubscribe","identifier":"..."}`;
 * - `{"command":"message","identifier":"...","data":"<JSON string>"}` - note
 *   that `data` is a STRING containing JSON, not an object, and that the
 *   action name travels inside it as `{"action":"...", ...args}`.
 *
 * ## The identifier is a string, and it is compared as one
 *
 * `identifier` is a JSON-encoded string such as `'{"channel":"PlaybackChannel"}'`.
 * The server echoes back the exact bytes it received and routes incoming
 * frames by looking that string up. Re-serialising with the keys in a
 * different order produces a different string, the lookup misses, and the
 * symptom is not an error: it is a subscription that confirms and then never
 * receives anything. So this module builds the identifier ONCE per
 * subscription, keys its own registry by that same string, and never rebuilds
 * it - including across a reconnect.
 *
 * ## Four traps
 *
 * 1. **The handshake authenticates on the FIRST candidate, with no fallback.**
 *    The `Authorization` header, then `?token=`, then the session cookie: the
 *    handshake takes the first one that is merely NON-BLANK. The HTTP API
 *    tries each candidate until one resolves to a live session; the cable does
 *    not. A stale `Authorization` header therefore shadows a perfectly good
 *    cookie on the cable and on the cable only. This module never sends an
 *    `Authorization` header on the handshake (browsers cannot attach one to a
 *    WebSocket anyway) and puts the token in the query string.
 * 2. **Anonymous connections are ACCEPTED.** A bad token, an expired token, or
 *    no token at all produces a perfectly healthy socket that says `welcome`
 *    and then pings forever. The identity failure surfaces ONE LEVEL DOWN, as
 *    `reject_subscription` on each channel that needs a user. A client that
 *    only handles connection errors will sit there believing it is signed in.
 *    Handle {@link CableHandlers.onReject}, always.
 * 3. **Only session tokens work.** An OAuth access token that authenticates
 *    every REST call in this SDK produces an ANONYMOUS cable connection, i.e.
 *    trap 2. There is no scope that fixes this and no error that says it; you
 *    get silent rejections on every channel. Cable access needs a session
 *    token or the session cookie.
 * 4. **`/cable` is exempt from the rate limits.** Neither the 600 requests a
 *    minute authed ceiling nor the 120 a minute anonymous one applies to the
 *    handshake or to anything sent over the socket. That is a convenience for
 *    `position_tick` at 1 Hz, not a licence: the reconnect backoff below
 *    exists because an unthrottled reconnect loop against a restarting server
 *    is a self-inflicted denial of service.
 *
 * ## Injecting the socket
 *
 * The WebSocket constructor is a parameter, not a global lookup. Three reasons,
 * in ascending order of importance: `globalThis.WebSocket` does not exist on
 * every runtime the SDK targets; a host that wants a proxy, a header, or a
 * permessage-deflate setting has nowhere else to put it; and without injection
 * there is no way to test any of this without a network. The default factory
 * reads `globalThis.WebSocket` if it is there and throws a message naming the
 * option if it is not.
 *
 * ```ts
 * const cable = oms.realtime.connect({ token: sessionToken });
 * const sub = cable.notifications({
 *   onMessage: (msg) => { if (msg.type === "created") show(msg.notification); },
 *   onReject: () => { /* anonymous or logged out - see trap 2 *\/ },
 * });
 * // later
 * sub.unsubscribe();
 * cable.close();
 * ```
 */

import { OmsNetworkError } from "../errors";
import { Resource } from "../http";

// ---------------------------------------------------------------------------
// Injected platform surface
// ---------------------------------------------------------------------------

/**
 * The slice of the WHATWG `WebSocket` this module actually uses.
 *
 * Deliberately structural and deliberately small: a browser `WebSocket`, a
 * Bun one, React Native's polyfill and a hand-written test double all satisfy
 * it without a cast. Note that the handlers are ASSIGNED (`socket.onmessage =`)
 * rather than added as listeners, because that is the subset every one of those
 * four implements identically.
 */
export interface CableSocket {
  /** `0` connecting, `1` open, `2` closing, `3` closed. See {@link SOCKET_OPEN}. */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** `WebSocket.OPEN`, spelled out so this module never touches the global. */
export const SOCKET_OPEN = 1;

/**
 * Builds a socket for a URL. This is the injection point.
 *
 * It is called once per connection attempt, so a factory that wants to add a
 * subprotocol, an agent or a proxy gets a fresh chance on every reconnect.
 */
export type CableSocketFactory = (url: string) => CableSocket;

/**
 * The clock and the timer, injected together so tests are deterministic.
 *
 * The reconnect backoff and the ping watchdog are the two things in here that
 * are hard to test against a real clock and easy to test against a fake one.
 * Defaults to `globalThis`.
 */
export interface CableTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds since the epoch. Only differences are ever used. */
  now(): number;
}

/** A credential for the handshake: a token, a thunk, or nothing (cookie auth). */
export type CableCredential =
  | string
  | null
  | undefined
  | (() => string | null | undefined | Promise<string | null | undefined>);

// ---------------------------------------------------------------------------
// Connection options and lifecycle
// ---------------------------------------------------------------------------

/** Options for {@link RealtimeNamespace.connect}. */
export interface CableConnectOptions {
  /**
   * The credential, sent as `?token=` on the handshake URL.
   *
   * Omit it (or pass `null`) for cookie auth: on a first-party page the
   * browser attaches the httpOnly session cookie to a same-site WebSocket
   * handshake by itself, and the server's third credential candidate picks it
   * up. Omitting is NOT the same as passing `""` in intent, but it is the same
   * on the wire - both produce a bare `/cable` - so either works.
   *
   * A function is resolved on every connection attempt, which is what makes a
   * rotating token survive a reconnect. It must not throw; if it does, the
   * attempt is treated as a failed connect and retried on the backoff.
   *
   * Read trap 3 in the module docs before passing an OAuth access token here:
   * the cable does not understand them and will silently connect as nobody.
   */
  readonly token?: CableCredential;
  /**
   * How to build the socket. Required on any runtime without a global
   * `WebSocket`, and the seam every test uses.
   */
  readonly socket?: CableSocketFactory;
  /** Clock and timer. Defaults to `globalThis`. */
  readonly timers?: CableTimers;
  /**
   * Cable endpoint, absolute or relative to the API root. Defaults to
   * `/cable` under the client's `baseUrl`, with `http`/`https` rewritten to
   * `ws`/`wss`.
   */
  readonly path?: string;
  /** First reconnect delay in ms. Defaults to 1000. */
  readonly reconnectInitialMs?: number;
  /** Ceiling for the doubling backoff in ms. Defaults to 30000. */
  readonly reconnectMaxMs?: number;
  /**
   * How long a welcomed socket may go without a frame before it is presumed
   * dead and cycled. Defaults to 25000, against a ~3 s server ping.
   *
   * `0` disables the watchdog. Disable it only if you have another liveness
   * signal: a TCP connection that a NAT or a sleeping radio dropped stays
   * `readyState === 1` forever on several runtimes, so `onclose` never fires
   * and, without this, neither does the reconnect.
   */
  readonly staleAfterMs?: number;
  /** Called on every connection-level state transition. */
  readonly onStateChange?: (state: CableState) => void;
}

/**
 * Connection state.
 *
 * `"connected"` means WELCOMED, not merely open: a socket that has completed
 * the TCP and HTTP upgrade but not yet received `welcome` cannot carry a single
 * command, so calling it connected would be a lie the caller acts on.
 */
export type CableState = "closed" | "connecting" | "connected";

/** Per-subscription callbacks. All optional except {@link onMessage}. */
export interface CableHandlers<TMessage = unknown> {
  /**
   * One stream payload. This is the `message` field of the frame, already
   * parsed - the envelope never reaches here.
   */
  onMessage(message: TMessage): void;
  /**
   * `confirm_subscription` arrived. Fires again after every reconnect, because
   * a reconnect re-subscribes; treat it as "the channel is live now", not as
   * "the channel just became live for the first time".
   */
  onConfirm?(): void;
  /**
   * `reject_subscription` arrived. On this API that almost always means one of
   * two things and they are worth telling apart: the connection is anonymous
   * (trap 2 - a bad token, an OAuth token, or no credential), or the specific
   * resource is gone or was never yours (a jam that ended, a job you may not
   * read). Neither is retryable by resubscribing; both need the caller to do
   * something.
   */
  onReject?(): void;
  /**
   * The underlying socket dropped while this subscription was live. The
   * subscription is NOT cancelled - see {@link CableSubscription} - so this is
   * a "show the reconnecting spinner" signal, not a teardown.
   */
  onDisconnect?(): void;
}

/** A live subscription. */
export interface CableSubscription {
  /**
   * The exact identifier string this subscription is keyed by. Exposed because
   * it is the thing to log when a channel confirms and then stays silent.
   */
  readonly identifier: string;
  /**
   * Sends `{"command":"message"}` with `{"action": action, ...data}`.
   *
   * A no-op when the connection is not welcomed, matching the server, which
   * discards pre-welcome frames without answering. There is deliberately no
   * queue: every action on this API is either idempotent state (a snapshot
   * request, a heartbeat) or positional and stale by the time a socket comes
   * back (a position tick, a seek). Replaying them on reconnect would push
   * playback backwards.
   */
  perform(action: string, data?: Record<string, unknown>): void;
  /** Unsubscribes and forgets the identifier. Idempotent. */
  unsubscribe(): void;
  /** False once {@link unsubscribe} has run. */
  readonly active: boolean;
}

// ---------------------------------------------------------------------------
// The five channels that exist
// ---------------------------------------------------------------------------

/**
 * Every channel the server exposes, as of this writing.
 *
 * There are exactly five, and none of them is generic: each has its own
 * subscription params, its own rejection rule, and its own message vocabulary.
 * That is why this module exposes five typed helpers rather than one
 * `subscribe(channel, params)` - a caller who has to remember that
 * `JobChannel` takes a string id and `JamChannel` takes a number will get it
 * wrong, and the failure mode is a subscription that confirms and then never
 * fires.
 *
 * {@link CableConnection.channel} is still there for a sixth channel that
 * ships before this file is updated.
 */
export const CABLE_CHANNELS = [
  "PlaybackChannel",
  "JamChannel",
  "FriendListeningChannel",
  "JobChannel",
  "NotificationsChannel",
] as const;

/** One of {@link CABLE_CHANNELS}. */
export type CableChannelName = (typeof CABLE_CHANNELS)[number];

// --- PlaybackChannel -------------------------------------------------------

/**
 * The playback state as the cable serialises it.
 *
 * **Two id fields, two types.**
 *
 * - `queue` really is `string[]` coming back, whatever the client sent: the
 *   server stringifies it on write;
 * - `song_id` is sent as a string and comes back as a JSON NUMBER. Code that
 *   does `state.song_id === queue[i]` compares a number to a string and
 *   silently never matches.
 *
 * The rule that does hold everywhere is: normalise with `String(...)` at the
 * boundary and compare strings. This SDK types the fields as the wire actually
 * carries them, so the mismatch is a type error at your call site instead of a
 * bug at runtime.
 */
export interface PlaybackSnapshotState {
  readonly active_device_id: string | null;
  /** v1 shim, scheduled for removal. */
  readonly active_session_id: string | null;
  /** A NUMBER, not a string. See the note on this interface. */
  readonly song_id: number | null;
  readonly position: number;
  readonly paused: boolean;
  /** Song ids as strings, because the channel stringifies them on write. */
  readonly queue: readonly string[];
  readonly queue_index: number;
  /** Indices into `queue`, the shuffle permutation. */
  readonly queue_order: readonly number[];
  readonly loop_mode: "none" | "one" | "all";
  readonly shuffle: boolean;
  /**
   * The ACTIVE DEVICE's own output level. It rides the state so it survives a
   * reload, but it is explicitly not adopted on a takeover - a phone at 20%
   * must not set a laptop to 20%.
   */
  readonly volume: number;
  readonly playback_rate: number;
  readonly playback_mode: "original" | "instrumental" | "vocals" | "custom";
  readonly eq_low: number;
  readonly eq_mid: number;
  readonly eq_high: number;
  readonly eq_enabled: boolean;
  readonly separation_enabled: boolean;
  readonly vocal_volume: number;
  readonly instrumental_volume: number;
  /**
   * The full record of every queued song - by far the heaviest part of the
   * payload, and OMITTED whenever the queue itself did not change.
   *
   * This is the single most misread field on the cable. `state_changed` for a
   * volume drag carries a complete `state` with NO `queue_songs`; a client that
   * replaces its local state wholesale empties its own queue view on every
   * pause. Merge: take the new state, and keep the last `queue_songs` you saw
   * whenever this is `undefined`.
   */
  readonly queue_songs?: readonly unknown[];
}

/** One entry of the device picker. Online and offline rows differ in shape. */
export interface PlaybackDeviceEntry {
  /**
   * `"<session_id>:<tab_uuid>"` for an online device, a bare session id for an
   * offline one. Never the raw `device_id` you sent: the server composes it
   * from your session so one session cannot claim another's device.
   */
  readonly id: string;
  readonly label: string | null;
  readonly device_type: string | null;
  /** Offline rows only. */
  readonly description?: string;
  /** Online rows only. */
  readonly last_seen_at?: string;
  /** Offline rows only. */
  readonly last_used_at?: string;
  /**
   * `false` marks a recently used session with no live socket. Those rows are
   * DISPLAY ONLY - `transfer` to one answers `device_offline`.
   */
  readonly online: boolean;
}

/** Everything `PlaybackChannel` streams, discriminated on `type`. */
export type PlaybackMessage =
  | {
      readonly type: "snapshot";
      /** Always `2` from a current server. v1 clients saw no `v` at all. */
      readonly v: number;
      readonly state: PlaybackSnapshotState;
      readonly devices: readonly PlaybackDeviceEntry[];
      readonly active_device_id: string | null;
      /** The composed id of THIS subscription, or null for a v1 subscribe. */
      readonly your_device_id: string | null;
      readonly active_session_id: string | null;
      readonly your_session_id: string;
    }
  | {
      readonly type: "state_changed";
      readonly state: PlaybackSnapshotState;
      readonly active_device_id: string | null;
      /** Null when the change came from the server (a reap, an adoption). */
      readonly from_device_id: string | null;
      readonly from_session_id: string | null;
    }
  | {
      readonly type: "position_tick";
      readonly position: number;
      readonly paused: boolean;
      /**
       * A STRING here, unlike `state.song_id`, because the channel re-emits
       * what the publisher sent after a `\A\d{1,18}\z` match. `null` when the
       * publisher omitted it or sent something that did not match.
       *
       * It exists so a controller can DROP a tick describing a song it no
       * longer shows; without that check the old position flashes across every
       * track change.
       */
      readonly song_id: string | null;
      /** Server clock in epoch ms, for estimating drift. */
      readonly server_time: number;
      readonly from_device_id: string | null;
      readonly from_session_id: string | null;
    }
  | {
      readonly type: "devices_changed";
      readonly devices: readonly PlaybackDeviceEntry[];
      readonly active_device_id: string | null;
      readonly active_session_id: string | null;
    }
  | {
      readonly type: "command";
      readonly command: PlaybackCommandName;
      readonly args: Record<string, unknown>;
      /**
       * Execute ONLY when this is your own device id. The command is broadcast
       * to the whole user stream, so every one of that user's tabs sees every
       * remote control press; obeying one addressed to another device is how
       * two devices end up fighting over the same queue.
       */
      readonly target_device_id: string | null;
      readonly target_session_id: string | null;
      readonly from_device_id: string | null;
      readonly from_session_id: string | null;
    }
  | {
      /** A `claim_active` with `mode: "if_none"` lost the race. Stay passive. */
      readonly type: "claim_rejected";
      readonly active_device_id: string | null;
      readonly active_session_id: string | null;
    }
  | {
      /** Sent to the SENDER only: a command was issued with nothing to run it. */
      readonly type: "no_active_device";
      readonly active_device_id: null;
    }
  | {
      /** The active device could not autoplay. Surface "tap to resume". */
      readonly type: "activation_blocked";
      readonly device_id: string | null;
    }
  | {
      /**
       * Sent to the SENDER only. `reason` is one of `not_active_device`,
       * `unknown_command`, `invalid_args`, `payload_too_large`,
       * `device_offline`, `queue_truncated`, or a model validation string.
       *
       * The right response to any of them is `request_snapshot`: an error means
       * your idea of the state and the server's have diverged, and every one of
       * these was raised while REFUSING a write, so nothing was broadcast to
       * put you back in sync.
       */
      readonly type: "error";
      readonly action: string;
      readonly reason: string;
    };

/**
 * The remote-control vocabulary.
 *
 * A name outside this set is answered with `error: unknown_command` and never
 * reaches a broadcast. `jam_add_song` is missing on purpose: the server builds
 * it itself so a client cannot forge a jam proposal.
 */
export type PlaybackCommandName =
  | "play"
  | "pause"
  | "toggle"
  | "next"
  | "previous"
  | "seek"
  | "set_queue_index"
  | "set_queue_order"
  | "set_shuffle"
  | "set_loop_mode"
  | "set_volume"
  | "add_to_queue"
  | "play_next"
  | "remove_from_queue"
  | "reorder_queue";

/** Subscription params for `PlaybackChannel`. */
export interface PlaybackSubscribeParams {
  /**
   * A per-tab, per-launch opaque token matching `[A-Za-z0-9-]{8,64}` - a
   * `crypto.randomUUID()` is the intended shape.
   *
   * The server prefixes it with your session id, so the id you see on the wire
   * is `"<session_id>:<this>"` and impersonating another session is impossible
   * by construction. An invalid shape does not error: it is treated as a v1
   * client with no device at all, which then fails every publisher action with
   * `not_active_device`. Sending nothing at all is the same thing.
   */
  readonly device_id?: string;
  /** Free text, truncated to 80 chars. Defaults to the session's name. */
  readonly device_label?: string;
  /**
   * The previous tab uuid of a reloading page.
   *
   * Without it, a reload leaves the old tab "online" until the 75 s registry
   * TTL expires, and if that tab was the active device every other device shows
   * "playing elsewhere" until then. With it, the ghost dies immediately and
   * activeness follows to the reborn tab (paused - the reload stopped audio).
   */
  readonly predecessor?: string;
}

/**
 * A `PlaybackChannel` subscription, with the eight client actions named.
 *
 * `perform` is still there for anything added server-side before this file
 * catches up, but every action the channel defines today has a method, because
 * the argument shapes are validated strictly and a typo in an action name is
 * silently ignored by the server rather than reported.
 */
export interface PlaybackSubscription extends CableSubscription {
  /**
   * Keeps the registry row alive. Send it every 20 s: the row's TTL is 75 s
   * and a device that stops beating drops off every picker.
   */
  heartbeat(): void;
  /**
   * Asks for a fresh `snapshot`, transmitted to this subscriber only.
   *
   * Send it after any cable `error`, and on every app foreground: a socket that
   * survived a background suspension is not a socket whose state is current.
   */
  requestSnapshot(): void;
  /**
   * Becomes the active device.
   *
   * `"if_none"` (the default) is a compare-and-set - it claims only if nothing
   * is active, and the loser gets `claim_rejected` and must stay passive.
   * `"steal"` is an unconditional takeover, which is what pressing play on a
   * second device means everywhere else and what starting a jam requires.
   */
  claimActive(mode?: "if_none" | "steal"): void;
  /**
   * Hands playback to another device.
   *
   * Only a device that is ONLINE right now can receive it; an offline picker
   * row answers `error: device_offline`. `target_session_id` is the v1 shim and
   * is mapped to that session's newest online device when there is one.
   */
  transfer(target: { device_id?: string; session_id?: string }): void;
  /**
   * Sends a remote-control command to whichever device is active.
   *
   * The whole frame is capped at 8 KiB. Args are schema-checked per command and
   * a mismatch is answered with `invalid_args` rather than clamped - unlike
   * `state_changed`, which clamps almost everything. `song_id` args must be a
   * STRING of digits.
   */
  command(command: PlaybackCommandName, args?: Record<string, unknown>): void;
  /**
   * Publishes a partial state. **Active device only** - anyone else gets
   * `error: not_active_device` and nothing is written.
   *
   * Debounce it to ~200 ms. The server clamps rather than rejects (queue to
   * 1000 entries, rate to 0.25-4, EQ to +/-12 dB, volumes to 0-1) and silently
   * STRIPS song ids you do not own, remapping `queue_order` and `queue_index`
   * around the holes, so what comes back may not be what you sent. Only a
   * truncation is reported, as `error: queue_truncated`.
   */
  publishState(payload: Record<string, unknown>): void;
  /**
   * The 1 Hz position heartbeat. **Active device only.**
   *
   * Cheap by design: the server persists at most every 5 s and broadcasts the
   * rest straight through. Send `song_id` as a digit STRING so listeners can
   * discard ticks from a track they have already left.
   */
  positionTick(tick: { position: number; paused: boolean; song_id?: string | number | null }): void;
  /**
   * Announces that autoplay was refused here. **Active device only.** Fans out
   * so every device can show the needs-a-tap hint.
   */
  activationBlocked(): void;
}

// --- JamChannel ------------------------------------------------------------

/**
 * Everything `JamChannel` streams.
 *
 * The channel is RECEIVE-ONLY: it defines no client actions at all, and every
 * jam mutation is a REST call on `/jams`. `perform` on a jam subscription
 * therefore does nothing useful, and the SDK does not offer a typed action for
 * it.
 */
export type JamMessage =
  | { readonly type: "snapshot"; readonly jam: unknown; readonly state: unknown }
  | { readonly type: "state_changed"; readonly state: unknown }
  | {
      readonly type: "position_tick";
      readonly position: number;
      readonly paused: boolean;
      /** A string, same as the playback tick. Correlate, do not trust ordering. */
      readonly song_id: string | null;
      readonly server_time: number;
    }
  | { readonly type: "members_changed"; readonly jam: unknown }
  | { readonly type: "jam_updated"; readonly jam: unknown }
  | {
      readonly type: "song_proposed";
      /** `song.id` is an INTEGER here. */
      readonly song: { readonly id: number; readonly title: string; readonly artist_names: string };
      readonly proposer: { readonly id: string; readonly handle: string; readonly name: string };
    }
  | {
      readonly type: "skip_votes";
      /** The host's playback `song_id`: a NUMBER, not a string. */
      readonly song_id: number | null;
      readonly count: number;
      readonly needed: number;
    }
  | { readonly type: "skipped" }
  | { readonly type: "ended" };

// --- FriendListeningChannel ------------------------------------------------

/** One friend's row in the listening feed. */
export interface FriendListening {
  readonly user: { readonly id: string; readonly handle: string; readonly name: string };
  /**
   * `null` when that friend turned sharing off. Presence and jam stay visible
   * either way, because joining a jam is an explicit social act and passive
   * listening data is not. `song.id` is an INTEGER.
   */
  readonly song: {
    readonly id: number;
    readonly title: string;
    readonly album: string | null;
    readonly duration: number | null;
    readonly owner_id: string;
    readonly artist_names: string;
    readonly artwork_url: string | null;
  } | null;
  readonly paused: boolean;
  /** A device of theirs was seen within 75 s. */
  readonly online: boolean;
  readonly jam_id: number | null;
  readonly updated_at: string | null;
}

/**
 * Everything `FriendListeningChannel` streams.
 *
 * `listening_update` is NOT wrapped: the snapshot nests its rows under
 * `friends`, but an update spreads one row's fields at the TOP LEVEL beside
 * `type`. Replace the row whose `user.id` matches, append when it is new.
 */
export type FriendListeningMessage =
  | { readonly type: "snapshot"; readonly friends: readonly FriendListening[] }
  | ({ readonly type: "listening_update" } & FriendListening);

// --- JobChannel ------------------------------------------------------------

/** Everything `JobChannel` streams. */
export interface JobMessage {
  /** Always `"snapshot"`, on subscribe and on every change alike. */
  readonly type: "snapshot";
  /** The job record, as `oms.jobs.get` answers it. Finished when `finished_at` is non-null. */
  readonly job: unknown;
}

/** Subscription params for `JobChannel`. */
export interface JobSubscribeParams {
  /** The job id. A STRING - jobs are among the string-id models. */
  readonly id: string;
  /**
   * A watch token minted at enqueue time, for a caller with no session.
   *
   * This is the one channel an anonymous connection can legitimately use: the
   * captcha-gated tools hand an anonymous user a signed token so they can watch
   * their own job. The token is checked to name THIS job id, so it is not a
   * general read capability.
   */
  readonly token?: string;
}

// --- NotificationsChannel --------------------------------------------------

/** Everything `NotificationsChannel` streams. */
export type NotificationsMessage =
  | {
      /** Sent on subscribe, and again whenever a read flag or a delete moves it. */
      readonly type: "unread_count";
      readonly unread_count: number;
    }
  | {
      readonly type: "created";
      /** The notification record. */
      readonly notification: unknown;
      readonly unread_count: number;
    };

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/**
 * One multiplexed cable connection.
 *
 * All five channels share a single WebSocket; the `identifier` is the
 * demultiplexing key. Open one of these per identity and keep it for the
 * lifetime of the session.
 *
 * ## What a reconnect does to your subscriptions
 *
 * Nothing you have to undo, and one thing you have to expect.
 *
 * The registry of subscriptions lives on the CONNECTION, not on the socket. A
 * drop clears the welcomed flag, fires {@link CableHandlers.onDisconnect} on
 * every live subscription, and schedules a reopen; the identifiers stay in the
 * map. When the new socket says `welcome`, EVERY identifier still in that map
 * is re-subscribed, in insertion order, and each one confirms again through
 * {@link CableHandlers.onConfirm}. Your {@link CableSubscription} handle stays
 * valid across all of it - you never re-subscribe by hand and you must not, or
 * you will end up with the same identifier registered twice.
 *
 * The thing to expect is that server-side subscribe-time work RUNS AGAIN.
 * Concretely: `PlaybackChannel` re-registers the device and re-broadcasts
 * `devices_changed`, every channel re-transmits its snapshot, and
 * `FriendListeningChannel` re-reads the friend roster. That last one is
 * load-bearing in the other direction too - the roster is fixed at subscribe
 * time, so a new friend or a privacy flip only appears after a resubscribe;
 * resubscribe it on foreground.
 *
 * The thing that does NOT happen is a replay of anything you sent. Frames sent
 * while disconnected are dropped, not queued: see {@link CableSubscription.perform}.
 *
 * A rejection is remembered as a rejection only by your handler. The identifier
 * stays in the map, so a reconnect re-subscribes it and it is rejected again.
 * If a rejection means "give up" - and on this API it usually does, see trap 2 -
 * call `unsubscribe()` from your `onReject`.
 */
export interface CableConnection {
  /** Current state. `"connected"` means welcomed. */
  readonly state: CableState;
  /** The URL of the current attempt, with the token redacted. For logs. */
  readonly url: string;
  /** How many identifiers are registered right now, live or rejected. */
  readonly subscriptionCount: number;

  /**
   * Subscribes to any channel by its params object.
   *
   * The escape hatch, and the primitive the five typed helpers are built on.
   * `channel` is required; every other key becomes a subscription param. Key
   * insertion order becomes the identifier's byte order, and the SDK never
   * re-serialises it, so any order works as long as it is yours.
   */
  channel<TMessage = unknown>(
    params: { channel: string } & Record<string, unknown>,
    handlers: CableHandlers<TMessage>,
  ): CableSubscription;

  /**
   * `PlaybackChannel` - remote playback, device presence, and the host half of
   * a jam. Rejected for an anonymous connection, and rejected outright when
   * `device_id` is present but malformed.
   */
  playback(
    params: PlaybackSubscribeParams,
    handlers: CableHandlers<PlaybackMessage>,
  ): PlaybackSubscription;

  /**
   * `JamChannel` - receive-only. JOIN OVER REST FIRST: the channel rejects
   * anyone who is not already a member of an ACTIVE jam, and a rejection
   * arriving mid-jam means the jam is gone. Clear your state; do not retry.
   */
  jam(jamId: number, handlers: CableHandlers<JamMessage>): CableSubscription;

  /**
   * `FriendListeningChannel` - the friends-are-listening feed. Takes no params.
   * The roster is captured at subscribe time; resubscribe to refresh it.
   */
  friendListening(handlers: CableHandlers<FriendListeningMessage>): CableSubscription;

  /**
   * `JobChannel` - one job's progress, replacing a poll loop. Pair it with a
   * slow REST poll (~10 s) anyway: a job that finished before you subscribed
   * still sends its snapshot, but a socket that dies mid-job does not.
   */
  job(params: JobSubscribeParams, handlers: CableHandlers<JobMessage>): CableSubscription;

  /** `NotificationsChannel` - one per-user stream for every signed-in device. */
  notifications(handlers: CableHandlers<NotificationsMessage>): CableSubscription;

  /**
   * Closes the socket and stops reconnecting. Subscriptions are dropped.
   * Idempotent; the connection cannot be reopened - build a new one.
   */
  close(): void;
}

interface Registration {
  readonly handlers: CableHandlers<never>;
  live: boolean;
}

class CableConnectionImpl implements CableConnection {
  private readonly base: string;
  private readonly credential: CableCredential;
  private readonly makeSocket: CableSocketFactory;
  private readonly timers: CableTimers;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly staleAfterMs: number;
  private readonly onStateChange: ((state: CableState) => void) | undefined;

  private readonly subs = new Map<string, Registration>();
  private socket: CableSocket | null = null;
  private welcomed = false;
  private stateValue: CableState = "closed";
  private closed = false;
  private delay: number;
  private reconnectHandle: unknown = null;
  private watchdogHandle: unknown = null;
  private lastFrameAt = 0;
  /**
   * Bumped on every open attempt. The token may be resolved asynchronously, so
   * a slow provider can hand back a token for a connection that has since been
   * superseded or closed; the generation check throws that result away instead
   * of opening a second socket nobody is listening to.
   */
  private generation = 0;

  constructor(base: string, options: CableConnectOptions) {
    this.base = base;
    this.credential = options.token;
    this.makeSocket = options.socket ?? defaultSocketFactory;
    this.timers = options.timers ?? defaultTimers();
    this.initialDelay = options.reconnectInitialMs ?? 1_000;
    this.maxDelay = options.reconnectMaxMs ?? 30_000;
    this.staleAfterMs = options.staleAfterMs ?? 25_000;
    this.onStateChange = options.onStateChange;
    this.delay = this.initialDelay;
    this.open();
  }

  get state(): CableState {
    return this.stateValue;
  }

  get url(): string {
    return this.base;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  channel<TMessage = unknown>(
    params: { channel: string } & Record<string, unknown>,
    handlers: CableHandlers<TMessage>,
  ): CableSubscription {
    const identifier = JSON.stringify(params);
    const registration: Registration = { handlers: handlers as CableHandlers<never>, live: true };
    // Replacing an identifier that is already registered would leave the old
    // handlers unreachable while the server still considers one subscription
    // open, so say so instead of papering over it.
    if (this.subs.has(identifier)) {
      throw new OmsNetworkError(
        `Already subscribed to ${identifier}. Subscriptions are keyed by identifier, so a second one would shadow the first: reuse the handle, or unsubscribe before resubscribing.`,
      );
    }
    this.subs.set(identifier, registration);
    if (this.welcomed) this.send({ command: "subscribe", identifier });

    const self = this;
    return {
      identifier,
      get active(): boolean {
        return registration.live;
      },
      perform(action: string, data: Record<string, unknown> = {}): void {
        if (!registration.live || !self.welcomed) return;
        self.send({
          command: "message",
          identifier,
          // `data` is a JSON STRING, not an object. The server parses it a
          // second time on arrival; an object here is silently ignored.
          data: JSON.stringify({ action, ...data }),
        });
      },
      unsubscribe(): void {
        if (!registration.live) return;
        registration.live = false;
        self.subs.delete(identifier);
        if (self.welcomed) self.send({ command: "unsubscribe", identifier });
      },
    };
  }

  playback(
    params: PlaybackSubscribeParams,
    handlers: CableHandlers<PlaybackMessage>,
  ): PlaybackSubscription {
    // Built key-by-key so the identifier carries only the params that were
    // actually given: JSON.stringify drops `undefined` values, which is exactly
    // what "the client did not send this param" has to look like on the wire.
    const base = this.channel<PlaybackMessage>(
      {
        channel: "PlaybackChannel",
        ...(params.device_id === undefined ? {} : { device_id: params.device_id }),
        ...(params.device_label === undefined ? {} : { device_label: params.device_label }),
        ...(params.predecessor === undefined ? {} : { predecessor: params.predecessor }),
      },
      handlers,
    );
    return Object.assign(base, {
      heartbeat: (): void => base.perform("heartbeat"),
      requestSnapshot: (): void => base.perform("request_snapshot"),
      claimActive: (mode: "if_none" | "steal" = "if_none"): void =>
        base.perform("claim_active", { mode }),
      transfer: (target: { device_id?: string; session_id?: string }): void =>
        base.perform("transfer", {
          ...(target.device_id === undefined ? {} : { target_device_id: target.device_id }),
          ...(target.session_id === undefined ? {} : { target_session_id: target.session_id }),
        }),
      command: (command: PlaybackCommandName, args: Record<string, unknown> = {}): void =>
        base.perform("command", { command, args }),
      publishState: (payload: Record<string, unknown>): void =>
        base.perform("state_changed", { payload }),
      positionTick: (tick: {
        position: number;
        paused: boolean;
        song_id?: string | number | null;
      }): void =>
        base.perform("position_tick", {
          position: tick.position,
          paused: tick.paused,
          // Stringified here because the server matches it against
          // `\A\d{1,18}\z` and re-emits the string; a number would still match
          // after `to_s`, but sending the shape the wire uses keeps the
          // round trip identical for every publisher.
          song_id: tick.song_id === null || tick.song_id === undefined ? null : String(tick.song_id),
        }),
      activationBlocked: (): void => base.perform("activation_blocked"),
    });
  }

  jam(jamId: number, handlers: CableHandlers<JamMessage>): CableSubscription {
    // A NUMBER: jams are one of the integer-id models, and `'{"id":"7"}'` is a
    // different identifier string from `'{"id":7}'`.
    return this.channel<JamMessage>({ channel: "JamChannel", id: jamId }, handlers);
  }

  friendListening(handlers: CableHandlers<FriendListeningMessage>): CableSubscription {
    return this.channel<FriendListeningMessage>({ channel: "FriendListeningChannel" }, handlers);
  }

  job(params: JobSubscribeParams, handlers: CableHandlers<JobMessage>): CableSubscription {
    return this.channel<JobMessage>(
      {
        channel: "JobChannel",
        id: params.id,
        ...(params.token === undefined ? {} : { token: params.token }),
      },
      handlers,
    );
  }

  notifications(handlers: CableHandlers<NotificationsMessage>): CableSubscription {
    return this.channel<NotificationsMessage>({ channel: "NotificationsChannel" }, handlers);
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.clearReconnect();
    this.teardownSocket();
    for (const registration of this.subs.values()) registration.live = false;
    this.subs.clear();
    this.setState("closed");
  }

  // ----- internals ---------------------------------------------------------

  private setState(next: CableState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    try {
      this.onStateChange?.(next);
    } catch {
      // A state listener must never be able to break the socket it observes.
    }
  }

  private open(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.setState("connecting");
    void this.resolveToken().then(
      (token) => {
        if (this.closed || generation !== this.generation) return;
        this.attach(token, generation);
      },
      () => {
        // A credential provider that throws is a transient failure like any
        // other: retry it on the backoff rather than wedging the connection.
        if (this.closed || generation !== this.generation) return;
        this.scheduleReconnect();
      },
    );
  }

  private async resolveToken(): Promise<string | null> {
    const credential = this.credential;
    if (credential === undefined || credential === null) return null;
    if (typeof credential === "string") return credential;
    return (await credential()) ?? null;
  }

  private attach(token: string | null, generation: number): void {
    let socket: CableSocket;
    try {
      socket = this.makeSocket(handshakeUrl(this.base, token));
    } catch {
      // A constructor that throws (a bad URL, a runtime with no WebSocket)
      // never produces an `onclose`, so the retry has to be scheduled here.
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastFrameAt = this.timers.now();

    const current = (): boolean => this.socket === socket && generation === this.generation;

    socket.onopen = (): void => {
      if (!current()) return;
      // Still "connecting": an open socket is not a welcomed one, and nothing
      // may be sent until the server says so.
      this.lastFrameAt = this.timers.now();
      this.armWatchdog();
    };

    socket.onmessage = (event: { data: unknown }): void => {
      if (!current()) return;
      // Every frame counts as liveness, `ping` included - that is the whole
      // point of the watchdog, since an idle connection sends nothing else.
      this.lastFrameAt = this.timers.now();
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (typeof parsed !== "object" || parsed === null) return;
        frame = parsed as Record<string, unknown>;
      } catch {
        // Garbage on the wire is not worth killing a healthy socket over.
        return;
      }
      this.handleFrame(frame);
    };

    socket.onclose = (): void => {
      if (!current()) return;
      this.socket = null;
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      this.clearWatchdog();
      this.setState("closed");
      if (wasWelcomed) {
        // Only tell subscribers about a drop they could have noticed. A socket
        // that died before `welcome` never delivered anything to interrupt.
        for (const registration of [...this.subs.values()]) {
          if (!registration.live) continue;
          try {
            registration.handlers.onDisconnect?.();
          } catch {
            // One subscriber's failure must not strand the others.
          }
        }
      }
      this.scheduleReconnect();
    };

    socket.onerror = (): void => {
      if (!current()) return;
      // `error` is advisory and is always followed by `close` on every runtime
      // that matters; closing here just makes sure of it.
      try {
        socket.close();
      } catch {
        // Closing a socket that is already dying is allowed to throw.
      }
    };
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = frame["type"];
    if (type === "welcome") {
      this.welcomed = true;
      this.delay = this.initialDelay;
      this.setState("connected");
      this.armWatchdog();
      // The whole registry, in insertion order. See the note on
      // CableConnection about what this re-runs server-side.
      for (const identifier of [...this.subs.keys()]) {
        this.send({ command: "subscribe", identifier });
      }
      return;
    }
    if (type === "ping") return;
    if (type === "disconnect") {
      // `reconnect: false` is the server saying "do not come back" - a session
      // was revoked, or the app told this connection to stop. Honour it, or
      // build a reconnect loop that can never succeed.
      if (frame["reconnect"] === false) this.closed = true;
      this.cycleSocket();
      return;
    }
    const identifier = frame["identifier"];
    if (typeof identifier !== "string") return;
    const registration = this.subs.get(identifier);
    if (registration === undefined || !registration.live) return;

    if (type === "confirm_subscription") {
      this.safely(() => registration.handlers.onConfirm?.());
      return;
    }
    if (type === "reject_subscription") {
      this.safely(() => registration.handlers.onReject?.());
      return;
    }
    // Anything else with an identifier is a stream payload. It has no `type` of
    // its own; the application-level `type` lives inside `message`.
    const message = frame["message"];
    if (message === undefined) return;
    this.safely(() => registration.handlers.onMessage(message as never));
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch {
      // A throwing handler must not take down the connection or the other
      // subscriptions sharing it. The SDK core cannot log, so it swallows.
    }
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // A send on a closing socket is a no-op; `onclose` owns the recovery.
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectHandle !== null) return;
    const delay = this.delay;
    // Doubling, capped, reset only by a `welcome`. Capping matters more here
    // than on HTTP: `/cable` is exempt from every rate limit, so nothing on the
    // server side would slow a runaway reconnect loop down for us.
    this.delay = Math.min(this.delay * 2, this.maxDelay);
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = null;
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectHandle === null) return;
    this.timers.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = null;
  }

  /**
   * Presumes a silent socket dead and cycles it.
   *
   * The server pings every ~3 s no matter what, so silence is not idleness: it
   * is a connection whose other end is gone. That happens constantly on mobile
   * (a NAT rebind, a radio asleep) and the socket is left `readyState === 1`
   * with no `onclose` ever firing, so without this the reconnect never starts.
   */
  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.staleAfterMs <= 0 || !this.welcomed) return;
    const elapsed = this.timers.now() - this.lastFrameAt;
    const wait = Math.max(this.staleAfterMs - elapsed, 0);
    this.watchdogHandle = this.timers.setTimeout(() => {
      this.watchdogHandle = null;
      if (this.closed || !this.welcomed) return;
      if (this.timers.now() - this.lastFrameAt >= this.staleAfterMs) {
        this.cycleSocket();
        return;
      }
      // A frame landed while the timer was pending: re-arm for what is left
      // rather than waking on a fixed interval.
      this.armWatchdog();
    }, wait);
  }

  private clearWatchdog(): void {
    if (this.watchdogHandle === null) return;
    this.timers.clearTimeout(this.watchdogHandle);
    this.watchdogHandle = null;
  }

  /** Closes the socket and lets `onclose` run the normal recovery path. */
  private cycleSocket(): void {
    const socket = this.socket;
    if (socket === null) return;
    try {
      socket.close();
    } catch {
      // `onclose` still runs.
    }
  }

  /** Detaches and closes without letting the handlers fire. */
  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    this.clearWatchdog();
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already dying.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Turns the API root into the cable endpoint.
 *
 * `https://backend.omelhorsite.pt` becomes
 * `wss://backend.omelhorsite.pt/cable`. The scheme swap is a prefix rewrite
 * rather than a `URL` round trip on purpose: `URL` is not universally available
 * on the runtimes this SDK targets, and the only two schemes the API is ever
 * served under are `http` and `https`.
 */
export function cableEndpoint(baseUrl: string, path = "/cable"): string {
  if (/^wss?:\/\//i.test(path)) return path;
  if (/^https?:\/\//i.test(path)) return path.replace(/^http/i, "ws");
  const root = baseUrl.replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Appends the credential as `?token=`, or returns the bare URL.
 *
 * The token goes in the query and NOWHERE else. A browser cannot put a header
 * on a WebSocket handshake at all, and on the runtimes that can, doing so would
 * hit trap 1: the handshake takes the first non-blank candidate, header first,
 * so any header at all - including a stale one - decides the identity and the
 * query param is never consulted.
 *
 * An empty string is treated as no credential, which is the cookie-auth case:
 * the handshake goes out bare and the browser attaches the httpOnly session
 * cookie itself. That only works same-site.
 */
export function handshakeUrl(endpoint: string, token: string | null | undefined): string {
  if (token === null || token === undefined || token === "") return endpoint;
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/** Reads `globalThis.WebSocket`, or explains which option to pass. */
const defaultSocketFactory: CableSocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => CableSocket }).WebSocket;
  if (typeof ctor !== "function") {
    throw new OmsNetworkError(
      "No WebSocket implementation available. Pass one to realtime.connect({ socket: (url) => new WS(url) }): the SDK never reaches for a global it cannot guarantee.",
      { url },
    );
  }
  return new ctor(url);
};

/**
 * The platform clock and timer.
 *
 * Built inside a function rather than as a module constant so that nothing is
 * read at import time: the SDK must load cleanly in an isolate that has not
 * decided what its globals are yet.
 */
function defaultTimers(): CableTimers {
  return {
    setTimeout: (handler: () => void, ms: number): unknown => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle: unknown): void => globalThis.clearTimeout(handle as number),
    now: (): number => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

/**
 * The `realtime` namespace, reachable as `oms.realtime`.
 *
 * It holds no socket of its own. {@link connect} builds one and hands it back,
 * so a host that needs two identities (a signed-in user and an anonymous job
 * watcher) gets two connections rather than a hidden singleton it cannot
 * separate.
 *
 * ## Why the credential is passed in and not taken from the client
 *
 * `Oms` already holds a credential, and this namespace deliberately does not
 * reach into it. Two reasons:
 *
 * - the cable resolves ONLY session tokens, so the OAuth access token an `Oms`
 *   may be carrying is not a cable credential at all - silently reusing it
 *   would hand you an anonymous connection;
 * - `sessionCookie: true` clients have no token to reuse, and their handshake
 *   needs no `?token=` because the browser sends the cookie. For those, pass
 *   nothing.
 *
 * ## Rate limits
 *
 * None. `/cable` is exempt, so neither the 600 requests a minute authed
 * ceiling nor the 120 a minute anonymous one applies to the handshake or to
 * any frame after it. The backoff in {@link CableConnectOptions.reconnectMaxMs}
 * is therefore the only thing standing between a restarting server and a
 * reconnect storm; it is not decorative.
 */
export class RealtimeNamespace extends Resource {
  /**
   * Opens a cable connection. Connecting starts immediately.
   *
   * The returned {@link CableConnection} is usable before it is welcomed:
   * subscriptions made now are registered and sent the moment `welcome`
   * arrives, which is the normal way to use it - there is no "wait until
   * connected" step and you should not build one.
   *
   * ```ts
   * const cable = oms.realtime.connect({
   *   token: sessionToken,          // a Session token, NOT an OAuth one
   *   socket: (url) => new WebSocket(url),
   *   onStateChange: (s) => setBadge(s),
   * });
   *
   * const playback = cable.playback(
   *   { device_id: crypto.randomUUID(), device_label: "Laptop" },
   *   {
   *     onMessage: (msg) => {
   *       if (msg.type === "snapshot") hydrate(msg.state);
   *       if (msg.type === "error") playback.requestSnapshot();
   *     },
   *     onReject: () => signOut(),   // anonymous connection: see trap 2
   *     onConfirm: () => playback.claimActive("if_none"),
   *   },
   * );
   * ```
   */
  connect(options: CableConnectOptions = {}): CableConnection {
    return new CableConnectionImpl(cableEndpoint(this.http.baseUrl, options.path), options);
  }

  /**
   * The cable URL this client would use, without a credential.
   *
   * Useful for a host that wants to open the socket itself (an Expo background
   * task, a Worker Durable Object) and only needs the SDK to agree with it on
   * where `/cable` lives.
   */
  endpoint(path?: string): string {
    return cableEndpoint(this.http.baseUrl, path);
  }
}
