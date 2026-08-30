/**
 * The `music.songs` namespace: the library, its lyrics and its stems.
 *
 * Everything under here is strictly single-tenant: there is no such thing as
 * reading somebody else's track by id. A foreign id is a
 * `404 "Resource not found"`, never a `403`. The same is true of
 * `liked_songs`, of `/artist_metadata/:name` (which resolves against YOUR
 * artist roster, not a global one) and of `/songs/artist_pictures`. Cross-user
 * song payloads exist in this API, but they arrive through jams and social
 * feeds, not through this namespace.
 *
 * ## Three things to know before the first call
 *
 * **Song ids are integers.** So are `liked_songs` ids. The ids sitting NEXT to
 * them are not: `user_id` is a string uuid, every `*_media_id` is a string, and
 * a vocal separation's own `id` is a string. On the realtime stream the same
 * song ids come back as strings. Compare with `===` against the right type or
 * nothing will ever match.
 *
 * **Media never travels inline.** A song carries ids of storage nodes, not
 * bytes and not URLs. Resolve one with `oms.media` (`GET /media/:id/data_url`
 * hands back a short-lived signed URL, which is what you give a player).
 * `GET /fs_nodes/:id/data_url` is a legacy alias that reaches the same bytes;
 * new code should ask `oms.media`. Prefer the compressed twin either way:
 * `compressed_audio_media_id` before `audio_media_id`,
 * `compressed_artwork_media_id` before `artwork_media_id`. The originals are
 * lossless files on slow storage and an album grid that reaches for them takes
 * seconds per tile.
 *
 * **Every key that names a media node is sent TWICE.** `<name>_media_id` and
 * `<name>_fs_node_id` carry the identical value, the second being a legacy
 * alias. Read the `_media_id` spelling; the twin is declared here only so that
 * older code keeps type-checking, and it will be removed server-side without a
 * major version of this SDK.
 *
 * ## An OAuth token cannot reach any of this
 *
 * An OAuth access token gets `403 {"error":"insufficient_scope"}` on EVERY
 * method here. Music needs a session cookie or a personal token. That gap may
 * close later; until it does, an {@link OmsAuthError} with status 403 and that
 * body means "wrong kind of credential", not "wrong user".
 *
 * ## The 60-per-minute bucket nobody expects to share
 *
 * `/lyrics*`, `/artists/*`, `/artist_metadata/*` and `/music_radios/*` share
 * ONE budget of 60 requests per minute, keyed by the `Authorization` header,
 * because all four proxy to somebody else's servers (lrclib, Genius, Last.fm,
 * Wikipedia, Deezer). One counter, four route families: fetching lyrics for
 * sixty tracks in a minute leaves zero budget for artist metadata, and the 429
 * lands on whichever call is unlucky enough to be the sixty-first. Pace a
 * backfill at roughly one request per second and it will never be seen.
 *
 * The rest of the namespace lives under the general ceiling (600/min
 * authenticated), with two exceptions that have their own budgets and their own
 * doc comments: {@link MusicSongsNamespace.startSeparation} (20/min, shared with
 * every other expensive tool) and {@link MusicSongsNamespace.externalSearch}
 * (30/min, and it does NOT answer 429 - read that method).
 */

import { OmsApiError } from "../../errors";
import { NULL_SENTINEL, Resource, buildFormData, filenameFromDisposition, readJson } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { ListParams, PageAt } from "../../listing";
import {
  createPage,
  type BaseRecord,
  type FileInput,
  type FileOutput,
  type Id,
  type NativeFile,
  type PageParams,
  type Paginated,
  type QueryParams,
  type QueryValue,
  type RequestOptions,
  type Timestamp,
} from "../../types";
import type { VocalSeparation } from "../tools/vocalSeparation";

/**
 * Primary key of a song. An **integer**, unlike most ids in this API.
 *
 * `songs`, `artists`, `playlists`, `playlist_songs`, `liked_songs`,
 * `play_events`, `jams`, `song_imports` and `artist_imports` kept integer
 * primary keys; `users`, `sessions`, `fs_nodes`, `playback_states` and
 * `vocal_separations` are string uuids. Both spellings are accepted wherever a
 * song id is taken as an argument, because a caller that read the id off a
 * realtime message is holding a string, but the JSON these methods RETURN
 * always carries a number.
 */
export type SongId = number | string;

/** How an artist is credited on a track. */
export type SongArtistRole = "primary" | "featured" | "with";

/**
 * One artist credit, nested under {@link Song.artists}.
 *
 * `id` is the id of the credit row, not of the artist - the artist's own id is
 * `artist_id`. Getting those two the wrong way round is how a link to an artist
 * page ends up pointing at a random other artist, so prefer `slug` for routing
 * and keep `artist_id` for lookups.
 *
 * The picture fields are a deliberate denormalisation: almost no artist has an
 * uploaded image, the cached Deezer picture is what actually renders in a song
 * row, and the alternative was a second request per row. Only `picture` and
 * `picture_medium` travel here; the full set (`picture_small`, `picture_big`,
 * `picture_xl`) lives on the artist record.
 */
export interface SongArtistCredit extends Omit<BaseRecord, "id"> {
  /** Id of the credit row. NOT the artist id. */
  readonly id: number;
  readonly song_id: number;
  readonly artist_id: number;
  /** Ordering within the credits. Sort by it; the server does not. */
  readonly position: number;
  readonly role: SongArtistRole;
  /** `null` only if the credit outlived its artist, which the server prevents. */
  readonly name: string | null;
  readonly slug: string | null;
  /** Artist avatar the user uploaded, as a storage node id. Usually `null`. */
  readonly image_media_id: Id | null;
  readonly compressed_image_media_id: Id | null;
  /** Cached Deezer picture URLs, absolute and public. Usually the ones that render. */
  readonly picture: string | null;
  readonly picture_medium: string | null;
  /** Stamped by the Last.fm / MusicBrainz backfill. */
  readonly external_image_url: string | null;
  /** @deprecated Legacy twin of `image_media_id`. Same value. Read the `_media_id` spelling. */
  readonly image_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `compressed_image_media_id`. Same value. */
  readonly compressed_image_fs_node_id?: Id | null;
}

/** Where a track came from. */
export type SongSourceKind = "upload" | "yt_dlp" | "spotify_sync";

/**
 * A track in the library.
 *
 * The shape below is what every route in this namespace answers with - index,
 * show, update and import alike. There is no narrower view to guard against.
 * There is no `track_number`, no `disc_number` and no legacy `artist` string
 * on the wire; {@link Song.artists} is the only artist source.
 */
