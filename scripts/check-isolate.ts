/**
 * Enforces decision #2: `@omelhorsite/sdk` runs inside a Cloudflare-Worker-class
 * isolate, so it may not touch `node:*`, `process`, or `console`.
 *
 * Why this exists when `src/isolate-guard.d.ts` already declares a poisoned
 * `process`, and `tsc` already rejects `import "node:fs"`:
 *
 *  - The compiler only rejects `node:*` because every tsconfig here sets
 *    `"types": []` and `@types/node` is not installed. The day anything pulls
 *    `@types/node` into the workspace - a transitive devDependency is enough -
 *    those imports start resolving and the guard evaporates silently. This
 *    check does not depend on what happens to be installed.
 *  - `console` cannot be poisoned by declaration at all: `lib.dom.d.ts` already
 *    declares it, and a second declaration is a duplicate-identifier error.
 *    Until this file existed, "the core must not print" was enforced by review.
 *
 * Bundling is NOT a viable guard and was measured, not assumed:
 * `bun build --target=browser` over a core that imports `node:fs/promises`
 * exits 0 and emits a bundle with no trace of the import left in it. A green
 * bundle says nothing.
 *
 * So this walks the real syntax tree with the TypeScript compiler API - the
 * same library `packages/mcp/scripts/generate-types.ts` uses, and the reason a
 * regex is not good enough here: `src/local/wordlist.ts` contains the string
 * literals "process" and "console", and nearly every file mentions `node:` in
 * a comment. Only an AST can tell an identifier from prose.
 *
 * Run it directly, or let `bun test` run it through `test/isolate.test.ts`:
 *
 * ```sh
 * bun run --filter '@omelhorsite/sdk' check:isolate
 * ```
 *
 * This is a build-time tool, not shipped code: `package.json` publishes only
 * `src` and `dist`.
 */

import ts from "typescript";

/** One thing in the core that would not survive in an isolate. */
export interface IsolateViolation {
  /** Path relative to `@omelhorsite/sdk`, e.g. `src/local/qr.ts`. */
  readonly file: string;
  /** 1-based, as an editor counts. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /** The offending source text, e.g. `process` or `"node:fs/promises"`. */
  readonly text: string;
  /** What to do instead. This is what a contributor reads. */
  readonly reason: string;
}

/**
 * Node builtins, with and without the `node:` prefix.
 *
 * The prefixed form is caught by prefix regardless of what is on this list, so
 * the list only has to cover the bare specifiers (`import "fs"`), which still
 * resolve in a Node-flavoured bundler.
 */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * Globals that exist on a host runtime and not in an isolate.
 *
 * `Buffer`, `global` and `setImmediate` are here for the same reason as
 * `process`: they are what a contributor arriving from a Node codebase reaches
 * for by reflex, and every one of them is absent in a Worker.
 */
const BANNED_GLOBALS: ReadonlyMap<string, string> = new Map([
  [
    "process",
    "The core has no process. Take the value through the Oms constructor (baseUrl, token, fetch) instead of reading the environment.",
  ],
  [
    "console",
    "The core never prints. Return the value, or throw an OmsError, and let the CLI decide what reaches a terminal.",
  ],
  ["require", "The core is ESM only. Use a static import."],
  ["__dirname", "The core has no filesystem. Files enter and leave as Blob / Uint8Array / ReadableStream, never as paths."],
  ["__filename", "The core has no filesystem. Files enter and leave as Blob / Uint8Array / ReadableStream, never as paths."],
  ["Buffer", "Not a platform API. Use Uint8Array."],
  ["global", "Not a platform API. Use globalThis."],
  ["setImmediate", "Not a platform API. Use queueMicrotask or setTimeout."],
  ["Bun", "Bun globals are host APIs. Anything they do belongs in packages/cli."],
]);

/** `@omelhorsite/sdk`, derived from this file's own location rather than a cwd. */
export function corePackageDir(): string {
  return decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
}

