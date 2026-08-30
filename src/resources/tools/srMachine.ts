/** The `tools.srMachine` namespace: fetch a track's audio, artwork and metadata by URL, and transcode audio to Opus. Administrators only. */

import { Resource, buildFormData, filenameFromDisposition } from "../../http";
import type { FileInput, FileOutput, NativeFile, RequestOptions } from "../../types";

/** What `GET /s_r_machine/metadata` answers. Two keys, both nullable. */
export interface SRMachineMetadata {
  readonly title: string | null;
  readonly artist: string | null;
}

/**
 * The SR Machine helpers, reachable as `oms.tools.srMachine`.
 *
 * ## Admin only, and the check is blunt
 *
 * Every route answers `403 "You SHALL NOT use this resource"` to anyone who is
 * not an administrator. There is no allowlist, no scope and no per-user
 * quota.
 *
 * ## What it is
 *
 * Four unrelated primitives left over from the "slowed + reverb" video tool:
 * fetch the artwork behind a URL, fetch its audio, read its title and artist,
 * and transcode an arbitrary audio blob to Opus. Nothing here touches the
 * library - no song is created, nothing is stored, and the bytes come back in
 * the response body. If you want a track IN the library, use
 * `oms.music.imports.create()` instead; this is the raw pipe.
 *
 * Three of the four fetch a caller-supplied URL and hold a server thread while
 * they do it, exactly like `oms.music.imports.previewPlaylist()` - but
 * they have no budget of their own, so the only ceiling is the general
 * 600/min. The admin gate is what stands in for a budget here. Do not build a
 * batch loop on top of these.
 *
 * A YouTube URL carrying `?list=` is truncated at the `?list=` before the fetch,
 * so a link copied from inside a playlist resolves to the single video rather
 * than the playlist. That happens server-side, in all three fetchers.
 *
 * All three fetchers respond with `Content-Disposition: attachment` and a
 * fixed filename (`artwork.jpg`, `audio.opus`), so `FileOutput.filename` is
 * that constant rather than anything derived from the source.
 */
export class SRMachineNamespace extends Resource {
  /**
   * `GET /s_r_machine/metadata` - the title and artist read off a URL.
   *
   * Both keys can be `null` for a source that carries no tags; it is a
   * best-effort read, not a lookup.
   *
   * Not retried by default: it parks a server thread for up to 60 seconds,
   * and a failure means the source refused.
   *
   * @throws {OmsAuthError} 403 `"You SHALL NOT use this resource"` for a
   *   non-admin.
   * @throws {OmsApiError} 400 `"url is not allowed"` for a URL that is not
   *   public http(s); 500 when the fetch itself fails - an upstream failure
   *   surfaces as a server error here, not as a 502.
   */
  async metadata(url: string, options: RequestOptions = {}): Promise<SRMachineMetadata> {
    return this.http.get<SRMachineMetadata>("/s_r_machine/metadata", {
      timeoutMs: 120_000,
      ...options,
      query: { url },
      retry: options.retry ?? false,
    });
  }

  /**
   * `GET /s_r_machine/artwork` - the cover behind a URL, as `image/jpeg`.
   *
   * Buffered fully into memory in every runtime, React Native included. It is a
   * cover, so that is fine; {@link SRMachineNamespace.audio} is where it is not.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   * @throws {OmsApiError} 400 `"url is not allowed"`; 500 on a fetch failure.
   */
  async artwork(url: string, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download("/s_r_machine/artwork", {
      timeoutMs: 120_000,
      ...options,
      query: { url },
      retry: options.retry ?? false,
    });
  }

  /**
   * `GET /s_r_machine/audio` - the audio behind a URL, as `audio/opus`.
   *
   * The whole track is downloaded server-side, held in memory there, and sent
   * back in one body which this then buffers into memory again on the client.
   * Nothing streams. On a phone that is a whole track in the JavaScript heap,
   * and there is no signed-URL alternative here the way there is for library
   * media - this endpoint has no storage node behind it. Reach for it on
   * desktop, think twice on React Native, and never for a batch.
   *
   * Generous `timeoutMs` by default because a long track legitimately takes
   * minutes.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   * @throws {OmsApiError} 400 `"url is not allowed"`; 500 on a fetch failure.
   */
  async audio(url: string, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download("/s_r_machine/audio", {
      timeoutMs: 600_000,
      ...options,
      query: { url },
      retry: options.retry ?? false,
    });
  }

  /**
   * `POST /s_r_machine/convert-opus` - transcode an audio file to Opus.
   *
   * Multipart, field name `file`, and the only method in this namespace that
   * uploads. The response is `audio/opus` bytes, not JSON.
   *
   * Works on all three runtimes: a React Native `{ uri, name, type }` descriptor
   * goes into the `FormData` verbatim and is streamed off disk by the native
   * layer, while a browser or Bun caller passes a `FileInput` carrying a Blob
   * or a `Uint8Array`. A `ReadableStream` is buffered first, because
   * `FormData` has no streaming entry.
   *
   * The upload has no client-side size cap here because the server declares
   * none - but the CDN in front of the API rejects a request body over roughly
   * 100 MB with a 413 that never reaches it. There is no chunked path for this
   * route, so a file above that simply cannot go through it.
   *
   * The server reads the whole part into memory before transcoding, so a large
   * input is a large allocation on both sides.
   *
   * @throws {OmsAuthError} 403 `"You SHALL NOT use this resource"` for a
   *   non-admin.
   * @throws {OmsApiError} 500 when no `file` part was sent or when the input
   *   cannot be transcoded. Neither is a graceful 400.
   * @throws {TypeError} when a React Native descriptor is passed on a runtime
   *   whose `FormData` is the web one, which would otherwise upload the literal
   *   text `"[object Object]"` and answer 500.
   */
  async convertToOpus(file: FileInput | NativeFile, options: RequestOptions = {}): Promise<FileOutput> {
    const form = await buildFormData({ file });
    const response = await this.http.raw("POST", "/s_r_machine/convert-opus", {
      timeoutMs: 600_000,
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
}
