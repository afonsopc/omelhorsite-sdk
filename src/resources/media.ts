/**
 * The `media` namespace: the canonical bytes of the music library.
 *
 * A song, an artist and a playlist never carry bytes or URLs inline. They carry
 * MEDIA IDS - `audio_media_id`, `compressed_artwork_media_id`,
 * `image_media_id`, `vocals_media_id` and the rest - and this namespace is the
 * one place those ids turn into something playable.
 *
 * ## Two routes, and which one is the real one
 *
 * - `GET /media/:id/data` and `GET /media/:id/data_url` are the CANONICAL
 *   routes. Every new client should use them.
 * - `GET /fs_nodes/:id/data` and `GET /fs_nodes/:id/data_url` are a TEMPORARY
 *   ALIAS. An all-digit id there is served as media; a storage UUID keeps the
 *   filesystem behaviour. The alias is scheduled to go, together with the
 *   `*_fs_node_id` twins on the music records.
 *
 * {@link MediaNamespace.aliasUrl} and {@link MediaNamespace.aliasDataUrl} are
 * here for code that still spells the old routes, and for the one case where
 * the alias is genuinely more capable (see the OAuth note below). Reach for
 * {@link MediaNamespace.url} and {@link MediaNamespace.dataUrl} in new code.
 *
 * ## A media id is not a storage node id
 *
 * It is a STRING whose characters happen to all be digits (`"48211"`).
 * Storage node ids are uuids. The two id spaces are not interchangeable, and
 * the only reason a media id works on the `fs_nodes` path at all is the
 * numeric branch described above. {@link isMediaId} exists to keep that
 * straight.
 *
 * ## 404 NEVER 401, and why that will empty somebody's library
 *
 * The server answers `404 "Not found"` for every one of these, deliberately
 * indistinguishable:
 *
 * - the id does not exist;
 * - it exists but belongs to a book, a tool output, another user;
 * - the caller sent no credential at all;
 * - the caller sent a credential that no longer resolves to a live session.
 *
 * The routes accept anonymous callers, so authentication never gets a chance
 * to answer `401`. That is correct for the server:
 * existence must not leak. It is a TRAP for the client.
 *
 * A client that reads `404` as "this file is gone" will, the moment a session
 * expires or a token rotates, quietly render an entire library of broken
 * artwork and unplayable tracks - and it will look like data loss, not like a
 * sign-in problem, because nothing anywhere returned `401`. **Never conclude
 * "missing" from a media 404 alone.** Confirm the session first with a route
 * that does distinguish the two (`oms.account.me()` answers `401` when the
 * credential is dead) and only then decide the media is really gone.
 * {@link isMediaMissing} carries that warning at the point of use.
 *
 * ## The rate ceilings are not the same on the two routes, and that is the point
 *
 * The general rate-limit exemption covers `/media/:id/data` and
 * `/fs_nodes/:id/(data|zip)`, and NEITHER `data_url`:
 *
 * - **`data` is EXEMPT** from the 600/min authenticated and 120/min anonymous
 *   ceilings, on both the canonical route and the alias. An artwork grid, a
 *   prefetch sweep and a bulk download can hammer it without spending the
 *   account's budget. This is the route for images and for downloads.
 * - **`data_url` COUNTS** against the general ceiling like any other call.
 *   Resolving a presigned URL per tile in a scrolling grid is how a client
 *   429s itself out of the whole API. Reserve it for the player's resolver,
 *   which needs a URL a media element can load cross-origin, and cache what it
 *   returns BY MEDIA ID - never by URL, because a fresh signature comes back
 *   on every single resolve.
 *
 * The exemption is matched against a normalised path with the format suffix
 * stripped, so `/media/48211/data.json` is exempt too, and a query string
 * never changes the verdict.
 *
 * ## An OAuth access token cannot reach `/media/*` at all
 *
 * The canonical routes accept no OAuth scope at all: an OAuth token gets
 * `403 {"error":"insufficient_scope"}` whatever it carries. The `/fs_nodes`
 * alias DOES accept `storage:read` on `data`/`data_url`, so - until the
 * canonical routes gain a scope - a token holding `storage:read` can reach
 * music bytes through the temporary alias and not through the canonical
 * route. That inversion is a server-side gap rather
 * than a design decision; it is the single reason to prefer the alias, and it
 * is expected to close. A session token or the browser cookie reaches both.
 *
 * ## Who may read what
 *
 * Owner-only, with exactly one hole cut in it on purpose: the `audio`,
 * `compressed_audio`, `artwork` and `compressed_artwork` attachments of a SONG
 * that sits, unhidden, in a `friends`-visibility playlist belonging to one of
 * the caller's friends. Stems, artist images and playlist covers stay
 * owner-only. Every other cross-user surface in the API - jams, the friends
 * feed, music profiles - ships READY-MADE presigned `artwork_url` / `audio_url`
 * strings instead; use those verbatim and never try to re-derive one from an id
 * you do not own, because that is a 404.
 */

