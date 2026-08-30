/**
 * The `music.artists` namespace: the artist roster, the Artists page header,
 * artist artwork, the Spotify-backed "import a whole artist" flow, and the
 * daily release watch that follows an artist for what it puts out NEXT.
 *
 * ## An artist row belongs to ONE user
 *
 * There is no global artist table. `Artist` is scoped by `user_id` and every
 * route here runs inside `Artist.viewable_by(Current.user)`, so two accounts
 * that both own a Chico Buarque track own two different artist rows with two
 * different integer ids. Never cache an artist id across identities, and never
 * hand one to another user's client.
 *
 * Rows are created as a side effect of importing songs (`Songs::ArtistAttacher`)
 * and by `ArtistResolver`; this namespace has no `create`. `POST /artists` is
 * not routed - `resources :artists, only: [index, show, update, destroy]`.
 *
 * ## Almost everything here shares ONE 60/min bucket
 *
 * `Rack::Attack` throttles `/lyrics`, `/artists/`, `/artist_metadata/` and
 * `/music_radios/` together at **60 requests a minute** - one bucket for all
 * four families, keyed by the literal `Authorization` header (or by IP when the
 * call is anonymous). A screen that opens an artist page while a lyrics panel
 * polls is spending the same budget twice.
 *
 * The regular expression is `\A/(lyrics|artists/|artist_metadata/|music_radios/)`
 * and the trailing slash after `artists` is load-bearing: the path is
 * normalised before it is matched, so `GET /artists` (the roster index) does
 * NOT match and falls back to the general authenticated ceiling of 600/min.
 * `/artists/overview`, `/artists/:id`, both uploads, `PATCH` and `DELETE` all
 * DO match. The `/artist_imports*` and `/artist_syncs*` routes do not (neither
 * `artist_imports` nor `artist_syncs` is `artists/`) and are on the general
 * ceiling as well.
 *
 * Every method below states which of the two it lands in.
 *
 * ## An OAuth access token cannot reach any of this
 *
 * `Authentication#enforce_oauth_scope!` denies by default: a Doorkeeper token
 * reaches an action only when its controller declared an `oauth_scope` for it.
 * No music controller declares one, so a CLI or MCP host holding an OAuth
 * token gets `403 {"error":"insufficient_scope"}` on every route in this file,
 * whatever scopes it was granted. Use a session token (`POST /sessions`) or,
 * in the browser, the session cookie.
 */

