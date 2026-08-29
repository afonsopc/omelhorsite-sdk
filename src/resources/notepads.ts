/**
 * The `notepads` namespace: anonymous shared scratch pads.
 *
 * A pad is addressed by its slug and by nothing else. `Notepad.viewable_by`
 * returns `none` by construction and the blueprint strips the numeric `id` from
 * every view, precisely so that nobody can walk primary keys into other
 * people's pads. Knowing the slug IS the whole authorisation story: anyone
 * holding it can read AND rewrite the pad.
 *
 * So treat a slug as a bearer secret. Do not log it, do not put it in a URL you
 * paste somewhere, and do not put anything in a pad you would mind a stranger
 * reading - the slugs the server mints come from `Faker::Internet.unique.slug`,
 * which is word-shaped and short.
 *
 * Pads that are still empty an hour after their last write are swept away by a
 * background job.
 */

import { Resource } from "../http";
import type { RequestOptions, Timestamp } from "../types";

/**
 * A shared notepad.
 *
 * There is no `id`: the blueprint excludes it from the default view AND from
 * `:extended`, so this is one of the very few records in the API that does not
 * extend `BaseRecord`. The slug is the identifier.
 */
export interface Notepad {
  /** Word-shaped capability, e.g. `"quick-brown-fox"`. Treat it as a secret. */
  readonly slug: string;
  /**
   * The whole document. Empty string, never `null`, for a fresh pad: the
   * column is `NOT NULL DEFAULT ''`.
   */
  readonly content: string;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /**
   * Endpoint of the `n/` short link the backend keeps pointing at this pad,
   * so `https://omelhor.site/n/<endpoint>` opens it in the web tool.
   *
   * Only {@link NotepadsNamespace.showOrCreate} sends this field;
   * {@link NotepadsNamespace.update} answers with the bare record.
   */
  readonly short_link_endpoint?: string;
}

/** Arguments for {@link NotepadsNamespace.showOrCreate}. */
export interface OpenNotepadInput {
  /**
   * Slug to open. Omit it to mint a brand new pad - that branch is throttled
   * per IP, so never omit it in a loop and never omit it just to poll.
   */
  readonly slug?: string;
}

/** The `notepads` namespace, reachable as `oms.notepads`. */
export class NotepadsNamespace extends Resource {
  /**
   * `GET /notepads/show_or_create` - opens the pad with this slug, creating it
   * if no pad has that slug yet.
   *
   * Fully anonymous: no credential is sent, none is needed, and one would not
   * change the answer.
   *
   * Two very different calls share this one route, and they have different
   * costs:
   *
   * - **with a slug** it is a plain read, cheap and unthrottled beyond the
   *   general ceiling. This is the call a poller makes;
   * - **without a slug** it MINTS a row, and minting is capped at **20 pads
   *   per hour per IP** by a counter inside the controller (deliberately not in
   *   rack-attack, so that polling reads do not spend the budget). Over the cap
   *   the answer is `429` with the body `{"error":"rate_limited"}` and **no**
   *   `Retry-After` header, which arrives here as an {@link OmsQuotaError}
   *   whose `retryAfterMs` is `undefined`. Waiting is the only cure; there is
   *   nothing to read off the response.
   *
   * Retries are disabled for the mint branch: every attempt would generate a
   * DIFFERENT random slug, so a retry after a lost response leaves an orphan
   * pad behind and hands you the wrong one. The read branch keeps the client's
   * normal retry policy.
   *
   * @throws {OmsQuotaError} 429 when the per-IP creation budget is spent.
   */
  async showOrCreate(input: OpenNotepadInput = {}, options: RequestOptions = {}): Promise<Notepad> {
    const minting = input.slug === undefined;
    return this.http.get<Notepad>("/notepads/show_or_create", {
      ...(minting ? { retry: false } : {}),
      ...options,
      ...(minting ? {} : { query: { slug: input.slug } }),
    });
  }

  /**
   * `PATCH /notepads/:slug` - replaces the whole content.
   *
   * The `:id` path segment is the SLUG, not a database id; the controller looks
   * the pad up by slug and then requires that same slug back as proof the
   * caller was handed the pad rather than guessing at it.
   *
   * There is no diff and no merge: the last write wins, and two editors will
   * clobber each other silently. A host that wants collaborative editing has to
   * reconcile before calling. `content` is the only writable field.
   *
   * @throws {OmsApiError} 404 when no pad has that slug. Note the asymmetry
   *   with {@link showOrCreate}, which would have created it.
   */
  async update(slug: string, content: string, options: RequestOptions = {}): Promise<Notepad> {
    // A slug with a slash or a dot would be eaten by Rails' path parsing, so
    // encode it; the server-minted ones are always word-and-hyphen shaped.
    return this.http.patch<Notepad>(`/notepads/${encodeURIComponent(slug)}`, { content }, options);
  }
}
