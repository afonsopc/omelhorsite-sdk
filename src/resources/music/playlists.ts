/**
 * The `music.playlists` namespace: playlists, the join rows inside them, the
 * generated shelves (mixes and radios) and the play history.
 *
 * Five endpoint families live here because they are one screen's worth of API:
 * a playlist, the queue you build from it, the shelves the server builds for
 * you, and the history that feeds those shelves. They are exposed as one entry
 * class with three sub-namespaces hanging off it
 * ({@link MusicPlaylistsNamespace.songs}, `.mixes`, `.radios`, `.plays`), and
 * every sub-namespace is also exported on its own so a host that prefers
 * `oms.music.mixes` can mount it there instead.
 *
 * ## Four things that have already cost bugs
 *
 * 1. **Every id here is an INTEGER.** Playlists, playlist songs, songs,
 *    artists and play events all kept auto-increment primary keys, so they
 *    arrive as JSON numbers while the `user_id` right next to them is a
 *    string. {@link MusicPlaylistsNamespace.reorder} is the one place where
 *    that distinction is load-bearing rather than cosmetic - see its docs.
 * 2. **System playlists are half read-only.** A playlist whose `source_kind`
 *    is present and not `"manual"` is maintained by an external sync
 *    (Spotify today). Renaming it, re-arting it and reordering it are refused
 *    with `401`; adding, removing, hiding and copying are NOT. That split is
 *    newer than `docs/api-music.md`, which still says every structural edit is
 *    refused. Test with {@link isSystemPlaylist}.
 * 3. **Removing a song from a synced playlist does not delete anything.** The
 *    sync would just put it back, so the row is marked `hidden` instead and
 *    the API still answers `204`. The row keeps coming back in listings for
 *    the OWNER (so it can be un-hidden) and disappears for everyone else. See
 *    {@link PlaylistSongsNamespace.remove}.
 * 4. **`/music_radios/*` is throttled at 60 requests per minute**, and the
 *    bucket is keyed by the `Authorization` header - or by the client IP when
 *    there is none. A cookie-authenticated web client therefore shares one
 *    budget with every other visitor behind the same address. See
 *    {@link MusicRadiosNamespace}.
 */

import { Resource, pageModifier } from "../../http";
import type {
  FileInput,
  Id,
  NativeFile,
  PageParams,
  Paginated,
  QueryParams,
  RequestOptions,
  Timestamp,
} from "../../types";
import { createPage } from "../../types";

/**
 * Primary key of a playlist. A NUMBER: `playlists` never moved to the opaque
 * string ids the account-side tables use.
 */
export type MusicPlaylistId = number;

/**
 * Primary key of a `playlist_songs` join ROW, which is not the id of the song
 * on it. `DELETE /playlist_songs/:id` wants this one; every method here that
 * takes a `rowId` means this and says so.
 */
export type MusicPlaylistSongId = number;

/** Primary key of a play event. A number, like everything else in this file. */
export type PlayEventId = number;

/** Visibility of a playlist. There is no `public`: the widest setting is `friends`. */
export type PlaylistVisibility = "private" | "friends";

/**
 * Where a playlist came from. `"manual"` (or `null` on very old rows) is a
 * playlist the user built; anything else marks it as maintained by a sync and
 * makes {@link isSystemPlaylist} true. The column is a free string, so treat
 * unknown values as system rather than as a bug.
 */
export type PlaylistSourceKind = "manual" | "imported" | "spotify_sync" | (string & {});

/**
 * Which side created a join row. `"sync"` rows belong to the external sync and
 * are hidden rather than deleted; `"manual"` rows are the user's own additions
 * and are deleted for real.
 */
export type PlaylistSongOrigin = "sync" | "manual";

/**
 * Positions at or above this floor are the manual block of a synced playlist.
 *
 * The sync numbers its own rows from 1 upwards and never reaches here, so a
 * user's additions to a synced playlist are parked above the floor and the
 * next sync run can renumber its own rows without colliding with them.
 * Mirrors `PlaylistSong::MANUAL_BLOCK_FLOOR`.
 */
export const PLAYLIST_MANUAL_BLOCK_FLOOR = 100_000;

/**
 * Most songs `POST /playlists` will seed from `song_ids` in one call. Mirrors
 * `PlaylistsController::SEED_CAP`; the server takes the first 500 and drops
 * the rest in silence, so the SDK raises instead.
 */
export const PLAYLIST_SEED_CAP = 500;

/**
 * Requests per minute allowed against `/music_radios/*`. See
 * {@link MusicRadiosNamespace} for what the bucket is keyed on, which matters
 * more than the number.
 */
export const MUSIC_RADIO_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Window in which a repeat play of the same song is swallowed rather than
 * recorded. Mirrors `PlayEvent::DEDUPE_WINDOW`.
 */
export const PLAY_EVENT_DEDUPE_WINDOW_MS = 30_000;

/**
 * Client labels the backend will store on a play event.
 *
 * A value outside this list does NOT fail the request: the controller records
 * the play with a `null` source rather than losing real listening history over
 * a typo. So a misspelt label is invisible until somebody audits by origin and
 * finds a pile of unlabelled rows.
 */
export const PLAY_EVENT_SOURCES = ["oms-ios", "oms-desktop", "web"] as const;

/** One of {@link PLAY_EVENT_SOURCES}. */
export type PlayEventSource = (typeof PLAY_EVENT_SOURCES)[number];

/** Windows `GET /play_events/top` accepts. Anything else is a `400`. */
export const PLAY_EVENT_TOP_WINDOWS = ["7d", "30d", "90d", "all"] as const;

/** One of {@link PLAY_EVENT_TOP_WINDOWS}. */
export type PlayEventWindow = (typeof PLAY_EVENT_TOP_WINDOWS)[number];

/** Ceiling on `limit` for both `/play_events/recent` and `/play_events/top`. */
export const PLAY_EVENT_MAX_LIMIT = 100;

/** Kinds of generated mix the server currently produces. */
export const MIX_KINDS = [
  "top_artist",
  "this_is",
  "monthly_rewind",
  "year_mix",
  "repeat_rewind",
  "time_capsule",
  "discoveries",
] as const;

/**
 * Kind of a generated mix. Widened with `string & {}` on purpose: the
 * generator gains kinds faster than any client is redeployed, and a mix whose
 * kind is unknown still renders perfectly well from its title and its songs.
 */
export type MixKind = (typeof MIX_KINDS)[number] | (string & {});

/**
 * The compact `ArtistBlueprint` view, as it is embedded in mixes and in the
 * album/artist rows of the history endpoints.
 *
 * Blueprinter views ADD to the base rather than replace it, so `compact`
 * carries `id`, `created_at` and `updated_at` too. The `*_fs_node_id` keys are
 * a deliberate duplicate of the `*_media_id` ones, kept for the old web
 * frontend; read the `_media_id` form in new code.
 */
