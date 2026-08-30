/**
 * The `music.social` namespace: jams, the music half of a public profile, the
 * music storage meter, the chat assistant and the DJ.
 *
 * None of these is a CRUD resource. The payloads are bespoke, none carries the
 * `id`/`created_at`/`updated_at` base fields as a matter of course, none
 * accepts the list DSL (`search[...]`, `exact_search[...]`, `modifiers[page]`),
 * and there is no paging: every listing is a whole bare array with a
 * server-side cap, so no method returns a `Paginated`.
 *
 * ## A jam is half HTTP and half realtime, and this file is the HTTP half
 *
 * Every method below performs an ACTION and returns what that action produced.
 * None of them tells you what the jam is doing right now. The host's current
 * song and position, the queue members are watching, the running skip tally,
 * "somebody joined", "the jam ended" - all of that arrives over the realtime
 * WebSocket, on two streams this SDK does not open and has no code for:
 *
 * - `jam:<jam_id>` (see {@link jamStreamName}), carrying `snapshot`,
 *   `state_changed`, `position_tick`, `members_changed`, `jam_updated`,
 *   `song_proposed`, `skip_votes`, `skipped` and `ended`. It is RECEIVE-ONLY:
 *   every mutation in a jam is one of the HTTP calls below.
 * - `playback:user:<host_id>`, the host's own playback stream, where
 *   {@link MusicJamsNamespace.propose} and a passing
 *   {@link MusicJamsNamespace.skipVote} deposit a `command` for the host's
 *   player to execute.
 *
 * Two consequences to design around:
 *
 * 1. **Join over HTTP first, subscribe second.** The jam stream admits members
 *    only, so a subscription opened before `POST /jams/:id/join` has returned
 *    is rejected. A rejection later in the session means the jam ended or you
 *    were dropped - clear local state, do not retry-loop.
 * 2. **A `200` from `propose` means "the message was sent", not "the song is
 *    queued".** The song enters the jam when the HOST's client acts on the
 *    `jam_add_song` command; a host whose app is backgrounded and disconnected
 *    never acts on it, and nothing reports that back. The same is true of a
 *    `skipVote` that returns `skipped: true`.
 *
 * ## Rate limits
 *
 * Every path here sits under the general authenticated ceiling of **600
 * requests a minute**, keyed by the `Authorization` header. The single extra
 * ceiling is forty DJ generations per user per hour, shared between
 * `/music_dj` and `/music_dj/batch` and counted per REQUEST, refused ones
 * included, which is why {@link MusicDjNamespace} turns retrying off by
 * default - see {@link MUSIC_DJ_HOURLY_CAP}.
 *
 * ## An OAuth access token cannot reach any of this
 *
 * Every route in this file answers `403 {"error":"insufficient_scope"}` to an
 * OAuth access token, whatever scopes it was granted. Use a session token
 * (`POST /sessions`) or, in the browser, the session cookie.
 *
 * ## Errors are bare JSON strings
 *
 * `"Jam not found"`, `"Only friends of a jam member can join"`, `"Song not
 * found"`. There is no `{ error: ... }` object and no envelope; the SDK's
 * `OmsError` carries the string in `message`. One status is worth calling out
 * before it costs somebody a session: **a refused join or a refused host action
 * is `401`, not `403`**. A host-wide "on 401, log the user out" interceptor
 * will sign somebody out for tapping Join on the wrong jam. Test the message,
 * or scope the interceptor to the auth routes.
 */

import { Resource } from "../../http";
import type { Id, RequestOptions, Timestamp } from "../../types";
import type { Song, SongId } from "./songs";

/* ========================================================================== *
 * Jams
 * ========================================================================== */

/**
 * Primary key of a jam. An INTEGER, like songs, playlists and artists - and
 * unlike `host_id` and the member ids sitting beside it in the very same
 * payload, which are user ids and therefore strings. `MusicListeningSnapshot.jam_id` is the same integer, so a feed row
 * can be matched straight against {@link Jam.id}.
 */
export type JamId = number;

/** Who may feed the queue. */
export type JamQueueMode = "everyone" | "host";

/** What it takes for a skip to pass. */
export type JamSkipMode = "majority" | "host" | "anyone";

/** Every accepted `queue_mode`. Anything else is a `400`. */
export const JAM_QUEUE_MODES = ["everyone", "host"] as const;

/** Every accepted `skip_mode`. Anything else is a `400`. */
export const JAM_SKIP_MODES = ["majority", "host", "anyone"] as const;

/**
 * How many upcoming entries the realtime state payload carries. Nothing in
 * this file returns them - it is here so a client sizing its "up next" list
 * uses the server's number rather than a guess.
 */
export const JAM_UPCOMING_LIMIT = 10;

/**
 * How long a presigned `*_url` in any cross-user payload stays valid, in
 * milliseconds (six hours).
 *
 * The server caches each signature for five hours, so a URL you receive has at
 * least an hour of life left and the SAME string is handed out again across
 * broadcasts - deliberately, so a follower does not treat every pause/resume
 * as a new source and rebuffer. Compare songs by `id`, never by URL.
 */
export const MUSIC_PRESIGNED_URL_TTL_MS = 6 * 60 * 60 * 1000;

/** One participant, as the jam payload nests them. */
export interface JamMember {
  /** The USER's id, a string. Never a `jam_members` row id - that is not sent. */
  readonly id: Id;
  readonly handle: string;
  readonly name: string;
  /** True for exactly one member: the one whose id equals `jam.host_id`. */
  readonly is_host: boolean;
  /** When this member joined - the join row's `created_at`. */
  readonly joined_at: Timestamp;
}

/**
 * A jam.
 *
 * There is no `updated_at`, and `members` is a bespoke five-key object rather
 * than a user record, so none of the base-record guarantees the rest of the
 * API makes apply.
 *
 * `members` comes back ordered by join time, which normally puts the host
 * first - normally, not always. Find the host with {@link jamHost} rather than
 * by position.
 */
export interface Jam {
  readonly id: JamId;
  /** Owner of the jam. A user id, so a STRING beside this record's integer id. */
  readonly host_id: Id;
  /** Defaults to `"everyone"` at creation. */
  readonly queue_mode: JamQueueMode;
  /** Defaults to `"majority"` at creation. */
  readonly skip_mode: JamSkipMode;
  readonly created_at: Timestamp;
  /**
   * `null` while the jam is live.
   *
   * Every route here only sees live jams, so an ended jam answers `404` rather
   * than a payload with a timestamp in this field. You will only ever see a
   * non-null value on a copy you were already holding, or on one that arrived
   * over the realtime stream.
   */
  readonly ended_at: Timestamp | null;
  readonly members: JamMember[];
}

