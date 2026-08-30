/** What direct messages and group chats share: the attachment kind, the caps both message families obey, and the helpers behind them. */

import { OmsError, OmsNetworkError } from "../../errors";
import type { ApiClient, TokenProvider } from "../../http";
import type { FileInput, NativeFile, RequestOptions, Timestamp } from "../../types";
import { isNativeFile } from "../../types";

/* -------------------------------------------------------------------------- */
/* Limits the server enforces                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 25 MiB, for a direct message and a group chat message alike, checked before
 * anything is attached.
 *
 * IMAGES HAVE A LOWER, WORSE-BEHAVED CEILING. See
 * {@link MESSAGE_IMAGE_MAX_BYTES}.
 */
export const MESSAGE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Fifteen minutes from `created_at`, for a direct message and a group chat
 * message alike, after which an edit is `401`.
 *
 * Measured against the SERVER's clock. {@link canEditMessage} compares against
 * the caller's, which is close enough to grey out a button and not close
 * enough to promise the edit will land.
 */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/** How the server classified an attachment, from its `content_type`. */
export type AttachmentKind = "image" | "audio" | "video" | "file";

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether a message is still inside its edit window, for greying out a button.
 *
 * Measured against the CALLER's clock, and the server measures against its own,
 * so this is an approximation that gets less honest the further the two drift.
 * Always handle the `401` as well; do not treat `true` here as a promise that
 * the edit will land, and do not treat `false` as a reason to skip the call if
 * the user insists.
 *
 * Takes `now` so the function stays pure and the module stays isolate-safe -
 * no `Date.now()` at module scope, and a caller can pass a server-derived
 * clock if it has one.
 */
export function canEditMessage(
  message: { created_at: Timestamp },
  now: number = new Date().getTime(),
): boolean {
  const created = new Date(message.created_at).getTime();
  if (Number.isNaN(created)) return false;
  return now - created <= MESSAGE_EDIT_WINDOW_MS;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Fails fast on a value the server would answer for with a framework error. */
export function assertPresent(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OmsError(`${field} is required and cannot be blank.`, "invalid_request");
  }
}

/**
 * Byte length of an attachment, when it is knowable without reading anything.
 *
 * Deliberately `undefined` rather than zero for a `ReadableStream` with no
 * declared `size` and for a picker that reported none: buffering a file just to
 * measure it would cost more than the server's 400.
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
 * Follows an attachment redirect and turns the browser-in-cookie-mode CORS
 * failure into an error that explains itself.
 *
 * The redirect to object storage arrives with `Origin: null` on a credentialed
 * request and the store answers a wildcard `Access-Control-Allow-Origin`, which
 * CORS forbids. That reaches us as a bare `fetch` rejection, indistinguishable
 * from a real network fault and already retried three times by the transport.
 * Only the client's SHAPE tells the two apart: no bearer token means cookie
 * mode, which means a browser.
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

/**
 * The bearer token the transport would send, or `null` when there is none -
 * which for a working client means it is in cookie mode.
 *
 * Read off `ApiClient` through a defensive probe, the same way `tickets.ts`
 * does and for the same reason: the provider is private, `http.ts` is shared,
 * and neither of these two needs is worth growing the transport a new public
 * member for. A probe that finds nothing degrades to `null`, which is the safe
 * answer in both places it is used - a URL with no credential rather than a
 * wrong one, and the CORS explanation rather than a swallowed error.
 */
export async function tokenOf(http: ApiClient): Promise<string | null> {
  const provider = (http as unknown as { tokens?: TokenProvider }).tokens;
  if (provider === undefined || typeof provider.getToken !== "function") return null;
  try {
    return (await provider.getToken()) ?? null;
  } catch {
    return null;
  }
}