export interface Song extends Omit<BaseRecord, "id"> {
  /** Integer primary key. See {@link SongId}. */
  readonly id: number;
  readonly title: string;
  /** `null` is a real value: the "no album" bucket, reachable with `album: null`. */
  readonly album: string | null;
  /** Whole seconds. */
  readonly duration: number;
  /** Legacy library ordering. Nullable and largely unused. */
  readonly position: number | null;
  readonly year: number | null;
  /** Owner. A string uuid, next to an integer `id`. */
  readonly user_id: Id;
  readonly source_kind: SongSourceKind | null;
  /** `"youtube"`, `"soundcloud"`, `"spotify"`, `"bandcamp"`, `"vimeo"`, or another. */
  readonly source_provider: string | null;
  readonly source_url: string | null;
  readonly source_id: string | null;
  /** Recording identifier, when the importer resolved one. */
  readonly isrc: string | null;
  readonly original_filename: string | null;
  readonly audio_codec: string | null;
  readonly audio_bitrate_kbps: number | null;
  readonly audio_sample_rate_hz: number | null;
  readonly audio_channels: number | null;
  readonly audio_lossless: boolean | null;
  readonly audio_filesize_bytes: number | null;
  /**
   * The uploaded file, as a storage node id. `null` when the attachment is
   * gone - which is rare but real, and is why
   * {@link MusicSongsNamespace.startSeparation} can answer `400 "Song has no
   * audio"`.
   */
  readonly audio_media_id: Id | null;
  /** Transcoded stream copy. Prefer it over the original for playback. */
  readonly compressed_audio_media_id: Id | null;
  readonly artwork_media_id: Id | null;
  /** Thumbnail. Prefer it in any grid: the original is a full-size cover. */
  readonly compressed_artwork_media_id: Id | null;
  /** Set once a separation finished. See {@link MusicSongsNamespace.separation}. */
  readonly vocals_media_id: Id | null;
  readonly instrumental_media_id: Id | null;
  /**
   * Stamped when a separation starts and cleared when it settles, so a
   * non-null value means "a separation is in flight". It can go stale if a
   * run dies; `GET /songs/:id/separation` clears it as a side effect, which
   * is one reason to poll that route rather than re-reading the song.
   */
  readonly vocal_separation_started_at: Timestamp | null;
  /** Credits, unsorted. Sort by {@link SongArtistCredit.position} yourself. */
  readonly artists: SongArtistCredit[];
  /** @deprecated Legacy twin of `audio_media_id`. Same value. */
  readonly audio_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `compressed_audio_media_id`. Same value. */
  readonly compressed_audio_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `artwork_media_id`. Same value. */
  readonly artwork_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `compressed_artwork_media_id`. Same value. */
  readonly compressed_artwork_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `vocals_media_id`. Same value. */
  readonly vocals_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `instrumental_media_id`. Same value. */
  readonly instrumental_fs_node_id?: Id | null;
  /**
   * Ready-made presigned URL, present ONLY on a song injected into a jam by
   * another member - the host cannot resolve a stranger's storage nodes, so
   * the jam serializer inlines URLs instead of ids. A song that came out of
   * this namespace never has them.
   */
  readonly audio_url?: string;
  readonly artwork_url?: string | null;
  /** Pre-joined display line, again only on jam entries. */
  readonly artist_names?: string | string[];
  /** Marks a jam proposal. Never record a play event for one. */
  readonly jam_song?: true;
  readonly jam_proposer?: { readonly id: Id; readonly handle: string; readonly name: string };
}

/**
 * A row of `GET /songs/albums`.
 *
 * Not a stored record: the endpoint groups the caller's songs and this is the
 * summary it builds. `name: null` is the bucket of songs with no
 * album, and it is a legitimate row rather than an error.
 */
export interface SongAlbumSummary {
  /** `null` for the no-album bucket. */
  readonly name: string | null;
  /** Display name of the primary artist. A plain string here, not an object. */
  readonly artist: string | null;
  readonly artist_slug: string | null;
  readonly artwork_media_id: Id | null;
  /** @deprecated Legacy twin of `artwork_media_id`. Same value. */
  readonly artwork_fs_node_id?: Id | null;
}

/**
 * One Deezer picture set, from `GET /songs/artist_pictures`.
 *
 * Every field is nullable: Deezer returns partial sets, and the row is only
 * emitted at all when `picture` itself is non-null.
 */
export interface SongArtistPictures {
  readonly picture: string | null;
  readonly picture_small: string | null;
  readonly picture_medium: string | null;
  readonly picture_big: string | null;
  readonly picture_xl: string | null;
}

/** Wrapper `GET /songs/:id/separation` answers with. */
export interface SongSeparationStatus {
  /** True once both stems are attached to the song. The one flag worth branching on. */
  readonly stems_ready: boolean;
  readonly vocals_media_id: Id | null;
  readonly instrumental_media_id: Id | null;
  /**
   * Lifted out of `job` for convenience, and `null` unless the run is actually
   * processing - queued and finished runs both report `null` here.
   */
  readonly progress_percent: number | null;
  /**
   * The run itself, or `null` when this song has never had one.
   *
   * The same `VocalSeparation` record the `tools.vocalSeparation` namespace
   * returns, so it is imported rather than redeclared here. For a song-owned run `vocals_url` and
   * `instrumental_url` are permanently `null`: the stems are written onto the
   * song as storage nodes, not attached to this row.
   */
  readonly job: VocalSeparation | null;
}

/** A liked track. The join row, with the whole song inlined. */
export interface LikedSong extends Omit<BaseRecord, "id"> {
  /** Integer primary key of the like itself. NOT the song id. */
  readonly id: number;
  readonly user_id: Id;
  readonly song_id: number;
  /** The cursor {@link ListLikedSongsParams.before} pages on. */
  readonly liked_at: Timestamp;
  /** Always present. */
  readonly song: Song;
}

/** Lyrics for one track. */
export interface SongLyrics {
  /** LRC text with `[mm:ss.xx]` timestamps, or `null` when only plain text exists. */
  readonly synced: string | null;
  /** Newline-separated plain text, or `null`. */
  readonly plain: string | null;
  /** Where they came from, e.g. `"lrclib.net"`. Never `null`. */
  readonly attribution: string;
}

/** Lyrics translated line for line, with the LRC timestamps untouched. */
export interface SongLyricsTranslation extends SongLyrics {
  /** Echo of the requested target. */
  readonly target: string;
}

/**
 * The seven locales the translator accepts. Anything else is a `400
 * "Unsupported target"`, checked before any work is done and before the
 * hourly budget is spent.
 */
export const LYRICS_TRANSLATION_TARGETS = Object.freeze([
  "pt",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "lv",
] as const);

/** One of {@link LYRICS_TRANSLATION_TARGETS}. */
export type LyricsTranslationTarget = (typeof LYRICS_TRANSLATION_TARGETS)[number];

/** Handle returned by {@link MusicSongsNamespace.syncLyrics}. */
export interface LyricsSyncHandle {
  /** Poll it with `oms.jobs`, or just re-read the lyrics until `synced` appears. */
  readonly job_id: string;
}

/** A related artist, as Last.fm scored it. */
export interface ArtistMetadataSimilar {
  readonly name: string | null;
  /** Similarity in `[0, 1]`, as a number or a numeric string depending on upstream. */
  readonly match: number | string | null;
  readonly mbid: string | null;
}

/**
 * The legacy payload `GET /artist_metadata/:name` answers with.
 *
 * One of the very few records in the API with NO `created_at` / `updated_at`.
 * It also never 404s - see {@link MusicSongsNamespace.artistMetadata}.
 */