/**
 * `GET /jams`: the caller's own jam, plus the jams they are allowed to join.
 *
 * `joinable` is not "every live jam". It is the live jams containing at least
 * one ACCEPTED FRIEND of the caller - which is the exact predicate
 * {@link MusicJamsNamespace.join} authorizes against, so the list can never
 * offer a jam that would then refuse you. The caller's own jam is excluded.
 */
export interface JamsIndex {
  /** The live jam the caller belongs to, or `null`. At most one, ever. */
  readonly current: Jam | null;
  /** Live jams with a friend in them, minus {@link JamsIndex.current}. */
  readonly joinable: Jam[];
}

/**
 * The rules a host may change. Both fields optional; sending an empty object is
 * an accepted no-op that still broadcasts `jam_updated` to everyone.
 */
export interface UpdateJamRulesInput {
  readonly queue_mode?: JamQueueMode;
  readonly skip_mode?: JamSkipMode;
}

/** `POST /jams/:id/skip_vote` in full. */
export interface JamSkipVoteResult {
  /**
   * True when this vote carried the skip and the host's player was told to
   * advance. Also true, always and immediately, when the voter is the host.
   */
  readonly skipped: boolean;
  /** Distinct voters for the CURRENT song, this one included. */
  readonly count: number;
  /** Votes required: `1` under `"anyone"`, `floor(members / 2) + 1` otherwise. */
  readonly needed: number;
}

/* ========================================================================== *
 * Music profile and the listening feed shapes
 * ========================================================================== */

/**
 * A song as the cross-user payloads render it: the seven fields somebody who
 * does NOT own the track is allowed to see.
 *
 * `id` is a JSON NUMBER here, exactly like `Song.id` everywhere else in the
 * REST API. Song ids become strings only on the realtime stream
 * (`position_tick.song_id`); do not stringify this one, or
 * `snapshot.song.id === song.id` is always false.
 */
export interface MusicListeningSong {
  /** Integer song id. */
  readonly id: number;
  readonly title: string;
  readonly album: string | null;
  /** Whole seconds. */
  readonly duration: number;
  /** The OWNER's user id, a string. Not the viewer's. */
  readonly owner_id: Id;
  /** Pre-joined credits, `", "`-separated. An empty string when there are none. */
  readonly artist_names: string;
  /**
   * A PRESIGNED absolute URL, already usable, and short-lived
   * ({@link MUSIC_PRESIGNED_URL_TTL_MS}).
   *
   * The viewer does not own the underlying attachment, so `/media/:id/data`
   * would refuse it - use this string verbatim and never try to re-derive one
   * from the id. `null` is a real outcome: a failed presign yields `null`
   * rather than an error.
   */
  readonly artwork_url: string | null;
}

/**
 * What a friend may see about somebody's playback, and the shape the friends
 * feed pushes over `listening:user:<id>` with a `type: "listening_update"` key
 * merged in AT THE TOP LEVEL, not nested.
 */
export interface MusicListeningSnapshot {
  readonly user: { readonly id: Id; readonly handle: string; readonly name: string };
  /**
   * `null` when nothing is playing OR when the user turned `share_listening`
   * off. The two are deliberately indistinguishable.
   */
  readonly song: MusicListeningSong | null;
  /** `true` when there is no playback state at all, not only when paused. */
  readonly paused: boolean;
  /** Whether a playback device was seen in the last 75 seconds. */
  readonly online: boolean;
  /**
   * The live jam they are in, or `null`. Survives `share_listening: false`
   * along with `online`, `paused` and `updated_at`: a jam is an explicit social
   * act, listening is passive, and only the passive half is hidden.
   */
  readonly jam_id: JamId | null;
  /** When the playback row last changed, or `null` when there is none. */
  readonly updated_at: Timestamp | null;
}

/** One row of {@link MusicProfileVisible.top_artists}. */
export interface MusicProfileArtist {
  /** Integer artist id, scoped to the PROFILE OWNER's library, never the viewer's. */
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  /** Cached Deezer picture set. Absolute public URLs; all set, or all null. */
  readonly picture: string | null;
  readonly picture_medium: string | null;
  readonly picture_big: string | null;
  readonly picture_xl: string | null;
  /** Last.fm's image. Almost always `null` - see the artists namespace. */
  readonly external_image_url: string | null;
  /** Presigned URL for the owner's uploaded avatar, or `null`. Use verbatim. */
  readonly image_url: string | null;
  /** Plays in the last 30 days. */
  readonly play_count: number;
}

/**
 * A profile the viewer is allowed to see. All six keys are always present on
 * a visible profile, which is why they are required here.
 */
export interface MusicProfileVisible {
  readonly visible: true;
  /** A full listening snapshot of the OWNER, same shape as a feed row. */
  readonly now_playing: MusicListeningSnapshot;
  /** Up to 8, over the last 30 days, most played first. */
  readonly top_artists: MusicProfileArtist[];
  /** Up to 10, over the last 30 days, most played first. */
  readonly top_songs: (MusicListeningSong & { readonly play_count: number })[];
  /** Up to 10 distinct songs, most recently played first. */
  readonly recent: (MusicListeningSong & { readonly last_played_at: Timestamp })[];
  /** Play events in the last 30 days. */
  readonly plays_30d: number;
}

/**
 * A profile the viewer may not see: `{ "visible": false }` and nothing else, at
 * status `200`.
 *
 * This is not an error and must not be handled as one. It is what a signed-in
 * stranger gets, what a friend of somebody with `share_listening` off gets, and
 * what you should render as nothing - a private profile is deliberately
 * indistinguishable from an empty one. A real `404` ("User not found.") means
 * the user does not exist; a `401` means you sent no credential, because the
 * route requires authentication.
 */
export interface MusicProfileHidden {
  readonly visible: false;
}

/**
 * `GET /users/:idOrHandle/music_profile`.
 *
 * A discriminated union: the five content fields are present together or
 * absent together. Narrow once with {@link isMusicProfileVisible} and the rest
 * is non-optional.
 */
export type MusicProfile = MusicProfileVisible | MusicProfileHidden;

/* ========================================================================== *
 * Music storage meter
 * ========================================================================== */