import { OmsApiError, OmsError, OmsNetworkError } from "../errors";
import { type ApiClient, Resource } from "../http";
import type { FileOutput, RequestOptions } from "../types";

/**
 * A media id: a string of digits.
 *
 * Typed as a plain `string` rather than a branded type because that is what
 * every `*_media_id` field on a song, an artist and a playlist already is, and
 * a brand would force a cast at every one of them.
 */
export type MediaId = string;

/**
 * How long a presigned URL from {@link MediaNamespace.dataUrl} stays valid:
 * six hours.
 *
 * The window is long because it has to be, not out of generosity. A media
 * element re-requests the object on every seek and whenever it resumes a
 * buffered track, so the signing default of five minutes dies mid-listen with
 * no way to recover. Six hours is also what the cross-user presigned URLs on
 * jams and the friends feed are signed for.
 */
export const MEDIA_URL_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a browser may reuse the `302` from `GET /media/:id/data`:
 * five minutes, `Cache-Control: private`.
 *
 * It exists because a redirect with no `Cache-Control` is never cached, so
 * every `<img>` re-followed the hop on every mount and artwork visibly
 * re-fetched itself. Deliberately far below {@link MEDIA_URL_TTL_MS} so a
 * cached redirect always points at a signature with hours of life left.
 *
 * `private` means per-browser: a shared cache must not hold it, because the
 * response is the product of the caller's own credential.
 */
export const MEDIA_REDIRECT_CACHE_TTL_MS = 5 * 60 * 1000;

/** The `media` namespace, reachable as `oms.media`. */
export class MediaNamespace extends Resource {
  /**
   * Absolute URL of `GET /media/:id/data`, carrying NO credential.
   *
   * Synchronous, because it is called while a component renders and a token
   * provider may be async. What that means depends on the client:
   *
   * - **browser, cookie mode**: this is the URL you want. The `oms_session`
   *   cookie rides along on its own, the element follows the `302` to object
   *   storage with no CORS check at all, and the redirect is cacheable for
   *   {@link MEDIA_REDIRECT_CACHE_TTL_MS}. Do NOT put `crossorigin` on the
   *   element: it turns a no-cors load into a CORS one and re-creates exactly
   *   the failure the split between `data` and `data_url` exists to avoid.
   * - **token mode**: this URL alone is a `404`,
   *   because no credential reaches the server. Use
   *   {@link authenticatedUrl} instead.
   *
   * Rate-limit exempt (see the namespace notes), which is what makes it the
   * right route for an artwork grid and for a prefetch sweep.
   */
  url(id: MediaId): string {
    return this.http.url(dataPath(id));
  }

  /**
   * {@link url} with the caller's token appended as `?token=`, for an `<img>`,
   * an `<audio>`, a lock-screen artwork slot or a native downloader - anything
   * that fetches a URL itself and cannot be given an `Authorization` header.
   *
   * Asynchronous because resolving the credential may refresh it, so it cannot
   * be a getter. In cookie mode there is no token and it returns the bare URL,
   * which is the correct answer there.
   *
   * The server reads the `Authorization` header, then the `token` query
   * parameter, then the cookie, so a query token is a first-class credential
   * on this route.
   *
   * **THE RESULT IS A LIVE CREDENTIAL.** It goes into the DOM, into the server
   * access log, into `Referer` and into anything that records URLs; anyone
   * holding it holds the whole session until it is revoked. Build it at the
   * moment of use, never store it, never log it, and never hand it to
   * something outside your own app - fetch the bytes with {@link download} and
   * pass a `blob:` URL instead.
   *
   * One consequence worth planning for: the token is part of the URL, so it is
   * part of the browser HTTP cache key. Every sign-in invalidates the warmed
   * artwork cache of a token-mode client. That costs one cold cache, never
   * correctness, and there is no client-side fix.
   *
   * ```ts
   * const src = await oms.media.authenticatedUrl(song.compressed_artwork_media_id);
   * ```
   */
  async authenticatedUrl(id: MediaId): Promise<string> {
    const token = await tokenOf(this.http);
    return this.http.url(dataPath(id), token === null ? undefined : { token });
  }