/**
 * Scans `src` and returns every violation, in file order.
 *
 * Empty means the core would load in a Worker. It is a pure function of the
 * files on disk, so both the CLI entry point below and `test/isolate.test.ts`
 * call it.
 */
export function findIsolateViolations(packageDir: string = corePackageDir()): IsolateViolation[] {
  const srcDir = `${packageDir}/src`;
  const files = ts.sys.readDirectory(srcDir, [".ts"], undefined, undefined).sort();
  if (files.length === 0) throw new Error(`No TypeScript sources under ${srcDir}. Wrong path?`);

  const violations: IsolateViolation[] = [];
  for (const path of files) {
    const text = ts.sys.readFile(path);
    if (text === undefined) throw new Error(`Could not read ${path}`);
    const relative = path.startsWith(`${packageDir}/`) ? path.slice(packageDir.length + 1) : path;
    scanFile(relative, text, violations);
  }
  violations.push(...findDependencyViolations(packageDir));
  return violations;
}

/**
 * Checks the core's RUNTIME dependencies, because a clean `src/` proves nothing
 * if a dependency imports `node:fs` on its way in.
 *
 * Only `dependencies` are examined - devDependencies never reach a Worker.
 * Each one's resolved entry point is scanned with the same AST walk as our own
 * sources. That is one file per dependency rather than the full transitive
 * graph, which is enough in practice because these packages ship pre-bundled
 * (`uqr` is a single `dist/index.mjs`) and a bundle carries its imports at the
 * top. A dependency that ships unbundled would need this widened, and that is
 * a conversation to have when one appears.
 */
function findDependencyViolations(packageDir: string): IsolateViolation[] {
  const manifestPath = `${packageDir}/package.json`;
  const manifestText = ts.sys.readFile(manifestPath);
  if (manifestText === undefined) throw new Error(`Could not read ${manifestPath}`);
  const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, string> };

  const violations: IsolateViolation[] = [];
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const entry = resolveDependencyEntry(packageDir, name);
    if (entry === undefined) {
      violations.push({
        file: "package.json",
        line: 1,
        column: 1,
        text: name,
        reason: `Runtime dependency "${name}" is not installed, so it cannot be checked for isolate safety. Run bun install.`,
      });
      continue;
    }
    const text = ts.sys.readFile(entry.path);
    if (text === undefined) continue;
    // Imports only. What a dependency does with `console` internally is its own
    // business - Workers have a console; what they do not have is `node:fs`.
    // The no-printing rule is ours and applies to our code.
    scanFile(`node_modules/${name}/${entry.relative}`, text, violations, { importsOnly: true });
  }
  return violations;
}

/** Finds a dependency's ESM entry file, preferring the module build. */
function resolveDependencyEntry(
  packageDir: string,
  name: string,
): { readonly path: string; readonly relative: string } | undefined {
  const root = `${packageDir}/node_modules/${name}`;
  const manifestText = ts.sys.readFile(`${root}/package.json`);
  if (manifestText === undefined) return undefined;
  const manifest = JSON.parse(manifestText) as {
    module?: string;
    main?: string;
    exports?: unknown;
  };

  const candidates = [exportsEntry(manifest.exports), manifest.module, manifest.main, "index.js"];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const relative = candidate.replace(/^\.\//, "");
    const path = `${root}/${relative}`;
    if (ts.sys.fileExists(path)) return { path, relative };
  }
  return undefined;
}