/**
 * `GET /music/storage`: bytes of music media stored, against the account's
 * ceiling.
 *
 * `limit_bytes` IS NULLABLE: an administrator can mark an account unlimited,
 * and the limit is then serialised as `null`, because JSON has no infinity.
 * So read {@link MusicStorageUsage.unlimited} FIRST. A client that divides
 * `used_bytes` by `limit_bytes` renders `NaN%`, and one that reads `null` as
 * `0` shows a permanently full bar to exactly the accounts that were given no
 * ceiling at all. {@link musicStorageRemaining} and
 * {@link musicStorageAffords} answer both questions without the arithmetic.
 * An ordinary account's ceiling is the default of 100 GiB.
 *
 * The same number is reported as `music_storage_bytes` by `GET /quotas`, and
 * the two cannot disagree. Use `oms.quotas.list()` when you want every ceiling
 * at once; use this when you want only this one.
 */
export interface MusicStorageUsage {
  /**
   * Sum of the DISTINCT blobs reachable from the account's songs, artists and
   * playlists. Computed live on every call - a blob shared by two records
   * counts once, exactly as it costs once in storage. It is also not free:
   * read it on a settings screen, not on a timer.
   */
  readonly used_bytes: number;
  /** The ceiling in bytes, or `null` when {@link unlimited} is `true`. */
  readonly limit_bytes: number | null;
  /** `true` when an administrator removed this account's ceiling. */
  readonly unlimited: boolean;
}

/* ========================================================================== *
 * Assistant
 * ========================================================================== */

/** Primary key of a persisted assistant chat. An INTEGER. */
export type MusicAssistantChatId = number;

/** Turns of history the server feeds the model. */
export const MUSIC_ASSISTANT_HISTORY_TURNS = 20;

/** Messages a chat keeps before the oldest fall off. */
export const MUSIC_ASSISTANT_CHAT_MAX_MESSAGES = 200;

/** Player actions one answer may carry. */
export const MUSIC_ASSISTANT_MAX_ACTIONS = 10;

/**
 * Largest request body `POST /music_assistant` accepts, in bytes. Over it is
 * `413 "Request too big"`, decided from `Content-Length` before any parsing.
 */
export const MUSIC_ASSISTANT_MAX_BODY_BYTES = 256 * 1024;

/**
 * How long a chat may sit idle before it seals itself, in milliseconds (two
 * days).
 *
 * It is COMPUTED against the clock at read time, never stored, so a summary
 * you cached yesterday can report `read_only: false` for a chat that is now
 * sealed. The `POST` is where you find out, with a `423`.
 */
export const MUSIC_ASSISTANT_READ_ONLY_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Default deadline for one assistant generation, in milliseconds.
 *
 * The client's global default is 60 s and a cold model routinely beats that
 * while still being on its way to an answer. Pass `timeoutMs` to override.
 */
export const MUSIC_ASSISTANT_TIMEOUT_MS = 90_000;

/** One turn of a conversation. */
export interface MusicAssistantMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Only on messages read back from a stored chat; never on ones you send. */
  readonly created_at?: Timestamp;
}

/** A stored session, without its transcript. */
export interface MusicAssistantChatSummary {
  readonly id: MusicAssistantChatId;
  /** The first 60 squished characters of the first user message. */
  readonly title: string;
  readonly last_message_at: Timestamp;
  /** See {@link MUSIC_ASSISTANT_READ_ONLY_AFTER_MS}: computed, so it can go stale. */
  readonly read_only: boolean;
}

/** A stored session with its transcript. */
export interface MusicAssistantChatDetail extends MusicAssistantChatSummary {
  /** Oldest first. Capped at {@link MUSIC_ASSISTANT_CHAT_MAX_MESSAGES}. */
  readonly messages: MusicAssistantMessage[];
}

/**
 * Snapshot of the caller's player, so the model can answer "pause this" and
 * "who sings this".
 *
 * The server applies a strict whitelist; a key that is not one of these nine
 * never reaches the prompt, silently. Every field is optional here because the
 * whitelist permits rather than requires.
 */
export interface MusicAssistantPlayerContext {
  readonly song_id?: number | null;
  readonly title?: string | null;
  readonly artist?: string | null;
  readonly playing?: boolean;
  /** `0` to `1`. */
  readonly volume?: number;
  readonly shuffle?: boolean;
  /** `"none"`, `"one"` or `"all"`. */
  readonly loop_mode?: string;
  /** Playback rate, `0.5` to `1.5`. */
  readonly rate?: number;
  readonly queue_length?: number;
}

/** A playlist the assistant created or changed during the turn. */
export interface MusicAssistantPlaylistRef {
  readonly id: number;
  readonly name: string;
  readonly song_count: number;
}

/**
 * A player command the server validated and the client executes LOCALLY.
 *
 * Nothing here runs on the server. The songs in `play` and `queue` arrive fully
 * serialised in the `GET /songs` shape and already scoped to what the caller
 * may play, so a client queues them without a second request and without
 * re-checking anything. Values are clamped server-side before they get here:
 * `set_volume` to `[0, 1]`, `set_rate` to `[0.5, 1.5]`, `sleep_timer.minutes`
 * to `[1, 600]`. An action the sanitiser did not recognise is DROPPED rather
 * than passed through, so an unknown `action` string should not appear - handle
 * one by ignoring it anyway, because this list grows.
 */
export type MusicAssistantAction =
  | { readonly action: "play"; readonly songs: Song[]; readonly shuffle: boolean }
  | { readonly action: "queue"; readonly songs: Song[]; readonly mode: "next" | "last" }
  | { readonly action: "pause" }
  | { readonly action: "resume" }
  | { readonly action: "skip" }
  | { readonly action: "previous" }
  | { readonly action: "set_shuffle"; readonly on: boolean }
  | { readonly action: "set_loop"; readonly mode: "none" | "one" | "all" }
  | { readonly action: "set_volume"; readonly value: number }
  | { readonly action: "set_rate"; readonly value: number }
  | { readonly action: "sleep_timer"; readonly minutes: number }
  | { readonly action: "sleep_timer"; readonly end_of_song: true }
  | { readonly action: "sleep_timer"; readonly off: true }
  | { readonly action: "open"; readonly target: "playlist"; readonly playlist_id: number }
  | { readonly action: "open"; readonly target: "artist"; readonly artist: string }
  | { readonly action: "open"; readonly target: "album"; readonly artist: string | null; readonly album: string }
  | { readonly action: "open"; readonly target: "liked" }
  | { readonly action: "open"; readonly target: "settings" };