export interface MusicArtistPayload {
  readonly id: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly name: string;
  readonly slug: string;
  readonly image_media_id: string | null;
  readonly compressed_image_media_id: string | null;
  /** @deprecated Legacy twin of `image_media_id`, same value. */
  readonly image_fs_node_id?: string | null;
  /** @deprecated Legacy twin of `compressed_image_media_id`, same value. */
  readonly compressed_image_fs_node_id?: string | null;
}

/** One artist credit on a song, as `SongArtistBlueprint` renders it. */
export interface MusicSongArtistPayload {
  readonly id: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly song_id: number;
  readonly artist_id: number;
  /** 0 for the lead credit; featured artists follow. */
  readonly position: number;
  readonly role: string | null;
  readonly name: string | null;
  readonly slug: string | null;
  readonly image_media_id: string | null;
  readonly compressed_image_media_id: string | null;
  /** Cached Deezer picture. This, not the uploads, is what usually renders. */
  readonly picture: string | null;
  readonly picture_medium: string | null;
  readonly external_image_url: string | null;
}

/**
 * A song, as it is embedded in playlist rows, mixes, radios and history.
 *
 * This is a deliberate SUBSET of what `SongBlueprint` sends: the fields every
 * consumer in this file needs, and no more. The full song type belongs to the
 * songs namespace, and duplicating thirty audio-metadata columns in two places
 * is how the two copies drift apart. Extra keys ARE on the wire - cast when
 * you need `isrc`, the codec fields or the stem media ids.
 */
export interface MusicSongPayload {
  readonly id: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly title: string;
  readonly album: string | null;
  /** Seconds. `null` or `0` on old uploads and on failed probes. */
  readonly duration: number | null;
  readonly year: number | null;
  readonly user_id: Id;
  readonly artists: readonly MusicSongArtistPayload[];
  readonly audio_media_id: string | null;
  readonly compressed_audio_media_id: string | null;
  readonly artwork_media_id: string | null;
  readonly compressed_artwork_media_id: string | null;
}

/**
 * A playlist.
 *
 * `visibility` and `owned` are newer than `docs/api-music.md` and than the
 * `Playlist` type in `oms-music/src/domain/playlist.ts`; both are on the wire
 * today. `owned` is computed against the ASKING user, which is what makes a
 * followed playlist distinguishable from your own in one listing.
 */
export interface MusicPlaylist {
  readonly id: MusicPlaylistId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly name: string;
  /** Owner. A string id, unlike every other id in this file. */
  readonly user_id: Id;
  readonly visibility: PlaylistVisibility;
  /**
   * False for a playlist you FOLLOW rather than own. Everything that writes
   * refuses on those, so this is the flag a UI hides its edit affordances on.
   */
  readonly owned: boolean;
  readonly source_kind: PlaylistSourceKind | null;
  /** e.g. `"spotify"`. Used verbatim in the refusal message on a system playlist. */
  readonly source_provider: string | null;
  readonly source_url: string | null;
  /** `"liked"` marks the mirror of the provider's liked-tracks list. */
  readonly source_external_id: string | null;
  readonly synced_at: Timestamp | null;
  /** Attachment id of the cover, as a string, or `null`. */
  readonly artwork_media_id: string | null;
  /** @deprecated Legacy twin of `artwork_media_id`, same value. */
  readonly artwork_fs_node_id?: string | null;
}

/** One song's membership of one playlist. */
export interface MusicPlaylistSong {
  /** The JOIN ROW id. Not the song id. This is what `remove` takes. */
  readonly id: MusicPlaylistSongId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly playlist_id: MusicPlaylistId;
  readonly song_id: number;
  /**
   * Sort key inside the playlist. Not dense and not stable: appends take
   * `max + 1`, seeds start at 1, {@link MusicPlaylistsNamespace.reorder}
   * renumbers from 0, and manual rows on a synced playlist start at
   * {@link PLAYLIST_MANUAL_BLOCK_FLOOR}. Order by it; never do arithmetic
   * with it.
   */
  readonly position: number;
  readonly origin: PlaylistSongOrigin;
  /**
   * A `sync` row the owner removed. It stays so the next sync run finds it and
   * leaves it alone. Only the OWNER ever sees a hidden row: the listing filters
   * `hidden = FALSE OR playlists.user_id = <you>`, so a follower's page count
   * and the owner's differ for the same playlist.
   */
  readonly hidden: boolean;
  /** The full song. Present on every row of every view. */
  readonly song: MusicSongPayload;
}

/** A generated shelf, without its songs. */
export interface MusicMixSummary {
  /**
   * Identity of the shelf, e.g. `"mix:top_artist:1:ab12cd34"`. It contains
   * colons, so it MUST be percent-encoded into the path -
   * {@link MusicMixesNamespace.get} does that for you.
   */
  readonly slug: string;
  readonly kind: MixKind;
  /** English fallback. Render {@link title_key} instead where you have i18n. */
  readonly title: string;
  /** English fallback. Render {@link description_key} instead. */
  readonly description: string;
  readonly title_key: string;
  readonly title_params: Readonly<Record<string, string | number>>;
  readonly description_key: string;
  readonly description_params: Readonly<Record<string, string | number>>;
  /** What the mix was built around: an artist name, a year, or `null`. */
  readonly seed: string | number | null;
  /**
   * Resolved at render time rather than cached, so a refreshed picture shows up
   * without waiting out the 24h cache. Only `top_artist` and `this_is` mixes
   * carry one.
   */
  readonly artist: MusicArtistPayload | null;
  /** Tailwind gradient classes for the card. Clients are free to ignore it. */
  readonly gradient: string | null;
}

/** A generated shelf with its songs, in mix order. */
export interface MusicMix extends MusicMixSummary {
  readonly songs: readonly MusicSongPayload[];
}

/** An artist or song radio. */
export interface MusicRadio {
  /** `"radio:artist:<hash>"` or `"radio:song:<song id>"`. */
  readonly slug: string;
  readonly kind: "artist" | "song";
  /**
   * Pre-baked and PORTUGUESE, unlike a mix, which ships i18n keys. There is no
   * `title_key` here to render instead, so a non-Portuguese UI either shows
   * Portuguese or builds its own title from `seed`.
   */
  readonly title: string;
  readonly description: string;
  /** Seed artist name, or the seed song's title for a song radio. */
  readonly seed: string | number;
  readonly gradient: string | null;
  /**
   * Around 40 tracks, all from the caller's own library. For a song radio the
   * seed song is guaranteed to be `songs[0]`.
   */
  readonly songs: readonly MusicSongPayload[];
}

/** A recorded play. */
export interface MusicPlayEvent {
  readonly id: PlayEventId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly user_id: Id;
  readonly song_id: number;
  readonly played_at: Timestamp;
  /** `null` when the client sent nothing, or sent a label off the whitelist. */
  readonly source: PlayEventSource | null;
  /** Seconds actually listened, clamped server-side. `null` when not reported. */
  readonly listened_s: number | null;
  /** The full song. `POST /play_events` renders the `:extended` view. */
  readonly song: MusicSongPayload;
}

