/** The `movies.watchProgress` area: how far into each title the user got, and what "Continuar a ver" is built from. */

import { Resource } from "../../http";
import { OmsError } from "../../errors";
import type { BaseRecord, Id, RequestOptions, Timestamp } from "../../types";
import type { MovieType } from "./types";
import { assertPresent, pickOptional } from "./types";

/**
 * Fraction of the runtime that counts as watched when the server derives
 * `finished` itself.
 */
export const MOVIE_WATCH_FINISHED_THRESHOLD = 0.95;

/**
 * Rows `POST /movie_watch_progresses/bulk` will accept in one call.
 *
 * The server keeps the first 200 entries: the rest are dropped in SILENCE and
 * the call still answers `200` with the 200 rows it did save, so a client
 * marking a 300-episode series watched would believe it succeeded.
 * {@link MovieWatchProgressesNamespace.saveMany} raises instead.
 */
export const MOVIE_WATCH_BULK_LIMIT = 200;

/**
 * Rows `GET /movie_watch_progresses` returns, at most. Hard-coded, with no
 * paging and no way to reach row 501 - see
 * {@link MovieWatchProgressesNamespace.list}.
 */
export const MOVIE_WATCH_LIST_LIMIT = 500;

/** One title-or-episode the user has started, and how far in they got. */
export interface MovieWatchProgress extends BaseRecord {
  readonly user_id: Id;
  readonly movie_type: MovieType;
  /** The addon's id for the TITLE. A series shares it across every episode. */
  readonly movie_id: string;
  /**
   * The addon's id for the specific playable. For a film this is usually the
   * same string as `movie_id`; for a series it is the episode.
   *
   * `(user_id, movie_id, video_id)` is the row's identity and carries a unique
   * index.
   */
  readonly video_id: string;
  readonly season: number | null;
  readonly episode: number | null;
  readonly name: string | null;
  readonly episode_title: string | null;
  readonly poster: string | null;
  /** Seconds into the playable. A float, `NOT NULL DEFAULT 0.0`. */
  readonly position: number;
  /** Runtime in seconds, as the player measured it. `0` when unknown. */
  readonly duration: number;
  /** See {@link MovieWatchProgressInput.finished} for how this gets its value. */
  readonly finished: boolean;
  /** What "Continuar a ver" sorts on, descending. */
  readonly last_watched_at: Timestamp;
}

/**
 * One row to upsert, through {@link MovieWatchProgressesNamespace.save} or
 * {@link MovieWatchProgressesNamespace.saveMany}.
 *
 * `movie_id`, `video_id` and `movie_type` are checked up front and a missing
 * one is `400 "movie_id, video_id, movie_type are required"`. Everything else
 * is optional, but read the notes on `finished` and `last_watched_at` before
 * leaving them out: both are cases where omitting the field does something
 * other than "leave it as it was".
 */
export interface MovieWatchProgressInput {
  readonly movie_type: MovieType;
  /** Identity, with `video_id`. Changing `movie_type` does NOT make a new row. */
  readonly movie_id: string;
  /** Identity, with `movie_id`. */
  readonly video_id: string;
  readonly season?: number | null;
  readonly episode?: number | null;
  readonly name?: string | null;
  readonly episode_title?: string | null;
  readonly poster?: string | null;
  /** Seconds into the playable. Negative is `400 "Position must be greater than or equal to 0"`. */
  readonly position?: number;
  /** Runtime in seconds. Negative is a `400` the same way. */
  readonly duration?: number;
  /**
   * Three states, not two.
   *
   * - **omitted** - the server derives it:
   *   `finished = position >= duration * 0.95`, and if `duration <= 0` it
   *   leaves the stored flag ALONE. This is what a playback tick should send.
   * - **`true` / `false`** - the user said so. The value is written as given,
   *   even when `duration <= 0`.
   * - **`null`** - dropped before it is read, and therefore identical to
   *   omitting it.
   *
   * That last branch is the bug that was fixed here. "Marcar como nao visto"
   * sends `position: 0, duration: 0`, which used to hit the `duration <= 0`
   * guard and leave `finished` true forever. Sending an explicit `false` is
   * what makes it stick - sending `null`, or leaving the key out, still does
   * nothing at all. {@link MovieWatchProgressesNamespace.setWatched} spells it
   * out so you cannot get this wrong by accident.
   *
   * An explicit value only pins the flag for THAT save. The next tick that
   * omits `finished` goes back to deriving it from the position.
   */
  readonly finished?: boolean;
  /**
   * When the user last watched, ISO-8601.
   *
   * SEND IT ON EVERY CALL. It is only defaulted when the row is first
   * created - so an upsert that omits it keeps whatever timestamp was there
   * when the row was first created. The Continue Watching list is ordered by
   * it, descending, so omitting this pins the title where it first appeared
   * and it never moves back to the front. `new Date().toISOString()` at the
   * call site is the whole fix.
   */
  readonly last_watched_at?: Timestamp;
}

