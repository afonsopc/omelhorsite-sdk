/** Intel scripts: the fetchers. */

import { Resource } from "../../../http";
import { listQuery, paginate } from "../../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../../listing";
import type { Id, Paginated, RequestOptions, Timestamp } from "../../../types";

/** Largest script body the server will store. */
export const INTEL_SCRIPT_MAX_CODE_BYTES = 64 * 1024;

/**
 * A TypeScript fetcher that knows how to pull items out of one kind of feed.
 *
 * Runs in the `intel-runner` sidecar, inside a V8 isolate with nothing but the
 * injected `ctx`. Two populations share this table:
 *
 * - **built-ins** (`builtin: true`, `user_id: null`, `slug` set) are managed by
 *   `Intel::BuiltinScripts`, visible to everyone, and immutable over HTTP;
 * - **user scripts** (`builtin: false`, `user_id` set, `slug: null`) are yours.
 *
 * `viewable_by` is `builtin OR mine`, so a listing mixes the two. Check
 * {@link builtin} before offering an edit affordance - see
 * {@link IntelScriptsNamespace.update} for what happens if you do not.
 */
export interface IntelScript {
  readonly id: Id;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  /** Up to 120 characters, whitespace-trimmed by the model. */
  readonly name: string;
  /** Stable handle, e.g. `"rss"`. Non-null for built-ins ONLY; always `null` for yours. */
  readonly slug: string | null;
  readonly description: string | null;
  /** `true` for a platform script. Immutable, and not yours to delete. */
  readonly builtin: boolean;
  /** Owner. `null` exactly when {@link builtin} is `true`. */
  readonly user_id: Id | null;
  /**
   * The source code - **only on the `:extended` view**.
   *
   * Only the `:extended` view carries `code`, so `get()`, `create()` and
   * `update()` carry it and `list()` does not. That is a
   * deliberate weight decision (a listing of 64 KiB bodies), not an oversight,
   * and it is why this key is optional. A row from `list()` has it `undefined`;
   * fetch the script by id when you actually need the body.
   */
  readonly code?: string;
}

/** Filter columns of `GET /intel_scripts`, on top of {@link BASE_FILTER_COLUMNS}. */
export const INTEL_SCRIPT_FILTER_COLUMNS = Object.freeze(["name", "builtin", "slug"] as const);

/** Filters for {@link IntelScriptsNamespace.list}. */
export interface ListIntelScriptsParams extends ListParams<(typeof INTEL_SCRIPT_FILTER_COLUMNS)[number]> {
  /**
   * `true` for the platform scripts, `false` for yours. Omit for both - the
   * listing scope is `builtin OR mine`, so both populations are mixed by
   * default.
   */
  readonly builtin?: boolean;
}

/** Arguments for {@link IntelScriptsNamespace.create}. */
export interface CreateIntelScriptInput {
  /** Up to 120 characters. */
  readonly name: string;
  /** The body. Up to {@link INTEL_SCRIPT_MAX_CODE_BYTES}. */
  readonly code: string;
  readonly description?: string;
}

/** Arguments for {@link IntelScriptsNamespace.update}. */
export interface UpdateIntelScriptInput {
  readonly name?: string;
  readonly code?: string;
  readonly description?: string;
}

/**
 * `/intel_scripts` - the fetchers. Full CRUD over YOUR scripts, read-only over
 * the platform's.
 */
export class IntelScriptsNamespace extends Resource {
  /**
   * `GET /intel_scripts` - the built-ins plus yours, mixed.
   *
   * **No `code`.** The body is on the `:extended` view only, so every row here
   * has `code: undefined`. See {@link IntelScript.code}.
   *
   * Declared filters: `name`, `builtin`, `slug`, plus the inherited three.
   * The controller sets no ordering, so the SDK sends `created_at:desc`.
   *
   * @throws {OmsApiError} 403 outside the allowlist.
   */
  async list(params: ListIntelScriptsParams = {}, options: RequestOptions = {}): Promise<Paginated<IntelScript>> {
    const base = { order: "created_at:desc", exactSearch: { builtin: params.builtin } };
    return paginate(params, 100, (at) =>
      this.http.get<IntelScript[]>("/intel_scripts", { ...options, query: listQuery(params, at, base) }),
    );
  }

  /**
   * `GET /intel_scripts/:id` - the script WITH its body.
   *
   * This is the only read that carries {@link IntelScript.code}. Works for a
   * built-in too: they are visible to everyone, so this is how you read one
   * before forking it.
   *
   * @throws {OmsApiError} 404 when the id is neither a built-in nor yours.
   */
  async get(id: Id, options: RequestOptions = {}): Promise<IntelScript> {
    return this.http.get<IntelScript>(`/intel_scripts/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /intel_scripts` - saves a fetcher. `201`, with `code`.
   *
   * The controller transpiles the body in the `intel-runner` sidecar BEFORE
   * saving, so a syntax error surfaces here rather than at the first poll:
   * `400 "Invalid script: <the compiler's message>"`.
   *
   * **The check is best-effort and fails OPEN.** `check_script!` rescues
   * `Intel::RunnerClient::Error` and returns `nil`, so when the runner is down
   * or unreachable the script saves unchecked and a `201` means only "stored".
   * There is nothing on the response that distinguishes a checked save from an
   * unchecked one. Treat a successful create as "it parses, probably", and
   * confirm with {@link IntelSourcesNamespace.run} on a throwaway source.
   *
   * The check is a transpile, not an execution: it proves the code parses, not
   * that it fetches anything.
   *
   * The created script is always yours - `builtin` is not on `create_params`,
   * so it cannot be set - and up to
   * {@link INTEL_SCRIPT_MAX_CODE_BYTES} long.
   *
   * Not retried by default: a replay creates a second script.
   */
  async create(input: CreateIntelScriptInput, options: RequestOptions = {}): Promise<IntelScript> {
    return this.http.post<IntelScript>(
      "/intel_scripts",
      {
        name: input.name,
        code: input.code,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      { retry: false, ...options },
    );
  }

  /**
   * `PATCH /intel_scripts/:id` - edits one of YOUR scripts. Answers with `code`.
   *
   * Same best-effort transpile check as {@link create}, and only when `code` is
   * present in the body.
   *
   * **A built-in answers `401`, not `403`.** The body is
   * `"You are not authorized to update this resource"` under a 401 status. That
   * is an authorisation refusal wearing an authentication status code: do NOT
   * let a generic 401 handler log the user out over it. Check
   * {@link IntelScript.builtin} first and fork instead of editing.
   *
   * A live edit takes effect on the next poll of every source using this
   * script; there is no versioning and no rollback.
   *
   * @throws {OmsApiError} 404 when the id is not visible to you; 401 for a
   *   built-in; 400 for a syntax error or an over-long body.
   */
  async update(id: Id, input: UpdateIntelScriptInput, options: RequestOptions = {}): Promise<IntelScript> {
    return this.http.patch<IntelScript>(
      `/intel_scripts/${encodeURIComponent(id)}`,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      options,
    );
  }

  /**
   * `DELETE /intel_scripts/:id`. `204`, empty body.
   *
   * Refuses while any source still uses it, with
   * `400 "Cannot delete record because dependent intel sources exist"`. Delete
   * or repoint the sources first - {@link IntelSourcesNamespace.list} with
   * `scriptId` finds them in one call.
   *
   * A built-in answers `401` with `"You are not authorized to destroy this
   * resource"`, for the reason spelled out on {@link update}.
   */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/intel_scripts/${encodeURIComponent(id)}`, options);
  }
}
