/** Intel sources: the feeds you follow. */

import { Resource } from "../../../http";
import { listQuery, paginate } from "../../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../../listing";
import type { Id, Json, Paginated, RequestOptions, Timestamp } from "../../../types";

/** The three values a source's health can take. */
export const INTEL_SOURCE_HEALTHS = ["unknown", "ok", "error"] as const;

/** Health of a source's last run. `"unknown"` until it has ever run. */
export type IntelSourceHealth = (typeof INTEL_SOURCE_HEALTHS)[number];

/**
 * Consecutive failures after which a source flips `enabled` to `false` by
 * itself.
 *
 * Nothing turns it back on: a source that hit this stays off until someone
 * `update()`s `enabled` back to `true`. That is what
 * {@link IntelSource.consecutive_failures} is for - watch it, do not wait for
 * an alert.
 */
export const INTEL_SOURCE_DISABLE_AFTER_FAILURES = 20;

/**
 * A configured feed: a script plus the settings that script needs.
 *
 * A source is polled by `PollDispatcherJob` once every
 * {@link poll_interval_minutes}, and each poll writes {@link IntelItem} rows
 * that the analysis pipeline later turns into stories.
 */
export interface IntelSource {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Up to 200 characters, whitespace-trimmed by the model, unique per user. */
  readonly name: string;
  /**
   * The script's own settings - a URL, a channel, a CSS selector. There is no
   * schema: the backend permits `config: {}`, meaning an arbitrary object, and
   * the SCRIPT decides what it reads out of it. What belongs in here is
   * documented by the script, not by this API.
   */
  readonly config: Record<string, Json>;
  /** Which {@link IntelScript} fetches this source. */
  readonly intel_script_id: Id;
  /** Minutes between polls. Validated `in: 5..1440`. */
  readonly poll_interval_minutes: number;
  /**
   * Whether the dispatcher will poll it.
   *
   * Can flip to `false` WITHOUT anyone asking: see
   * {@link INTEL_SOURCE_DISABLE_AFTER_FAILURES}.
   */
  readonly enabled: boolean;
  /**
   * Incremental cursor the script returned last time - a timestamp, an etag, a
   * last-seen id, whatever that script uses. Opaque to everything but the
   * script. Writable, so clearing it is how you force a full re-fetch.
   */
  readonly cursor: string | null;
  /** Result of the last run. `"unknown"` until it has run once. */
  readonly health: IntelSourceHealth;
  /** Failure message from the last failed run, truncated to 1000 characters. */
  readonly last_error: string | null;
  /** When the source last ran, successfully or not. */
  readonly last_run_at: Timestamp | null;
  /** When it last SUCCEEDED. A gap between the two is the thing to alert on. */
  readonly last_success_at: Timestamp | null;
  /** Reset to 0 on any success. See {@link INTEL_SOURCE_DISABLE_AFTER_FAILURES}. */
  readonly consecutive_failures: number;
}

/** Filter columns of `GET /intel_sources`, on top of {@link BASE_FILTER_COLUMNS}. */
export const INTEL_SOURCE_FILTER_COLUMNS = Object.freeze(["name", "health", "enabled", "intel_script_id"] as const);

/** Filters for {@link IntelSourcesNamespace.list}. */
export interface ListIntelSourcesParams extends ListParams<(typeof INTEL_SOURCE_FILTER_COLUMNS)[number]> {
  /** Only healthy / only broken feeds. Sent as `exact_search[health]`. */
  readonly health?: IntelSourceHealth;
  /** Only enabled, or only the ones that switched themselves off. */
  readonly enabled?: boolean;
  /** Every source driven by one script. */
  readonly scriptId?: Id;
}