/**
 * The same arithmetic the server uses, for a client that wants to render a
 * "watched" tick before the round trip lands.
 *
 * Returns `null` - not `false` - when `duration` is zero or negative, because
 * that is precisely the case where the server declines to decide and leaves the
 * stored flag untouched. Treating that as `false` is how an optimistic UI ends
 * up un-ticking something the server still considers watched.
 */
export function movieWatchFinished(position: number, duration: number): boolean | null {
  if (!(duration > 0)) return null;
  return position >= duration * MOVIE_WATCH_FINISHED_THRESHOLD;
}

/**
 * The `movies.watchProgress` namespace: how far into each title the user got,
 * and what "Continuar a ver" is built from.
 *
 * This family is the odd one out: none of the list DSL applies, `create`
 * answers `200`, and there is no `show` and no `update`. Everything is an
 * upsert keyed on `(user, movie_id, video_id)`.
 */
export class MovieWatchProgressesNamespace extends Resource {
  /**
   * `GET /movie_watch_progresses` - the caller's rows, newest first.
   *
   * Not paginated, and not filterable. The query string is ignored entirely
   * and the answer is always the 500 most recently watched rows, so:
   *
   * - there is NO way to reach row 501. A user with more history than that
   *   simply cannot read the tail through this API;
   * - `search[...]` / `exact_search[...]` / `modifiers[...]` are not rejected,
   *   they are silently ignored - this index never raises
   *   `400 "Unknown search filter"`. A client that thinks it asked for one
   *   title gets all 500 rows and, if it trusts the filter, the wrong answer.
   *   Filter client-side; that is why this method takes no params;
   * - there is no `ETag` either.
   *
   * Finished rows are included. Build "Continuar a ver" by dropping
   * `finished === true` yourself, and remember an episode can be finished while
   * its series is not.
   *
   * @throws {OmsApiError} 401 for an anonymous caller, 403 for an OAuth token.
   */
  async list(options: RequestOptions = {}): Promise<MovieWatchProgress[]> {
    return this.http.get<MovieWatchProgress[]>("/movie_watch_progresses", options);
  }

  /**
   * `POST /movie_watch_progresses` - upserts ONE row. **`200`, not `201`.**
   *
   * This is the playback tick: call it while something is playing, throttled
   * by the player to whatever interval you like. The server finds by
   * `(user, movie_id, video_id)` and updates in place, so it is idempotent and
   * safe to repeat - the only create in this file where opting into
   * `options.retry` is a good idea rather than a way to make duplicates.
   * (The transport does not replay non-safe methods unless you ask.)
   *
   * `movie_type` is NOT part of the key. Posting the same `(movie_id,
   * video_id)` with a different type rewrites the existing row's type rather
   * than creating a second one.
   *
   * Read {@link MovieWatchProgressInput.finished} and
   * {@link MovieWatchProgressInput.last_watched_at} before using this: a tick
   * that omits `last_watched_at` does not move the title up the list, and
   * `finished` has three states rather than two. A `finished` of `null` is
   * dropped by this method rather than sent, matching what the server would do
   * with it, so `finished` reaches the wire only as a real boolean.
   *
   * Use {@link saveMany} instead when you have more than a couple of rows -
   * see its docs for why one request is not just faster but differently shaped.
   *
   * @throws {OmsError} `invalid_request` when `movie_id`, `video_id` or
   *   `movie_type` is blank.
   * @throws {OmsApiError} 400 `"movie_id, video_id, movie_type are required"`
   *   from the server's own check, or a validation sentence such as
   *   `"Position must be greater than or equal to 0"`.
   */
  async save(
    input: MovieWatchProgressInput,
    options: RequestOptions = {},
  ): Promise<MovieWatchProgress> {
    return this.http.post<MovieWatchProgress>(
      "/movie_watch_progresses",
      watchProgressBody(input),
      options,
    );
  }

