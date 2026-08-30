/** The Space Invaders leaderboard. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../listing";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../types";

/** `GET /space_invaders_games` filters on {@link BASE_FILTER_COLUMNS} only; there is no player filter. */
export const SPACE_INVADERS_GAME_FILTER_COLUMNS = Object.freeze([] as const);

/** Filters for {@link SpaceInvadersNamespace.list}. */
export type ListSpaceInvadersGamesParams = ListParams<(typeof SPACE_INVADERS_GAME_FILTER_COLUMNS)[number]>;

/** Primary key of a leaderboard entry. An INTEGER. */
export type SpaceInvadersGameId = number;

/** Points a single kill can be worth. Mirrors `MAX_POINTS_PER_KILL`. */
export const SPACE_INVADERS_MAX_POINTS_PER_KILL = 10;

/** Kills per second the validator will believe. Mirrors `MAX_KILLS_PER_SECOND`. */
export const SPACE_INVADERS_MAX_KILLS_PER_SECOND = 1;

/** Longest session the validator accepts, in seconds. 24 hours. */
export const SPACE_INVADERS_MAX_SESSION_SECONDS = 24 * 60 * 60;

/** Rows the leaderboard returns. Mirrors the `leaderboard` scope's `limit`. */
export const SPACE_INVADERS_LEADERBOARD_SIZE = 100;

/**
 * One finished game.
 *
 * ## `money` and `time` are STRINGS
 *
 * They are `decimal` columns with no precision or scale, and Rails encodes
 * `BigDecimal` as a JSON string on purpose - a JSON number would be parsed as
 * a float by most clients and silently lose precision. So the wire carries
 * `"1200.0"`, not `1200`. `kills` is an `integer` column right next to them
 * and arrives as a real number.
 *
 * Anything that sorts, sums or compares these must `Number()` them first;
 * `"9.0" > "10.0"` is `true` in JavaScript.
 */
export interface SpaceInvadersGame {
  readonly id: SpaceInvadersGameId;
  /** The player. A STRING id. */
  readonly user_id: Id;
  /** Score. A decimal serialised as a STRING - see the interface docs. */
  readonly money: string;
  /** Session length in seconds. Also a decimal serialised as a STRING. */
  readonly time: string;
  /** Enemies killed. An integer, and a real JSON number. */
  readonly kills: number;
  /**
   * When the game ended. Stamped SERVER-side from `Time.current` in a
   * `before_create`, and deliberately not accepted from the request body, so a
   * client cannot back-date or future-date an entry. Sending it is ignored.
   */
  readonly played_at: Timestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/**
 * Arguments for {@link SpaceInvadersNamespace.submit}.
 *
 * All three are required and all three are validated against each other. The
 * bounds mirror `frontend/public/spaceinvaders/config.json` and are documented
 * in the model as what they are: not anti-cheat, just a rejection of scores
 * that are impossible under the game's own rules. The score is
 * client-authoritative, so anybody willing to call this endpoint by hand can
 * post any score inside the bounds.
 */
export interface SubmitSpaceInvadersGameInput {
  /**
   * Score. Must be `>= 0` and no greater than
   * `kills * {@link SPACE_INVADERS_MAX_POINTS_PER_KILL}`, or the call is
   * `400 "Money is impossibly high for N kills"`.
   */
  readonly money: number;
  /**
   * Session length in seconds. Must be `>= 0` and
   * `<= {@link SPACE_INVADERS_MAX_SESSION_SECONDS}`.
   */
  readonly time: number;
  /**
   * Enemies killed. Must be a non-negative integer and no greater than
   * `ceil(time * {@link SPACE_INVADERS_MAX_KILLS_PER_SECOND})`, or the call is
   * `400 "Kills are impossibly high for a Ns game"`.
   */
  readonly kills: number;
}

/**
 * The `space_invaders_games` namespace: the leaderboard for the embedded game.
 *
 * The only genuinely public thing here is {@link leaderboard}. Submitting
 * needs a session, and so - oddly - does {@link list}.
 */
export class SpaceInvadersNamespace extends Resource {
  /**
   * `GET /space_invaders_games/leaderboard` - the top
   * {@link SPACE_INVADERS_LEADERBOARD_SIZE} scores, highest `money` first.
   *
   * Anonymous callers welcome. Not the list DSL: no paging, no filters, no
   * ordering - `order(money: :desc).limit(100)` is the whole query, and it is
   * backed by a descending index on `money`.
   *
   * One row per GAME, not per player: a player who posts three good runs
   * occupies three slots. Deduplicate client-side if you want a per-player
   * board.
   *
   * The rows carry `user_id` and nothing else about the player - no handle, no
   * avatar - so a board with names needs a separate lookup.
   */
  async leaderboard(options: RequestOptions = {}): Promise<SpaceInvadersGame[]> {
    return this.http.get<SpaceInvadersGame[]>("/space_invaders_games/leaderboard", options);
  }

  /**
   * `GET /space_invaders_games` - every game ever recorded, paged.
   *
   * `viewable_by` is `all`, so any signed-in caller enumerates the whole
   * table, everybody's runs included. It needs a session even though
   * {@link leaderboard} does not, which is the wrong way round if you were
   * expecting the listing to be the public one.
   *
   * **You cannot filter by player.** The controller declares only
   * `create_params`, so the search allowlist is the three defaults - `id`,
   * `created_at`, `updated_at`. `exact_search: { user_id: "..." }` is
   * `400 "Unknown exact_search filter: user_id"`. To show one player's
   * history, page and filter client-side, or use `order: "money:desc"` and
   * stop early.
   *
   * No default ordering, so pass one. Sends an `ETag`.
   */
  async list(params: ListSpaceInvadersGamesParams = {}, options: RequestOptions = {}): Promise<Paginated<SpaceInvadersGame>> {
    return paginate(params, 100, (at) =>
      this.http.get<SpaceInvadersGame[]>("/space_invaders_games", { ...options, query: listQuery(params, at) }),
    );
  }

  /**
   * `POST /space_invaders_games` - records a finished run. `201`.
   *
   * The player is taken from the session and `played_at` is stamped
   * server-side; neither can be supplied. Any signed-in user may submit.
   *
   * Every submission is a new row, so a retry after a lost response posts the
   * run twice and both appear on the leaderboard. The transport does not
   * replay a `POST` by default, and this is an endpoint where you should not
   * ask it to.
   *
   * There is no per-user rate limit beyond the general 600/min, and no
   * de-duplication: two identical runs are two rows.
   *
   * @throws {OmsApiError} 400 with the validation sentence when the score
   *   fails the plausibility bounds - see {@link SubmitSpaceInvadersGameInput};
   *   401 without a session.
   */
  async submit(
    input: SubmitSpaceInvadersGameInput,
    options: RequestOptions = {},
  ): Promise<SpaceInvadersGame> {
    return this.http.post<SpaceInvadersGame>("/space_invaders_games", input, options);
  }

  /**
   * `DELETE /space_invaders_games/:id` - removes an entry. `204`.
   *
   * The player who set it, or an admin. Anybody else gets
   * `401 "You are not authorized to destroy this resource"` - and note it is a
   * 401 rather than a 404, because `viewable_by` is `all` and the lookup
   * succeeds before the authorisation check.
   *
   * There is no update route: the resource is declared
   * `only: [:create, :index, :destroy]`, so a score can be deleted but never
   * edited.
   */
  async destroy(id: SpaceInvadersGameId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/space_invaders_games/${encodeURIComponent(String(id))}`, options);
  }
}