/** Arguments for {@link IntelSourcesNamespace.create}. */
export interface CreateIntelSourceInput {
  /** Up to 200 characters, and unique among YOUR sources - a clash is a 400. */
  readonly name: string;
  /**
   * The script that fetches it. Must be a built-in or one of yours;
   * `script_visible_to_owner` rejects anything else with
   * `400 "Intel script is not accessible"` rather than a 404, so this also
   * tells you the id exists. Do not use it as an existence oracle.
   */
  readonly intelScriptId: Id;
  /** Whatever that script reads. Free-form; the API validates nothing in it. */
  readonly config?: Record<string, Json>;
  /** 5-1440. Defaults to 15 server-side. */
  readonly pollIntervalMinutes?: number;
  /** Defaults to `true`. Create it disabled if you want to configure first. */
  readonly enabled?: boolean;
}

/**
 * Arguments for {@link IntelSourcesNamespace.update}.
 *
 * One key wider than the create form: `cursor` is updatable and not creatable.
 */
export interface UpdateIntelSourceInput {
  readonly name?: string;
  readonly intelScriptId?: Id;
  /**
   * REPLACES the whole object; there is no merge. `assign_attributes` writes
   * the JSON column wholesale, so sending `{ url: "..." }` to a source that
   * also had a `selector` drops the selector. Read the source, spread, write.
   */
  readonly config?: Record<string, Json>;
  readonly pollIntervalMinutes?: number;
  /** Set back to `true` to revive a source that disabled itself. */
  readonly enabled?: boolean;
  /**
   * The incremental cursor. Set it to `null` to force the next poll to start
   * from the beginning - which for most scripts means re-fetching everything.
   *
   * `null` here is a JSON body `null`, not the query-string sentinel: bodies
   * never carry `\b`.
   */
  readonly cursor?: string | null;
}

/** What `POST /intel_sources/:id/run` answers with. The whole body. */
export interface IntelSourceRunAccepted {
  /** Always `true`. The job was enqueued; nothing has been fetched yet. */
  readonly queued: boolean;
}

/**
 * `/intel_sources` - the feeds you have configured. Full CRUD, plus a manual
 * run.
 */