export interface ArtistMetadata {
  /** `null` on the not-found branch. Integer when the artist exists. */
  readonly id: number | null;
  /** Echoed back verbatim on the not-found branch, so it is the one non-null key there. */
  readonly name: string | null;
  readonly slug: string | null;
  readonly mbid: string | null;
  readonly lastfm_listeners: number | null;
  readonly lastfm_playcount: number | null;
  /** Sanitised HTML. Still HTML: escape it or render it deliberately. */
  readonly bio_html: string | null;
  /** The artist's `external_image_url`, renamed by this legacy shim. */
  readonly image_url: string | null;
  readonly image_media_id: Id | null;
  readonly compressed_image_media_id: Id | null;
  readonly banner_media_id: Id | null;
  readonly compressed_banner_media_id: Id | null;
  readonly picture: string | null;
  readonly picture_small: string | null;
  readonly picture_medium: string | null;
  readonly picture_big: string | null;
  readonly picture_xl: string | null;
  /** `[]` on the not-found branch, never `null`. */
  readonly similar: ArtistMetadataSimilar[];
  /** @deprecated Legacy twin of `image_media_id`. Same value. */
  readonly image_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `compressed_image_media_id`. Same value. */
  readonly compressed_image_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `banner_media_id`. Same value. */
  readonly banner_fs_node_id?: Id | null;
  /** @deprecated Legacy twin of `compressed_banner_media_id`. Same value. */
  readonly compressed_banner_fs_node_id?: Id | null;
}

/**
 * Where an external-search hit came from.
 *
 * `"soundcloud"` and `"bandcamp"` are kept for compatibility only: the search
 * queries Spotify, iTunes and YouTube and nothing else, so they never appear
 * today.
 */
export type MusicExternalSource = "spotify" | "itunes" | "youtube" | "soundcloud" | "bandcamp";

/** What to ask the external providers for. */
export type MusicExternalSearchKind = "track" | "album" | "artist" | "any";

/** An external track hit. */
export interface MusicExternalTrack {
  readonly source: MusicExternalSource;
  readonly kind: "track";
  /** Provider-native id. `null` from iTunes rows missing a `trackId`. */
  readonly source_id: string | null;
  /** Downloadable or linkable page. Only YouTube rows are actually downloadable. */
  readonly source_url: string | null;
  readonly title: string | null;
  /** Already joined with `", "` for Spotify rows; the uploader name for YouTube. */
  readonly artist: string | null;
  readonly album: string | null;
  readonly duration_ms: number | null;
  /** Spotify only; `null` from iTunes and YouTube. The importer's fast path. */
  readonly isrc: string | null;
  readonly artwork_url: string | null;
}

/** An external album hit. Spotify only. */
export interface MusicExternalAlbum {
  readonly source: "spotify";
  readonly kind: "album";
  readonly source_id: string | null;
  readonly source_url: string | null;
  readonly title: string | null;
  readonly artist: string | null;
  readonly total_tracks: number | null;
  readonly artwork_url: string | null;
}

/** An external artist hit. Spotify only. */
export interface MusicExternalArtist {
  readonly source: "spotify";
  readonly kind: "artist";
  readonly source_id: string | null;
  readonly source_url: string | null;
  readonly name: string | null;
  readonly followers: number | null;
  readonly artwork_url: string | null;
}

/** All three lists, always all three keys. */
export interface MusicExternalSearchResult {
  readonly tracks: MusicExternalTrack[];
  readonly albums: MusicExternalAlbum[];
  readonly artists: MusicExternalArtist[];
}

/**
 * Columns `search` and `exact_search` accept on `/songs` and `/songs/albums`.
 *
 * Exported because the filter allowlist FAILS CLOSED: an unrecognised key is a
 * `400 "Unknown search filters: ..."`, not a wider result. Check against this
 * before building a filter bag from user input.
 *
 * `artist` is on the list but is not a column - see
 * {@link ListSongsParams.artist}.
 */
export const SONG_FILTER_COLUMNS = Object.freeze([
  "id",
  "created_at",
  "updated_at",
  "title",
  "album",
  "position",
  "year",
  "artist",
] as const);

/** Columns the backend will accept in `modifiers[order]`. */
export const SONG_ORDER_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "created_at",
  "updated_at",
  "title",
  "album",
  "duration",
  "position",
  "year",
]);

/** Filters shared by `GET /songs` and `GET /songs/albums`. */
export interface SongFilters {
  /**
   * Partial title match, sent as `search[title]`.
   *
   * The comparison is slug-shaped: the server lowercases, strips accents,
   * replaces every run of non-alphanumerics with a hyphen and then does a
   * substring match on both sides. So `"cafe"` finds
   * "Café", `"nao quero"` finds "Não Quero", and punctuation is irrelevant. It
   * is not a full-text index and there is no ranking.
   *
   * An empty or whitespace-only string is DROPPED rather than matching
   * everything, which is right but means a cleared search box quietly becomes
   * an unfiltered listing.
   */
  readonly title?: string;
  /**
   * Exact album, sent as `exact_search[album]`. Pass `null` for the no-album
   * bucket: the transport encodes it as the server's `\b` null sentinel, which
   * is the only way to ask for it.
   *
   * Not a substring match. `search[album]` exists and IS partial, but it can
   * never express the null bucket, so this field takes the exact route and the
   * escape hatch below covers the other one.
   */
  readonly album?: string | null;
  /** Exact year, or a list of years (encoded as `IN`). `null` matches rows with no year. */
  readonly year?: number | number[] | null;
  /** Fetch specific songs in one request, sent as `exact_search[id][]`. */
  readonly ids?: number[];
  /**
   * Narrow to one artist, by canonical name OR by slug.
   *
   * This one is not a column and does not behave like the others. The server
   * resolves it against YOUR artist roster (canonical name first, then slug)
   * and matches on credits. Consequences:
   *
   * - it is EXACT even though it is spelled like a search. `search[artist]`
   *   and `exact_search[artist]` are the same code path; there is no partial
   *   artist match anywhere in this API, so a type-ahead over artists has to
   *   filter client-side or go through `oms.music.artists`;
   * - an artist you do not have resolves to nothing and yields an EMPTY list,
   *   not a 404 and not an error. An empty page is genuinely ambiguous here;
   * - it changes what {@link MusicSongsNamespace.albums} deduplicates on.
   */
  readonly artist?: string;
  /**
   * Restrict the artist filter to one kind of credit. Meaningless without
   * {@link SongFilters.artist} and silently ignored then.
   *
   * `"featured"` is subtractive: it means "credited as featured or with, AND
   * not also primary on that same song", so a song where the artist leads is
   * excluded even if they also appear as a feature.
   */
  readonly artistRole?: SongArtistRole;
}

/** Arguments for {@link MusicSongsNamespace.list}. */
export interface ListSongsParams extends SongFilters, ListParams<(typeof SONG_FILTER_COLUMNS)[number]> {
  /**
   * `modifiers[order]`, as `"column:asc"` or `"column:desc"`.
   *
   * Defaults to `"created_at:asc"`, which is also the endpoint's own base
   * order and the one that makes paging stable. Two traps:
   *
   * - a column the record does not have is IGNORED, silently. `modifiers[order]`
   *   is an allowed key so the request is not rejected; the base order is
   *   handed back instead. A typo costs you nothing but the sort you asked for;
   * - a real column REPLACES the base order, tie breaker included. Ordering
   *   4000 tracks by `title:asc` when several share a title lets the database
   *   return them in a different sequence per page, which duplicates and drops
   *   rows across a paged walk. Prefer `created_at` or `id` for anything you
   *   intend to page through.
   *
   * A third `:`-separated segment pins specific values first
   * (`"album:asc:Clube da Esquina,Acabou Chorare"`).
   */
  readonly order?: string | null;
  /**
   * `modifiers[random]=true` - shuffle server-side.
   *
   * Mutually destructive with paging: the ordering is re-evaluated per request,
   * so page 2 of a random listing is a fresh shuffle and shares rows with page
   * 1. Use it for "give me N tracks", never to walk a library. It also disables
   * the endpoint's `ETag`, deliberately, because every answer differs.
   */
  readonly random?: boolean;
}