/**
 * What `POST /music_assistant` answers.
 *
 * `playlist` and `actions` are OMITTED when the turn produced none - the
 * server only writes the keys it has - so test with `in` or a truthiness
 * check rather than against `null`.
 */
export interface MusicAssistantAnswer {
  /** Always present. Falls back to an apology when the model made no sense. */
  readonly reply: string;
  /** One card per answer at most, for the last playlist a tool touched. */
  readonly playlist?: MusicAssistantPlaylistRef;
  /** Up to {@link MUSIC_ASSISTANT_MAX_ACTIONS}, in order. Execute, do not re-resolve. */
  readonly actions?: MusicAssistantAction[];
  /**
   * The chat the exchange was stored in - NEW on the first message of a
   * session, so keep whatever comes back. Present only in the persisted mode;
   * {@link MusicAssistantNamespace.ask} never returns one.
   */
  readonly chat_id?: MusicAssistantChatId;
}

/** Everything {@link MusicAssistantNamespace.send} takes. */
export interface SendMusicAssistantMessageInput {
  /** The new message, and only the new one. The history is the server's. */
  readonly message: string;
  /** Omit to open a new chat. The answer carries the id it created. */
  readonly chatId?: MusicAssistantChatId;
  /** Optional player snapshot. Strictly whitelisted server-side. */
  readonly player?: MusicAssistantPlayerContext;
}

/* ========================================================================== *
 * DJ
 * ========================================================================== */

/**
 * Generations per user per hour, shared by `/music_dj` and `/music_dj/batch`.
 *
 * The counter is incremented by EVERY request - including the ones it then
 * refuses with `429`. A retry loop therefore drives the count further past the
 * cap and can never recover inside the hour, which is why
 * {@link MusicDjNamespace} passes `retry: false` unless you override it.
 */
export const MUSIC_DJ_HOURLY_CAP = 40;

/**
 * Default deadline for one DJ generation, in milliseconds. Writing the script
 * and speaking it takes well past the client's 60 s default.
 */
export const MUSIC_DJ_TIMEOUT_MS = 120_000;

/** Songs one `/music_dj/batch` set plans at most. */
export const MUSIC_DJ_BATCH_SIZE = 4;

/** `POST /music_dj`: one spoken link between two tracks. */
export interface MusicDjInterstitial {
  /** The script as text, at most 320 characters. Worth showing while audio loads. */
  readonly text: string;
  /**
   * The same script spoken, base64, NOT a data URL. Decode with
   * {@link musicDjAudioBytes} or wrap with {@link musicDjAudioDataUrl}.
   */
  readonly audio_base64: string;
  /** Container of the decoded bytes. `"wav"` today, and typed wide on purpose. */
  readonly format: string;
}

/** `POST /music_dj/batch`: a whole set - what to play next, and the words for it. */
export interface MusicDjBatch extends MusicDjInterstitial {
  /**
   * The planned tracks, in play order, in the full `GET /songs` shape and
   * already scoped to what the caller may play. Between 1 and
   * {@link MUSIC_DJ_BATCH_SIZE}: the server fails rather than answer with an
   * empty set, so this is never `[]`.
   */
  readonly songs: Song[];
}

/** Everything `POST /music_dj/batch` accepts. All of it optional. */
export interface MusicDjBatchInput {
  /** A free-text steer ("something calmer"). Truncated to 300 characters. */
  readonly request?: string;
  /**
   * Recently played ids. Only the last 60 are read, and the planner SUBTRACTS
   * them from its own picks - so a list that covers the whole library leaves
   * nothing playable and the call fails with a `502`.
   */
  readonly recentSongIds?: SongId[];
  /** Ids the listener skipped, as negative signal. Only the last 20 are read. */
  readonly skippedSongIds?: SongId[];
  /** Which set of the session this is, so the script can vary its opening. */
  readonly batchIndex?: number;
}

/* ========================================================================== *
 * Namespaces
 * ========================================================================== */

/**
 * Jams over HTTP. The realtime half lives on the WebSocket stream and is not in
 * this SDK - see the module note, and {@link jamStreamName} for the stream to
 * subscribe to.
 */
export class MusicJamsNamespace extends Resource {
  /**
   * `GET /jams` - the caller's live jam plus the ones they may join.
   *
   * Cheap and not cached anywhere, but also not a subscription: it is what you
   * call on app start to rediscover a jam you were already in, and when opening
   * a "join a jam" list. Everything that happens afterwards arrives on the
   * realtime stream, so polling this is the wrong shape.
   *
   * Missing keys are normalised (`current: null`, `joinable: []`) so a caller
   * never has to guard the two separately.
   *
   * General ceiling: 600/min.
   */
  async list(options: RequestOptions = {}): Promise<JamsIndex> {
    const answer = await this.http.get<JamsIndex | null>("/jams", options);
    return { current: answer?.current ?? null, joinable: answer?.joinable ?? [] };
  }

  /**
   * The caller's live jam, or `null`. Convenience over {@link list} for the
   * app-start "am I still in a jam" question; costs the same one request.
   */
  async current(options: RequestOptions = {}): Promise<Jam | null> {
    return (await this.list(options)).current;
  }

  /**
   * `POST /jams` - opens a jam hosted by the caller, who becomes its first
   * member. `201`.
   *
   * Two side effects worth knowing before you call it:
   *
   * - **It silently leaves whatever jam you were in, and ENDS it if you were
   *   hosting.** One jam at a time is enforced server-side, with no
   *   confirmation and no error - the previous jam's members just receive
   *   `ended`.
   * - The caller's friends-feed row is re-broadcast so it gains the jam badge.
   *
   * A jam with no active host device is a silent jam: the whole relay rides the
   * host's playback publishes, so proposals and skip votes answer `400 "The
   * host is not playing right now"` until the host's client claims the active
   * playback device (a `claim_active` with `mode: "steal"` on the host's
   * playback channel) and plays something. Do that immediately after this
   * returns.
   *
   * General ceiling: 600/min.
   */
  create(options: RequestOptions = {}): Promise<Jam> {
    return this.http.post<Jam>("/jams", undefined, options);
  }

