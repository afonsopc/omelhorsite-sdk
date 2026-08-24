/**
 * The isolate rule, enforced on every `bun test`.
 *
 * Decision #2 says the core runs in a Cloudflare-Worker-class isolate. That is
 * not a style preference: a single `import "node:fs"` anywhere under `src/`
 * makes the whole SDK unloadable there, and nothing else in the build catches
 * it reliably. `tsc` only rejects those imports for as long as `@types/node`
 * stays out of the workspace, and `bun build --target=browser` bundles them
 * without complaint.
 *
 * So the check lives in `scripts/check-isolate.ts` and is called from two
 * places: `bun run check:isolate`, and here, so that nobody has to remember it.
 *
 * The scanner's own precision is tested too. A check that quietly stops
 * catching things is worse than no check, and this one has to walk past a
 * wordlist containing the literal strings "process" and "console" and past
 * dozens of interfaces with a `node:` property.
 */

import { describe, expect, test } from "bun:test";
import { findIsolateViolations } from "../scripts/check-isolate";

describe("packages/core is isolate-safe", () => {
  test("no source file reaches for a node builtin, a process, or a console", () => {
    const violations = findIsolateViolations();
    // Rendered rather than counted: a failure should say which line to open.
    const report = violations.map((v) => `${v.file}(${v.line},${v.column}): ${v.text} - ${v.reason}`).join("\n");
    expect(report).toBe("");
  });
});

describe("the scanner itself", () => {
  /** Runs the scanner over a throwaway package laid out like the real one. */
  const scan = async (source: string): Promise<ReturnType<typeof findIsolateViolations>> => {
    const dir = `${import.meta.dir}/.tmp-isolate-${crypto.randomUUID()}`;
    await Bun.write(`${dir}/src/sample.ts`, source);
    // No dependencies: these cases are about the source scan, and the real
    // package's dependencies are covered by the first test above.
    await Bun.write(`${dir}/package.json`, JSON.stringify({ name: "sample", dependencies: {} }));
    try {
      return findIsolateViolations(dir);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  };

  test("catches a prefixed node import", async () => {
    const found = await scan(`import { readFile } from "node:fs/promises";\nexport const a = readFile;\n`);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe("node:fs/promises");
  });

  test("catches a bare node builtin, which resolves under a Node-flavoured bundler", async () => {
    const found = await scan(`import { join } from "path";\nexport const a = join;\n`);
    expect(found.map((v) => v.text)).toEqual(["path"]);
  });

  test("catches a dynamic import and a require", async () => {
    const found = await scan(`export const a = () => import("node:os");\nexport const b = () => require("fs");\n`);
    // `require("fs")` is two findings: the module, and the `require` global.
    expect(found.map((v) => v.text).sort()).toEqual(["fs", "node:os", "require"]);
  });

  test("catches a Bun host API", async () => {
    const found = await scan(`import { Database } from "bun:sqlite";\nexport const a = Database;\n`);
    expect(found[0]?.text).toBe("bun:sqlite");
  });

  test("catches process, console and the Node-only globals", async () => {
    const found = await scan(
      `export function f() {\n  console.log(process.env.X);\n  return Buffer.from(__dirname);\n}\n`,
    );
    expect(found.map((v) => v.text).sort()).toEqual(["Buffer", "__dirname", "console", "process"]);
  });

  test("catches a node builtin arriving through a runtime dependency", async () => {
    // The hole the source scan alone leaves open, and the one a bundle check
    // cannot see: `bun build --target=browser` swallows this without a word.
    const dir = `${import.meta.dir}/.tmp-isolate-dep-${crypto.randomUUID()}`;
    await Bun.write(`${dir}/src/a.ts`, `export const ok = 1;\n`);
    await Bun.write(`${dir}/package.json`, JSON.stringify({ name: "s", dependencies: { evil: "1.0.0" } }));
    await Bun.write(`${dir}/node_modules/evil/package.json`, JSON.stringify({ name: "evil", module: "./index.mjs" }));
    await Bun.write(
      `${dir}/node_modules/evil/index.mjs`,
      // The console call must NOT be reported: Workers have a console, and the
      // no-printing rule is ours, not a dependency's.
      `import { readFileSync } from "node:fs";\nconsole.warn("fine");\nexport const r = readFileSync;\n`,
    );
    try {
      const found = findIsolateViolations(dir);
      expect(found.map((v) => v.text)).toEqual(["node:fs"]);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("reports a runtime dependency that is not installed rather than passing it", async () => {
    const dir = `${import.meta.dir}/.tmp-isolate-miss-${crypto.randomUUID()}`;
    await Bun.write(`${dir}/src/a.ts`, `export const ok = 1;\n`);
    await Bun.write(`${dir}/package.json`, JSON.stringify({ name: "s", dependencies: { ghost: "1.0.0" } }));
    try {
      const found = findIsolateViolations(dir);
      expect(found).toHaveLength(1);
      expect(found[0]?.text).toBe("ghost");
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("does not fire on a property, a key, or a string that merely spells one", async () => {
    const found = await scan(
      [
        // The shapes that actually occur in this codebase, and would each be a
        // false positive under a grep: storage.ts has `readonly node:`,
        // wordlist.ts has "process" and "console" as data.
        `export interface Shape { readonly node: string; readonly process: number }`,
        `export const words = ["process", "console", "node:fs"];`,
        `export const read = (s: Shape) => s.process;`,
        `export const obj = { console: 1, process: 2 };`,
        `/** Mentions node:fs, process and console in prose. */`,
        `export function process_(): void {}`,
        `export const renamed = ({ process: p }: Shape) => p;`,
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });
});