/** Arguments for {@link MusicSongsNamespace.albums}. */
export interface ListSongAlbumsParams extends SongFilters, ListParams<(typeof SONG_FILTER_COLUMNS)[number]> {
  /**
   * Page of SONGS to scan, not of albums. Read
   * {@link MusicSongsNamespace.albums} before setting it; omitting it is
   * almost always right.
   */
  readonly page?: number;
  /** Size of that song scan, capped at 500 by the server. */
  readonly pageSize?: number;
}

/**
 * Fields {@link MusicSongsNamespace.update} can change.
 *
 * Four real fields and three virtual inputs. The virtual ones are the
 * complicated half; each carries its own note.
 */
export interface UpdateSongInput {
  readonly title?: string;
  /** `null` clears it and moves the track into the no-album bucket. */
  readonly album?: string | null;
  readonly year?: number | null;
  readonly position?: number | null;
  /**
   * The full list of artists, in credit order, replacing whatever is there.
   *
   * Wins over {@link UpdateSongInput.artist} when both are sent, and unlike it
   * there is no comma-splitting heuristic, so a name that genuinely contains a
   * comma survives.
   *
   * An EMPTY array is not "remove every artist": the server treats it as
   * absent and re-runs the legacy parser. There is no way through this
   * endpoint to leave a song with no artists at all.
   */
  readonly artistNames?: string[];
  /**
   * The featured credits, replacing whatever is there. Sending this key at all
   * is what switches the server out of its legacy mode.
   *
   * That legacy mode is a heuristic over the TITLE: with no `featured_artist_
   * names` key present, the server re-reads `"Song (feat. X)"` and rebuilds the
   * credits from it. So a caller that edits artists without sending this key
   * can watch its explicit list be overwritten by a parse of the title.
   *
   * An empty array means "explicitly no featured artists" and is transmitted
   * correctly in both encodings by this method - which takes some doing in
   * multipart, where an empty array appends no parts and is indistinguishable
   * from an absent key. See the note on {@link MusicSongsNamespace.update}.
   */
  readonly featuredArtistNames?: string[];
  /**
   * Legacy single-line artist input, re-parsed server-side (it splits on
   * commas and on "feat."). Prefer {@link UpdateSongInput.artistNames}; this
   * exists for compatibility.
   */
  readonly artist?: string;
  /**
   * New cover art. Its presence is what makes the request multipart.
   *
   * Stored as a new node in the caller's music storage and charged against the
   * music quota, so it can answer `400 "Music storage quota exceeded"`. On
   * React Native pass the picker's `{ uri, name, type }` object directly.
   */
  readonly artwork?: FileInput | NativeFile;
}

/** Arguments for {@link MusicSongsNamespace.listLiked}. */
export interface ListLikedSongsParams {
  /**
   * How many rows to return. Server default 200, ceiling 500, and a value at
   * or below zero falls back to the default rather than erroring.
   */
  readonly limit?: number;
  /**
   * Cursor: return only likes STRICTLY OLDER than this instant. Pass the
   * `liked_at` of the last row you already hold.
   *
   * Deliberately not an offset. The list is ordered by `liked_at` descending
   * and liking one track mid-scroll shifts every later offset page by one,
   * which shows a duplicate and hides a row. A `Date` is encoded as ISO-8601;
   * an unparseable string is a `400 "Invalid before timestamp"`.
   */
  readonly before?: string | Date;
}

/** Arguments for {@link MusicSongsNamespace.startSeparation}. */
export interface StartSongSeparationInput {
  /**
   * Which separation model to run. Omit for the default. The selectable list is
   * `oms.tools.vocalSeparation.models()`; an id that is not on it is a
   * `400 "Unknown model"`.
   */
  readonly modelId?: string;
}

/** Tags {@link MusicSongsNamespace.modifyMetadata} can write. */
export interface SongFileMetadata {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  /** A string, not a number: it is written into the container's tag verbatim. */
  readonly year?: string;
  readonly genre?: string;
  /** Cover art to embed. Re-encoded to MJPEG, or to a Vorbis picture block for ogg/opus. */
  readonly artwork?: FileInput | NativeFile;
}

/** Arguments for {@link MusicSongsNamespace.modifyMetadata}. */
export interface ModifySongMetadataInput {
  /** The file to retag. Hard cap 50 MiB, enforced before anything else happens. */
  readonly audio: FileInput | NativeFile;
  /**
   * At least one tag is REQUIRED. An empty bag comes back as a 500, so this
   * method rejects it locally instead.
   */
  readonly metadata: SongFileMetadata;
}

/** Arguments for {@link MusicSongsNamespace.externalSearch}. */
export interface MusicExternalSearchParams {
  /** The query. Blank short-circuits to three empty lists without spending budget. */
  readonly q: string;
  /** Defaults to `"track"` server-side. See the method for what it does and does not change. */
  readonly kind?: MusicExternalSearchKind;
}

/** Default `limit` the liked-songs endpoint applies when none is sent. */
export const LIKED_SONGS_DEFAULT_LIMIT = 200;

/** Hard ceiling the liked-songs endpoint clamps `limit` to. */
export const LIKED_SONGS_MAX_LIMIT = 500;

/** Audio extensions `POST /songs/import` accepts. Anything else is a 415. */
export const SONG_IMPORT_EXTENSIONS: readonly string[] = Object.freeze([
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "m4a",
  "opus",
]);

/** Ceiling `POST /songs/import` enforces on the uploaded file: 1 GiB. */
export const SONG_IMPORT_MAX_BYTES = 1_073_741_824;

/** Ceiling `POST /songs/metadata_modifier` enforces on its input: 50 MiB. */
export const SONG_METADATA_MAX_BYTES = 52_428_800;

/**
 * True when this error is `music/external_search` refusing on its rate limit.
 *
 * That endpoint answers **`400 "Rate limit exceeded"`**, not `429`, so it
 * arrives as an {@link OmsApiError} with `code === "invalid_request"` and slips
 * straight past `instanceof OmsQuotaError` and past `status === 429`. Every
 * error handler that routes by status treats it as "your query was malformed"
 * and retries with a different query, which spends more budget. This is the
 * check to use instead.
 *
 * Matched on the body rather than only on the status, because a genuine 400
 * from this route is possible in principle and must not be swallowed as a
 * quota.
 */
export function isMusicExternalSearchRateLimited(error: unknown): boolean {
  if (!(error instanceof OmsApiError) || error.status !== 400) return false;
  const body = typeof error.body === "string" ? error.body : error.message;
  return body === "Rate limit exceeded";
}

/**
 * Builds the one-line artist credit for a song, Spotify style.
 *
 * `"Chico Buarque, Milton Nascimento (feat. Elis Regina)"`: primaries joined
 * with `", "`, then a `feat.` clause. Pure string building, no request.
 *
 * `with` credits are excluded unless `includeWith` is set; they belong in a
 * credits dialog and in media session metadata, where completeness beats line
 * length.
 *
 * Written here because {@link Song.artists} arrives UNSORTED and forgetting to
 * sort by `position` prints the credits in insertion order, which is roughly
 * random. It also copes with a jam entry, whose `artist_names` is a pre-joined
 * string and whose `artists` array is empty.
 */