  /**
   * `POST /jams/:id/join` - joins a live jam. `200`, body is the jam.
   *
   * Authorization is "an accepted friend of ANY current member", not of the
   * host, and it is the same predicate {@link list} filters `joinable` with -
   * so a jam that came out of that list will not refuse you unless its
   * membership changed in between. Joining a jam you are already in is a no-op
   * success rather than an error.
   *
   * Like {@link create}, this silently leaves (or ends) your previous jam.
   *
   * Then, and only then, subscribe to {@link jamStreamName}: the channel
   * rejects non-members.
   *
   * @throws {OmsError} `404 "Jam not found"` - also what an ENDED jam answers.
   * @throws {OmsError} `401 "Only friends of a jam member can join"`. Note the
   *   status: this is an authorization failure wearing a `401`, so do not let a
   *   global "401 means log out" interceptor see it.
   */
  join(jamId: JamId, options: RequestOptions = {}): Promise<Jam> {
    return this.http.post<Jam>(`/jams/${jamId}/join`, undefined, options);
  }

  /**
   * `POST /jams/:id/leave` - leaves a jam. `200` with a `null` body.
   *
   * **If the caller is the HOST this ends the jam for everybody.** There is no
   * host handoff anywhere in this feature; the remaining members receive
   * `ended` and the jam row is closed. For a member it deletes the membership
   * row and broadcasts `members_changed`.
   *
   * @throws {OmsError} `404 "Jam not found"` when the jam is over, or when the
   *   caller was not a member of it - the two are not distinguished.
   */
  async leave(jamId: JamId, options: RequestOptions = {}): Promise<void> {
    await this.http.post<null>(`/jams/${jamId}/leave`, undefined, options);
  }

  /**
   * `DELETE /jams/:id` - the host ends the jam for everyone. `200` with a
   * `null` body, NOT the `204` the SDK's other destroys answer with.
   *
   * Identical in effect to a host calling {@link leave}. Both set `ended_at`,
   * broadcast `ended`, and re-broadcast every member's feed row so their jam
   * badges drop.
   *
   * @throws {OmsError} `401 "Only the host can end a jam"` - an authorization
   *   failure with an authentication status. See {@link join}.
   */
  async end(jamId: JamId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<null>(`/jams/${jamId}`, options);
  }

  /**
   * `PATCH /jams/:id` - the host changes the rules. `200`, body is the jam.
   *
   * `queue_mode` gates {@link propose}, `skip_mode` gates {@link skipVote}. Any
   * subset is accepted, an empty object included (a no-op that still fans
   * `jam_updated` out to everyone). An invalid value is a `400` carrying the
   * validation message; use {@link JAM_QUEUE_MODES} and {@link JAM_SKIP_MODES}
   * rather than a literal.
   *
   * @throws {OmsError} `401 "Only the host can change the rules"`.
   */
  updateRules(jamId: JamId, rules: UpdateJamRulesInput, options: RequestOptions = {}): Promise<Jam> {
    return this.http.patch<Jam>(`/jams/${jamId}`, rules, options);
  }

  /**
   * `POST /jams/:id/invite` - notifies a friend that the jam exists. `200` with
   * a `null` body.
   *
   * An invitation is PURELY a notification (`kind: "jam_invite"`, delivered on
   * the invitee's notifications channel). It creates no state, grants no
   * access, expires never, and has no accept endpoint: the invitee joins
   * through {@link join} like anybody else, which they could already do because
   * being a friend of the inviter - a member - is the whole authorization rule.
   * So an invite is a nudge, and revoking one is not a thing.
   *
   * The caller must be a member; the target must be an accepted friend of the
   * CALLER (not of the host) and not already in the jam.
   *
   * @throws {OmsError} `404 "Jam not found"`, `404 "User not found"`,
   *   `400 "You can only invite your friends"`, `400 "Already in the jam"`.
   */
  async invite(jamId: JamId, userId: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.post<null>(`/jams/${jamId}/invite`, { user_id: userId }, options);
  }

  /**
   * `POST /jams/:id/propose` - offers one of YOUR OWN songs as an upcoming
   * pick. `200` with a `null` body.
   *
   * ## The `200` is weaker than it looks
   *
   * Nothing is stored here. The server allows the host's playback state to
   * reference your song for 24 hours, then broadcasts a `jam_add_song` command
   * onto the HOST's playback stream carrying a fully presigned payload.
   * The song joins the queue when the host's CLIENT handles that command and
   * republishes its state. A host whose app is backgrounded, disconnected, or
   * simply older than the feature never handles it, and no error comes back to
   * you. Watch the jam stream for the `state_changed` that follows, rather than
   * treating the `200` as confirmation.
   *
   * The song must be the CALLER's. Proposing the host's song, or a third
   * user's, is `404 "Song not found"` - the lookup is scoped to your own
   * library, so a song you can see but do not own does not exist for this
   * route.
   *
   * @throws {OmsError} `404 "Jam not found"` (also when you are not a member).
   * @throws {OmsError} `400 "The host picks the music in this jam"` when
   *   `queue_mode` is `"host"` and you are not the host.
   * @throws {OmsError} `404 "Song not found"` - you do not own it, or it has no
   *   media attached.
   * @throws {OmsError} `400 "The host is not playing right now"` when the host
   *   has no active playback device.
   */
  async propose(jamId: JamId, songId: SongId, options: RequestOptions = {}): Promise<void> {
    await this.http.post<null>(`/jams/${jamId}/propose`, { song_id: songId }, options);
  }

  /**
   * `POST /jams/:id/skip_vote` - votes to skip whatever is playing.
   *
   * Votes are kept for 15 minutes, per jam AND per CURRENT song, so voting
   * twice is idempotent and **a track change resets the tally silently** - no
   * message says so. Reset any local counter whenever
   * the song id in the jam state changes.
   *
   * The threshold is `1` under `"anyone"` and `floor(members / 2) + 1` under
   * `"majority"` ({@link jamSkipVotesNeeded} computes it from a jam you already
   * hold). A vote from the HOST always passes immediately, whatever the mode
   * and whatever the count.
   *
   * When it passes, the server sends `next` to the host's active device and
   * broadcasts `skipped`; the actual skip then depends on the host's client
   * acting, exactly as in {@link propose}.
   *
   * @throws {OmsError} `404 "Jam not found"` (also when you are not a member).
   * @throws {OmsError} `400 "Only the host can skip in this jam"` under
   *   `skip_mode: "host"`.
   * @throws {OmsError} `400 "Nothing is playing"` when the host has no current
   *   song or no active device.
   */
  skipVote(jamId: JamId, options: RequestOptions = {}): Promise<JamSkipVoteResult> {
    return this.http.post<JamSkipVoteResult>(`/jams/${jamId}/skip_vote`, undefined, options);
  }
}