export class IntelSourcesNamespace extends Resource {
  /**
   * `GET /intel_sources` - your feeds.
   *
   * Declared filters: `name`, `health`, `enabled`, `intel_script_id`, plus the
   * inherited `id`, `created_at`, `updated_at`. The controller sets NO ordering
   * of its own, so a listing with no `order` is in whatever order Postgres
   * returns rows - which is not stable across pages. The SDK therefore sends
   * `created_at:desc` unless you say otherwise.
   *
   * A good health check in one call: `list({ health: "error" })`.
   *
   * @throws {OmsApiError} 403 outside the allowlist.
   */
  async list(params: ListIntelSourcesParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelSource>> {
    const base = {
      order: "created_at:desc",
      exactSearch: { health: params.health, enabled: params.enabled, intel_script_id: params.scriptId },
    };
    return paginate(params, 100, (at) =>
      this.http.get<IntelSource[]>("/intel_sources", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /intel_sources/:id`.
   *
   * There are no `:extended` extras, so this is exactly the shape a listing
   * row has. Fetching one adds nothing but a round trip;
   * prefer finding it in {@link list} when you already have the page.
   *
   * @throws {OmsApiError} 404 when the source is not yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelSource> {
    return this.http.get<IntelSource>(`/intel_sources/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /intel_sources` - configures a feed. `201`.
   *
   * The source starts `health: "unknown"` and is not polled immediately: the
   * dispatcher picks it up on its next pass, or you can force it with
   * {@link run}.
   *
   * Three ways this fails with a 400 and a bare-string body:
   *
   * - `"Name has already been taken"` - names are unique per user;
   * - `"Intel script is not accessible"` - the script is neither a built-in nor
   *   yours. This is a 400 rather than a 404, so it does not tell you whether
   *   the id exists;
   * - `"Source limit reached (N)"` - you are at
   *   {@link IntelConfig.max_sources}. Raise it with
   *   {@link IntelConfigNamespace.update} if the ceiling is yours to raise.
   *
   * Not retried by default: a replayed `POST` after a lost response would fail
   * the uniqueness check rather than duplicate the row, but it would report
   * that failure as if the first attempt had never worked.
   */
  async create(input: CreateIntelSourceInput, options: RequestOptions = {}): Promise<IntelSource> {
    return this.http.post<IntelSource>(
      "/intel_sources",
      {
        name: input.name,
        intel_script_id: input.intelScriptId,
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.pollIntervalMinutes === undefined ? {} : { poll_interval_minutes: input.pollIntervalMinutes }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /intel_sources/:id`.
   *
   * Note what is NOT writable: `health`, `last_error`, `last_run_at`,
   * `last_success_at` and `consecutive_failures` are not on `update_params`, so
   * you cannot clear a source's failure history by hand. Only a successful run
   * resets it (`register_success!`). Re-enabling a source that disabled itself
   * therefore leaves `consecutive_failures` at 20 until the next success - do
   * not read that field as "currently failing".
   *
   * {@link UpdateIntelSourceInput.config} replaces the whole object.
   *
   * @throws {OmsApiError} 404 when the source is not yours; 400 with the
   *   validation sentence otherwise.
   */
  async update(id: Id, input: UpdateIntelSourceInput, options: RequestOptions = {}): Promise<IntelSource> {
    return this.http.patch<IntelSource>(
      `/intel_sources/${encodeURIComponent(id)}`,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.intelScriptId === undefined ? {} : { intel_script_id: input.intelScriptId }),
        ...(input.config === undefined ? {} : { config: input.config }),
        ...(input.pollIntervalMinutes === undefined ? {} : { poll_interval_minutes: input.pollIntervalMinutes }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      options,
    );
  }

  /**
   * `DELETE /intel_sources/:id`. `204`, empty body.
   *
   * Destructive well beyond the row: `has_many :intel_items, dependent:
   * :destroy` takes every raw item this source ever produced, and the stories
   * built from them lose their citations
   * ({@link IntelArticleDetail.sources} shrinks, {@link IntelArticle.n_sources}
   * with it) while the stories themselves stay. Disabling is almost always what
   * you meant: `update(id, { enabled: false })`.
   *
   * @throws {OmsApiError} 404 when the source is not yours.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_sources/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /intel_sources/:id/run` - polls the source now instead of waiting
   * for its interval. `202 {"queued":true}`.
   *
   * **It enqueues; it does not fetch.** The answer arrives before anything has
   * happened, and it says nothing about whether the poll will succeed. To see
   * the outcome, re-read the source and watch {@link IntelSource.last_run_at},
   * {@link IntelSource.health} and {@link IntelSource.last_error}. There is no
   * job id and nothing to wait on.
   *
   * Three sharp edges:
   *
   * - it runs a source even when {@link IntelSource.enabled} is `false`. The
   *   action does not look at the flag, so this is also how you test a feed you
   *   have deliberately switched off;
   * - it is authorised by VISIBILITY only. The action does its own `find_by`
   *   inside `viewable_by` and never calls `updatable_by?` - which happens to
   *   be the same set here, since sources are only ever visible to their owner;
   * - it has **no bucket of its own**. It rides the general 600-per-minute
   *   ceiling, so a loop can enqueue hundreds of `FetchSourceJob`s into the
   *   `syncs` queue in seconds and starve everything else on it. Call it on a
   *   user gesture; never in a poll loop.
   *
   * Not retried by default: a replay enqueues a second fetch.
   *
   * @throws {OmsApiError} 404 `"Resource not found"` when the source is not
   *   yours.
   */
  async run(id: Id, options: RequestOptions = {}): Promise<IntelSourceRunAccepted> {
    return this.http.post<IntelSourceRunAccepted>(
      `/intel_sources/${encodeURIComponent(id)}/run`,
      undefined,
      { retry: false, ...options },
    );
  }
}