export function songArtistsLine(
  song: Pick<Song, "artists"> & Partial<Pick<Song, "artist_names">>,
  includeWith = false,
): string {
  const credits = song.artists ?? [];
  if (credits.length === 0) {
    const inlined = song.artist_names;
    if (typeof inlined === "string") return inlined;
    if (Array.isArray(inlined)) return inlined.join(", ");
    return "";
  }

  const sorted = [...credits].sort((a, b) => a.position - b.position);
  const named = (role: SongArtistRole): string[] =>
    sorted.filter((credit) => credit.role === role && credit.name).map((credit) => credit.name as string);

  const primary = named("primary");
  const head = (primary.length > 0 ? primary : sorted.map((c) => c.name).filter((n): n is string => !!n)).join(", ");

  const parts = [head];
  const featured = named("featured");
  if (featured.length > 0) parts.push(`(feat. ${featured.join(", ")})`);
  if (includeWith) {
    const withs = named("with");
    if (withs.length > 0) parts.push(`(with ${withs.join(", ")})`);
  }
  return parts.join(" ");
}

/** The `music.songs` namespace, reachable as `oms.music.songs`. */
export class MusicSongsNamespace extends Resource {
  /**
   * `GET /songs` - the caller's library, oldest first.
   *
   * Pagination is FORCED here and nowhere else in this namespace: a request
   * with no page modifier is given `1:500` and one asking for more than 500 is
   * clamped to it. That is a guard, not tidiness - a five-thousand-track
   * library serialises megabytes of JSON with every credit inlined. The SDK
   * sends a page modifier every time, so the clamp never surprises you and
   * {@link Paginated.pageSize} always reports the size the rows were counted
   * against.
   *
   * Order defaults to `created_at:asc`, the endpoint's own base order, which is
   * what makes a paged walk stable. See {@link ListSongsParams.order} before
   * changing it.
   *
   * The response supports `ETag` / `If-None-Match` (except with
   * {@link ListSongsParams.random}), so a repeated identical listing is cheap
   * for the server even though the SDK does not cache it for you.
   *
   * @throws {OmsAuthError} 401 when anonymous, 403 for an OAuth token.
   * @throws {OmsApiError} 400 naming the offending key when a filter is not in
   *   {@link SONG_FILTER_COLUMNS}. Filters fail closed on purpose: silently
   *   dropping an unknown one would answer with the UNFILTERED set.
   */
  async list(params: ListSongsParams = {}, options: RequestOptions = {}): Promise<Paginated<Song>> {
    return paginate(params, 100, (at) =>
      this.http.get<Song[] | undefined>("/songs", { ...options, query: this.songQuery(params, at) }),
    );
  }

  /**
   * `GET /songs/:id` - one track. Returns exactly what a row of {@link list}
   * carries.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` - for an id that does not
   *   exist AND for one that belongs to somebody else, indistinguishably. The
   *   lookup is scoped to the caller before the id is even compared.
   */
  async get(id: SongId, options: RequestOptions = {}): Promise<Song> {
    return this.http.get<Song>(`/songs/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `PATCH /songs/:id` - edits metadata, and optionally replaces the artwork.
   *
   * JSON normally; multipart as soon as {@link UpdateSongInput.artwork} is
   * present, because that is the only way to carry a file. Both encodings
   * behave the same server-side, and this method papers over the two places
   * where they would otherwise differ:
   *
   * - **clearing a field in multipart.** Every form field is a string, so
   *   there is no `null` to send. The server's `\b` null sentinel is decoded
   *   for update fields exactly as it is for filters, so `album: null` is
   *   written as that one character and clears the field.
   * - **an empty `featuredArtistNames`.** Appending an empty array appends
   *   nothing, and an absent key is what puts the server back into its
   *   title-parsing legacy mode - the opposite of what "no featured artists"
   *   means. This sends the single empty string the server reads as an explicit
   *   empty list.
   *
   * Editing the TITLE alone also re-runs artist parsing, which can rewrite the
   * credits you did not touch. Send `featuredArtistNames` whenever you care
   * about them.
   *
   * @throws {OmsAuthError} 401 when the song is not yours - not 403 or 404.
   * @throws {OmsApiError} 400 `"Music storage quota exceeded"` when the artwork
   *   would not fit in the music quota.
   */
  async update(id: SongId, input: UpdateSongInput, options: RequestOptions = {}): Promise<Song> {
    const path = `/songs/${encodeURIComponent(String(id))}`;

    if (input.artwork === undefined) {
      return this.http.patch<Song>(path, this.updateBody(input), options);
    }

    const form = await buildFormData({
      ...this.multipartUpdateFields(input),
      artwork: input.artwork,
    });
    const response = await this.http.raw("PATCH", path, { ...options, body: form });
    return (await readJson(response)) as Song;
  }

  /**
   * `DELETE /songs/:id` - removes the track and its media.
   *
   * @throws {OmsAuthError} 401 when the song is not yours.
   * @throws {OmsApiError} 404 the second time, because the row is already gone.
   *   That is why this is not retried on a torn connection: a replay would
   *   report "not found" for a delete that worked perfectly well.
   */
  async delete(id: SongId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/songs/${encodeURIComponent(String(id))}`, options);
  }

  /**
   * `POST /songs/import` - uploads an audio file and adds it to the library.
   *
   * Synchronous, and slow: the server reads the tags, extracts the embedded
   * artwork, detects the real codec from the file header rather than the
   * extension, stores the original and enqueues a transcode. A lossless upload
   * takes tens of seconds, so the per-attempt deadline defaults to five minutes
   * here instead of the client's usual one.
   *
   * Answers **200**, not 201, with the created song. Do not branch on the code.
   *
   * Two size limits and they are not the same one. The API rejects anything
   * over {@link SONG_IMPORT_MAX_BYTES} (1 GiB) with a 400 - but the CDN in
   * front of it refuses a request body over roughly 100 MB with its own `413`
   * before the API ever sees it. A big FLAC therefore fails with an HTML-ish
   * 413 that says nothing about songs. There is no chunked import route; that
   * ceiling is real.
   *
   * On React Native pass the picker's `{ uri, name, type }` object directly -
   * it is appended verbatim and streamed off disk by the native layer.
   *
   * @throws {OmsApiError} 400 for a missing file, a file over 1 GiB, an
   *   extension outside {@link SONG_IMPORT_EXTENSIONS}, or
   *   `"Music storage quota exceeded"`; 415 with validation messages when the
   *   audio itself will not import.
   */
  async import(file: FileInput | NativeFile, options: RequestOptions = {}): Promise<Song> {
    return this.http.postForm<Song>("/songs/import", { file }, { timeoutMs: 300_000, ...options });
  }

  /**
   * `GET /songs/albums` - one card per album in the library.
   *
   * Takes the same filters as {@link list}, and is the endpoint every album
   * grid is built on. It is also the most expensive read in this namespace, for
   * a reason worth understanding: the forced pagination that protects
   * `GET /songs` does not apply here, so this route loads the whole filtered
   * library and deduplicates by `[album, primary artist]`. On a
   * five-thousand-track library that is a full scan per call.
   *
   * Paging it does not fix that and is usually a mistake:
   * {@link ListSongAlbumsParams.page} pages the SONGS that get scanned, and the
   * grouping happens after the page is cut. Page 2 is "the albums of the next
   * 500 songs", which overlaps page 1 wherever an album straddles the boundary,
   * and concatenating the pages gives you duplicates rather than the full list.
   * Ask for everything, once, and cache it.
   *
   * With {@link SongFilters.artist} set, the dedup key switches to the FILTERED
   * artist, which is what stops a compilation appearing twice because two of
   * its tracks have different leads.
   *
   * @throws {OmsApiError} 400 for an unknown filter key, exactly as {@link list}.
   */
  async albums(params: ListSongAlbumsParams = {}, options: RequestOptions = {}): Promise<SongAlbumSummary[]> {
    const query = this.songQuery(
      params,
      params.page === undefined && params.pageSize === undefined
        ? undefined
        : { page: params.page ?? 1, pageSize: params.pageSize ?? 500 },
    );
    const rows = await this.http.get<SongAlbumSummary[] | undefined>("/songs/albums", { ...options, query });
    return rows ?? [];
  }