/** The music section of a user's public profile. */
export class MusicProfilesNamespace extends Resource {
  /**
   * `GET /users/:idOrHandle/music_profile` - now playing, 30-day tops, recent
   * plays and a play count.
   *
   * The path segment accepts EITHER a user id or a handle; the server tries the
   * id first and then the lowercased handle, so pass whatever you have. It is
   * percent-encoded here, which matters for a handle more than for an id.
   *
   * **A `200` does not mean there is a profile.** A viewer who is not the owner
   * and not an accepted friend with `share_listening` on gets
   * `{ "visible": false }` at status `200`, on purpose: a private profile has to
   * look identical to an empty one. Narrow with {@link isMusicProfileVisible}.
   *
   * Authentication is required even though it looks like a public read: an
   * anonymous call is a `401`, not a hidden profile.
   *
   * Every `*_url` in the answer is presigned and short-lived
   * ({@link MUSIC_PRESIGNED_URL_TTL_MS}); use them verbatim, do not store them,
   * and pick an artist image with {@link musicProfileArtistImage}.
   *
   * General ceiling: 600/min. Note this is a `/users/` path, NOT one of the
   * `/artists/` family, so the tighter 60/min music bucket does not apply.
   *
   * @throws {OmsError} `404 "User not found."` when nobody matches.
   */
  get(idOrHandle: string, options: RequestOptions = {}): Promise<MusicProfile> {
    return this.http.get<MusicProfile>(`/users/${encodeURIComponent(idOrHandle)}/music_profile`, options);
  }
}

/** The music storage meter. */
export class MusicStorageNamespace extends Resource {
  /**
   * `GET /music/storage` - bytes of music media stored, against the ceiling.
   *
   * Read {@link MusicStorageUsage.unlimited} before doing arithmetic with
   * `limit_bytes`, which is `null` for an unlimited account. See the interface
   * for the whole story.
   *
   * `used_bytes` is computed live over the account's distinct blobs, so it is
   * never stale and never free. A settings screen, not a poll.
   *
   * General ceiling: 600/min - this route is NOT covered by the 30/min bucket
   * on `GET /quotas`, even though the two report the same number.
   */
  get(options: RequestOptions = {}): Promise<MusicStorageUsage> {
    return this.http.get<MusicStorageUsage>("/music/storage", options);
  }
}

/**
 * Stored assistant sessions: list, reopen, delete.
 *
 * Reading and deleting live here; WRITING does not. A message is appended by
 * {@link MusicAssistantNamespace.send}, because the only path that may add to a
 * chat is the one that talks to the model.
 */
export class MusicAssistantChatsNamespace extends Resource {
  /**
   * `GET /music_assistant/chats` - the caller's sessions, newest activity
   * first, without their messages.
   *
   * A bare array with no paging and no filters: `modifiers[page]` and
   * `search[...]` are ignored rather than rejected. The list grows without
   * bound; nothing prunes old chats.
   *
   * General ceiling: 600/min.
   */
  async list(options: RequestOptions = {}): Promise<MusicAssistantChatSummary[]> {
    return (await this.http.get<MusicAssistantChatSummary[] | null>("/music_assistant/chats", options)) ?? [];
  }

  /**
   * `GET /music_assistant/chats/:id` - one session with its full transcript.
   *
   * @throws {OmsError} `404 "Chat not found"` for a chat that does not exist
   *   AND for one belonging to somebody else. The scope is applied before the
   *   lookup precisely so the two are indistinguishable; never expect a `403`.
   */
  get(chatId: MusicAssistantChatId, options: RequestOptions = {}): Promise<MusicAssistantChatDetail> {
    return this.http.get<MusicAssistantChatDetail>(`/music_assistant/chats/${chatId}`, options);
  }

