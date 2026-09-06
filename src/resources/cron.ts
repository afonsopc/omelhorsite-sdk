/**
 * The `cron` namespace: TypeScript scripts of the signed-in person that the
 * server runs on a schedule.
 *
 * A script is an ES module exporting `run(ctx)`. It runs with nothing but the
 * API: no filesystem, no environment, no processes, and no network beyond
 * this SDK (`ctx.oms`, authenticated as the owner with the job's scopes) and,
 * when the job has `network` on, a `ctx.fetch` that goes through the server's
 * guard against private addresses. What it keeps in `ctx.state` is stored
 * when a run ends well and handed back on the next one; what it returns is
 * the run's `result`, and `result.summary` is what the listing shows.
 *
 * Needs the `cron:read` scope to read and `cron:write` to change anything.
 * A job's own token never carries either: a script cannot edit jobs.
 */

import { Resource, type ApiClient } from "../http";
import { listQuery, paginate } from "../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../listing";
import type { Id, Json, Paginated, RequestOptions, Timestamp } from "../types";

/** Scopes a job may ask for its token. Anything else answers `400`. */
export const CRON_JOB_SCOPES = Object.freeze([
  "profile", "news:read", "news:write", "storage:read", "storage:write", "llm", "tools:read", "tools:write", "blogs:read", "blogs:write",
] as const);
export type CronJobScope = (typeof CRON_JOB_SCOPES)[number];

export const CRON_JOB_HEALTHS = Object.freeze(["unknown", "ok", "error"] as const);
export type CronJobHealth = (typeof CRON_JOB_HEALTHS)[number];

/** Consecutive failures after which a job switches itself off. Turn `enabled` back on to revive it. */
export const CRON_JOB_DISABLE_AFTER_FAILURES = 10;
/** Code longer than this answers `400`. */
export const CRON_JOB_MAX_CODE_BYTES = 256 * 1024;
/** `state` and `config` ceilings. A run whose state grows past this fails and the state is not stored. */
export const CRON_JOB_MAX_STATE_BYTES = 256 * 1024;
export const CRON_JOB_MAX_CONFIG_BYTES = 64 * 1024;
/** Two runs of one job must be at least this far apart. */
export const CRON_JOB_MIN_INTERVAL_MINUTES = 5;
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
  /** Five-field cron expression, read in `timezone`. */
  readonly schedule: string;
  /** An IANA zone such as `"Europe/Lisbon"` (the default). */
  readonly timezone: string;
  /** The scopes the run's token carries. */
  readonly scopes: CronJobScope[];
  /** Names of the stored secrets. The values never leave the server. */
  readonly secret_keys: string[];
  /** Whether `ctx.fetch` exists in the script. */
  readonly network: boolean;
  readonly timeout_seconds: number;
  /** A folder of the owner's storage handed to the script as `ctx.job.outputDirId`. */
  readonly output_dir_id: Id | null;
  readonly enabled: boolean;
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

/** `GET /cron_jobs/:id` (and every write) adds the code, the config and the state. */
export interface CronJobDetail extends CronJob {
  readonly code: string;
  readonly config: Record<string, Json>;
  readonly state: Record<string, Json>;
}

export const CRON_JOB_FILTER_COLUMNS = Object.freeze(["name", "enabled", "health", "template_slug"] as const);
export interface ListCronJobsParams extends ListParams<(typeof CRON_JOB_FILTER_COLUMNS)[number]> {}

export interface CreateCronJobInput {
  readonly name: string;
  readonly description?: string | null;
  /** Five fields. Two runs must be at least {@link CRON_JOB_MIN_INTERVAL_MINUTES} apart. */
  readonly schedule: string;
  readonly timezone?: string;
  /** TypeScript. Checked for syntax on the server before it is stored. */
  readonly code: string;
  /** Defaults to every scope but `news:write` and `tools:write`. */
  readonly scopes?: readonly CronJobScope[];
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
export const CRON_RUN_TRIGGERS = Object.freeze(["schedule", "manual", "test"] as const);
export type CronRunTrigger = (typeof CRON_RUN_TRIGGERS)[number];

export interface CronRun {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly cron_job_id: Id;
  readonly status: CronRunStatus;
  /** `test` runs never write the state back and never count as failures. */
  readonly trigger: CronRunTrigger;
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

/** A ready-made script: copy it into a job with {@link CronJobsNamespace.create}. */
export interface CronTemplate {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** The schedule the template expects. */
  readonly schedule: string;
  readonly scopes: CronJobScope[];
  readonly network: boolean;
  /** The config the script reads, with defaults. */
  readonly config: Record<string, Json>;
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
   * @throws {OmsApiError} 400 `this job is already running`; 429
   *   `error: "limit"` when the day's `cron_run_seconds` are spent.
   */
  async run(id: Id, options: RequestOptions = {}): Promise<CronRun> {
    return this.http.post<CronRun>(`/cron_jobs/${encodeURIComponent(id)}/run`, {}, { retry: false, ...options });
  }

  /** `POST /cron_jobs/:id/test` - runs now WITHOUT storing the state or counting a failure. `202`. */
  async test(id: Id, options: RequestOptions = {}): Promise<CronRun> {
    return this.http.post<CronRun>(`/cron_jobs/${encodeURIComponent(id)}/test`, {}, { retry: false, ...options });
  }

  /** `POST /cron_jobs/check` - the syntax check the server runs before storing code, on its own. */
  async check(code: string, options: RequestOptions = {}): Promise<CronCheckResult> {
    return this.http.post<CronCheckResult>("/cron_jobs/check", { code }, options);
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
  readonly runs: CronRunsNamespace;
  readonly templates: CronTemplatesNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.jobs = new CronJobsNamespace(http);
    this.runs = new CronRunsNamespace(http);
    this.templates = new CronTemplatesNamespace(http);
  }
}

function jobBody(input: Partial<CreateCronJobInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body["name"] = input.name;
  if (input.description !== undefined) body["description"] = input.description;
  if (input.schedule !== undefined) body["schedule"] = input.schedule;
  if (input.timezone !== undefined) body["timezone"] = input.timezone;
  if (input.code !== undefined) body["code"] = input.code;
  if (input.scopes !== undefined) body["scopes"] = [...input.scopes];
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
