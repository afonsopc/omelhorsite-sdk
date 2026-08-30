/**
 * Reads the filter allowlists the API's controllers declare, so the SDK's
 * per-resource column tuples can be checked against them.
 *
 * Each controller may declare `search_params`, `extra_options_params` and
 * `custom_filter_params`; a declaration is a list of `:symbols` and
 * `key: []` array markers, possibly continued over several lines when a line
 * ends with a comma.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface ControllerAllowlist {
  /** Columns accepted in `search` and `exact_search`, as declared (base columns excluded). */
  readonly search: readonly string[];
  /** Keys accepted in `extra_options`. */
  readonly extra_options: readonly string[];
  /** Filter keys the controller reads by hand, accepted alongside `search`. */
  readonly custom: readonly string[];
}

/** Keyed by resource path: `books`, `admin/jobs`. */
export type BackendAllowlists = Record<string, ControllerAllowlist>;

const DECLARATION = /^\s*(search_params|extra_options_params|custom_filter_params)\b(.*)$/;

export function parseControllerAllowlists(controllersDir: string): BackendAllowlists {
  const out: Record<string, ControllerAllowlist> = {};
  for (const file of rubyFiles(controllersDir)) {
    if (!file.endsWith("_controller.rb")) continue;
    const key = relative(controllersDir, file).replace(/_controller\.rb$/, "");
    if (key.startsWith("concerns/")) continue;
    out[key] = parseController(readFileSync(file, "utf8"));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function parseController(source: string): ControllerAllowlist {
  const search: string[] = [];
  const extraOptions: string[] = [];
  const custom: string[] = [];

  for (const statement of statements(source)) {
    const match = DECLARATION.exec(statement);
    if (!match) continue;
    const keys = declaredKeys(match[2] ?? "");
    if (match[1] === "search_params") search.push(...keys);
    else if (match[1] === "extra_options_params") extraOptions.push(...keys);
    else custom.push(...keys);
  }

  return { search: unique(search), extra_options: unique(extraOptions), custom: unique(custom) };
}

/** Joins lines that continue with a trailing comma into one logical statement. */
function statements(source: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const raw of source.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    pending = pending === "" ? line : `${pending} ${line.trim()}`;
    if (pending.trimEnd().endsWith(",")) continue;
    out.push(pending);
    pending = "";
  }
  if (pending !== "") out.push(pending);
  return out;
}

function declaredKeys(args: string): string[] {
  const keys: string[] = [];
  for (const match of args.matchAll(/(?::(\w+)\b(?!:)|\b(\w+):\s*\[)/g)) {
    keys.push(match[1] ?? match[2] ?? "");
  }
  return keys.filter((key) => key !== "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function rubyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...rubyFiles(path));
    else if (path.endsWith(".rb")) out.push(path);
  }
  return out.sort();
}