  /**
   * `DELETE /music_assistant/chats/:id` - permanent, `204`, no body.
   *
   * Unlike the rest of this file, this one really is a `204`. A repeat delete
   * is a `404`, which is why the transport does not replay a `DELETE` after a
   * torn connection: it would turn a success into an error.
   *
   * @throws {OmsError} `404 "Chat not found"`, including for somebody else's.
   */
  async delete(chatId: MusicAssistantChatId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/music_assistant/chats/${chatId}`, options);
  }
}

/**
 * "O Melhor Assistente": a chat that can search the library, build playlists
 * and drive the player.
 */
export class MusicAssistantNamespace extends Resource {
  /** Stored sessions: list, reopen, delete. */
  readonly chats: MusicAssistantChatsNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.chats = new MusicAssistantChatsNamespace(http);
  }

  /**
   * `POST /music_assistant` in its PERSISTED mode - send one message, get one
   * answer, and let the server keep the conversation.
   *
   * ## Send the new message only
   *
   * The history is the SERVER's. Omit `chatId` for a new session and the answer
   * carries the `chat_id` that was created; pass it back on every later turn.
   * Do not send a transcript - the model is fed the stored history (the last
   * {@link MUSIC_ASSISTANT_HISTORY_TURNS} turns of it) and anything you resend
   * is simply a second copy of a message.
   *
   * ## Nothing is stored until the model answers
   *
   * The server runs the generation FIRST and only then creates the chat and
   * appends both messages. So a `502` leaves the chat exactly as it was - no
   * dangling user message, no empty chat on a failed first turn, and a resend
   * that cannot duplicate. That is also why a failure gives you no `chat_id` to
   * continue from.
   *
   * ## Two failure modes that are not network errors
   *
   * - `423 "Este chat é só de leitura."` - the chat has been idle for two days
   *   and is sealed. Open a new one (call again with no `chatId`); there is no
   *   unseal. The `read_only` flag is computed, so a cached summary can say
   *   `false` and this still fire.
   * - `502` - the model refused or fell over. The reply is not partial, it is
   *   absent.
   *
   * A body over {@link MUSIC_ASSISTANT_MAX_BODY_BYTES} is `413 "Request too
   * big"`, decided from `Content-Length` before parsing.
   *
   * The deadline defaults to {@link MUSIC_ASSISTANT_TIMEOUT_MS} rather than the
   * client's 60 s, because a generation regularly outlives 60 s while still
   * being on its way. Note that the transport does not replay a `POST`, so a
   * timeout here is genuinely unknown ground: the server may well have
   * finished and stored the turn. Reload with {@link MusicAssistantChatsNamespace.get}
   * before resending.
   *
   * General ceiling: 600/min, and one generation holds a server thread for its
   * whole duration - do not fan these out.
   */
  send(input: SendMusicAssistantMessageInput, options: RequestOptions = {}): Promise<MusicAssistantAnswer> {
    const body: Record<string, unknown> = { message: input.message };
    if (input.chatId !== undefined) body["chat_id"] = input.chatId;
    if (input.player !== undefined) body["player"] = input.player;
    return this.http.post<MusicAssistantAnswer>("/music_assistant", body, {
      ...options,
      timeoutMs: options.timeoutMs ?? MUSIC_ASSISTANT_TIMEOUT_MS,
    });
  }

  /**
   * `POST /music_assistant` in its STATELESS mode - you own the history, the
   * server stores nothing.
   *
   * This is the older contract, and the right one for a caller that has no
   * place to keep a `chat_id` between invocations. The whole transcript
   * rides in the request every time, so it grows, and the body ceiling
   * ({@link MUSIC_ASSISTANT_MAX_BODY_BYTES}) is a real limit rather than a
   * theoretical one. Only the last {@link MUSIC_ASSISTANT_HISTORY_TURNS}
   * messages reach the model whatever you send.
   *
   * The answer never carries a `chat_id`, and the two modes do not mix: a
   * request with both `messages` and `message` takes the persisted branch and
   * ignores `messages` entirely.
   *
   * The side effects are NOT stateless. A `tools` turn writes real playlists
   * into the library, so this is not a "read-only" mode - only a "no
   * transcript" one.
   *
   * @throws {OmsError} `400 "messages required"` when the array is empty.
   */
  ask(
    messages: MusicAssistantMessage[],
    player?: MusicAssistantPlayerContext,
    options: RequestOptions = {},
  ): Promise<MusicAssistantAnswer> {
    const body: Record<string, unknown> = {
      messages: messages.map((entry) => ({ role: entry.role, content: entry.content })),
    };
    if (player !== undefined) body["player"] = player;
    return this.http.post<MusicAssistantAnswer>("/music_assistant", body, {
      ...options,
      timeoutMs: options.timeoutMs ?? MUSIC_ASSISTANT_TIMEOUT_MS,
    });
  }
}

/**
 * "O Melhor DJ": a written-and-spoken link between tracks, and a whole planned
 * set.
 *
 * Both methods pass `retry: false` by default. That is not caution about
 * duplicates - the transport does not replay a `POST` anyway - it is about the
 * one thing it DOES replay: a `429`. The hourly cap here counts every request
 * including the refused ones, so waiting out a `Retry-After` and asking again
 * pushes the count further past the cap and cannot succeed inside the hour.
 * Pass `retry: {}` to opt back in if you are sure the `429` came from the
 * general per-minute ceiling instead.
 */
export class MusicDjNamespace extends Resource {
  /**
   * `POST /music_dj` - the DJ introduces the next track.
   *
   * Returns the script AND the spoken audio in one answer, base64 in the JSON
   * body rather than as a URL, because the clip is small and ephemeral and
   * nothing stores it. Decode with {@link musicDjAudioBytes}, or hand
   * {@link musicDjAudioDataUrl} to a player that takes a URI.
   *
   * Both ids are resolved against what the caller may play, so a followed
   * playlist's track works and a stranger's does not. `previousSongId` is genuinely optional and
   * is what lets the script say goodbye to the outgoing track.
   *
   * Generation takes seconds; the deadline defaults to
   * {@link MUSIC_DJ_TIMEOUT_MS}. The
   * intended pattern is to ask for the clip while the current track is still
   * playing and drop it on the boundary, ideally over the outgoing
   * instrumental.
   *
   * @throws {OmsError} `401 "Session required"` when unauthenticated.
   * @throws {OmsError} `404 "Song not found"` for either id.
   * @throws {OmsError} `429 "DJ limit reached, try again later"` past
   *   {@link MUSIC_DJ_HOURLY_CAP}.
   * @throws {OmsError} `502 "DJ is unavailable right now"` when the script
   *   failed, `503 "DJ voice is unavailable right now"` when the voice did.
   *   The split is deliberate: a `503` means the words exist but nothing can
   *   say them.
   */
  interstitial(
    input: { readonly nextSongId: SongId; readonly previousSongId?: SongId | null },
    options: RequestOptions = {},
  ): Promise<MusicDjInterstitial> {
    const body: Record<string, unknown> = { next_song_id: input.nextSongId };
    if (input.previousSongId !== undefined && input.previousSongId !== null) {
      body["previous_song_id"] = input.previousSongId;
    }
    return this.http.post<MusicDjInterstitial>("/music_dj", body, {
      ...options,
      timeoutMs: options.timeoutMs ?? MUSIC_DJ_TIMEOUT_MS,
      retry: options.retry ?? false,
    });
  }

  /**
   * `POST /music_dj/batch` - a whole set: what to play next AND the words
   * introducing it, from one model call.
   *
   * The intended cadence is a real station's: take the set, play it, and come
   * back when about two tracks remain. Every field is optional, so
   * `batch({})` is a valid cold start.
   *
   * `recentSongIds` is a filter, not just a hint - the planner subtracts those
   * ids from its own picks. Send a list covering the whole library and the
   * planner has nothing left, which surfaces as `502 "DJ is unavailable right
   * now"` rather than as an empty set. Keep it to a genuine recent window; only
   * the last 60 are read anyway.
   *
   * `songs` comes back in play order, in the full `GET /songs` shape, already
   * scoped to what the caller may play. It is never empty.
   *
   * Shares {@link MUSIC_DJ_HOURLY_CAP} with {@link interstitial}. Same
   * timeouts, same error shapes.
   */
  batch(input: MusicDjBatchInput = {}, options: RequestOptions = {}): Promise<MusicDjBatch> {
    const body: Record<string, unknown> = {};
    if (input.request !== undefined) body["request"] = input.request;
    if (input.recentSongIds !== undefined) body["recent_song_ids"] = input.recentSongIds;
    if (input.skippedSongIds !== undefined) body["skipped_song_ids"] = input.skippedSongIds;
    if (input.batchIndex !== undefined) body["batch_index"] = input.batchIndex;
    return this.http.post<MusicDjBatch>("/music_dj/batch", body, {
      ...options,
      timeoutMs: options.timeoutMs ?? MUSIC_DJ_TIMEOUT_MS,
      retry: options.retry ?? false,
    });
  }
}

/**
 * The `music.social` entry point, holding the five families as sub-namespaces.
 *
 * Each is also exported on its own, so a host that would rather mount
 * `oms.music.jams` or `oms.assistant` can do that instead of reaching through
 * this class.
 */
export class MusicSocialNamespace extends Resource {
  /** Shared listening sessions. HTTP half only - the rest is on the realtime stream. */
  readonly jams: MusicJamsNamespace;
  /** The music card on somebody's profile. */
  readonly profiles: MusicProfilesNamespace;
  /** Music bytes stored against the account's ceiling. */
  readonly storage: MusicStorageNamespace;
  /** The chat assistant, with its stored sessions. */
  readonly assistant: MusicAssistantNamespace;
  /** Scripted and spoken links between tracks. */
  readonly dj: MusicDjNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.jams = new MusicJamsNamespace(http);
    this.profiles = new MusicProfilesNamespace(http);
    this.storage = new MusicStorageNamespace(http);
    this.assistant = new MusicAssistantNamespace(http);
    this.dj = new MusicDjNamespace(http);
  }
}

