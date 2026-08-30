/**
 * The music domain, reachable as `oms.music`.
 *
 * Five modules split by what they own rather than by URL prefix, because the
 * routes here are flatter than the concepts are: `/songs`, `/artists`,
 * `/playlists`, `/song_imports`, `/jams` and a dozen more all hang off the
 * root, and grouping them by prefix would have produced a surface nobody could
 * guess from.
 *
 * ```ts
 * const songs = await oms.music.songs.list({ artist: "Nina Simone" });
 * const mine  = await oms.music.playlists.list();
 * await oms.music.playlists.plays.record({ song_id: songs[0].id, source: "web" });
 * const jam   = await oms.music.social.jams.create();
 * ```
 *
 * ## Two id conventions live side by side here, and mixing them is the bug
 *
 * `songs`, `artists`, `playlists`, `playlist_songs`, `liked_songs`,
 * `play_events`, `jams`, `song_imports` and `artist_imports` are INTEGERS over
 * HTTP. The same song ids come back as STRINGS on the realtime stream. The
 * types in each
 * module say which one applies where; do not normalise them yourself on the way
 * in, because `exact_search` compares them typed and a stringified integer
 * silently matches nothing.
 *
 * ## Rate limits worth knowing before wiring a UI
 *
 * `/lyrics*`, `/artists/*`, `/artist_metadata/*` and `/music_radios/*` are on
 * the 60/min bucket rather than the general 600/min one, so a grid that fetches
 * artwork per row will hit a ceiling the rest of the SDK never touches. The
 * external-search and DJ endpoints have their own, documented on the methods.
 *
 * Every sub-namespace is exported on its own, so a host that only ships the
 * player can construct {@link MusicSongsNamespace} directly with the same
 * `ApiClient` and never pull the rest into its bundle.
 */

import { ApiClient, Resource } from "../../http";
import { MusicArtistsNamespace } from "./artists";
import { MusicImportsNamespace } from "./imports";
import { MusicPlaylistsNamespace } from "./playlists";
import { MusicSocialNamespace } from "./social";
import { MusicSongsNamespace } from "./songs";

export * from "./artists";
export * from "./imports";
export * from "./playlists";
export * from "./social";
export * from "./songs";

/** The `music` namespace, reachable as `oms.music`. */
export class MusicNamespace extends Resource {
  /** The library itself: songs, their files, lyrics, likes and separations. */
  readonly songs: MusicSongsNamespace;
  /** Artists, their metadata and artwork. `.imports` builds new ones. */
  readonly artists: MusicArtistsNamespace;
  /** Playlists, plus `.songs`, `.mixes`, `.radios` and `.plays`. */
  readonly playlists: MusicPlaylistsNamespace;
  /** Getting audio in: uploads, URL downloads, `.spotify` sync and `.srMachine`. */
  readonly imports: MusicImportsNamespace;
  /** Jams, music profiles, the assistant and the DJ. */
  readonly social: MusicSocialNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.songs = new MusicSongsNamespace(http);
    this.artists = new MusicArtistsNamespace(http);
    this.playlists = new MusicPlaylistsNamespace(http);
    this.imports = new MusicImportsNamespace(http);
    this.social = new MusicSocialNamespace(http);
  }
}
