/** What direct messages and group chats share: the attachment kind and the caps both message families obey. */

import type { Timestamp } from "../../types";

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

