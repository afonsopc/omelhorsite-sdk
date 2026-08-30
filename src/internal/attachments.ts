/** Attachment helpers shared by the message families. Not part of the public surface. */

import { OmsError, OmsNetworkError } from "../errors";
import type { ApiClient, TokenProvider } from "../http";
import type { FileInput, NativeFile, RequestOptions } from "../types";
import { isNativeFile } from "../types";

/**
 * Byte length of an attachment, when it is knowable without reading anything.
 * `undefined` for a stream with no declared `size` and for a picker that
 * reported none.
 */
export function attachmentSize(file: FileInput | NativeFile): number | undefined {
  if (isNativeFile(file)) return file.size;
  if (typeof file.size === "number") return file.size;
  const data = file.data;
  if (isNativeFile(data)) return data.size;
  if (typeof Blob === "function" && data instanceof Blob) return data.size;
  if (data instanceof Uint8Array) return data.byteLength;
  return undefined;
}

/**
 * Follows an attachment redirect. In a browser in cookie mode the redirect
 * to object storage fails CORS and surfaces as a bare network error; that
 * case is turned into an error that says what to do instead.
 */
export async function followAttachment(
  http: ApiClient,
  path: string,
  what: string,
  options: RequestOptions,
): Promise<Blob> {
  try {
    const response = await http.raw("GET", path, options);
    return await response.blob();
  } catch (thrown) {
    if (thrown instanceof OmsNetworkError && (await tokenOf(http)) === null) {
      throw new OmsError(
        `The ${what} attachment redirect could not be followed. In a browser, a client built with ` +
          "`sessionCookie: true` sends credentials, the 302 to object storage arrives there with " +
          "`Origin: null`, and the store answers a wildcard `Access-Control-Allow-Origin` - which CORS " +
          "forbids for a credentialed request. Use the matching `attachmentUrl(...)` and put the URL in an " +
          "<img>, a <video> or an <a download> instead: those follow the redirect with no CORS check.",
        "unsupported",
        { method: "GET", url: http.url(path), cause: thrown },
      );
    }
    throw thrown;
  }
}

/** The bearer token the transport would send, or `null` when there is none (cookie mode). */
export async function tokenOf(http: ApiClient): Promise<string | null> {
  const provider = (http as unknown as { tokens?: TokenProvider }).tokens;
  if (provider === undefined || typeof provider.getToken !== "function") return null;
  try {
    return (await provider.getToken()) ?? null;
  } catch {
    return null;
  }
}
