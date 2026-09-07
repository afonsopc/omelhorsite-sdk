/**
 * The `cron` namespace: TypeScript scripts of the signed-in person that the
 * server runs on a schedule.
 *
 * A script is an ES module exporting `run(ctx)`. WHERE it runs follows from
 * what it declares: a job with no scopes runs in the light sandbox (the one
 * the news sources use: no token, no SDK, only a guarded `fetchText` and the
 * HTML/XML helpers, thousands of runs a day); a job with scopes runs in the
 * full runner, with `ctx.oms` authenticated as the owner and, when the job
 * has `network` on, a `ctx.fetch` that goes through the server's guard
 * against private addresses. The base contract (`config`, `params`, `state`,
 * `log`, `fetchText`, `select`, `parseXml`, `htmlText`) is the same in both.
 * What a script keeps in `ctx.state` is stored when a run ends well and
 * handed back on the next one; what it returns is the run's `result`, and
 * `result.summary` is what the listing shows.
 *
 * A job whose `output` is `{ kind: "items" }` returns `{ items, cursor? }`
 * and the server stores the items in the news source the run belongs to.
 *
 * A job has zero or more SCHEDULES ({@link CronSchedule}): each a cron
 * expression in a timezone with its own `params` and switch. A run carries
 * `params`: an object merged over the job's `config` (so the script reads
 * `ctx.config` as usual) and handed on its own as `ctx.params`. They come
 * from the schedule that fired, or from whoever called `run`.
 *
 * Needs the `cron:read` scope to read and `cron:write` to change anything.
 * A job's own token never carries either; with `cron:run` it may start other
 * jobs.
 */

import { Resource, type ApiClient } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../listing";
import type { Id, Json, Paginated, RequestOptions, Timestamp } from "../types";

/**
 * Scopes a job may ask for its token. Anything else answers `400`. `cron:run`
 * lets a script run other jobs (with params) without reading or editing them.
 */
export const CRON_JOB_SCOPES = Object.freeze([
  "profile", "news:read", "news:write", "storage:read", "storage:write", "llm", "tools:read", "tools:write", "blogs:read", "blogs:write", "bots:read", "bots:write", "cron:run",
] as const);
export type CronJobScope = (typeof CRON_JOB_SCOPES)[number];

export const CRON_JOB_HEALTHS = Object.freeze(["unknown", "ok", "error"] as const);
export type CronJobHealth = (typeof CRON_JOB_HEALTHS)[number];

/** Where a job runs, derived from its scopes: none means the light sandbox. */
export const CRON_JOB_RUNTIMES = Object.freeze(["sandbox", "full"] as const);
export type CronJobRuntime = (typeof CRON_JOB_RUNTIMES)[number];

/** What a job's runs produce, when it is not just a result: news items for a source. */
export interface CronJobOutput {
  readonly kind: "items";
}

/** Consecutive failures after which a job switches itself off. Turn `enabled` back on to revive it. */
export const CRON_JOB_DISABLE_AFTER_FAILURES = 10;
/** Code longer than this answers `400`. */
export const CRON_JOB_MAX_CODE_BYTES = 256 * 1024;
/** `state` and `config` ceilings. A run whose state grows past this fails and the state is not stored. */
export const CRON_JOB_MAX_STATE_BYTES = 256 * 1024;
export const CRON_JOB_MAX_CONFIG_BYTES = 64 * 1024;
/** Two occurrences of one schedule must be at least this far apart. */
export const CRON_JOB_MIN_INTERVAL_MINUTES = 5;
/** Schedules one job may have. */
export const CRON_SCHEDULES_MAX_PER_JOB = 200;
/** `timeout_seconds` range; above 120 the account needs a trusted tier, like `network`. */
export const CRON_JOB_MIN_TIMEOUT_SECONDS = 5;
export const CRON_JOB_MAX_TIMEOUT_SECONDS = 1200;
export const CRON_JOB_BASE_MAX_TIMEOUT_SECONDS = 120;