/* ========================================================================== *
 * Pure helpers
 * ========================================================================== */

/**
 * The realtime stream a jam broadcasts on.
 *
 * This SDK does not open it - it has no WebSocket client - but the name is
 * part of the contract. Subscribe with the identifier
 * `{"channel":"JamChannel","id":<jam id>}` AFTER
 * {@link MusicJamsNamespace.join} has returned, and treat the subscription as
 * receive-only.
 */
export function jamStreamName(jamId: JamId): string {
  return `jam:${jamId}`;
}

/**
 * The host's member row, or `undefined` when the payload is inconsistent.
 *
 * Reads `host_id` rather than trusting `is_host` or the array order. Both are
 * correct today; only `host_id` is the source of truth.
 */
export function jamHost(jam: Jam): JamMember | undefined {
  return jam.members?.find((member) => member.id === jam.host_id);
}

/** True when `userId` hosts this jam. The gate on rules, ending, and skipping. */
export function isJamHost(jam: Jam, userId: Id): boolean {
  return jam.host_id === userId;
}

/** That user's member row, or `undefined` when they are not in the jam. */
export function jamMember(jam: Jam, userId: Id): JamMember | undefined {
  return jam.members?.find((member) => member.id === userId);
}

/**
 * How many votes a skip needs right now: `1` under `"anyone"`,
 * `floor(members / 2) + 1` otherwise.
 *
 * The same arithmetic the server does, so a client can render "2 of 3" before
 * anybody votes rather than waiting for the first result to learn the
 * threshold. It moves as people join and leave, and `"host"` returns the
 * majority number even though no vote can pass under it - the host skips in
 * their own player instead.
 */
export function jamSkipVotesNeeded(jam: Jam): number {
  if (jam.skip_mode === "anyone") return 1;
  return Math.floor((jam.members?.length ?? 0) / 2) + 1;
}

/** Narrows a {@link MusicProfile} to the variant that has any content. */
export function isMusicProfileVisible(profile: MusicProfile): profile is MusicProfileVisible {
  return profile?.visible === true;
}

/**
 * Picks the best available image for a profile's top artist: the owner's
 * upload, then the large Deezer sizes, then the small ones, then Last.fm.
 * `undefined` when there is nothing, which is common - render initials.
 *
 * Note that `picture_big` deliberately comes before `picture_xl`: `xl` is a
 * 1000px square and these render at avatar size.
 */
export function musicProfileArtistImage(artist: MusicProfileArtist): string | undefined {
  return (
    artist.image_url ||
    artist.picture_big ||
    artist.picture_xl ||
    artist.picture_medium ||
    artist.picture ||
    artist.external_image_url ||
    undefined
  );
}

/**
 * Bytes still available, or `null` when the account is unlimited.
 *
 * `null` means "no ceiling", never "zero" - the distinction the raw
 * `limit_bytes` makes so easy to lose. Clamped at zero, because an account
 * whose limit was lowered below its usage is over, not negative.
 */
export function musicStorageRemaining(usage: MusicStorageUsage): number | null {
  if (usage.unlimited || usage.limit_bytes === null) return null;
  return Math.max(0, usage.limit_bytes - usage.used_bytes);
}

/**
 * Whether `bytes` more would fit. Always true for an unlimited account.
 *
 * Worth calling before an upload: the music quota is checked server-side at
 * attach time, and failing there means the bytes have already crossed the
 * network.
 */
export function musicStorageAffords(usage: MusicStorageUsage, bytes: number): boolean {
  const remaining = musicStorageRemaining(usage);
  return remaining === null || bytes <= remaining;
}

/** Alphabet {@link musicDjAudioBytes} decodes against. Standard base64, no URL variant. */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes a DJ clip's `audio_base64` into bytes.
 *
 * Uses the platform's `atob` when there is one and falls back to a arithmetic
 * decode when there is not, because this has to work in every runtime and
 * `atob` is the kind of global that is present in a browser and in Bun, arrived
 * in React Native only recently, and is not guaranteed in a Worker-class
 * isolate. No `Buffer`, no `node:*`.
 *
 * Padding, whitespace and newlines are tolerated; anything outside the base64
 * alphabet is skipped rather than throwing, because a clip that decodes to
 * slightly short audio is a better failure than one that throws inside a
 * playback callback.
 */
export function musicDjAudioBytes(clip: Pick<MusicDjInterstitial, "audio_base64">): Uint8Array {
  const source = clip.audio_base64 ?? "";
  const platformDecode = (globalThis as { atob?: (encoded: string) => string }).atob;
  if (typeof platformDecode === "function") {
    const binary = platformDecode(source.replace(/[^A-Za-z0-9+/=]/g, ""));
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index) & 0xff;
    return out;
  }

  let accumulator = 0;
  let bits = 0;
  let written = 0;
  const out = new Uint8Array(Math.floor((source.length * 3) / 4) + 1);
  for (let index = 0; index < source.length; index += 1) {
    const value = BASE64_ALPHABET.indexOf(source.charAt(index));
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
  }
  return out.subarray(0, written);
}

/**
 * Wraps a DJ clip as a `data:` URI, for a player that takes a URI rather than
 * bytes - which is most of them.
 *
 * The string is roughly a third larger than the audio, and the audio is already
 * in memory, so this is cheap in every sense that matters at this size. It is
 * not a URL anything can fetch twice - it is the bytes, spelled differently.
 */
export function musicDjAudioDataUrl(clip: MusicDjInterstitial): string {
  const format = (clip.format || "wav").toLowerCase();
  const mime = format === "wav" ? "audio/wav" : format === "mp3" ? "audio/mpeg" : `audio/${format}`;
  return `data:${mime};base64,${clip.audio_base64}`;
}