  /**
   * `GET /songs/artists` - the names of every artist in the caller's roster.
   *
   * A flat array of strings, ordered by name, and that is the whole payload.
   *
   * It IGNORES every filter you could send it: it reads names straight off the
   * roster. This method
   * therefore takes no parameters at all rather than accepting some that would
   * do nothing. It also does not go through `/artists`, so despite the shared
   * subject it does NOT spend the 60/min external-proxy budget.
   *
   * Kept for back-compatibility. `oms.music.artists` returns real records with
   * ids, slugs, pictures and counts; reach for that unless a list of bare names
   * is genuinely all you want.
   */
  async artistNames(options: RequestOptions = {}): Promise<string[]> {
    const names = await this.http.get<string[] | undefined>("/songs/artists", options);
    return names ?? [];
  }

  /**
   * `GET /songs/artist_pictures?name=` - the cached Deezer picture set for an
   * artist you already have.
   *
   * Lookup only: an artist absent from your roster returns `[]` and no stub row
   * is created, which is deliberate - a slug or a joined display string
   * ("100 gecs, Lil West, Tony Velour") must not mint stub artists.
   *
   * The array holds zero or one entry. Zero means either "not your artist" or
   * "Deezer has never given us a picture for them", and the two are not
   * distinguishable from the response.
   *
   * Prefer the `picture_*` fields already inlined on {@link SongArtistCredit}
   * and on artist records: they are the same values, and a page that calls this
   * per row does a request per row for data it was already sent. A cold lookup
   * also blocks on Deezer, and results are cached on the artist for about three
   * days with a jitter.
   *
   * @throws {OmsQuotaError} 429 once the shared 60/min external-proxy bucket is
   *   spent - this route sits under `/songs`, but a cold call still talks to
   *   Deezer through the same guard.
   */
  async artistPictures(name: string, options: RequestOptions = {}): Promise<SongArtistPictures[]> {
    const body = await this.http.get<{ pictures?: SongArtistPictures[] } | undefined>("/songs/artist_pictures", {
      ...options,
      query: { name },
    });
    return body?.pictures ?? [];
  }