export interface CronJob {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Up to 120 characters, unique per account. */
  readonly name: string;
  readonly description: string | null;
  /** The cron expression of the job's FIRST schedule, or `null` when it has none. The whole list is in {@link CronJobDetail.schedules}. */
  readonly schedule: string | null;
  /** How many schedules the job has. */
  readonly schedules_count: number;
  /** An IANA zone such as `"Europe/Lisbon"` (the default); the default timezone of new schedules. */
  readonly timezone: string;
  /** The scopes the run's token carries. Empty means the job runs in the sandbox, with no token. */
  readonly scopes: CronJobScope[];
  /** Derived from `scopes`: `sandbox` when there are none, `full` otherwise. */
  readonly runtime: CronJobRuntime;
  /** `{ kind: "items" }` when the script returns news items the server ingests; `null` for a plain result. */
  readonly output: CronJobOutput | null;
  /** Names of the stored secrets. The values never leave the server. */
  readonly secret_keys: string[];
  /** Whether `ctx.fetch`/`ctx.fetchText` exist in the script. In the sandbox this needs no trusted tier. */
  readonly network: boolean;
  readonly timeout_seconds: number;
  /** A folder of the owner's storage handed to the script as `ctx.job.outputDirId`. */
  readonly output_dir_id: Id | null;
  readonly enabled: boolean;
  /** The nearest occurrence among the enabled schedules; `null` when the job is off or has none. */
  readonly next_run_at: Timestamp | null;
  readonly last_run_at: Timestamp | null;
  readonly last_success_at: Timestamp | null;
  readonly health: CronJobHealth;
  readonly consecutive_failures: number;
  readonly notify_on_failure: boolean;
  readonly notify_on_success: boolean;
  /** The template the job was created from, if any. */
  readonly template_slug: string | null;
  /** Whether a run is queued or running right now. */
  readonly running: boolean;
}

/** The types a script may give a variable it declares with `// @var key type Label | description`. */
export const CRON_VAR_TYPES = Object.freeze(["string", "text", "number", "boolean", "list", "json"] as const);
export type CronVarType = (typeof CRON_VAR_TYPES)[number];

/**
 * A variable a script declares as editable, parsed by the server from the
 * `// @var` lines at the top of the code. Its value lives in `config[key]`.
 */
export interface CronVar {
  readonly key: string;
  readonly type: CronVarType;
  readonly label: string;
  readonly description: string | null;
}

/** `GET /cron_jobs/:id` (and every write) adds the code, the config, the state, the declared variables and the schedules. */
export interface CronJobDetail extends CronJob {
  readonly code: string;
  readonly config: Record<string, Json>;
  readonly state: Record<string, Json>;
  readonly vars: CronVar[];
  /** Oldest first. */
  readonly schedules: CronSchedule[];
}

/**
 * One schedule of a job: when it fires and with what params. A job may have
 * several (a source per site, a report per feed) or none (run by hand, by
 * the API or by another job).
 */
export interface CronSchedule {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly cron_job_id: Id;
  /** Optional label, up to 120 characters. */
  readonly name: string | null;
  /** Five-field cron expression, read in `timezone`. */
  readonly cron: string;
  readonly timezone: string;
  /** Handed to every run this schedule starts, merged over the job's config and as `ctx.params`. */
  readonly params: Record<string, Json>;
  /** Off, the schedule does not fire; the job's other schedules still do. */
  readonly enabled: boolean;
  readonly next_run_at: Timestamp | null;
  readonly last_run_at: Timestamp | null;
}

export const CRON_SCHEDULE_FILTER_COLUMNS = Object.freeze(["cron_job_id", "enabled"] as const);
export interface ListCronSchedulesParams extends ListParams<(typeof CRON_SCHEDULE_FILTER_COLUMNS)[number]> {
  readonly jobId?: Id;
  readonly enabled?: boolean;
}

export interface CreateCronScheduleInput {
  readonly jobId: Id;
  /** Five fields; two occurrences must be at least {@link CRON_JOB_MIN_INTERVAL_MINUTES} apart. */
  readonly cron: string;
  /** Defaults to `"Europe/Lisbon"`. */
  readonly timezone?: string;
  readonly name?: string | null;
  /** Up to 64 KB. */
  readonly params?: Record<string, Json>;
  readonly enabled?: boolean;
}

export type UpdateCronScheduleInput = Partial<Omit<CreateCronScheduleInput, "jobId">>;

export const CRON_JOB_FILTER_COLUMNS = Object.freeze(["name", "enabled", "health", "template_slug"] as const);
export interface ListCronJobsParams extends ListParams<(typeof CRON_JOB_FILTER_COLUMNS)[number]> {}