/** Pulls the `import` condition out of an `exports` map, however it is nested. */
function exportsEntry(exports: unknown): string | undefined {
  if (typeof exports === "string") return exports;
  if (typeof exports !== "object" || exports === null) return undefined;
  const map = exports as Record<string, unknown>;
  for (const key of [".", "import", "module", "default"]) {
    const found = exportsEntry(map[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Walks one file's syntax tree. */
function scanFile(
  relative: string,
  text: string,
  out: IsolateViolation[],
  options: { readonly importsOnly?: boolean } = {},
): void {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  // A `.d.ts` declares things rather than using them - `isolate-guard.d.ts`
  // exists precisely to name `process` and `require` - so only its imports are
  // interesting, never its identifiers.
  const declarationsOnly = options.importsOnly === true || relative.endsWith(".d.ts");

  const record = (node: ts.Node, offendingText: string, reason: string): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    out.push({ file: relative, line: line + 1, column: character + 1, text: offendingText, reason });
  };

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifierOf(node);
    if (specifier !== undefined) {
      const reason = reasonForSpecifier(specifier);
      if (reason !== undefined) record(node, specifier, reason);
    }

    if (!declarationsOnly && ts.isIdentifier(node) && isValueReference(node)) {
      const reason = BANNED_GLOBALS.get(node.text);
      if (reason !== undefined) record(node, node.text, reason);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** The imported module name, for any node that pulls one in. Else undefined. */
function moduleSpecifierOf(node: ts.Node): string | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  }
  // `import type X = require("fs")`.
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return ts.isStringLiteral(expression) ? expression.text : undefined;
  }
  // `import("fs")` and `require("fs")`. The bare `require` identifier is caught
  // separately, but naming the module gives a far better error message.
  if (ts.isCallExpression(node)) {
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    const [first] = node.arguments;
    if ((isDynamicImport || isRequire) && first && ts.isStringLiteral(first)) return first.text;
  }
  return undefined;
}

/** Why this module may not be imported, or undefined if it may. */
function reasonForSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith("node:")) {
    return `"${specifier}" is a Node builtin and does not exist in an isolate. Move the work to packages/cli and pass the result in.`;
  }
  if (specifier === "bun" || specifier.startsWith("bun:")) {
    return `"${specifier}" is a Bun host API and does not exist in an isolate. Move the work to packages/cli and pass the result in.`;
  }
  if (NODE_BUILTINS.has(specifier)) {
    return `"${specifier}" is a Node builtin and does not exist in an isolate. Move the work to packages/cli and pass the result in.`;
  }
  return undefined;
}

/**
 * True when this identifier is a variable being READ, rather than a name that
 * merely happens to spell one.
 *
 * Without this, `readonly node: FsNode`, `{ process: "..." }` and
 * `import { console as c }` would all be reported, and the check would be
 * ignored within a week.
 */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;

  // `foo.process` - a property, not the global.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  // `Foo.process` in a type position.
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  // `{ process: x }` and `interface X { process: Y }` and `class X { process = 1 }`.
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  // `const { process: renamed } = x` - `process` here is the source key.
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  // Declaration names: `function process()`, `const process = 1`, `class process {}`,
  // and the `declare const process` in isolate-guard.d.ts.
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  // `import { process }` / `export { process }` - the specifier, not a read.
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return false;
  // `{ process }` shorthand in a type literal.
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  // A label, e.g. `process: for (;;)`.
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;

  return true;
}

/** Renders one violation the way a compiler would, so an editor can jump to it. */
function format(violation: IsolateViolation): string {
  return `${violation.file}(${violation.line},${violation.column}): ${violation.text}\n    ${violation.reason}`;
}

/**
 * CLI entry.
 *
 * Throws rather than calling `process.exit`, for the obvious reason: this file
 * is about not having a process. An uncaught throw is a non-zero exit anyway.
 */
// `import.meta.main` is a Bun global with no type under `"types": []`. Narrowed
// at the use site, the same way `packages/cli/src/main.ts` does it, so that this
// file needs no host declarations at all and can be typechecked by the core's
// own project.
if ((import.meta as { main?: boolean }).main === true) {
  const violations = findIsolateViolations();
  if (violations.length > 0) {
    for (const violation of violations) console.error(format(violation));
    throw new Error(
      `packages/core is not isolate-safe: ${violations.length} violation(s). ` +
        `The core runs in a Cloudflare-Worker-class isolate; host work belongs in packages/cli.`,
    );
  }
  console.log("@omelhorsite/sdk is isolate-safe: no node builtins, no process, no console.");
}