  /**
   * `POST /movie_watch_progresses/bulk` - upserts up to
   * {@link MOVIE_WATCH_BULK_LIMIT} rows in ONE request and ONE transaction.
   * `200`, with the saved rows in the order sent.
   *
   * ## Why this endpoint exists, and when to reach for it
   *
   * "Marcar temporada como vista" is one row per episode. A 24-episode season
   * through {@link save} is 24 POSTs: 24 round trips, 24 chances for one to
   * fail and leave the season half-marked, and 24 requests against the
   * caller's 600/min ceiling. This collapses it into one.
   *
   * The transaction is the other half of the point, and it cuts both ways:
   *
   * - **use {@link saveMany}** for a statement about several rows at once that
   *   must be all-or-nothing - mark a season watched or unwatched, restore a
   *   device's offline queue, seed history on first sync. If any entry is
   *   invalid the whole batch rolls back and answers `400`, so you never end up
   *   with episodes 1-9 marked and 10-24 not.
   * - **use {@link save}** for the continuous playback tick. One row, and a
   *   failure costs one tick that the next one will overwrite anyway. Batching
   *   ticks would trade a lost second for a lost minute.
   *
   * ## The silent-truncation trap this method closes
   *
   * The server keeps the first 200 entries: the rest are dropped without a
   * word and the response is a cheerful `200` listing the 200 that were saved.
   * A 300-episode batch would look like it worked. This method raises before
   * sending instead, so split the work yourself - and note that separate
   * batches are separate transactions, so a split is no longer atomic end to
   * end.
   *
   * Retrying the whole batch is safe: every entry is the same upsert
   * {@link save} performs.
   *
   * @throws {OmsError} `invalid_request` for an empty list, for more than
   *   {@link MOVIE_WATCH_BULK_LIMIT} entries, or for an entry missing
   *   `movie_id`, `video_id` or `movie_type`.
   * @throws {OmsApiError} 400 `"items is required"` for an empty list that got
   *   through, or the first failing entry's validation sentence - and in that
   *   case NOTHING was saved.
   */
  async saveMany(
    inputs: readonly MovieWatchProgressInput[],
    options: RequestOptions = {},
  ): Promise<MovieWatchProgress[]> {
    if (inputs.length === 0) {
      throw new OmsError("saveMany needs at least one entry.", "invalid_request");
    }
    if (inputs.length > MOVIE_WATCH_BULK_LIMIT) {
      throw new OmsError(
        `saveMany takes at most ${MOVIE_WATCH_BULK_LIMIT} entries; got ${inputs.length}. The server would silently drop the rest and still answer 200, so split the batch yourself.`,
        "invalid_request",
      );
    }
    return this.http.post<MovieWatchProgress[]>(
      "/movie_watch_progresses/bulk",
      { items: inputs.map(watchProgressBody) },
      options,
    );
  }

  /**
   * Marks one playable watched or unwatched, explicitly.
   *
   * Sugar over {@link save} that exists because this is the exact call the
   * fixed bug was about. Marking something UNWATCHED sends `position: 0,
   * duration: 0`, and with `finished` absent the server's `duration <= 0`
   * guard leaves the stored flag as it was - so the tick never came off.
   * Passing the boolean outright skips that guard and writes what you said.
   *
   * Defaults `position` and `duration` to `0` when you do not supply them,
   * which is right for "mark unwatched" and harmless for "mark watched"
   * precisely because the explicit flag stops the server deriving anything from
   * them. Supply the real numbers when you have them; the progress bar reads
   * them.
   *
   * `last_watched_at` is still yours to send, and still matters: marking an
   * episode watched without one leaves the series where it was in the list.
   */
  async setWatched(
    input: Omit<MovieWatchProgressInput, "finished">,
    watched: boolean,
    options: RequestOptions = {},
  ): Promise<MovieWatchProgress> {
    return this.save(
      { position: 0, duration: 0, ...input, finished: watched },
      options,
    );
  }

  /**
   * `DELETE /movie_watch_progresses/:id` - forgets ONE playable. `204`, empty
   * body.
   *
   * The id is the progress row's primary key, which for a series is one
   * episode. To forget a whole title use {@link forgetMovie}.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` for a row that is not
   *   yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(
      `/movie_watch_progresses/${encodeURIComponent(id)}`,
      options,
    );
  }

  /**
   * `DELETE /movie_watch_progresses/for_movie?movie_id=...` - forgets EVERY row
   * for a title. `204`, empty body.
   *
   * This is the "remover de Continuar a ver" button. For a series it destroys
   * the progress of every episode, not just the one on screen; there is no
   * per-season form and no undo.
   *
   * Note the verb: despite the `?movie_id=` query string this is a **DELETE**,
   * not a read. It is a collection route, so the `movie_id` is the addon's id
   * for the title (an IMDb id, say), never a `movie_watch_progresses` primary
   * key.
   *
   * `204` even when nothing matched, so the answer does not tell you whether
   * anything was there.
   *
   * @throws {OmsError} `invalid_request` for a blank id.
   * @throws {OmsApiError} 400 `"movie_id is required"`.
   */
  async forgetMovie(movieId: string, options: RequestOptions = {}): Promise<void> {
    assertPresent("movie_id", movieId);
    await this.http.delete<void>("/movie_watch_progresses/for_movie", {
      ...options,
      query: { movie_id: movieId },
    });
  }
}

/**
 * Builds the body for one watch-progress upsert.
 *
 * `finished` is only forwarded when it is a real boolean. A `null` would be
 * dropped by the server anyway, so dropping it here keeps the wire honest
 * about what the server will act on.
 */
function watchProgressBody(input: MovieWatchProgressInput): Record<string, unknown> {
  assertPresent("movie_type", input.movie_type);
  assertPresent("movie_id", input.movie_id);
  assertPresent("video_id", input.video_id);
  const body: Record<string, unknown> = {
    movie_type: input.movie_type,
    movie_id: input.movie_id,
    video_id: input.video_id,
    ...pickOptional(input, [
      "season",
      "episode",
      "name",
      "episode_title",
      "poster",
      "position",
      "duration",
      "last_watched_at",
    ]),
  };
  if (typeof input.finished === "boolean") body.finished = input.finished;
  return body;
}