export interface CreateCronJobInput {
  readonly name: string;
  readonly description?: string | null;
  /**
   * Creates the job's first schedule (in `timezone`). Optional: a job with no
   * schedule runs by hand, by the API or by another job. Add more with
   * {@link CronSchedulesNamespace.create}; on update this edits the first one.
   */
  readonly schedule?: string;
  readonly timezone?: string;
  /** TypeScript. Checked for syntax on the server before it is stored. */
  readonly code: string;
  /** Defaults to every scope but `news:write` and `tools:write`. Pass `[]` for a sandbox job (no token, no SDK). */
  readonly scopes?: readonly CronJobScope[];
  /** `{ kind: "items" }` makes the runs' items go to the news source of each run. `null` removes it. */
  readonly output?: CronJobOutput | null;
  readonly config?: Record<string, Json>;
  /** Stored encrypted; on update the object is MERGED, and a `null` value removes that key. */
  readonly secrets?: Record<string, string | null>;
  readonly state?: Record<string, Json>;
  readonly network?: boolean;
  readonly timeoutSeconds?: number;
  readonly outputDirId?: Id | null;
  readonly enabled?: boolean;
  readonly notifyOnFailure?: boolean;
  readonly notifyOnSuccess?: boolean;
  readonly templateSlug?: string | null;
}

export type UpdateCronJobInput = Partial<Omit<CreateCronJobInput, "templateSlug">>;

export const CRON_RUN_STATUSES = Object.freeze(["queued", "running", "ok", "error", "timeout", "skipped"] as const);
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];
/**
 * Who asked for a run: a schedule, a person with a session (`manual`), a
 * third-party OAuth token (`api`), another job's run token (`job`), or a test.
 */
export const CRON_RUN_TRIGGERS = Object.freeze(["schedule", "manual", "api", "job", "test"] as const);
export type CronRunTrigger = (typeof CRON_RUN_TRIGGERS)[number];

export interface CronRun {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly cron_job_id: Id;
  /** The schedule that fired it, when the trigger is `schedule` and it still exists. */
  readonly cron_schedule_id: Id | null;
  /** The news source that received the items, for runs of a job with `output` items bound to a source. */
  readonly news_source_id: Id | null;
  /** Where it ran; `null` while queued. Sandbox runs do not count towards `cron_run_seconds`. */
  readonly runtime: CronJobRuntime | null;
  readonly status: CronRunStatus;
  /** `test` runs never write the state back and never count as failures. */
  readonly trigger: CronRunTrigger;
  /** Merged over the job's config for this run and handed to the script as `ctx.params`. */
  readonly params: Record<string, Json>;
  readonly scheduled_at: Timestamp;
  readonly started_at: Timestamp | null;
  readonly finished_at: Timestamp | null;
  readonly duration_ms: number | null;
  readonly error: string | null;
  readonly error_name: string | null;
  /** Model calls made with the run's token, and what they cost. */
  readonly llm_requests: number;
  readonly llm_cost: number;
  /** Requests the script made, through the SDK and `ctx.fetch`. */
  readonly http_calls: number;
  /** `result.summary`, when the script returned one. */
  readonly summary: string | null;
}

/** `GET /cron_runs/:id` adds the logs and the whole result. */
export interface CronRunDetail extends CronRun {
  /** What `ctx.log` and `console.log` wrote, one line per entry, capped at 64 KB. */
  readonly logs: string | null;
  readonly result: Json | null;
}

export const CRON_RUN_FILTER_COLUMNS = Object.freeze(["cron_job_id", "status", "trigger"] as const);
export interface ListCronRunsParams extends ListParams<(typeof CRON_RUN_FILTER_COLUMNS)[number]> {
  readonly jobId?: Id;
  readonly status?: CronRunStatus;
}

/** What `run` and `test` accept. */
export interface RunCronJobInput {
  /** Merged over the job's config for this run only; the script also gets them as `ctx.params`. Up to 64 KB. */
  readonly params?: Record<string, Json>;
}

/** A ready-made script: copy it into a job with {@link CronJobsNamespace.create}. */
export interface CronTemplate {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** The schedule the template expects. */
  readonly schedule: string;
  /** Empty for sandbox templates (the news source scripts). */
  readonly scopes: CronJobScope[];
  readonly runtime: CronJobRuntime;
  readonly output: CronJobOutput | null;
  readonly network: boolean;
  /** The config the script reads, with defaults. */
  readonly config: Record<string, Json>;
  /** The variables the template declares as editable (`// @var`). */
  readonly vars: CronVar[];
  /** SHA-256 of the code, so a client can tell an edited copy from a pristine one. */
  readonly hash: string;
}