/** What the server answers when a play was inside the dedupe window. */
export interface PlayEventDeduped {
  readonly deduped: true;
}

/** Either a stored event, or the marker saying the play was swallowed. */
export type RecordPlayResult = MusicPlayEvent | PlayEventDeduped;

/** One row of `GET /play_events/recent?group_by=song`. */
export interface RecentSongPlay {
  readonly song: MusicSongPayload;
  readonly last_played_at: Timestamp;
}

/** One row of `GET /play_events/recent?group_by=album`. */
export interface RecentAlbumPlay {
  readonly album: string | null;
  /**
   * Lead artist of the album, compact view, or `null`.
   *
   * `oms-music/src/api/endpoints/playEvents.ts` types this as
   * `Artist | string | null` and calls the string case "legacy rows". No such
   * case exists in the Rails this was checked against: the album grouping joins
   * `song_artists` and renders a blueprint or `nil`, never a bare name.
   */
  readonly artist: MusicArtistPayload | null;
  readonly artwork_media_id: string | null;
  /** @deprecated Legacy twin of `artwork_media_id`, same value. */
  readonly artwork_fs_node_id?: string | null;
  readonly last_played_at: Timestamp;
}

/** One row of `GET /play_events/top?scope=song`. */
export interface TopSongRow {
  readonly song: MusicSongPayload;
  readonly play_count: number;
}

/** One row of `GET /play_events/top?scope=album`. */
export interface TopAlbumRow {
  readonly album: string | null;
  readonly artist: MusicArtistPayload | null;
  readonly artwork_media_id: string | null;
  /** @deprecated Legacy twin of `artwork_media_id`, same value. */
  readonly artwork_fs_node_id?: string | null;
  readonly play_count: number;
}

/** One row of `GET /play_events/top?scope=artist`. */
export interface TopArtistRow {
  readonly artist: MusicArtistPayload;
  readonly play_count: number;
}

/** Filters for {@link MusicPlaylistsNamespace.list}. */
export interface ListPlaylistsParams extends PageParams {
  /**
   * Partial, accent-insensitive match on the name, sent as `search[name]`.
   *
   * There is no filter for the owner and none for the visibility: the
   * controller's allowlist is `id`, `name`, `created_at`, `updated_at` and
   * nothing else, and an unrecognised filter key is a `400`, not a wider
   * result. Use the `owned` flag on each row to tell yours from the ones you
   * follow.
   */
  readonly name?: string;
  /** Exact ids, sent as `exact_search[id][]`, which the backend turns into `IN`. */
  readonly ids?: readonly MusicPlaylistId[];
}

/** Arguments for {@link MusicPlaylistsNamespace.create}. */
export interface CreatePlaylistInput {
  readonly name: string;
  /** Defaults to `"private"` server-side. */
  readonly visibility?: PlaylistVisibility;
  /**
   * Reuses an EXISTING attachment as the cover - typically a song's
   * `artwork_media_id`. No bytes are copied and the blob counts once against
   * the music quota. To upload a new image instead, create the playlist and
   * then call {@link MusicPlaylistsNamespace.uploadArtwork}.
   */
  readonly artworkMediaId?: string;
  /**
   * Songs to seed the playlist with, in order. This is what "save this radio
   * as a playlist" uses.
   *
   * Ids you cannot see are dropped in SILENCE and the playlist is still
   * created, so compare `song_ids.length` against what you read back if that
   * matters. Positions start at 1. At most {@link PLAYLIST_SEED_CAP} ids; the
   * server truncates, the SDK throws.
   */
  readonly songIds?: readonly number[];
}

/** Fields {@link MusicPlaylistsNamespace.update} can change. */
export interface UpdatePlaylistInput {
  /** Refused with `401` on a system playlist: the sync owns the name. */
  readonly name?: string;
  /** Always editable, system playlist or not: visibility belongs to the owner. */
  readonly visibility?: PlaylistVisibility;
  /**
   * Point the cover at an existing attachment, or pass `null` to purge the
   * current one. Refused with `401` on a system playlist.
   *
   * Omitting the key and passing `null` are different requests: the server
   * tests `params.key?`, so an absent key leaves the artwork alone and an
   * explicit `null` deletes it.
   */
  readonly artworkMediaId?: string | null;
}

/** Filters for {@link PlaylistSongsNamespace.list}. */
export interface ListPlaylistSongsParams extends PageParams {
  readonly playlistId?: MusicPlaylistId;
  readonly songId?: number;
  readonly ids?: readonly MusicPlaylistSongId[];
  readonly origin?: PlaylistSongOrigin;
  /**
   * Narrow to hidden or to visible rows. Note that only the owner ever sees a
   * hidden row at all, so `hidden: true` is an empty page for a follower.
   */
  readonly hidden?: boolean;
}

/** Arguments for {@link PlayEventsNamespace.record}. */
export interface RecordPlayInput {
  readonly songId: number;
  /**
   * Which client is reporting. Off-whitelist values are stored as `null`
   * rather than rejected, so a typo costs you the label and nothing else.
   * See {@link PLAY_EVENT_SOURCES}.
   */
  readonly source?: PlayEventSource;
  /**
   * Seconds actually listened. Clamped server-side to `0 .. 3x` the track
   * duration, or to 24 hours when the duration is unknown, so a runaway
   * accumulator is capped rather than refused.
   */
  readonly listenedSeconds?: number;
}

/** Arguments for the `/play_events/recent` reads. */
export interface RecentPlaysParams {
  /** 1 to {@link PLAY_EVENT_MAX_LIMIT}. Defaults to 24 server-side. */
  readonly limit?: number;
}

/** Arguments for the `/play_events/top` reads. */
export interface TopPlaysParams {
  /** 1 to {@link PLAY_EVENT_MAX_LIMIT}. Defaults to 10 server-side. */
  readonly limit?: number;
  /** Defaults to `"all"`. Anything outside {@link PLAY_EVENT_TOP_WINDOWS} is a `400`. */
  readonly since?: PlayEventWindow;
}

/** Arguments for {@link PlayEventsNamespace.topSongs}. */
export interface TopSongsParams extends TopPlaysParams {
  /**
   * Narrow to one artist by NAME - the backend canonicalises it and looks it
   * up in your own roster. A name that matches nothing yields an empty array
   * rather than a `404`, so an empty result does not tell you which of the two
   * happened. Only `scope=song` honours this.
   */
  readonly artist?: string;
}

/**
 * True for a playlist an external sync owns. Pure function, no request.
 *
 * The rule is `source_kind` present and not `"manual"`, which means an
 * unrecognised value counts as system - deliberately, since the safe reading of
 * an unknown provider is "something else is writing to this".
 *
 * What it costs you: `update` (name and artwork only), `reorder` and
 * `uploadArtwork` all answer `401`. Adding, removing, hiding and copying still
 * work, and changing the visibility still works.
 */
export function isSystemPlaylist(playlist: Pick<MusicPlaylist, "source_kind">): boolean {
  return playlist.source_kind != null && playlist.source_kind !== "manual";
}