  /**
   * `GET /media/:id/data_url` - the presigned object-store URL for these bytes,
   * as JSON.
   *
   * This is the route a PLAYER wants. `data` answers a `302` to storage, and a
   * cross-origin media request cannot survive that hop either way: sent with
   * credentials the browser turns `Origin` into `null` after the redirect and
   * the store's wildcard `Access-Control-Allow-Origin` is illegal for a
   * credentialed request; sent without credentials the route 404s before it
   * ever redirects. Splitting it in two removes the redirect from the media
   * request entirely - this call carries the session and returns a URL, and
   * the element then loads that URL from storage directly and anonymously.
   *
   * Three properties that decide how you cache it:
   *
   * - **it is DIFFERENT on every call.** A fresh signature per resolve. Cache
   *   by media id, never by URL, or a cache keyed on the string will miss
   *   every time and grow forever.
   * - **it is good for {@link MEDIA_URL_TTL_MS}** (six hours) and then it is
   *   not. Re-resolve on a playback failure rather than treating one as fatal.
   * - **it COUNTS against the 600/min authenticated ceiling**, unlike
   *   {@link url}. One resolve per track as it is about to play is the
   *   intended shape; one resolve per tile in a grid is not.
   *
   * Do not forward your own `Authorization` header when fetching the returned
   * URL - the signature is the credential, and the object store rejects a
   * request that carries both.
   *
   * @throws {OmsApiError} 404 `"Not found"` - which does NOT mean the media is
   *   gone. See {@link isMediaMissing} and the namespace notes.
   * @throws {OmsAuthError} 403 `insufficient_scope` when the client
   *   authenticated with an OAuth access token; the route accepts no scope, so
   *   no OAuth token reaches it.
   */
  async dataUrl(id: MediaId, options: RequestOptions = {}): Promise<string> {
    const answer = await this.http.get<{ url: string }>(dataUrlPath(id), options);
    return answer.url;
  }

  /**
   * `GET /media/:id/data`, following the redirect and reading the bytes into
   * memory.
   *
   * For Bun, a Worker and React Native, where nothing enforces CORS. In a
   * BROWSER this cannot work and no amount of client code fixes it - the `302`
   * goes to a different origin, and the two failure modes described on
   * {@link dataUrl} apply here too. There, put {@link url} or
   * {@link authenticatedUrl} in an element, or resolve with {@link dataUrl}
   * and fetch that.
   *
   * Buffers everything. A lossless album track is a bad thing to pull through
   * JavaScript on a phone: resolve a URL and hand it to the platform player or
   * to a native downloader instead, both of which stream to disk. This method
   * is for artwork and for the odd file a host really does need in memory.
   *
   * The server may also send the bytes inline (with a `Content-Disposition`
   * filename) instead of redirecting; both shapes arrive here identically.
   *
   * The runtime follows the redirect, and every conformant one drops the
   * `Authorization` header on the cross-origin hop. That is not a limitation to
   * work around: the signature in the presigned URL is the credential, and the
   * object store rejects a request that arrives carrying both. A hand-rolled
   * downloader that helpfully re-attaches the header will get a `400` from
   * storage on bytes the server was perfectly willing to hand over.
   *
   * @throws {OmsError} `unsupported` when the redirect was blocked, which in
   *   practice means a browser in cookie mode.
   * @throws {OmsApiError} 404 - see {@link isMediaMissing} before believing it.
   */
  async download(id: MediaId, options: RequestOptions = {}): Promise<FileOutput> {
    const path = dataPath(id);
    try {
      return await this.http.download(path, options);
    } catch (thrown) {
      if (thrown instanceof OmsNetworkError && (await tokenOf(this.http)) === null) {
        throw new OmsError(
          "The media redirect could not be followed. In a browser, a client built with " +
            "`sessionCookie: true` sends credentials, the 302 to object storage arrives with " +
            "`Origin: null`, and the store answers a wildcard `Access-Control-Allow-Origin` - which CORS " +
            "forbids for a credentialed request. Use oms.media.url(id) in an <img> or an <audio>, or " +
            "oms.media.dataUrl(id) and fetch the presigned URL, neither of which redirects under CORS.",
          "unsupported",
          { method: "GET", url: this.http.url(path), cause: thrown },
        );
      }
      throw thrown;
    }
  }

  /**
   * `GET /fs_nodes/:id/data` - the TEMPORARY numeric-id alias for {@link url}.
   *
   * Identical bytes, identical owner-or-404 rule, identical rate-limit
   * exemption. It is here for two reasons and no others: code that still
   * spells the old route, and it is currently the only media route an OAuth
   * token carrying `storage:read` can reach (see the namespace notes).
   *
   * The id must be all digits. The alias only serves media for an all-digit
   * id; anything else is looked up as a storage node, which for a media id
   * means a 404 with a completely different cause. {@link isMediaId} checks
   * that before you spend a request finding out.
   *
   * @deprecated Prefer {@link url}. The alias is temporary and will be removed
   *   together with the `*_fs_node_id` twins.
   */
  aliasUrl(id: MediaId): string {
    return this.http.url(aliasDataPath(id));
  }