export interface CronTemplateDetail extends CronTemplate {
  readonly code: string;
}

/** What the syntax check answers. */
export interface CronCheckResult {
  readonly ok: boolean;
  readonly error?: string;
}

export class CronJobsNamespace extends Resource {
  async list(params: ListCronJobsParams = {}, options: RequestOptions = {}): Promise<Paginated<CronJob>> {
    const base = { order: "created_at:asc" };
    return paginate(params, 50, (at) => this.http.get<CronJob[]>("/cron_jobs", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<CronJobDetail> {
    return this.http.get<CronJobDetail>(`/cron_jobs/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /cron_jobs`. `201` with the full job.
   *
   * @throws {OmsApiError} 400 with the validation sentence: a bad or too
   *   frequent schedule, an unknown timezone, a scope outside
   *   {@link CRON_JOB_SCOPES}, `network` or a timeout above 120 s on an
   *   account without a trusted tier, an `Invalid script: ...` syntax error,
   *   or `job limit reached (N)` (the `cron_jobs` quota).
   */
  async create(input: CreateCronJobInput, options: RequestOptions = {}): Promise<CronJobDetail> {
    return this.http.post<CronJobDetail>("/cron_jobs", jobBody(input), { retry: false, ...options });
  }

  /** `PATCH /cron_jobs/:id`. Secrets merge; a `null` value removes a key. Changing the schedule recomputes `next_run_at`. */
  async update(id: Id, input: UpdateCronJobInput, options: RequestOptions = {}): Promise<CronJobDetail> {
    return this.http.patch<CronJobDetail>(`/cron_jobs/${encodeURIComponent(id)}`, jobBody(input), options);
  }

  /** `DELETE /cron_jobs/:id` - the job and its runs. `204`. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/cron_jobs/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /cron_jobs/:id/run` - runs now, outside the schedule, as a normal
   * run (the state is stored). `202` with the queued run.
   *
   * @throws {OmsApiError} 400 `this job is already running`, or
   *   `params must be an object`; 429 `error: "limit"` when the day's
   *   `cron_run_seconds` are spent.
   */
  async run(id: Id, input: RunCronJobInput = {}, options: RequestOptions = {}): Promise<CronRun> {
    return this.http.post<CronRun>(`/cron_jobs/${encodeURIComponent(id)}/run`, runBody(input), { retry: false, ...options });
  }

  /** `POST /cron_jobs/:id/test` - runs now WITHOUT storing the state or counting a failure. `202`. */
  async test(id: Id, input: RunCronJobInput = {}, options: RequestOptions = {}): Promise<CronRun> {
    return this.http.post<CronRun>(`/cron_jobs/${encodeURIComponent(id)}/test`, runBody(input), { retry: false, ...options });
  }

  /** `POST /cron_jobs/check` - the syntax check the server runs before storing code, on its own. */
  async check(code: string, options: RequestOptions = {}): Promise<CronCheckResult> {
    return this.http.post<CronCheckResult>("/cron_jobs/check", { code }, options);
  }
}

export class CronSchedulesNamespace extends Resource {
  /** `GET /cron_schedules` - oldest first, narrowed by job. */
  async list(params: ListCronSchedulesParams = {}, options: RequestOptions = {}): Promise<Paginated<CronSchedule>> {
    const base = { order: "created_at:asc", exactSearch: { cron_job_id: params.jobId, enabled: params.enabled } };
    return paginate(params, 50, (at) => this.http.get<CronSchedule[]>("/cron_schedules", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<CronSchedule> {
    return this.http.get<CronSchedule>(`/cron_schedules/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /cron_schedules`. `201`.
   *
   * @throws {OmsApiError} 400 with the sentence: a bad or too frequent cron,
   *   an unknown timezone, `params must be an object`,
   *   `cron_job_id must be one of your jobs`, or `schedule limit reached`.
   */
  async create(input: CreateCronScheduleInput, options: RequestOptions = {}): Promise<CronSchedule> {
    return this.http.post<CronSchedule>("/cron_schedules", { cron_job_id: input.jobId, ...scheduleBody(input) }, { retry: false, ...options });
  }

  /** `PATCH /cron_schedules/:id`. Changing the cron or the timezone recomputes `next_run_at`. */
  async update(id: Id, input: UpdateCronScheduleInput, options: RequestOptions = {}): Promise<CronSchedule> {
    return this.http.patch<CronSchedule>(`/cron_schedules/${encodeURIComponent(id)}`, scheduleBody(input), options);
  }

  /** `DELETE /cron_schedules/:id`. Past runs keep existing without it. `204`. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/cron_schedules/${encodeURIComponent(id)}`, options);
  }
}

export class CronRunsNamespace extends Resource {
  /** `GET /cron_runs` - newest first. */
  async list(params: ListCronRunsParams = {}, options: RequestOptions = {}): Promise<Paginated<CronRun>> {
    const base = { order: "created_at:desc", exactSearch: { cron_job_id: params.jobId, status: params.status } };
    return paginate(params, 50, (at) => this.http.get<CronRun[]>("/cron_runs", { ...options, query: listQuery(params, at, base) }));
  }

  async get(id: Id, options: RequestOptions = {}): Promise<CronRunDetail> {
    return this.http.get<CronRunDetail>(`/cron_runs/${encodeURIComponent(id)}`, options);
  }

  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/cron_runs/${encodeURIComponent(id)}`, options);
  }
}

export class CronTemplatesNamespace extends Resource {
  /** `GET /cron_templates` - the built-in scripts, without their code. */
  async list(options: RequestOptions = {}): Promise<CronTemplate[]> {
    return this.http.get<CronTemplate[]>("/cron_templates", options);
  }

  /** `GET /cron_templates/:slug` - one template with its code. */
  async get(slug: string, options: RequestOptions = {}): Promise<CronTemplateDetail> {
    return this.http.get<CronTemplateDetail>(`/cron_templates/${encodeURIComponent(slug)}`, options);
  }
}

/** The `cron` namespace, reachable as `oms.cron`. */
export class CronNamespace extends Resource {
  readonly jobs: CronJobsNamespace;
  readonly schedules: CronSchedulesNamespace;
  readonly runs: CronRunsNamespace;
  readonly templates: CronTemplatesNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.jobs = new CronJobsNamespace(http);
    this.schedules = new CronSchedulesNamespace(http);
    this.runs = new CronRunsNamespace(http);
    this.templates = new CronTemplatesNamespace(http);
  }
}

function scheduleBody(input: Partial<CreateCronScheduleInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.cron !== undefined) body["cron"] = input.cron;
  if (input.timezone !== undefined) body["timezone"] = input.timezone;
  if (input.name !== undefined) body["name"] = input.name;
  if (input.params !== undefined) body["params"] = input.params;
  if (input.enabled !== undefined) body["enabled"] = input.enabled;
  return body;
}

function runBody(input: RunCronJobInput): Record<string, unknown> {
  return input.params === undefined ? {} : { params: input.params };
}

function jobBody(input: Partial<CreateCronJobInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body["name"] = input.name;
  if (input.description !== undefined) body["description"] = input.description;
  if (input.schedule !== undefined) body["schedule"] = input.schedule;
  if (input.timezone !== undefined) body["timezone"] = input.timezone;
  if (input.code !== undefined) body["code"] = input.code;
  if (input.scopes !== undefined) body["scopes"] = [...input.scopes];
  if (input.output !== undefined) body["output"] = input.output;
  if (input.config !== undefined) body["config"] = input.config;
  if (input.secrets !== undefined) body["secrets"] = input.secrets;
  if (input.state !== undefined) body["state"] = input.state;
  if (input.network !== undefined) body["network"] = input.network;
  if (input.timeoutSeconds !== undefined) body["timeout_seconds"] = input.timeoutSeconds;
  if (input.outputDirId !== undefined) body["output_dir_id"] = input.outputDirId;
  if (input.enabled !== undefined) body["enabled"] = input.enabled;
  if (input.notifyOnFailure !== undefined) body["notify_on_failure"] = input.notifyOnFailure;
  if (input.notifyOnSuccess !== undefined) body["notify_on_success"] = input.notifyOnSuccess;
  if (input.templateSlug !== undefined) body["template_slug"] = input.templateSlug;
  return body;
}