/**
 * True for the playlist a provider's liked-tracks sync writes into. Pure
 * function, no request. It is a system playlist with the reserved
 * `source_external_id` of `"liked"`, and hosts usually give it their own
 * artwork rather than whatever the sync attached.
 */
export function isLikedMirror(
  playlist: Pick<MusicPlaylist, "source_kind" | "source_external_id">,
): boolean {
  return isSystemPlaylist(playlist) && playlist.source_external_id === "liked";
}

/**
 * Narrows the answer of {@link PlayEventsNamespace.record}.
 *
 * The endpoint answers with two different shapes on two different statuses
 * (`200 {"deduped":true}` and `201 <event>`), and the SDK cannot see the status
 * from the parsed body, so the shape is the test.
 */
export function playWasDeduped(result: RecordPlayResult): result is PlayEventDeduped {
  return (result as PlayEventDeduped).deduped === true;
}

/**
 * The `music.playlists` namespace.
 *
 * Mount it wherever you like; the sub-namespaces are reachable through it and
 * are also exported separately if you would rather mount them at their own
 * paths.
 */
export class MusicPlaylistsNamespace extends Resource {
  /** The join rows: what is inside a playlist, and in what order. */
  readonly songs: PlaylistSongsNamespace;
  /** Generated shelves, refreshed daily. */
  readonly mixes: MusicMixesNamespace;
  /** Artist and song radios. Throttled harder than everything else here. */
  readonly radios: MusicRadiosNamespace;
  /** Play history and the aggregates built on it. */
  readonly plays: PlayEventsNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.songs = new PlaylistSongsNamespace(http);
    this.mixes = new MusicMixesNamespace(http);
    this.radios = new MusicRadiosNamespace(http);
    this.plays = new PlayEventsNamespace(http);
  }

  /**
   * `GET /playlists` - the caller's library: playlists they own, plus the ones
   * they follow while those stay visible.
   *
   * "While those stay visible" is doing real work. A followed playlist leaves
   * the listing the moment its owner sets it back to `private` or the friendship
   * ends, without any event and without the follow being deleted; re-friending
   * brings it back. So a client that caches this list has to treat a
   * disappearance as normal rather than as a deletion.
   *
   * This is NARROWER than what {@link get} will open: a friend's `friends`
   * playlist you have not followed is readable by id but never enumerated here.
   *
   * The default order is `created_at:desc` rather than the server's, which is
   * unspecified. Offset pagination over an unordered query in Postgres can
   * repeat a row on one page and skip it on the next, so the SDK always sends
   * an order. Pass `order` to choose another one.
   *
   * Filters are `name` and `ids` and nothing else - see
   * {@link ListPlaylistsParams.name} for why. Indexes carry an `ETag`, so a
   * conditional GET can come back `304`; the transport does not fabricate a
   * body for that, and no method here sends `If-None-Match` of its own.
   *
   * Ceiling: the general authenticated 600/min.
   */
  async list(
    params: ListPlaylistsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<MusicPlaylist>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const order = params.order ?? "created_at:desc";

    const load = (at: { page: number; pageSize: number }): Promise<MusicPlaylist[]> =>
      this.fetchPage({ ...at, order, ...params }, options);

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `GET /playlists/:id` - one playlist.
   *
   * Wider than {@link list}: this opens any playlist you own AND any playlist a
   * friend has set to `friends`, followed or not. That is what makes a shared
   * link work before the recipient has followed anything.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` when the playlist does not
   *   exist OR is not visible to you. The two are deliberately indistinguishable.
   */
  async get(id: MusicPlaylistId, options: RequestOptions = {}): Promise<MusicPlaylist> {
    return this.http.get<MusicPlaylist>(`/playlists/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `POST /playlists` - creates a playlist, optionally seeded with songs.
   *
   * The seeding branch is the interesting one, and it fails soft on the server:
   * ids you cannot see are dropped without a word, duplicates are collapsed, and
   * the playlist is created regardless. It is done in one transaction AFTER the
   * playlist is saved, so a failure there leaves an empty playlist behind rather
   * than nothing.
   *
   * Not retried on a lost answer (the transport's default for a `POST`), because
   * a replay mints a second playlist. A `429` is still retried, and safely so:
   * this backend refuses before it writes.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {TypeError} when more than {@link PLAYLIST_SEED_CAP} song ids are
   *   passed, or one of them is not an integer. The server would silently keep
   *   the first 500 and drop the rest.
   * @throws {OmsApiError} 400 when the name is blank or `visibility` is not one
   *   of {@link PlaylistVisibility}, and when `artworkMediaId` does not resolve
   *   (`"Invalid artwork media id"`).
   */
  async create(input: CreatePlaylistInput, options: RequestOptions = {}): Promise<MusicPlaylist> {
    const songIds = input.songIds === undefined ? undefined : integerIds(input.songIds, "songIds");
    if (songIds !== undefined && songIds.length > PLAYLIST_SEED_CAP) {
      throw new TypeError(
        `A playlist can be seeded with at most ${PLAYLIST_SEED_CAP} songs in one call, and ${songIds.length} were ` +
          "given. The server keeps the first 500 and drops the rest without saying so; add the remainder with " +
          "songs.add() instead.",
      );
    }

    return this.http.post<MusicPlaylist>(
      "/playlists",
      {
        name: input.name,
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        ...(input.artworkMediaId === undefined ? {} : { artwork_media_id: input.artworkMediaId }),
        ...(songIds === undefined ? {} : { song_ids: songIds }),
      },
      options,
    );
  }

  /**
   * `PATCH /playlists/:id` - renames, re-visibilities or re-arts a playlist.
   *
   * The system-playlist guard here is per FIELD, not per request: `visibility`
   * is the owner's and goes through on a synced playlist, while a `name` or an
   * artwork change on the same playlist is refused. Sending all three at once
   * therefore fails as a whole - split the call if you want the visibility
   * change to land anyway.
   *
   * `artworkMediaId: null` purges the current cover; omitting the key leaves it
   * alone. See {@link UpdatePlaylistInput.artworkMediaId}.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` when the playlist is not
   *   visible to you; 401 when it is visible but not yours, and 401 again with
   *   an explanatory sentence when it is a system playlist and the change is
   *   one the sync owns; 400 on an invalid `artworkMediaId` or visibility.
   */
  async update(
    id: MusicPlaylistId,
    input: UpdatePlaylistInput,
    options: RequestOptions = {},
  ): Promise<MusicPlaylist> {
    return this.http.patch<MusicPlaylist>(
      `/playlists/${encodeURIComponent(String(id))}`,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        // `null` has to survive as an explicit key: it is what purges the cover.
        ...(input.artworkMediaId === undefined ? {} : { artwork_media_id: input.artworkMediaId }),
      },
      options,
    );
  }

  /**
   * `DELETE /playlists/:id` - destroys the playlist, its join rows, its follows
   * and its artwork blob. `204`, so this resolves to `undefined`.
   *
   * The songs themselves are untouched - a playlist owns memberships, not audio.
   * Deleting a SYSTEM playlist is allowed, and it is the only way to opt out of
   * a sync from this side; the provider will recreate it on the next run unless
   * the sync itself is switched off.
   *
   * @throws {OmsApiError} 404 when not visible, 401 when visible but not yours.
   */
  async delete(id: MusicPlaylistId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/playlists/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `POST /playlists/:id/copy` - forks a playlist into an editable one of your
   * own. `201` with the new playlist.
   *
   * This is the escape hatch from a system playlist, and its whole purpose:
   * the copy has `source_kind: "manual"`, so everything that was refused on the
   * original works on it. The artwork is re-attached to the SAME blob, which
   * costs no bytes and counts once against the music quota, and the songs are
   * renumbered densely from 1.
   *
   * Two things it will not do. It only copies a playlist you OWN - a friend's
   * playlist that {@link get} opens happily answers `401 "not yours"` here,
   * which `docs/api-music.md` does not mention. And the new name is built
   * server-side as `"<name> (cópia)"`, in Portuguese, whatever the client's
   * locale; rename it afterwards with {@link update} if that matters.
   *
   * Hidden rows are left behind: a copy is what you SEE, not what the sync
   * knows about.
   *
   * @throws {OmsApiError} 404 `"playlist not found"` (lower case here, unlike
   *   the generic `"Resource not found"` elsewhere), 401 `"not yours"`.
   */
  async copy(id: MusicPlaylistId, options: RequestOptions = {}): Promise<MusicPlaylist> {
    return this.http.post<MusicPlaylist>(
      `/playlists/${encodeURIComponent(String(id))}/copy`,
      undefined,
      options,
    );
  }

  /**
   * `POST /playlists/:id/reorder` - rewrites the order of the playlist.
   *
   * Read this before calling it. The endpoint is not "move song X to slot N";
   * it is "here is the complete order", and the implementation is one line that
   * makes three things true at once:
   *
   * ```ruby
   * new_position = @song_ids.index(ps.song_id)
   * ps.update(position: new_position) if new_position
   * ```
   *
   * 1. **Positions become the INDEX in your array, so they start at 0.** Every
   *    other path numbers from 1 (seeding) or from `max + 1` (appending). After
   *    a reorder the playlist is densely numbered `0..n-1`.
   * 2. **A row whose song you left out keeps its OLD position.** It is not
   *    moved to the end and not removed - it stays wherever it was and now
   *    interleaves with, or collides with, the renumbered rows. So send the
   *    complete order, always. Ordering by `position` after a partial reorder
   *    gives an arrangement nobody asked for.
   * 3. **The ids are matched with `Array#index`, which is `==` on Integers.**
   *    A string id matches nothing, so `["12","5"]` moves NOTHING and still
   *    answers `200`. This is the silent failure this method exists to prevent:
   *    it coerces to numbers and throws on anything that is not an integer.
   *
   * The response body is the reorderer's internal output (raw ActiveRecord JSON
   * of the join rows, not the blueprint) and is not part of the contract, so
   * this resolves to `undefined`. Refetch with
   * {@link PlaylistSongsNamespace.list} if you need the new state.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {TypeError} on an empty array (the service raises `ArgumentError`
   *   for it, which is a 500, not a 400) or on an id that is not an integer.
   * @throws {OmsApiError} 404 when the playlist is not visible, 401 `"not yours"`
   *   when it is visible but somebody else's - following it is not enough - and
   *   401 with the "make a copy first" sentence on a system playlist.
   */
  async reorder(
    id: MusicPlaylistId,
    songIds: readonly number[],
    options: RequestOptions = {},
  ): Promise<void> {
    const ids = integerIds(songIds, "songIds");
    if (ids.length === 0) {
      throw new TypeError(
        "reorder needs the complete desired order and refuses an empty array: the backend raises ArgumentError " +
          "for it, which surfaces as a 500 rather than a 400.",
      );
    }
    await this.http.post<unknown>(
      `/playlists/${encodeURIComponent(String(id))}/reorder`,
      { song_ids: ids },
      options,
    );
  }

  /**
   * `POST /playlists/:id/upload_artwork` - uploads a new cover. Multipart, in
   * the field `artwork`. `200` with the updated playlist.
   *
   * Works in all three runtimes, and the file is what differs between them:
   * pass a `FileInput` (`{ data: Blob | Uint8Array | ReadableStream, filename }`)
   * in the browser, in Bun or in a Worker, and pass the `{ uri, name, type }`
   * descriptor your picker returned on React Native. The RN descriptor is
   * appended to the `FormData` untouched so the native layer can stream it off
   * disk; on any other runtime that object would go out as the literal text
   * `"[object Object]"`, so `buildFormData` throws there instead of uploading
   * a 200 with no file in it.
   *
   * The bytes go through the music quota funnel, and replacing a cover
   * `purge_later`s the previous blob rather than leaking it. Note that this is
   * the only artwork path that spends quota: pointing `artworkMediaId` at an
   * existing attachment reuses the blob and costs nothing.
   *
   * Uploads are capped at roughly 100 MB by the CDN in front of the API, well
   * above anything an image crop produces; the app sends a JPEG of about 2 MB.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {OmsApiError} 400 `"Music storage quota exceeded"` when the account
   *   is out of music storage; 404 when the playlist is not visible; 401 when
   *   it is not yours or is a system playlist.
   */
  async uploadArtwork(
    id: MusicPlaylistId,
    artwork: FileInput | NativeFile,
    options: RequestOptions = {},
  ): Promise<MusicPlaylist> {
    return this.http.postForm<MusicPlaylist>(
      `/playlists/${encodeURIComponent(String(id))}/upload_artwork`,
      { artwork },
      options,
    );
  }

  /** One page of the playlist listing. */
  private async fetchPage(
    at: { page: number; pageSize: number; order: string } & ListPlaylistsParams,
    options: RequestOptions,
  ): Promise<MusicPlaylist[]> {
    const query: QueryParams = {
      modifiers: { page: pageModifier(at.page, at.pageSize), order: at.order },
      ...(at.name === undefined ? {} : { search: { name: at.name } }),
      ...(at.ids === undefined ? {} : { exact_search: { id: [...at.ids] } }),
    };
    const items = await this.http.get<MusicPlaylist[] | undefined>("/playlists", { ...options, query });
    return items ?? [];
  }
}

/**
 * The `playlist_songs` join rows: membership, order, and the semi-sync dance
 * around removing a song from a playlist somebody else maintains.
 *
 * Every method here addresses a ROW, never a song. The two ids are both plain
 * numbers and swapping them addresses a real, different row, so a mix-up
 * silently operates on the wrong record instead of erroring.
 */
export class PlaylistSongsNamespace extends Resource {
  /**
   * `GET /playlist_songs` - the rows of a playlist, or every playlist a song is
   * in, with the full song embedded on each row.
   *
   * Defaults to `position:asc` and a page of 100, which is how a playlist screen
   * reads itself. Filtering by `songId` instead is the membership check the
   * "add to playlist" dialogue needs: one request tells you which playlists
   * already contain the song.
   *
   * The scope is `Playlist.viewable_by`, so this also lists a friend's `friends`
   * playlist. What a follower does NOT see is the hidden rows: the query is
   * `hidden = FALSE OR playlists.user_id = <you>`, so the same playlist has a
   * different length depending on who is asking. Do not use a row count from
   * here as the owner's row count.
   *
   * Every row carries a fully preloaded song (artists, artwork, audio and stem
   * media ids), so a page of 100 is a large payload. Ask for the page size you
   * will actually render.
   *
   * Ceiling: the general authenticated 600/min.
   */
  async list(
    params: ListPlaylistSongsParams = {},
    options: RequestOptions = {},
  ): Promise<Paginated<MusicPlaylistSong>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const order = params.order ?? "position:asc";

    const load = (at: { page: number; pageSize: number }): Promise<MusicPlaylistSong[]> =>
      this.fetchPage({ ...at, order, ...params }, options);

    return createPage(await load({ page, pageSize }), page, pageSize, load);
  }

  /**
   * `POST /playlist_songs` - appends a song to a playlist. `201` with the row.
   *
   * The position is assigned server-side and you cannot choose it: it is
   * `max(position) + 1` normally, and on a SYSTEM playlist it is lifted to at
   * least {@link PLAYLIST_MANUAL_BLOCK_FLOOR} with `origin: "manual"`, so the
   * addition sits in a block the sync never renumbers.
   *
   * Adding to a system playlist WORKS. `docs/api-music.md` still says this is a
   * `401`, and it was before semi-sync landed; the current controller only
   * requires that you own the playlist. What is still refused on a system
   * playlist is renaming it, re-arting it and reordering it.
   *
   * Not retried on a lost answer: the unique index would turn the replay into a
   * `400`, reporting a failure for a row that was in fact created.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {OmsApiError} 400 `"Song has already been taken"` when the song is
   *   already on the playlist - including when it is there as a HIDDEN row,
   *   which is invisible to a follower and the usual cause of a surprising
   *   duplicate error; 404 `"Song not found"` when the song is not visible to
   *   you; 401 when the playlist is not yours.
   */
  async add(
    playlistId: MusicPlaylistId,
    songId: number,
    options: RequestOptions = {},
  ): Promise<MusicPlaylistSong> {
    return this.http.post<MusicPlaylistSong>(
      "/playlist_songs",
      { playlist_id: playlistId, song_id: songId },
      options,
    );
  }

  /**
   * `DELETE /playlist_songs/:id` - takes a song off a playlist. `204`, so this
   * resolves to `undefined`.
   *
   * `rowId` is the JOIN ROW id, the `id` on a {@link MusicPlaylistSong}, not the
   * song's id. Passing a song id here will usually address some other real row.
   *
   * **It does not always delete.** On a row the sync created (`origin: "sync"`)
   * the server marks it `hidden` and keeps it, because a deleted row would just
   * be recreated on the next sync run. The status is `204` either way, so the
   * response cannot tell you which happened - look at `origin` on the row before
   * you call, and expect a hidden row to keep appearing in the OWNER's listings.
   * {@link unhide} puts it back.
   *
   * Manual rows are deleted for real, on system playlists too.
   *
   * @throws {OmsApiError} 404 when the row is not visible, 401 when the playlist
   *   is not yours.
   */
  async remove(rowId: MusicPlaylistSongId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/playlist_songs/${encodeURIComponent(String(rowId))}`, options);
  }

  /**
   * `POST /playlist_songs/:id/hide` - hides a row without deleting it. `200`
   * with the updated row.
   *
   * This is what {@link remove} does implicitly to a sync row, made explicit and
   * available for manual rows too. Included even though it is not in the route
   * list this module was commissioned from, because exposing the hiding half of
   * the mechanism without {@link unhide} would leave a caller unable to undo a
   * `remove`.
   *
   * @throws {OmsApiError} 404 when the row is not visible, 401 when the playlist
   *   is not yours.
   */
  async hide(rowId: MusicPlaylistSongId, options: RequestOptions = {}): Promise<MusicPlaylistSong> {
    return this.http.post<MusicPlaylistSong>(
      `/playlist_songs/${encodeURIComponent(String(rowId))}/hide`,
      undefined,
      options,
    );
  }

  /**
   * `POST /playlist_songs/:id/unhide` - puts a hidden row back. `200` with the
   * updated row.
   *
   * The only way to undo a {@link remove} that turned into a hide. It needs the
   * row id, and only the OWNER can see a hidden row to get one - a follower's
   * listing does not contain it.
   *
   * @throws {OmsApiError} 404 when the row is not visible, 401 when the playlist
   *   is not yours.
   */
  async unhide(rowId: MusicPlaylistSongId, options: RequestOptions = {}): Promise<MusicPlaylistSong> {
    return this.http.post<MusicPlaylistSong>(
      `/playlist_songs/${encodeURIComponent(String(rowId))}/unhide`,
      undefined,
      options,
    );
  }

  /** One page of the join-row listing. */
  private async fetchPage(
    at: { page: number; pageSize: number; order: string } & ListPlaylistSongsParams,
    options: RequestOptions,
  ): Promise<MusicPlaylistSong[]> {
    const exact: QueryParams = {};
    if (at.playlistId !== undefined) exact["playlist_id"] = at.playlistId;
    if (at.songId !== undefined) exact["song_id"] = at.songId;
    if (at.ids !== undefined) exact["id"] = [...at.ids];
    if (at.origin !== undefined) exact["origin"] = at.origin;
    if (at.hidden !== undefined) exact["hidden"] = at.hidden;

    const query: QueryParams = {
      modifiers: { page: pageModifier(at.page, at.pageSize), order: at.order },
      ...(Object.keys(exact).length === 0 ? {} : { exact_search: exact }),
    };
    const items = await this.http.get<MusicPlaylistSong[] | undefined>("/playlist_songs", {
      ...options,
      query,
    });
    return items ?? [];
  }
}

/**
 * Generated mix shelves: "This is X", the monthly rewind, the year mix, the
 * time capsule, the discoveries.
 *
 * The whole set is generated per user and cached server-side for 24 hours, so
 * the first call after the cache expires is the slow one and everything after
 * it is cheap. The set ROTATES: slugs are content-addressed, so yesterday's
 * slug is simply gone today, which is why {@link get} answers `404` far more
 * often than a missing-record `404` normally would.
 *
 * Neither endpoint is CRUD-shaped: there is no list DSL, no paging and no
 * ETag. {@link list} always returns the complete set.
 */
export class MusicMixesNamespace extends Resource {
  /**
   * `GET /music_mixes` - every shelf currently generated for the caller,
   * without their songs.
   *
   * The song ids are stripped from this view on purpose, so the payload stays
   * small; fetch one shelf with {@link get} when the user opens it.
   *
   * Titles come twice over. `title` and `description` are an English fallback;
   * `title_key`/`title_params` and their description twins are the i18n
   * template the UI should actually render, so the shelf follows the app
   * language instead of being permanently one language. The embedded `artist`
   * is resolved at render time rather than cached with the shelf, so a picture
   * that lands today shows up today.
   *
   * Ceiling: the general authenticated 600/min.
   */
  async list(options: RequestOptions = {}): Promise<MusicMixSummary[]> {
    const items = await this.http.get<MusicMixSummary[] | undefined>("/music_mixes", options);
    return items ?? [];
  }

  /**
   * `GET /music_mixes/:slug` - one shelf with its songs, in mix order.
   *
   * The slug contains colons (`mix:top_artist:1:ab12cd34`). This encodes it for
   * you; the route accepts any segment without a slash.
   *
   * A `404` here is ORDINARY, not an error to report. The shelves rotate as the
   * user's listening changes and the cache turns over every 24 hours, so a slug
   * captured yesterday, deep-linked, or held in a stale list is simply not in
   * today's set. Refetch {@link list} and let the user pick again.
   *
   * The songs are filtered to the caller's own library, so a shelf can come back
   * with fewer songs than it was generated with if tracks were deleted in the
   * meantime.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {OmsApiError} 404 `"Mix not found"`.
   */
  async get(slug: string, options: RequestOptions = {}): Promise<MusicMix> {
    return this.http.get<MusicMix>(`/music_mixes/${encodeURIComponent(slug)}`, options);
  }
}

/**
 * Artist and song radios: about 40 tracks built by intersecting Last.fm
 * similar-artist data with what the caller actually owns.
 *
 * **This is the throttled family.** `/music_radios/*` sits behind
 * rack-attack's `external_proxy/by_session` rule at
 * {@link MUSIC_RADIO_RATE_LIMIT_PER_MINUTE} requests per minute, shared with
 * `/lyrics`, `/artists/*` and `/artist_metadata/*`. The bucket key is the
 * `Authorization` HEADER when there is one and the client IP when there is not,
 * which has a consequence worth planning around: a cookie-authenticated web
 * client sends no `Authorization`, so every visitor behind one address shares a
 * single 60/min budget. Token clients get a bucket per token.
 *
 * Over the limit the API answers `429` with a `Retry-After`, which the transport
 * honours by sleeping and retrying - a rate-limited call can therefore take most
 * of a minute. Pass `retry: false` on anything with a user waiting.
 *
 * A built radio is cached per user for 7 days, so the cost is paid once.
 */
export class MusicRadiosNamespace extends Resource {
  /**
   * `GET /music_radios/artist/:artist` - a radio seeded on one artist.
   *
   * Takes the artist's SLUG or their name: the backend canonicalises what you
   * send and tries `canonical_name` first, then `slug`. `docs/api-music.md` says
   * slug only, which understates it. Either way the lookup is against the
   * caller's own roster and never creates an artist, so an artist you do not
   * have is a `404` rather than an empty radio.
   *
   * Roughly 30% of the tracks come from the seed artist and the rest from
   * similar artists you own, shuffled. The mix is drawn with `RANDOM()` on the
   * first build and then frozen for 7 days, so calling twice gives the same
   * radio, not a reshuffle.
   *
   * Ceiling: {@link MUSIC_RADIO_RATE_LIMIT_PER_MINUTE} per minute. A cold build
   * runs several queries over the whole library; the mobile app allows 60
   * seconds for it, and passing `timeoutMs` is reasonable here.
   *
   * @throws {OmsApiError} 404 `"Could not build radio for <artist>"` - the same
   *   answer for "no such artist in your library" and for "nothing similar to
   *   play". 429 when the minute's budget is spent.
   */
  async forArtist(artistSlugOrName: string, options: RequestOptions = {}): Promise<MusicRadio> {
    return this.http.get<MusicRadio>(
      `/music_radios/artist/${encodeURIComponent(artistSlugOrName)}`,
      options,
    );
  }

  /**
   * `GET /music_radios/song/:id` - a radio seeded on one song.
   *
   * Built by taking the song's lead artist's radio and re-titling it, so a song
   * with no artist credit cannot produce one. The seed song is guaranteed to be
   * `songs[0]` - it is unshifted in if the shuffle did not already include it -
   * which is what lets a client start playback at index 0 and have the user hear
   * the track they tapped.
   *
   * Ceiling: {@link MUSIC_RADIO_RATE_LIMIT_PER_MINUTE} per minute.
   *
   * @throws {OmsApiError} 404 `"Could not build radio for song <id>"` when the
   *   song is not yours, has no artist, or its artist yields nothing to play.
   *   429 when the minute's budget is spent.
   */
  async forSong(songId: number, options: RequestOptions = {}): Promise<MusicRadio> {
    return this.http.get<MusicRadio>(
      `/music_radios/song/${encodeURIComponent(String(songId))}`,
      options,
    );
  }
}

/**
 * Play history: recording what was listened to, and the aggregates built on it.
 *
 * None of these are CRUD-shaped. They take plain query parameters (`limit`,
 * `group_by`, `scope`, `since`, `artist`), not the list DSL, so `modifiers[page]`
 * and `search[...]` are ignored rather than rejected here, there is no ETag, and
 * `limit` is the only way to bound a result. There is no way to page past it:
 * {@link PLAY_EVENT_MAX_LIMIT} rows is all the history these endpoints will give.
 *
 * Everything is scoped to the caller's own events. There is no route to read
 * anyone else's.
 */
export class PlayEventsNamespace extends Resource {
  /**
   * `POST /play_events` - records that a song was played.
   *
   * Two answers, two shapes, and this is the one thing to get right: a play of
   * the same song within {@link PLAY_EVENT_DEDUPE_WINDOW_MS} of the last one is
   * SWALLOWED, and the server answers `200 {"deduped": true}` instead of `201`
   * with an event. The transport parses both into the same promise, so narrow
   * with {@link playWasDeduped} before touching `.id`. The dedupe exists because
   * scrubbing, a rewind, and a double-mounted player component all look like
   * fresh plays otherwise.
   *
   * That window also makes this the one write in this file that is SAFE to
   * retry: a duplicate arriving inside 30 seconds is absorbed rather than
   * doubled. The transport still will not replay a `POST` by default, so pass
   * `retry: {}` if a lost answer on a flaky connection should be tried again.
   *
   * Hosts usually treat this as fire-and-forget - the app does, with no error
   * UI - because a lost play event is worth less than an error toast during
   * playback.
   *
   * `listenedSeconds` is clamped server-side rather than validated: `0` is the
   * floor and three times the track's duration is the ceiling, or 24 hours when
   * the duration is unknown or zero, so a runaway accumulator is capped instead
   * of refused.
   *
   * Ceiling: the general authenticated 600/min. A client that posts one event
   * per track is nowhere near it; one that posts on every seek is not.
   *
   * @throws {OmsApiError} 400 when `songId` is missing (`ParameterMissing`), 404
   *   `"Song not found"` when the song is not visible to you.
   */
  async record(input: RecordPlayInput, options: RequestOptions = {}): Promise<RecordPlayResult> {
    return this.http.post<RecordPlayResult>(
      "/play_events",
      {
        song_id: input.songId,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.listenedSeconds === undefined ? {} : { listened_s: input.listenedSeconds }),
      },
      options,
    );
  }

  /**
   * `GET /play_events/recent?group_by=song` - recently played songs, newest
   * first, each song appearing at most once with the timestamp of its latest
   * play.
   *
   * Collapsed, not raw history: ten plays of one song are one row. There is no
   * endpoint that returns the raw event stream.
   *
   * `limit` defaults to 24 and is capped at {@link PLAY_EVENT_MAX_LIMIT}. A value
   * the server cannot read as a positive integer falls back to the default
   * rather than failing, so a bad limit is invisible.
   *
   * Ceiling: the general authenticated 600/min.
   */
  async recentSongs(
    params: RecentPlaysParams = {},
    options: RequestOptions = {},
  ): Promise<RecentSongPlay[]> {
    const rows = await this.http.get<RecentSongPlay[] | undefined>("/play_events/recent", {
      ...options,
      query: { group_by: "song", ...limitQuery(params.limit) },
    });
    return rows ?? [];
  }

  /**
   * `GET /play_events/recent?group_by=album` - recently played albums.
   *
   * Grouped by album name AND lead artist, so two albums with the same title by
   * different artists stay apart. Songs with no album are excluded entirely -
   * the query filters `album NOT IN (NULL, '')` - so a library of loose singles
   * produces an empty shelf here while {@link recentSongs} is full.
   *
   * Ceiling: the general authenticated 600/min.
   */
  async recentAlbums(
    params: RecentPlaysParams = {},
    options: RequestOptions = {},
  ): Promise<RecentAlbumPlay[]> {
    const rows = await this.http.get<RecentAlbumPlay[] | undefined>("/play_events/recent", {
      ...options,
      query: { group_by: "album", ...limitQuery(params.limit) },
    });
    return rows ?? [];
  }

  /**
   * `GET /play_events/top?scope=song` - most played songs, with their counts.
   *
   * `since` defaults to `"all"`; the windows are fixed strings and anything else
   * is a `400`, so do not build one from a date. `limit` defaults to 10, capped
   * at {@link PLAY_EVENT_MAX_LIMIT}.
   *
   * The `artist` filter is the "popular tracks by this artist" query and only
   * exists on this scope. It matches on the canonicalised NAME against the
   * caller's own roster, and an artist that does not resolve gives an EMPTY
   * ARRAY rather than a `404` - indistinguishable from an artist you own but
   * have never played.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {OmsApiError} 400 `"Invalid since; must be 7d, 30d, 90d, or all"`.
   */
  async topSongs(params: TopSongsParams = {}, options: RequestOptions = {}): Promise<TopSongRow[]> {
    const rows = await this.http.get<TopSongRow[] | undefined>("/play_events/top", {
      ...options,
      query: {
        scope: "song",
        ...sinceQuery(params.since),
        ...limitQuery(params.limit),
        ...(params.artist === undefined ? {} : { artist: params.artist }),
      },
    });
    return rows ?? [];
  }

  /**
   * `GET /play_events/top?scope=album` - most played albums, with their counts.
   *
   * Same album/artist grouping and the same exclusion of songs with no album as
   * {@link recentAlbums}. The `artist` filter does NOT apply to this scope; it
   * is ignored rather than rejected, which is why this method does not offer it.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {OmsApiError} 400 on an unrecognised `since`.
   */
  async topAlbums(params: TopPlaysParams = {}, options: RequestOptions = {}): Promise<TopAlbumRow[]> {
    const rows = await this.http.get<TopAlbumRow[] | undefined>("/play_events/top", {
      ...options,
      query: { scope: "album", ...sinceQuery(params.since), ...limitQuery(params.limit) },
    });
    return rows ?? [];
  }

  /**
   * `GET /play_events/top?scope=artist` - most played artists, with their counts.
   *
   * Counted on credits whose `role` is `"primary"`, at ANY position - NOT the
   * stricter lead credit (`role: "primary"` and `position: 0`) that the album
   * groupings use. A track credited to two primaries therefore counts once for
   * each of them, and these counts can add up to more than the number of plays.
   * A featured credit never counts.
   *
   * Every row carries a compact artist, never a bare name.
   *
   * Ceiling: the general authenticated 600/min.
   *
   * @throws {OmsApiError} 400 on an unrecognised `since`.
   */
  async topArtists(
    params: TopPlaysParams = {},
    options: RequestOptions = {},
  ): Promise<TopArtistRow[]> {
    const rows = await this.http.get<TopArtistRow[] | undefined>("/play_events/top", {
      ...options,
      query: { scope: "artist", ...sinceQuery(params.since), ...limitQuery(params.limit) },
    });
    return rows ?? [];
  }
}

/**
 * Validates and clamps a `limit` for the history endpoints.
 *
 * The server's own handling is `value.to_i`, then "fall back to the default if
 * it is not positive", then "take the smaller of it and the maximum" - so `0`,
 * a negative and a word all quietly become the default, and 5000 quietly becomes
 * 100. Both silences hide a caller bug, so the SDK rejects what cannot be meant
 * and clamps what merely overshoots.
 *
 * @throws {TypeError} when the limit is not a finite integer of at least 1.
 */
function limitQuery(limit: number | undefined): QueryParams {
  if (limit === undefined) return {};
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(
      `limit must be a whole number of at least 1, got ${String(limit)}. The server would read it as 0 and ` +
        "silently substitute its own default.",
    );
  }
  return { limit: Math.min(limit, PLAY_EVENT_MAX_LIMIT) };
}

/** Sends `since` only when it was asked for; the server default is `"all"`. */
function sinceQuery(since: PlayEventWindow | undefined): QueryParams {
  return since === undefined ? {} : { since };
}

/**
 * Coerces a list of song ids to integers, or explains why it will not.
 *
 * This exists because of `reorder`. The backend matches ids with `Array#index`,
 * which compares an Integer column against whatever you sent: a numeric string
 * matches NOTHING, and the endpoint answers `200` having moved nothing at all.
 * A failure that looks exactly like a success is worth a local throw.
 *
 * Numeric strings are accepted and converted, since ids arrive as strings from
 * routers and forms often enough that refusing them would be pedantry; anything
 * that is not a whole number is refused.
 */
function integerIds(ids: readonly number[], field: string): number[] {
  return ids.map((raw, index) => {
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new TypeError(
        `${field}[${index}] is ${JSON.stringify(raw)}, which is not an integer id. Song ids are integers on this ` +
          "API, and the backend matches them by identity: a string id matches no row, so the request would " +
          "succeed and change nothing.",
      );
    }
    return value;
  });
}