  /**
   * `GET /fs_nodes/:id/data_url` - the TEMPORARY numeric-id alias for
   * {@link dataUrl}, with every caveat that method carries.
   *
   * Counts against the rate ceiling exactly as the canonical route does: the
   * exemption covers `/fs_nodes/:id/data` and `/fs_nodes/:id/zip`, and stops
   * there.
   *
   * Note the asymmetry with {@link aliasUrl}: a NON-numeric id here is not an
   * error but a different endpoint - the storage node's own data URL - which is
   * a perfectly valid thing to want and is what `oms.storage.downloadUrl` is
   * for. Do not use this method to reach a storage node; use that one.
   *
   * @deprecated Prefer {@link dataUrl}.
   */
  async aliasDataUrl(id: MediaId, options: RequestOptions = {}): Promise<string> {
    const answer = await this.http.get<{ url: string }>(aliasDataUrlPath(id), options);
    return answer.url;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** The canonical bytes route. The one place it is spelled. */
function dataPath(id: MediaId): string {
  return `/media/${encodeURIComponent(id)}/data`;
}

/** The canonical presign route. */
function dataUrlPath(id: MediaId): string {
  return `/media/${encodeURIComponent(id)}/data_url`;
}

/** The temporary numeric-id alias for the bytes. */
function aliasDataPath(id: MediaId): string {
  return `/fs_nodes/${encodeURIComponent(id)}/data`;
}

/** The temporary numeric-id alias for the presign. */
function aliasDataUrlPath(id: MediaId): string {
  return `/fs_nodes/${encodeURIComponent(id)}/data_url`;
}

/**
 * Whether a value has the shape the `/fs_nodes` alias routes to media: one or
 * more digits and nothing else.
 *
 * Worth having because the alias branches on exactly this regex. Hand it a
 * storage uuid and it does not fail loudly - it quietly serves a different
 * resource, or 404s for a reason that has nothing to do with the media you
 * asked for.
 */
export function isMediaId(value: unknown): value is MediaId {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Whether an error is a media `404`.
 *
 * **Read the name as "the server would not serve this", never as "this does
 * not exist".** The media routes accept anonymous callers and collapse five
 * different situations into the same `404`, on purpose, so that the existence
 * of a file never leaks: unknown id,
 * wrong owner, non-music attachment, no credential, and a credential that has
 * expired.
 *
 * The last two are the dangerous ones. A client that deletes its cached row,
 * or renders a permanent placeholder, on the strength of this returning `true`
 * will erase a user's entire visible library the first time their session
 * lapses - with no `401` anywhere to explain it.
 *
 * The safe shape:
 *
 * ```ts
 * try {
 *   src = await oms.media.dataUrl(song.compressed_audio_media_id);
 * } catch (error) {
 *   if (!isMediaMissing(error)) throw error;
 *   // 404 is ambiguous. Ask something that CAN answer 401 before believing it.
 *   await oms.account.me(); // throws OmsAuthError 401 on a dead session
 *   markArtworkUnavailable(song); // only now is "gone" a fair conclusion
 * }
 * ```
 */
export function isMediaMissing(error: unknown): boolean {
  return error instanceof OmsApiError && error.status === 404;
}

/**
 * The first media id in the list that is actually present, or `null`.
 *
 * Every music record offers the same choice twice over: a compressed twin and
 * an original, either of which may be `null`. The compressed one is what a
 * client should reach for - the originals are lossless files and an album
 * grid that asks for them takes seconds per tile.
 *
 * ```ts
 * const artwork = firstMediaId(song.compressed_artwork_media_id, song.artwork_media_id);
 * const audio = firstMediaId(song.compressed_audio_media_id, song.audio_media_id);
 * ```
 *
 * Empty strings are treated as absent: the field is `null` when there
 * is no attachment, but a form round-trip through a URL or a database can turn
 * that into `""`, and an empty id would build a request for `/media//data`.
 */
export function firstMediaId(...ids: readonly (MediaId | null | undefined)[]): MediaId | null {
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * The bearer token the transport would send, or `null` when there is none -
 * which for a working client means it is in cookie mode.
 *
 * Read off `ApiClient` through a defensive probe, the same way `tickets.ts` and
 * `social.ts` do and for the same reason: the provider is private, `http.ts` is
 * shared by every namespace, and this need is not worth growing the transport a
 * new public member for. A probe that finds nothing degrades to `null`, which
 * is the safe answer in both places it is used here - a URL with no credential
 * rather than a wrong one, and the CORS explanation rather than a swallowed
 * error.
 */
async function tokenOf(http: ApiClient): Promise<string | null> {
  const provider = (http as unknown as { tokens?: { getToken(): string | null | Promise<string | null> } }).tokens;
  if (provider === undefined || typeof provider.getToken !== "function") return null;
  try {
    return (await provider.getToken()) ?? null;
  } catch {
    return null;
  }
}