  /**
   * `POST /songs/metadata_modifier` - retags a local file and hands it back.
   *
   * The odd one out in this namespace: it writes nothing to the library, reads
   * nothing from it, and answers with BINARY rather than JSON. The file is
   * remuxed with the new tags (the audio is never re-encoded) and, when given
   * one, an embedded cover.
   *
   * The result is buffered fully into memory in every runtime. That is
   * unavoidable - there is no URL to hand a downloader - but it means a 50 MiB
   * input is a 50 MiB Blob on a phone. `FileOutput.filename` carries the name
   * the server suggested in `Content-Disposition`.
   *
   * At least one tag must be present, and this method enforces that locally
   * because the server does not fail gracefully: an empty `metadata` bag is a
   * 500, and so is a missing audio file. Both are avoided here.
   *
   * `metadata[track_number]` is dropped in silence server-side, so it is not
   * offered here.
   *
   * @throws {TypeError} when `metadata` carries no usable tag.
   * @throws {OmsApiError} 413 `"File too big"` above
   *   {@link SONG_METADATA_MAX_BYTES}, checked before the body is read. Note
   *   that the CDN's own ~100 MB body limit sits above it and never fires
   *   first.
   */
  async modifyMetadata(input: ModifySongMetadataInput, options: RequestOptions = {}): Promise<FileOutput> {
    const fields: Record<string, string | FileInput | NativeFile> = {};
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value === undefined || value === null) continue;
      fields[`metadata[${key}]`] = typeof value === "string" ? value : (value as FileInput | NativeFile);
    }
    if (Object.keys(fields).length === 0) {
      throw new TypeError(
        "modifyMetadata needs at least one tag in `metadata`. An empty bag raises server-side and comes back as a 500.",
      );
    }

    const form = await buildFormData({ audio_file: input.audio, ...fields });
    const response = await this.http.raw("POST", "/songs/metadata_modifier", {
      timeoutMs: 300_000,
      ...options,
      body: form,
    });
    const data = await response.blob();
    return {
      data,
      filename: filenameFromDisposition(response.headers.get("content-disposition")),
      contentType: response.headers.get("content-type") ?? undefined,
      size: data.size,
    };
  }

  /**
   * `POST /songs/:id/separate` - splits a track into vocals and instrumental.
   *
   * Answers `201` with the separation row. **Idempotent while one is running**:
   * if this song already has a separation that has not reached `complete` or
   * `failed`, the existing row is returned untouched and nothing new is
   * enqueued. So there is no need to guard the call site - but also no way to
   * force a re-run without deleting the stems first.
   *
   * **Rate limit:** 20 requests per minute, from a bucket SHARED with
   * `POST /vocal_separations`, the upscaler, transcriptions, caption jobs,
   * jumpstyle and the downloader previews. Each call schedules minutes of CPU
   * and gigabytes of RAM. Do not batch a library through it.
   *
   * The run itself is asynchronous. Poll {@link separation} roughly every three
   * seconds; the returned row's `status` moves `pending` to `processing` to
   * `complete` or `failed`, and there is no `canceled`.
   *
   * @throws {OmsQuotaError} 429 when the shared expensive-tools budget is spent.
   * @throws {OmsAuthError} 401 when the song is not yours.
   * @throws {OmsApiError} 400 `"Song has no audio"` when the attachment is
   *   missing, `"Unknown model"` for a model id not on
   *   `oms.tools.vocalSeparation.models()`.
   */
  async startSeparation(
    id: SongId,
    input: StartSongSeparationInput = {},
    options: RequestOptions = {},
  ): Promise<VocalSeparation> {
    return this.http.post<VocalSeparation>(
      `/songs/${encodeURIComponent(String(id))}/separate`,
      input.modelId === undefined ? {} : { model_id: input.modelId },
      options,
    );
  }

  /**
   * `GET /songs/:id/separation` - the poll.
   *
   * Answers `200` for every song, with `job: null` when none has ever run - not
   * a 404. Branch on {@link SongSeparationStatus.stems_ready}, which is the
   * only field that reflects the song rather than the run: a run can be
   * `complete` a moment before the stems are attached, and a song can have
   * stems from a run that was swept long ago.
   *
   * Reading this has a SIDE EFFECT, and it is a useful one: the server first
   * clears {@link Song.vocal_separation_started_at} when the flag outlived its
   * run (a run that died midway leaves it set forever). A UI that decides "a
   * separation is in flight" from the song record alone can therefore be stuck
   * on a spinner that only this call will clear.
   *
   * Poll at about three seconds. Nothing on this route is throttled beyond the
   * general ceiling, but `progress_percent` is fetched live on every call
   * while the run is processing, so a tighter loop costs real work.
   *
   * @throws {OmsApiError} 404 for a song that is not yours.
   */
  async separation(id: SongId, options: RequestOptions = {}): Promise<SongSeparationStatus> {
    return this.http.get<SongSeparationStatus>(`/songs/${encodeURIComponent(String(id))}/separation`, options);
  }

  /**
   * `DELETE /songs/:id/separation` - throws the stems away.
   *
   * Deletes both stems and clears the ids off the song. The ORIGINAL audio is
   * untouched, so this is safe: it costs a re-run, not the track. Answers 204.
   *
   * The way to force a fresh separation with a different model: delete, then
   * {@link startSeparation} again.
   *
   * @throws {OmsAuthError} 401 when the song is not yours.
   */
  async deleteSeparation(id: SongId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/songs/${encodeURIComponent(String(id))}/separation`, options);
  }

  /**
   * `GET /liked_songs` - the caller's likes, newest first, with each song
   * inlined in full.
   *
   * Cursor-paged, not offset-paged, and the cursor is a timestamp rather than
   * an id: pass the `liked_at` of the last row you hold as
   * {@link ListLikedSongsParams.before}. Offsets were wrong here because
   * liking a track while paging shifts every later page by one.
   *
   * End of list is a short page, as everywhere in this API. There is no count.
   *
   * Each row carries a whole {@link Song} with its credits, so 500 likes is a
   * large response. 100 is a sensible size.
   *
   * @throws {OmsApiError} 400 `"Invalid before timestamp"` for a cursor the
   *   server cannot parse. Pass a `Date` and this cannot happen.
   */
  async listLiked(params: ListLikedSongsParams = {}, options: RequestOptions = {}): Promise<LikedSong[]> {
    const before = params.before instanceof Date ? params.before.toISOString() : params.before;
    const rows = await this.http.get<LikedSong[] | undefined>("/liked_songs", {
      ...options,
      query: {
        limit: params.limit ?? LIKED_SONGS_DEFAULT_LIMIT,
        ...(before === undefined ? {} : { before }),
      },
    });
    return rows ?? [];
  }

  /**
   * `GET /liked_songs/ids` - just the song ids, as integers.
   *
   * The cheap way to render heart icons over a listing. It is a single flat
   * list with no pagination and no cap, so it returns EVERY like in one
   * array - which is the point, and also means it grows without bound. At a few
   * thousand likes it is still a handful of kilobytes.
   *
   * Note what the numbers are: `song_id`, not the id of the like. To unlike,
   * that is exactly what {@link unlike} wants.
   */
  async likedIds(options: RequestOptions = {}): Promise<number[]> {
    const ids = await this.http.get<number[] | undefined>("/liked_songs/ids", options);
    return ids ?? [];
  }

  /**
   * `POST /liked_songs` - likes a track. Answers `201` with the new row.
   *
   * Genuinely idempotent: liking twice returns the same row rather than
   * erroring or creating a duplicate.
   * That is why this is one of the few `POST`s in the SDK that opts INTO the
   * retry policy - a replay after a lost answer cannot produce a second like,
   * and the alternative is a heart that silently did nothing.
   *
   * @throws {OmsApiError} 404 `"Song not found"` for a song that is not yours,
   *   400 when `song_id` is missing.
   */
  async like(songId: SongId, options: RequestOptions = {}): Promise<LikedSong> {
    return this.http.post<LikedSong>("/liked_songs", { song_id: songId }, { retry: {}, ...options });
  }

  /**
   * `DELETE /liked_songs/:song_id` - unlikes a track. Answers 204.
   *
   * Keyed by the SONG id, not by the id of the like. Its sibling
   * `DELETE /playlist_songs/:id` is keyed by the join row, and mixing the two
   * up deletes the wrong thing or nothing at all - here it would simply 404,
   * because a like's own id will not match any `song_id` you own.
   *
   * The 404 is `"Not liked"` and is usually noise: an optimistic UI that
   * double-fires, or a rollback racing the user. Swallow it and treat the state
   * as reached. Not retried, for the same reason as every other destroy in this
   * SDK: a replay after a torn connection reports failure for a delete that
   * worked.
   */
  async unlike(songId: SongId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/liked_songs/${encodeURIComponent(String(songId))}`, options);
  }

  /**
   * `GET /lyrics?song_id=` - lyrics for a track, synced and plain.
   *
   * **`200` with both fields `null` is the "no lyrics" answer, not an error.**
   * A 404 here means the SONG is unknown, nothing else. Code that treats a
   * missing-lyrics response as a failure retries something the server has
   * already decided about.
   *
   * The first call for a track is slow and it is not the network: the request
   * blocks while the server searches lrclib and falls back to Genius, which
   * takes seconds. Hence the five-times-longer default deadline. A hit is
   * written onto the song row and cached for 30 days; a miss is negative-cached
   * for 24 hours, so hammering a track with no lyrics achieves nothing at all
   * for a day.
   *
   * **Rate limit:** 60/min, and it is the SHARED external-proxy bucket - the
   * same 60 requests that `/artists/*`, `/artist_metadata/*` and
   * `/music_radios/*` draw on. Prefetching lyrics for a queue is the classic
   * way to spend it and then have an artist page 429 for a minute.
   *
   * @throws {OmsQuotaError} 429 once that bucket is spent.
   * @throws {OmsApiError} 404 `"Song not found"`.
   */
  async lyrics(songId: SongId, options: RequestOptions = {}): Promise<SongLyrics> {
    return this.http.get<SongLyrics>("/lyrics", {
      timeoutMs: 60_000,
      ...options,
      query: { song_id: songId },
    });
  }

  /**
   * `GET /lyrics/translation?song_id=&target=` - the same lyrics, translated
   * line for line.
   *
   * The LRC timestamps are preserved exactly, so the same parser handles the
   * original and the translation and the two align one to one for a karaoke
   * view. Cached per song, target and lyrics digest, which means the second
   * request for a translation is free and a lyrics refetch invalidates it.
   *
   * **Retries are disabled and this one really matters.** The hourly cap
   * counts a rejected call too: a client that retries a 429 three times has
   * pushed itself three further past the cap without ever getting an answer. The 429 also
   * carries no `Retry-After`, so the transport would back off by its own
   * schedule - a few hundred milliseconds - into a limit measured in hours.
   * Wait out the window instead. Pass `retry` explicitly if you disagree.
   *
   * **Two limits at once:** 60 fresh translations per user per HOUR (429), on
   * top of the shared 60/min external-proxy bucket that every `/lyrics*` call
   * draws on.
   *
   * @throws {OmsQuotaError} 429 from either budget.
   * @throws {OmsApiError} 400 `"Unsupported target"` for a locale outside
   *   {@link LYRICS_TRANSLATION_TARGETS}, checked before the counter moves;
   *   404 `"No lyrics for this song"` when the song has neither synced nor
   *   plain lyrics stored yet - fetch {@link lyrics} first, that is what fills
   *   them in; 503 when the translator itself is down, which is transient but
   *   still not worth an automatic retry.
   */
  async lyricsTranslation(
    songId: SongId,
    target: LyricsTranslationTarget | string,
    options: RequestOptions = {},
  ): Promise<SongLyricsTranslation> {
    return this.http.get<SongLyricsTranslation>("/lyrics/translation", {
      timeoutMs: 60_000,
      retry: false,
      ...options,
      query: { song_id: songId, target },
    });
  }

  /**
   * `POST /lyrics/sync` - generates LRC timestamps for plain-text lyrics.
   *
   * Answers `201 { job_id }` and does the work in the background: it separates
   * the vocals if there are no stems, transcribes them and aligns the known
   * lines against the segments. Minutes of machine time
   * per call, which is what the 10-per-hour cap is protecting.
   *
   * Wait for it either way: `oms.jobs.wait({ id: job_id })`, or simply re-read
   * {@link lyrics} until `synced` stops being `null`. A `GET /jobs/:id` that
   * 404s early in the run is normal - keep waiting.
   *
   * Retries are disabled for the same reason as
   * {@link lyricsTranslation}: the hourly counter increments on rejection, and
   * the 429 has no `Retry-After` to honour.
   *
   * @throws {OmsQuotaError} 429 past 10 syncs in an hour, and separately from
   *   the shared 60/min `/lyrics*` bucket.
   * @throws {OmsApiError} 400 `"Lyrics are already synchronized"` when `synced`
   *   is already set - check before calling, it is a wasted slot otherwise;
   *   404 `"Song not found"`.
   */
  async syncLyrics(songId: SongId, options: RequestOptions = {}): Promise<LyricsSyncHandle> {
    return this.http.post<LyricsSyncHandle>("/lyrics/sync", { song_id: songId }, { retry: false, ...options });
  }

  /**
   * `GET /music/external_search` - searches Spotify, iTunes and YouTube for
   * something to import.
   *
   * **The trap: over its limit this endpoint answers `400 "Rate limit
   * exceeded"`, not `429`.** Every handler that routes by status code reads
   * that as a malformed query and does the worst possible thing - rewords it
   * and tries again, spending more of a budget that is already gone. The limit
   * is 30 requests per minute per user.
   * {@link isMusicExternalSearchRateLimited} is the check to use, and the
   * transport will not retry a 400 on its own, so nothing recovers silently.
   *
   * Two more things the shape does not tell you:
   *
   * - **`albums` and `artists` are Spotify-only.** They are populated from a
   *   Spotify search that only runs when the caller has a linked Spotify
   *   identity; without one both arrive as `[]` forever, however good the
   *   query. `tracks` is always populated, from iTunes and YouTube;
   * - **`kind` steers Spotify and nothing else.** iTunes and YouTube are
   *   always queried for TRACKS, so `kind: "artist"` still returns tracks
   *   alongside the artists. Tracks from all sources are deduplicated by
   *   lowercased title-and-artist and capped at 12, Spotify first.
   *
   * A blank query short-circuits to three empty lists WITHOUT spending budget,
   * which makes it safe to wire straight to an input. A cached hit does spend
   * it: the rate check runs before the 15-minute cache is consulted. Debounce
   * and require two characters.
   *
   * Every failing upstream is swallowed server-side, so a partial answer and a
   * complete one are indistinguishable - an empty `tracks` may mean "no
   * results" or "YouTube timed out".
   *
   * @throws {OmsApiError} 400 - which is either a real problem or the rate
   *   limit. Do not guess: call {@link isMusicExternalSearchRateLimited}.
   */
  async externalSearch(
    params: MusicExternalSearchParams,
    options: RequestOptions = {},
  ): Promise<MusicExternalSearchResult> {
    const body = await this.http.get<Partial<MusicExternalSearchResult> | undefined>("/music/external_search", {
      ...options,
      query: { q: params.q, ...(params.kind === undefined ? {} : { kind: params.kind }) },
    });
    return {
      tracks: body?.tracks ?? [],
      albums: body?.albums ?? [],
      artists: body?.artists ?? [],
    };
  }

  /**
   * `GET /artist_metadata/:name` - the legacy artist payload, by name or slug.
   *
   * **It never 404s.** An artist outside your roster comes back as `200` with
   * every field `null` except `name`, echoed back verbatim, and
   * `similar: []`. There is no error to catch and no flag to read: check
   * whether `id` is null. That branch also creates nothing.
   *
   * The payload has no `created_at` / `updated_at`, unlike essentially every
   * other record in this API.
   *
   * Reading a stale artist triggers a lazy background refresh from Last.fm and
   * MusicBrainz, so the first call after a while may be slower and the second
   * may answer with more.
   *
   * Kept alive on purpose, but it is a shim: `oms.music.artists.get()` returns
   * the modern record with the fields this one renames (`image_url` here is
   * `external_image_url` there) and the ones it omits.
   *
   * The name goes in the path, so it must be encoded - a slash in an artist
   * name would otherwise become a route segment and 404. This method does that
   * for you.
   *
   * @throws {OmsQuotaError} 429 from the shared 60/min external-proxy bucket.
   * @throws {OmsApiError} 400 `"name required"` for an empty name.
   */
  async artistMetadata(name: string, options: RequestOptions = {}): Promise<ArtistMetadata> {
    return this.http.get<ArtistMetadata>(`/artist_metadata/${encodeURIComponent(name)}`, options);
  }

  /**
   * Builds the query for `/songs` and `/songs/albums`.
   *
   * `artist_role` is deliberately TOP LEVEL and not inside `exact_search`: the
   * server reads it as a plain parameter, and nesting it would both miss the
   * filter and trip the unknown-key check.
   */
  private songQuery(params: ListSongsParams | ListSongAlbumsParams, at: PageAt | undefined): QueryParams {
    return listQuery(params, at, {
      order: at === undefined ? undefined : "created_at:asc",
      search: { title: params.title },
      exactSearch: { album: params.album, year: params.year, id: params.ids, artist: params.artist },
      top: params.artistRole === undefined ? {} : { artist_role: params.artistRole },
    });
  }

  /** JSON body for an update. `null` stays `null`; the transport does not touch a body. */
  private updateBody(input: UpdateSongInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body["title"] = input.title;
    if (input.album !== undefined) body["album"] = input.album;
    if (input.year !== undefined) body["year"] = input.year;
    if (input.position !== undefined) body["position"] = input.position;
    if (input.artist !== undefined) body["artist"] = input.artist;
    if (input.artistNames !== undefined) body["artist_names"] = input.artistNames;
    // An empty array with the key present is how "explicit mode, no featured
    // artists" is spelled.
    if (input.featuredArtistNames !== undefined) body["featured_artist_names"] = input.featuredArtistNames;
    return body;
  }

  /**
   * Multipart fields for an update, with the two encoding differences fixed.
   *
   * `null` becomes the `\b` sentinel, which the server decodes back to null
   * for update fields exactly as it does for filters - a form field has no
   * other way to say "clear this field". An empty `featured_artist_names`
   * becomes a single empty string, because appending an empty array appends
   * nothing and an absent key means the opposite thing.
   */
  private multipartUpdateFields(input: UpdateSongInput): Record<string, string | string[]> {
    const fields: Record<string, string | string[]> = {};
    const scalar = (key: string, value: string | number | null | undefined): void => {
      if (value === undefined) return;
      fields[key] = value === null ? NULL_SENTINEL : String(value);
    };

    scalar("title", input.title);
    scalar("album", input.album);
    scalar("year", input.year);
    scalar("position", input.position);
    scalar("artist", input.artist);
    if (input.artistNames !== undefined) fields["artist_names"] = input.artistNames;
    if (input.featuredArtistNames !== undefined) {
      fields["featured_artist_names"] =
        input.featuredArtistNames.length === 0 ? [""] : [...input.featuredArtistNames];
    }
    return fields;
  }
}