import { OmsError } from "../../errors";
import { ApiClient, Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import { assertPresent } from "../../internal/helpers";
import type { ListParams } from "../../listing";
import type {
  FileInput,
  NativeFile,
  PageLoader,
  Paginated,
  QueryParams,
  RequestOptions,
  Timestamp,
} from "../../types";
import { createPage, resolvePageNumber, resolvePageSize } from "../../types";

/**
 * Primary key of an artist. An INTEGER, unlike users, sessions and storage
 * nodes, which are strings. `user_id` on the same record is a string.
 */
export type ArtistId = number;

/** Primary key of an artist import. Also an integer. */
export type ArtistImportId = number;

/**
 * Page size the web roster and the mobile roster both use (FR-37: infinite
 * scroll, 60 a page). Nothing on the server requires it; it is here so the
 * three clients page identically and their caches line up.
 */
export const ARTIST_ROSTER_PAGE_SIZE = 60;

/** Largest artist image or banner the server will accept, in bytes. */
export const ARTIST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Content types `Artists::ImageAttacher` maps directly to a stored extension.
 *
 * A file whose type is not in this list is NOT necessarily refused: the
 * attacher falls back to the extension of the filename and only gives up when
 * that is empty too. So `application/octet-stream` + `cover.png` is accepted
 * and `application/octet-stream` + `cover` is a 400.
 */
export const ARTIST_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

/**
 * An artist, as `GET /artists` renders it (the blueprint's default view plus
 * two computed fields).
 *
 * ## Every image field, and which of them can be trusted
 *
 * There are four independent sources of a picture on this record and they are
 * refreshed by three different subsystems, so "this field is null" means
 * something different for each:
 *
 * - `image_media_id` / `banner_media_id` are UPLOADS. They are the only fields
 *   a user controls, they change only through {@link MusicArtistsNamespace.uploadImage}
 *   and {@link MusicArtistsNamespace.uploadBanner}, and nothing overwrites them.
 * - `picture*` is the cached Deezer set. NOTHING in this namespace refreshes
 *   it - it is written only by `GET /songs/artist_pictures`, which lives in the
 *   songs namespace. See {@link Artist.pictures_fetched_at} for why a fresh
 *   timestamp there is not a promise.
 * - `external_image_url` comes from Last.fm through `ArtistResolver`, and is
 *   usually null on purpose: Last.fm retired artist images and now answers with
 *   one grey-star placeholder for everybody, which the resolver filters out
 *   rather than store.
 * - `gallery_image_urls` (extended view only) is Wikipedia/Wikimedia.
 *
 * The resolution chain all three clients implement, in order:
 * `compressed_image_media_id` -> `image_media_id` -> the size-appropriate
 * `picture_*` (medium for an avatar, `picture_xl` for a hero) -> `picture` ->
 * `gallery_image_urls[0]` -> `fallback_artwork_media_id` -> `external_image_url`
 * -> initials.
 *
 * ## `*_media_id` and `*_fs_node_id` are the same value, twice
 *
 * `ApplicationBlueprint.media_id_fields` emits both keys with an identical
 * value for every attachment, because the old web frontend still reads the
 * legacy `_fs_node_id` name. Read `_media_id`; the twin is scheduled to go.
 * Both docs in `oms-music/docs` document only the legacy name.
 */
export interface Artist {
  /** Integer, and unique only within one user's library. */
  readonly id: ArtistId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Display name, as the user typed or as the import found it. */
  readonly name: string;
  /**
   * Identity key: NFKC-folded, lowercased, `[-_./]` collapsed to spaces. Other
   * punctuation survives on purpose, so `P!nk` and `Pink` stay distinct.
   * Recomputed whenever `name` changes.
   */
  readonly canonical_name: string;
  /**
   * URL slug, derived from the name at creation and then FROZEN: renaming an
   * artist does not move its slug, so bookmarks survive. Unique per user.
   */
  readonly slug: string;
  /** Owner. A STRING id, unlike this record's own integer `id`. */
  readonly user_id: string;
  /** Uploaded square avatar, or null. */
  readonly image_media_id: string | null;
  /** Legacy twin of {@link Artist.image_media_id}. Same value. */
  readonly image_fs_node_id: string | null;
  /**
   * Legacy compressed variant. Only the `artists:merge` rake helpers ever
   * adopt one; nothing generates new ones, and an upload purges the stale
   * companion, so on a modern row this is null.
   */
  readonly compressed_image_media_id: string | null;
  /** Legacy twin of {@link Artist.compressed_image_media_id}. */
  readonly compressed_image_fs_node_id: string | null;
  /** Uploaded hero banner, or null. */
  readonly banner_media_id: string | null;
  /** Legacy twin of {@link Artist.banner_media_id}. */
  readonly banner_fs_node_id: string | null;
  /** See {@link Artist.compressed_image_media_id}. */
  readonly compressed_banner_media_id: string | null;
  /** Legacy twin of {@link Artist.compressed_banner_media_id}. */
  readonly compressed_banner_fs_node_id: string | null;
  /** MusicBrainz id, when the lookup found one. */
  readonly mbid: string | null;
  readonly lastfm_listeners: number | null;
  readonly lastfm_playcount: number | null;
  /**
   * Last.fm's artist image. Null for nearly everyone - the placeholder every
   * artist now gets is filtered out rather than stored.
   */
  readonly external_image_url: string | null;
  /** Cached Deezer picture set. All five move together, or all stay null. */
  readonly picture: string | null;
  readonly picture_small: string | null;
  readonly picture_medium: string | null;
  readonly picture_big: string | null;
  readonly picture_xl: string | null;
  /**
   * When the Deezer picture set was last WRITTEN - which is not the same as
   * when it was last checked.
   *
   * `ArtistPicturesFetcher` stamps this only on a successful answer (a hit, or
   * a genuine "not on Deezer" miss). A failure - and a quota refusal is a
   * failure that arrives as `HTTP 200` with an `{"error": ...}` body - stamps
   * NOTHING and only sets a 30-minute in-cache guard, precisely so an
   * over-quota sweep cannot mark a whole library as "fetched, no picture" for
   * three days. That is the shape of the bug this behaviour exists to prevent,
   * so do not read a stale timestamp as "Deezer has nothing for this artist".
   */
  readonly pictures_fetched_at: Timestamp | null;
  /**
   * When Last.fm's biography was last fetched, successfully OR NOT.
   *
   * `ArtistResolver#populate!` rescues every transport failure and then stamps
   * all three `*_fetched_at` columns anyway, so the freshness gate stops
   * hammering an upstream that is down. The row therefore looks populated
   * while `bio_html` is still null. A null `bio_html` next to a recent
   * `bio_fetched_at` means "we tried and got nothing", not "never tried".
   */
  readonly bio_fetched_at: Timestamp | null;
  /** Same semantics as {@link Artist.bio_fetched_at}, for the similar list. */
  readonly similar_fetched_at: Timestamp | null;
  /**
   * Number of `song_artists` join rows, counting every credit (primary,
   * featured and with), not distinct songs.
   *
   * Computed per response, never stored. On `GET /artists` it comes from one
   * grouped `COUNT` for the whole page; everywhere else the blueprint runs its
   * own `COUNT(*)`. Always present.
   */
  readonly songs_count: number;
  /**
   * Artwork of one of this artist's own lead songs, for a card that has no
   * picture at all. A media id, resolvable through `oms.media` (the canonical
   * `/media/:id/data`); `/fs_nodes/:id/data` is the alias kept for the web
   * frontend and reaches the same bytes.
   *
   * NON-NULL ONLY ON `GET /artists` AND `GET /artists/:id`, where the
   * controller precomputes the whole page with a single `DISTINCT ON` query.
   * `PATCH` and both uploads render the blueprint standalone and answer null
   * here even for an artist that has one - so a card redrawn from an upload
   * response loses its fallback. Keep the value you already had.
   */
  readonly fallback_artwork_media_id: string | null;
  /** Legacy twin of {@link Artist.fallback_artwork_media_id}. */
  readonly fallback_artwork_fs_node_id: string | null;
}

/** One entry of Last.fm's similar-artists list. */
export interface ArtistSimilarEntry {
  readonly name: string;
  /**
   * Last.fm's similarity score, `0..1`. A NUMBER: the resolver runs `to_f`
   * before storing it. The web frontend types the whole `similar` field as an
   * object with an `artists` array, which is the DATABASE column's shape and
   * not the payload's - the blueprint flattens it to this array.
   */
  readonly match: number | null;
  readonly mbid: string | null;
}

/**
 * The `:extended` view: everything in {@link Artist} plus three fields.
 *
 * Blueprinter views INHERIT the base fields, so this is a superset and never a
 * subset. Returned by `GET /artists/:id`, `PATCH /artists/:id` and both upload
 * endpoints. `oms-music/docs/api-music.md` describes `:compact` and `:card` as
 * narrow subsets; they are not, for the same inheritance reason, and
 * `docs/API.md` says so correctly.
 */
export interface ArtistExtended extends Artist {
  /**
   * Last.fm biography summary. Contains HTML (and a trailing "Read more"
   * anchor); sanitised on the `/artist_metadata` shim but NOT here, so treat it
   * as untrusted markup and sanitise before injecting it.
   */
  readonly bio_html: string | null;
  /**
   * Wikipedia/Wikimedia photos of the artist.
   *
   * Writable through {@link MusicArtistsNamespace.update}, and OVERWRITTEN
   * without warning by the next metadata refresh: `ArtistResolver#populate!`
   * always assigns `gallery_image_urls` from `Artists::GalleryFetcher`, so a
   * hand-curated list survives only until the artist's gallery TTL (30 days,
   * jittered by up to 7) expires and someone opens the artist page. There is
   * no "pinned" flag. If a client offers gallery editing, it has to be
   * prepared to re-apply it.
   */
  readonly gallery_image_urls: string[];
  /** Flattened from the stored `similar_json`. Empty array, never null. */
  readonly similar: ArtistSimilarEntry[];
}

/**
 * Filters for {@link MusicArtistsNamespace.list}.
 *
 * The server's allowlist for this index is exactly `id`, `name`, `slug`,
 * `canonical_name`, `created_at` and `updated_at`. Any other key inside
 * `search` / `exact_search` is a **400**, not a silently ignored filter -
 * `CrudActions#reject_unknown_filter_keys!` fails closed on purpose, because
 * the alternative (dropping the key) answers with the UNFILTERED table.
 */
export const ARTIST_FILTER_COLUMNS = Object.freeze(["id", "name", "slug", "canonical_name", "created_at"] as const);

export interface ListArtistsParams extends ListParams<(typeof ARTIST_FILTER_COLUMNS)[number]> {
  /**
   * Substring match on the display name - `search[name]`. This is the roster
   * search box.
   *
   * `QuerySearcher#string_search` slugifies BOTH sides before comparing:
   * lowercase, accents transliterated, every run of anything outside
   * `[a-z0-9-]` replaced by a hyphen, then wrapped in `%`. So the query is
   * really `slug(name) LIKE %slug(input)%`, and three consequences follow:
   * `"Beyoncé"` finds `"Beyonce"` and the reverse; `"chico buarque"` and
   * `"chico-buarque"` are the SAME query; and punctuation is erased on both
   * sides, so `"P!nk"` matches `"P nk"` too. An accent this table's
   * `TRANSLATE` map does not list survives as a hyphen, which still matches.
   */
  readonly name?: string;
  /** Exact slug. Cheaper and less surprising than a `name` search. */
  readonly slug?: string;
  /**
   * Exact canonical name. Fold it the way the server does before sending it
   * (lowercase, `[-_./]` to spaces) or it will not match.
   */
  readonly canonicalName?: string;
  /** 1-based page number. */
  readonly page?: number;
  /** Rows per page. Clamped to 500 by the server and by the SDK. */
  readonly pageSize?: number;
  /**
   * `"column:asc"` / `"column:desc"`.
   *
   * PASS ONE. The index has no default order, so paging without it is paging
   * an unordered relation: Postgres may hand back the same row on two pages
   * and never hand back another. `name:asc` and `created_at:desc` are what the
   * clients use.
   *
   * `QueryModifier#apply_ordering` checks the column against
   * `model.column_names` and SILENTLY IGNORES anything else, so
   * `songs_count:desc` is not an error and is not an ordering either - that
   * field is computed per response and cannot be sorted on. Sort client-side,
   * or read {@link MusicArtistsNamespace.overview}, which ranks for you.
   */
  readonly order?: string;
}

/** Body accepted by {@link MusicArtistsNamespace.update}. */
export interface UpdateArtistInput {
  /**
   * New display name. `canonical_name` is recomputed from it; `slug` is NOT,
   * so the artist keeps the URL it was created with.
   */
  readonly name?: string;
  /**
   * Replaces the gallery wholesale - there is no merge. `[]` clears it.
   *
   * Every entry must start with `http://` or `https://` (blank entries are
   * stripped first); one that does not fails the whole request with
   * `400 "Gallery URLs must start with http:// or https://"`. And see
   * {@link ArtistExtended.gallery_image_urls}: what you write here is
   * temporary.
   */
  readonly gallery_image_urls?: string[];
}

/** Aggregate counters at the top of the Artists page. */
export interface ArtistOverviewStats {
  /** Artists in the library. */
  readonly artists: number;
  /** Songs in the library. */
  readonly songs: number;
  /** Artists first seen in the last 30 days. */
  readonly new_artists: number;
  /**
   * Total listening time, summed over the DURATION of the songs played rather
   * than counting plays, so a 12-second interlude does not weigh the same as
   * an eight-minute track. Covers the same window the shelves cover - see
   * {@link ArtistOverview.heavy_rotation_window}.
   */
  readonly seconds_played: number;
}

/** The hero of the Artists page. */
export interface ArtistSpotlight {
  readonly artist: Artist;
  readonly songs_count: number;
  /** Distinct non-empty `album` values across this artist's songs. */
  readonly albums_count: number;
  /** Plays in the active window. `0` when the spotlight came from the fallback. */
  readonly play_count: number;
}

/** One row of the heavy-rotation shelf. */
export interface ArtistHeavyRotationEntry {
  readonly artist: Artist;
  readonly play_count: number;
}

/** Library artists similar to the spotlight, seeded by the spotlight itself. */
export interface ArtistSimilarShelf {
  readonly seed: Artist;
  /** Never empty - the whole shelf is null instead. Max 12. */
  readonly artists: Artist[];
}

/** One row of the "you forgot about these" shelf. */
export interface ArtistNeglectedEntry {
  readonly artist: Artist;
  /** Primary credits the user owns. The shelf is ordered by it, descending. */
  readonly songs_count: number;
}

/**
 * The editorial header of the Artists page: five aggregate queries answered as
 * one document.
 *
 * The artists inside are rendered with the blueprint's `:card` view, which
 * inherits the base fields, so each one is a whole {@link Artist} - including
 * `fallback_artwork_media_id`, which the controller precomputes here.
 */
export interface ArtistOverview {
  readonly stats: ArtistOverviewStats;
  /**
   * Which window `heavy_rotation`, `spotlight.play_count` and
   * `stats.seconds_played` actually cover.
   *
   * The query prefers the last 30 days and falls back to ALL TIME when nothing
   * was played in them, rather than answering with an empty page. Label the
   * shelf from this field; a client that hardcodes "this month" will be lying
   * to anyone who took a month off.
   */
  readonly heavy_rotation_window: "30d" | "all";
  /**
   * Null only for an empty library. With no play history it falls back to
   * whoever the library holds the most songs of.
   */
  readonly spotlight: ArtistSpotlight | null;
  /** Up to 12, most played first. Empty for a library that was never played. */
  readonly heavy_rotation: ArtistHeavyRotationEntry[];
  /**
   * Null when there is no spotlight, when Last.fm never returned similars for
   * it, or when none of them are in the library. Recommending an artist the
   * user cannot play is noise, so the shelf disappears instead.
   */
  readonly similar: ArtistSimilarShelf | null;
  /** In the library, nothing played in 90 days. Up to 12. */
  readonly neglected: ArtistNeglectedEntry[];
}

/** `ArtistImport::STATES`. */
export const ARTIST_IMPORT_STATES = ["queued", "running", "complete", "failed"] as const;

/** State of a bulk artist import. */
export type ArtistImportState = (typeof ARTIST_IMPORT_STATES)[number];

/**
 * Cadence the three clients poll an in-flight import at, from
 * `oms-music/docs/API.md` section 14. There is no cable channel for imports.
 */
export const ARTIST_IMPORT_POLL_INTERVAL_MS = 1500;

/**
 * True once an import will never change again.
 *
 * Test against this rather than against a string you typed from memory: the
 * terminal success state is `"complete"`, not `"completed"`, and a loop that
 * waits for the wrong spelling never ends.
 */
export function isArtistImportTerminal(state: ArtistImportState | string): boolean {
  return state === "complete" || state === "failed";
}

/**
 * One bulk import of an artist's Spotify catalogue into the library.
 *
 * The counters exist because the pre-refactor flow swallowed Spotify errors
 * inside the job and left the user watching a spinner. Read them together:
 * `processed_albums` of `total_albums` is progress, and
 * `queued + skipped + failed` is what became of the tracks.
 */
export interface ArtistImport {
  readonly id: ArtistImportId;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Owner. A string id. */
  readonly user_id: string;
  readonly spotify_artist_id: string;
  /** Echoed back from the request; null when the caller sent it blank. */
  readonly spotify_artist_name: string | null;
  /** Exactly the ids the caller asked for, in the order they were sent. */
  readonly album_ids: string[];
  readonly state: ArtistImportState;
  readonly total_albums: number | null;
  /** Null until the job has expanded the albums into tracks. */
  readonly total_tracks: number | null;
  readonly processed_albums: number;
  /** Tracks handed to the song-import pipeline. */
  readonly queued_count: number;
  /** Tracks the library already had. */
  readonly skipped_count: number;
  readonly failed_count: number;
  /** Human-readable progress line, e.g. `"Waiting in queue…"`. */
  readonly last_message: string | null;
  /** Set only in the `failed` state. */
  readonly error_message: string | null;
  readonly started_at: Timestamp | null;
  readonly finished_at: Timestamp | null;
}

/** An artist the caller ALREADY has, offered by the import picker. */
export interface ArtistImportRosterMatch {
  readonly kind: "roster";
  /** The local {@link ArtistId}. An integer. */
  readonly id: ArtistId;
  readonly name: string;
  readonly slug: string;
  /**
   * A real URL (`picture_medium`, then `external_image_url`), or null. An
   * earlier version put a raw storage node id in this field, which no client
   * could load as an image.
   */
  readonly image_url: string | null;
}

/** A Spotify search hit offered by the import picker. */
export interface ArtistImportSpotifyMatch {
  readonly kind: "spotify";
  /** SPOTIFY's id, a string. This is what the other two methods take. */
  readonly id: string;
  readonly name: string;
  readonly followers: number | null;
  readonly genres: string[];
  /** Largest image Spotify offered, or null. */
  readonly image_url: string | null;
  readonly external_url: string | null;
}

/**
 * The import picker's two lists: what you already have, and what Spotify
 * found.
 */
export interface ArtistImportSearchResult {
  /** Up to 8 local matches, ordered by name. Available without Spotify. */
  readonly roster: ArtistImportRosterMatch[];
  /**
   * Up to 10 Spotify hits.
   *
   * EMPTY IS AMBIGUOUS and deliberately so: it means no Spotify identity is
   * linked, or Spotify genuinely matched nothing, or Spotify answered with an
   * upstream error that the server logged and swallowed so the roster half
   * would still render. Only a token-refresh failure is surfaced, as a 400.
   */
  readonly spotify: ArtistImportSpotifyMatch[];
}

/** One album in an artist's Spotify catalogue. */
export interface ArtistImportAlbum {
  /** Spotify album id - this is what goes in `albumIds`. */
  readonly id: string;
  readonly name: string;
  /** `"album" | "single" | "compilation"`, as Spotify spells it. */
  readonly album_type: string | null;
  /** `"album" | "single" | "compilation" | "appears_on"`. */
  readonly album_group: string | null;
  /** Spotify's partial date: `"2019"`, `"2019-05"` or `"2019-05-31"`. */
  readonly release_date: string | null;
  readonly total_tracks: number | null;
  readonly image_url: string | null;
  readonly external_url: string | null;
}

/** Arguments for {@link MusicArtistImportsNamespace.create}. */
export interface CreateArtistImportInput {
  /** Spotify's artist id, NOT a local {@link ArtistId}. */
  readonly spotifyArtistId: string;
  /** Stored for display. Sent blank, it lands as null. */
  readonly spotifyArtistName?: string;
  /** Spotify album ids. At least one, or the request is a 400. */
  readonly albumIds: string[];
}

/** Arguments for {@link MusicArtistImportsNamespace.list}. */
export interface ListArtistImportsParams {
  /**
   * How many of the newest imports to return. Clamped server-side to `1..50`;
   * the default is 20. Out-of-range values are clamped, never rejected.
   */
  readonly limit?: number;
}

/**
 * Bulk artist import, reachable as `oms.music.artists.imports`.
 *
 * ## Every route here needs a LINKED SPOTIFY IDENTITY, not a flag
 *
 * The gate is `Current.user.identities.find_by(provider: "spotify")`. Without
 * one the answer is `400 "Connect Spotify first."`, and when the stored refresh
 * token no longer works it is `400 "Spotify connection needs to be relinked."`
 * Both are plain JSON strings, both arrive as an {@link OmsApiError} with
 * status 400, and the only way to tell them apart is the message - so match on
 * it if the UI needs to distinguish "connect" from "reconnect".
 *
 * {@link search} is the exception: its roster half works with no Spotify at all.
 *
 * ## These calls are SLOW and they are on the general ceiling
 *
 * `/artist_imports*` does not match the 60/min proxy bucket, so it sits under
 * the general authenticated ceiling (600/min). What bounds it in practice is
 * Spotify: {@link search} and {@link albums} both call out synchronously on the
 * request thread, and {@link albums} pages through an entire discography. The
 * app allows 60 seconds for each, and so does this namespace.
 */
export class MusicArtistImportsNamespace extends Resource {
  /**
   * `GET /artist_imports/search?q=` - the import picker.
   *
   * A blank or whitespace-only query short-circuits to
   * `{ roster: [], spotify: [] }` with a `200` and no upstream call, so
   * debouncing an empty box is free. There is no minimum length beyond that
   * and no pagination.
   *
   * Retried like any GET. Sixty seconds by default, because the Spotify leg is
   * synchronous.
   *
   * @throws {OmsApiError} 400 `"Spotify connection needs to be relinked."`
   *   when the stored refresh token is dead. Note that a plain Spotify
   *   outage is NOT an error here - it comes back as an empty `spotify` array.
   */
  async search(query: string, options: RequestOptions = {}): Promise<ArtistImportSearchResult> {
    return this.http.get<ArtistImportSearchResult>("/artist_imports/search", {
      timeoutMs: 60_000,
      ...options,
      query: { q: query },
    });
  }

  /**
   * `GET /artist_imports/albums?spotify_artist_id=` - the artist's catalogue,
   * deduplicated by lowercased album name, first occurrence wins.
   *
   * That dedup is why the result can be shorter than Spotify's own catalogue
   * and why a deluxe edition sometimes disappears behind the standard one: the
   * comparison is the NAME, not the id.
   *
   * The server wraps the array in `{ items: [...] }`; this returns the array.
   *
   * `spotifyArtistId` is validated here rather than sent empty, because the
   * controller uses `params.require` and a missing key raises
   * `ActionController::ParameterMissing`. That escapes the API's own error
   * convention - it is a framework 400 with a framework body rather than a
   * bare JSON string - and it trips `ErrorReporting`, which pages the owner on
   * Discord for what is really a client bug.
   *
   * @throws {OmsError} `invalid_request` when `spotifyArtistId` is blank.
   * @throws {OmsApiError} 400 `"Connect Spotify first."` with no linked
   *   identity, `"Spotify connection needs to be relinked."` on a dead refresh
   *   token, or `"Spotify upstream error: ..."` (truncated to 200 characters)
   *   when Spotify itself failed. Unlike {@link search}, an outage IS surfaced
   *   here.
   */
  async albums(spotifyArtistId: string, options: RequestOptions = {}): Promise<ArtistImportAlbum[]> {
    assertPresent("spotifyArtistId", spotifyArtistId);
    const body = await this.http.get<{ items: ArtistImportAlbum[] }>("/artist_imports/albums", {
      timeoutMs: 60_000,
      ...options,
      query: { spotify_artist_id: spotifyArtistId },
    });
    return body.items ?? [];
  }

  /**
   * `POST /artist_imports` - queues every track of the chosen albums.
   *
   * Answers `201` immediately with a `queued` record; the work happens in
   * `ArtistImportJob`. Watch it with {@link list} at
   * {@link ARTIST_IMPORT_POLL_INTERVAL_MS} - THERE IS NO `GET
   * /artist_imports/:id`, so polling means re-reading the recent list and
   * finding your id in it.
   *
   * Not retried, and this one matters more than most: a replay does not
   * deduplicate, it creates a second `ArtistImport` row and runs the whole
   * catalogue through the pipeline again. Pass `retry: {}` only if you are
   * prepared to explain the duplicate.
   *
   * @throws {OmsError} `invalid_request` when `spotifyArtistId` is blank or
   *   `albumIds` is empty. The first would raise `ParameterMissing` on the
   *   server (see {@link albums}); the second is a clean
   *   `400 "album_ids required"`, checked here only so the round trip is saved.
   * @throws {OmsApiError} 400 for the two Spotify-identity messages.
   */
  async create(input: CreateArtistImportInput, options: RequestOptions = {}): Promise<ArtistImport> {
    assertPresent("spotifyArtistId", input.spotifyArtistId);
    if (input.albumIds.length === 0) {
      throw new OmsError(
        "albumIds is empty. An import with no albums is rejected by the server with 400 \"album_ids required\".",
        "invalid_request",
      );
    }
    return this.http.post<ArtistImport>(
      "/artist_imports",
      {
        spotify_artist_id: input.spotifyArtistId,
        spotify_artist_name: input.spotifyArtistName ?? "",
        album_ids: input.albumIds,
      },
      { retry: false, ...options },
    );
  }

  /**
   * `GET /artist_imports?limit=` - the caller's own imports, newest first.
   *
   * Not the List DSL: no `search`, no `modifiers`, no paging beyond `limit`,
   * and the payload is wrapped in `{ items: [...] }` (unwrapped here). Fifty
   * is the ceiling and it is clamped, not rejected.
   *
   * This is also the poll: filter for a `state` that
   * {@link isArtistImportTerminal} rejects to know whether anything is still
   * running. Nothing pushes import progress over the cable.
   */
  async list(params: ListArtistImportsParams = {}, options: RequestOptions = {}): Promise<ArtistImport[]> {
    const body = await this.http.get<{ items: ArtistImport[] }>("/artist_imports", {
      ...options,
      ...(params.limit === undefined ? {} : { query: { limit: params.limit } }),
    });
    return body.items ?? [];
  }
}


/**
 * Primary key of an artist sync. An integer, like {@link ArtistId} and
 * {@link ArtistImportId}, and interchangeable with NEITHER: a sync is keyed on
 * a SPOTIFY artist id and never references a local `Artist` row at all. Three
 * integer id spaces meet in this file and only the field name tells them apart.
 */
export type ArtistSyncId = number;

/**
 * A followed artist, as `/artist_syncs` renders it.
 *
 * ## This payload is hand-built, so the base fields you expect are MISSING
 *
 * There is no `ArtistSyncBlueprint`. `ArtistSyncsController#serialize` writes
 * the hash literally, which is why this is the one music record with no
 * `created_at` and no `updated_at` - the convention that every payload carries
 * them holds everywhere a Blueprinter view is involved and stops here. Do not
 * sort a list of these by `created_at` client-side; the server already returns
 * them newest-first and that ordering is the only one available.
 *
 * `known_album_ids` is likewise not exposed. The row stores the full array of
 * Spotify album ids (a `jsonb` column) and only its SIZE crosses the wire, so
 * the SDK cannot tell you WHICH albums are already known - only how many.
 */
export interface ArtistSync {
  readonly id: ArtistSyncId;
  /** Spotify's artist id. The join key, and the natural key of the row. */
  readonly spotify_artist_id: string;
  /**
   * Display name captured when the sync was created or last re-POSTed.
   *
   * `null` when the very first {@link MusicArtistSyncsNamespace.create} omitted
   * it. It is never refreshed from Spotify, and it cannot be CLEARED: a create
   * with a blank name keeps whatever the row already had (see
   * {@link CreateArtistSyncInput.spotifyArtistName}).
   */
  readonly artist_name: string | null;
  /**
   * Whether `ArtistDailySyncDispatcherJob` will pick this row up (its scope is
   * `where(enabled: true)`).
   *
   * Always `true` on anything this SDK can produce: `create` sets it, and there
   * is no update route to turn it off. A `false` here can only have been
   * written by the console, and the only way a client can stop a sync is
   * {@link MusicArtistSyncsNamespace.delete}. Render it, do not offer a toggle.
   */
  readonly enabled: boolean;
  /**
   * When the daily check last ran, ISO-8601, or `null` in the vanishingly
   * short window before `create` saves the row.
   *
   * A TOUCH, not a success marker. `ArtistSyncCheckJob` writes it on the happy
   * path AND in both of its rescue arms (dead refresh token, Spotify upstream
   * error), so a fresh timestamp proves the job ran, never that Spotify
   * answered. There is no field that records the last failure - it is a
   * `Rails.logger.warn` and nothing else - so a UI cannot honestly say "last
   * checked, all good".
   */
  readonly last_checked_at: Timestamp | null;
  /**
   * How many Spotify album ids the snapshot holds. `Array(known_album_ids).size`.
   *
   * This is the baseline the daily diff runs against, not a count of songs
   * imported. It GROWS and never shrinks, because the job stores the union
   * (`known | current_ids`) precisely so an album Spotify hides and later shows
   * again cannot re-import as new.
   */
  readonly known_album_count: number;
}

/** Arguments for {@link MusicArtistSyncsNamespace.create}. */
export interface CreateArtistSyncInput {
  /**
   * Spotify's artist id - the same string
   * {@link MusicArtistImportsNamespace.search} returns on its `spotify` side,
   * NOT a local {@link ArtistId}.
   */
  readonly spotifyArtistId: string;
  /**
   * Display name to store. Optional, and asymmetric: omitted on a FIRST create
   * it lands as `null`, omitted on a re-create it leaves the existing name
   * alone. Blank and absent behave identically, so there is no way to erase a
   * name once written - only to overwrite it with another.
   */
  readonly spotifyArtistName?: string;
}

/**
 * Daily release watch for a Spotify artist, reachable as
 * `oms.music.artists.syncs`.
 *
 * ## `syncs` versus `imports`: a subscription versus a backfill
 *
 * They share a Spotify artist id and nothing else, and picking the wrong one
 * is the mistake this namespace exists to make hard:
 *
 * | | {@link MusicArtistImportsNamespace} | this |
 * | --- | --- | --- |
 * | what it does | imports the albums you CHOSE, now | watches for albums released LATER |
 * | back catalogue | yes, that is the point | never |
 * | when work happens | immediately, `ArtistImportJob` | daily, 05:00 server time |
 * | you pick albums | yes, `albumIds` is required | no, there is no album argument |
 * | repeating the call | duplicates the whole import | idempotent, one row per artist |
 *
 * "Follow" here means FROM NOW ON. {@link create} takes a snapshot of the
 * artist's current catalogue and stores the album ids; the discography that
 * already exists is deliberately excluded from everything the sync will ever
 * do. A user who wants both has to do both - follow for the future, and run an
 * import for the past.
 *
 * ## What the sync produces is an ArtistImport, so watch it there
 *
 * `ArtistDailySyncDispatcherJob` runs at 05:00, walks every enabled row and
 * schedules each check at a random offset inside a 30-minute window (the same
 * anti-stampede discipline as the Spotify sync). Each `ArtistSyncCheckJob`
 * re-walks the artist's catalogue, diffs it against the snapshot and, when
 * something is new, creates an ordinary `ArtistImport` holding ONLY the new
 * album ids - `last_message` starts as `"Novo lançamento detectado pelo sync
 * diário…"`, which is the marker that tells an automatic import from one a
 * person asked for.
 *
 * So there is no progress on this namespace and nothing to poll here. Progress
 * lives in {@link MusicArtistImportsNamespace.list}, mixed in with manual
 * imports. Nothing pushes either over the cable.
 *
 * ## A LINKED SPOTIFY IDENTITY is required to write, not to read
 *
 * {@link create} is gated on `Current.user.identities.find_by(provider:
 * "spotify")` and answers `400 "Connect Spotify first."` without one. {@link
 * list} and {@link delete} are not gated, which matters after an unlink: the
 * rows survive, they still list, they can still be deleted, and the daily job
 * quietly skips them (`return unless identity`) without recording that it did.
 *
 * ## Ceilings and cost
 *
 * Every route here is on the GENERAL authenticated ceiling of 600/min.
 * `/artist_syncs` does not match the 60/min `\A/(lyrics|artists/|...)` bucket -
 * the underscore breaks the `artists/` prefix - and it is not in
 * `EXPENSIVE_TOOL_PATHS` either, even though {@link create} is by far the
 * slowest call in this file.
 *
 * ## An OAuth access token cannot reach any of this
 *
 * `ArtistSyncsController` declares no `oauth_scope`, and the gate denies by
 * default, so a Doorkeeper token gets `403 {"error":"insufficient_scope"}`
 * here as it does everywhere else in `music`. Session token or cookie only.
 */
export class MusicArtistSyncsNamespace extends Resource {
  /**
   * `GET /artist_syncs` - every artist this account follows, newest first.
   *
   * Not the List DSL and not a paginated index: no `search`, no
   * `exact_search`, no `modifiers`, no `limit`, and NO `ETag`, so this cannot
   * answer `304` and every poll pays for the full body. The server orders by
   * `created_at DESC` and hands back everything; a user following two hundred
   * artists gets two hundred rows.
   *
   * The array is wrapped in `{ items: [...] }` on the wire - the same envelope
   * `/artist_imports` uses and the opposite of the bare arrays the rest of the
   * API returns - and is unwrapped here.
   *
   * Safe to retry, and scoped to the caller: `ArtistSync.viewable_by` is
   * `where(user:)`, so there is no way to read anyone else's follows.
   */
  async list(options: RequestOptions = {}): Promise<ArtistSync[]> {
    const body = await this.http.get<{ items: ArtistSync[] }>("/artist_syncs", options);
    return body.items ?? [];
  }

  /**
   * `POST /artist_syncs` - follow an artist, and snapshot what it has today.
   *
   * Answers `201` with the stored row. The response is worth reading rather
   * than discarding: `known_album_count` is the size of the snapshot that was
   * just taken, and it is the only confirmation that the catalogue walk
   * actually happened.
   *
   * ## Idempotent, unlike its neighbour
   *
   * `find_or_initialize_by(user:, spotify_artist_id:)` behind a unique index,
   * so calling this twice for one artist updates a single row instead of
   * creating a second - it re-enables the sync, overwrites the name if one was
   * sent, and touches `last_checked_at`. It does NOT re-snapshot: the Spotify
   * walk is guarded by `if sync.known_album_ids.blank?`, so a second create is
   * cheap and, more importantly, cannot silently widen the baseline and swallow
   * releases that arrived in between.
   *
   * That is why this one opts INTO retries (`retry: {}`) while
   * {@link MusicArtistImportsNamespace.create} refuses them: a replayed follow
   * converges on the same row, a replayed import runs a whole discography
   * twice. Pass `retry: false` to opt back out.
   *
   * ## It is slow, because it walks the discography on the request thread
   *
   * `SpotifyClient#each_artist_album` pages through every album before the
   * response is written, exactly like
   * {@link MusicArtistImportsNamespace.albums}. Sixty seconds by default. The
   * one case that is instant is a re-create over a row that already has a
   * snapshot.
   *
   * An artist with a genuinely EMPTY catalogue never stops paying that cost:
   * `[]` is `blank?`, so every create for it walks Spotify again.
   *
   * @throws {OmsError} `invalid_request` when `spotifyArtistId` is blank. The
   *   server would answer `400` for it too - `params.require` raises
   *   `ParameterMissing` and this controller, unlike the import one, RESCUES it
   *   into a normal bad request, so it does not page the owner - but the round
   *   trip buys nothing.
   * @throws {OmsApiError} 400 `"Connect Spotify first."` with no linked
   *   identity, `"Spotify connection needs to be relinked."` on a dead refresh
   *   token, or `"Spotify upstream error: ..."` (truncated to 200 characters).
   *   All three are bare JSON strings and only the text separates them.
   */
  async create(input: CreateArtistSyncInput, options: RequestOptions = {}): Promise<ArtistSync> {
    assertPresent("spotifyArtistId", input.spotifyArtistId);
    return this.http.post<ArtistSync>(
      "/artist_syncs",
      {
        spotify_artist_id: input.spotifyArtistId,
        spotify_artist_name: input.spotifyArtistName ?? "",
      },
      { timeoutMs: 60_000, retry: {}, ...options },
    );
  }

  /**
   * `DELETE /artist_syncs/:id` - unfollow.
   *
   * Takes the {@link ArtistSyncId}, NOT the Spotify artist id: the only place
   * to get one is {@link list} or the record {@link create} returned.
   *
   * Destroys the row and its snapshot outright. Nothing already imported is
   * touched, and re-following later starts from a FRESH snapshot of the
   * catalogue as it stands then - which means anything released during the gap
   * is now part of the baseline and will never be picked up. That gap is
   * silent; if it matters, run an import for the missing albums.
   *
   * The server answers `200 {"ok": true}` here rather than the `204` the rest
   * of the API uses for a destroy. This resolves to `undefined` either way -
   * the body carries no information - but a caller reading `response.status`
   * through {@link ApiClient.raw} should not expect 204.
   *
   * Not retried, by the transport's default for `DELETE`: the second attempt
   * would find nothing and report `404` for a row it had just removed.
   *
   * @throws {OmsApiError} 404 `"Artist sync not found"` for an id that is not
   *   yours or no longer exists. A non-numeric id lands here too, cast to `0`
   *   by the column type rather than rejected.
   */
  async delete(id: ArtistSyncId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/artist_syncs/${id}`, options);
  }
}

/** The `music.artists` namespace, reachable as `oms.music.artists`. */
export class MusicArtistsNamespace extends Resource {
  /** Bulk import of a Spotify artist's catalogue. */
  readonly imports: MusicArtistImportsNamespace;
  /** Daily watch for FUTURE releases. Not a backfill - see the class. */
  readonly syncs: MusicArtistSyncsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.imports = new MusicArtistImportsNamespace(http);
    this.syncs = new MusicArtistSyncsNamespace(http);
  }

  /**
   * `GET /artists` - the roster.
   *
   * On the GENERAL ceiling (600/min), not the 60/min artist bucket: the
   * throttle's pattern is `/artists/` with a trailing slash and the index path
   * is normalised to `/artists`. It is the only route in this namespace with
   * that luxury.
   *
   * Rows are the blueprint's default view: no `bio_html`, no
   * `gallery_image_urls`, no `similar`. `songs_count` and
   * `fallback_artwork_media_id` ARE filled in here.
   *
   * ALWAYS PASS `order`. See {@link ListArtistsParams.order} - the relation
   * has no order of its own, and paging an unordered relation loses rows.
   *
   * This index emits an `ETag` and can answer `304`. The SDK never sends
   * `If-None-Match` itself, and a browser's HTTP cache turns a 304 back into a
   * 200 with the cached body before `fetch` sees it - but a hand-written
   * `If-None-Match` in `options.headers` on Bun or React Native would produce a
   * bare 304, which the transport treats as a failure (`response.ok` is false)
   * and raises as an {@link OmsApiError} with status 304 and no body. Do not
   * send the header.
   *
   * @throws {OmsApiError} 400 `"Unknown search filter: ..."` for a filter key
   *   outside the allowlist. Filters fail closed rather than widening the
   *   query.
   */
  async list(params: ListArtistsParams = {}, options: RequestOptions = {}): Promise<Paginated<Artist>> {
    const base = {
      search: { name: params.name },
      exactSearch: { slug: params.slug, canonical_name: params.canonicalName },
    };
    return paginate(params, ARTIST_ROSTER_PAGE_SIZE, (at) =>
      this.http.get<Artist[]>("/artists", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /artists/:idOrSlug` - one artist, extended view.
   *
   * Three lookups in order: a purely numeric segment is an id, otherwise a
   * slug, otherwise a canonical name. So `get(42)`, `get("chico-buarque")` and
   * `get("Chico Buarque")` all work, and an artist whose slug is all digits
   * would be unreachable by slug - a case the backend does not handle and
   * nothing in practice produces.
   *
   * ## This call can be slow the FIRST time, and it is not the network
   *
   * The controller runs `ArtistResolver.refresh_if_stale`, which is
   * stale-while-revalidate with one exception. A row that has never been
   * populated is filled in INLINE, on the request thread: a MusicBrainz search,
   * two Last.fm calls and a Wikimedia gallery fetch before the response is
   * written. A row that merely went stale is served immediately and refreshed
   * by a background job, deduplicated to one job per artist per ten minutes.
   *
   * So budget a generous `timeoutMs` for a cold artist, and do not read a
   * slow first load as a broken server. What you must NOT do is retry it fast:
   * this route is inside the shared 60/min bucket.
   *
   * ## What null metadata means
   *
   * If every external call fails, the resolver still stamps `bio_fetched_at`,
   * `similar_fetched_at` and the gallery timestamp, so the upstream is not
   * hammered on every page view. The response is a normal `200` with
   * `bio_html: null` and `similar: []`, and it will stay that way until the TTL
   * (7 days for the biography, jittered) expires. There is no field that says
   * "the fetch failed" - a client cannot distinguish a burnt fetch from an
   * artist Last.fm has never heard of, and should present both as "no
   * biography" rather than as an error.
   *
   * Deezer pictures are NOT touched by this route at all; they are refreshed
   * only through `GET /songs/artist_pictures`.
   *
   * **60/min**, shared with lyrics, artist metadata and radios.
   *
   * @throws {OmsApiError} 404 `"Artist not found"`.
   */
  async get(idOrSlug: ArtistId | string, options: RequestOptions = {}): Promise<ArtistExtended> {
    return this.http.get<ArtistExtended>(`/artists/${encodeURIComponent(String(idOrSlug))}`, options);
  }

  /**
   * `GET /artists/overview` - the whole Artists page header in one request.
   *
   * **Cached server-side for one hour, per user**, under
   * `artists_overview:v2:<user id>`. Two consequences worth designing around:
   * polling it is pointless, and an artist you just renamed or gave a new
   * picture keeps its old card here for up to an hour while
   * {@link MusicArtistsNamespace.get} already shows the new one. A client that
   * refreshes this after an edit should expect no change and not treat it as a
   * failed write.
   *
   * **60/min**, shared bucket. One call per page open is the intended shape.
   */
  async overview(options: RequestOptions = {}): Promise<ArtistOverview> {
    return this.http.get<ArtistOverview>("/artists/overview", options);
  }

  /**
   * `PATCH /artists/:id` - renames an artist and/or replaces its gallery.
   *
   * ## The body is FLAT
   *
   * `{ name, gallery_image_urls }` at the top level. The web frontend sends
   * `{ artist: { ... } }`, which `params.permit(:name, gallery_image_urls: [])`
   * permits nothing out of: the update then assigns an empty hash, saves
   * successfully and answers `200` with the record UNCHANGED. A nested body is
   * not an error, it is a silent no-op, and it is the reason this method takes
   * the fields rather than a body.
   *
   * Fields outside those two are dropped in silence as well (the fail-closed
   * 400 applies to filter buckets, not to update params), so read the returned
   * record rather than assuming the write landed.
   *
   * ## Addressed by NUMERIC ID ONLY
   *
   * Unlike {@link get}, this goes through the generic CRUD lookup
   * (`find_by(id:)`), so a slug 404s - and with a different message,
   * `"Resource not found"` rather than `"Artist not found"`. Resolve the slug
   * with {@link get} first.
   *
   * **60/min**, shared bucket. Not retried by default.
   *
   * @throws {OmsApiError} 400 `"Gallery URLs must start with http:// or https://"`,
   *   or a validation message (a name that collides with another artist's
   *   canonical name fails the per-user uniqueness index).
   * @throws {OmsApiError} 404 `"Resource not found"` for an unknown id, a slug,
   *   or another user's artist.
   */
  async update(id: ArtistId, input: UpdateArtistInput, options: RequestOptions = {}): Promise<ArtistExtended> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.gallery_image_urls !== undefined) body.gallery_image_urls = input.gallery_image_urls;
    return this.http.patch<ArtistExtended>(`/artists/${id}`, body, { retry: false, ...options });
  }

  /**
   * `DELETE /artists/:id` - `204` on success.
   *
   * ## A refusal arrives as 401, not 400
   *
   * `Artist#destroyable_by?` is `owner && song_artists.empty?`, and the CRUD
   * action turns a false there into
   * `401 "You are not authorized to destroy this resource"`. So "this artist
   * still has songs" and "this artist is not yours" are the SAME response, and
   * the SDK surfaces both as an {@link OmsAuthError}.
   *
   * That has one consequence a caller should know about: a client configured
   * with `tokens.onUnauthorized` will spend a token refresh on it and retry
   * once before failing, because the transport reasonably assumes a 401 means
   * a stale credential. Nothing breaks, but the refresh is wasted. Check
   * `songs_count === 0` before calling, and detach the songs first otherwise.
   *
   * Numeric id only, like {@link update}. **60/min**, shared bucket. Not
   * retried, because a replayed `DELETE` reports `404` for a row it removed
   * perfectly well.
   *
   * @throws {OmsAuthError} 401 when the artist still has credits, or is not
   *   yours.
   * @throws {OmsApiError} 404 `"Resource not found"`.
   */
  async delete(id: ArtistId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/artists/${id}`, { retry: false, ...options });
  }

  /**
   * `POST /artists/:id/upload_image` - multipart, field name `image`. Replaces
   * the square avatar and returns the extended record.
   *
   * See {@link uploadBanner} for everything the two share: sizes, accepted
   * types, quota, and what the response does not carry.
   *
   * **60/min**, shared bucket. Not retried: a replay re-uploads the bytes.
   *
   * @throws {OmsError} `invalid_request` when the size is known ahead of time
   *   and exceeds {@link ARTIST_IMAGE_MAX_BYTES}.
   */
  async uploadImage(
    id: ArtistId,
    image: FileInput | NativeFile,
    options: RequestOptions = {},
  ): Promise<ArtistExtended> {
    assertImageSize("image", image);
    return this.http.postForm<ArtistExtended>(
      `/artists/${id}/upload_image`,
      { image },
      { retry: false, ...options },
    );
  }

  /**
   * `POST /artists/:id/upload_banner` - multipart, field name **`banner`**.
   *
   * The field is `banner`, NOT `image`. The web frontend sends `image` to this
   * route and gets `400 "banner required"` for it; do not copy that.
   *
   * ## Shared rules for both uploads
   *
   * - **10 MiB** ceiling ({@link ARTIST_IMAGE_MAX_BYTES}), checked before
   *   anything else; over it is `400 "file too big (max 10485760B)"`. The SDK
   *   checks first when the size is known, which it is for a `Blob` and for a
   *   picker that reported one.
   * - JPEG, PNG, WebP and GIF are mapped straight to an extension; anything
   *   else falls back to the filename's extension and is a
   *   `400 "unsupported image type <type>"` only when that is empty too. So
   *   always send a `filename` with a real extension.
   * - The bytes go through the music storage quota. Over budget is
   *   `400 "Music storage quota exceeded"` - check `music_storage_bytes` in
   *   `oms.quotas` first if you want to say something better than that.
   * - An oversized or malformed IMAGE (a decompression bomb) is rejected by
   *   the image pipeline as a 400 as well, with the processor's own message.
   * - Uploading purges the legacy `compressed_*` companion, because nothing
   *   regenerates it for artists and a leftover copy would keep rendering the
   *   OLD picture. Expect `compressed_banner_media_id` to be null afterwards.
   * - The response is the `:extended` view rendered STANDALONE, so
   *   `fallback_artwork_media_id` comes back null even for an artist that has
   *   one. Merge the response into what you already had; do not replace it.
   * - Addressed like {@link get}, not like {@link update}: id, slug or
   *   canonical name all resolve, and the 404 message is `"Artist not found"`.
   *
   * ## The three clients
   *
   * React Native passes the picked `{ uri, name, type }` straight through; the
   * transport appends it verbatim, which is the only thing that works there.
   * Browser and Bun pass a {@link FileInput} carrying a `Blob`/`Uint8Array` -
   * a bare `NativeFile` on those runtimes is rejected loudly rather than
   * stringified into an empty part.
   *
   * @throws {OmsError} `invalid_request` when a known size exceeds the ceiling.
   * @throws {OmsApiError} 400 for size, type, quota or image-decode failures;
   *   401 when the artist is not yours; 404 `"Artist not found"`.
   */
  async uploadBanner(
    id: ArtistId,
    banner: FileInput | NativeFile,
    options: RequestOptions = {},
  ): Promise<ArtistExtended> {
    assertImageSize("banner", banner);
    return this.http.postForm<ArtistExtended>(
      `/artists/${id}/upload_banner`,
      { banner },
      { retry: false, ...options },
    );
  }
}

/**
 * Rejects an upload the server would refuse, when the size is knowable here.
 *
 * Deliberately silent when it is not: a `ReadableStream` with no declared
 * `size`, or an RN picker that reported none, is sent and judged by the
 * server. Buffering a stream just to measure it would be worse than the 400.
 */
function assertImageSize(field: string, file: FileInput | NativeFile): void {
  const size = fileSize(file);
  if (size !== undefined && size > ARTIST_IMAGE_MAX_BYTES) {
    throw new OmsError(
      `${field} is ${size} bytes; the server accepts at most ${ARTIST_IMAGE_MAX_BYTES}.`,
      "invalid_request",
    );
  }
}

/** Byte length of an upload, when the caller or the platform declared one. */
function fileSize(file: FileInput | NativeFile): number | undefined {
  const declared = (file as { size?: unknown }).size;
  if (typeof declared === "number" && Number.isFinite(declared)) return declared;
  const data = (file as { data?: unknown }).data;
  if (data && typeof (data as { size?: unknown }).size === "number") {
    return (data as { size: number }).size;
  }
  if (data instanceof Uint8Array) return data.byteLength;
  return undefined;
}
