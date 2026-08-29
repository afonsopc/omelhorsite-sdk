/**
 * Guards the two things about the public surface that the compiler will not.
 *
 * **1. `export *` collisions are silent.** When two modules in the re-export
 * graph export the same name, TypeScript does not error at the barrel, at the
 * offending module, or at the call site. It drops the ambiguous name from the
 * barrel and moves on, so `import { Thing } from "@omelhorsite/sdk"` stops
 * resolving for a reason nothing in the build output mentions. Thirteen
 * resource modules landed in one week, every one of them free to invent a
 * `Stats` or a `CreateInput`; the naming convention in `resources/index.ts` is
 * what keeps that from happening, and this is what proves the convention held.
 *
 * **2. A resource nobody mounted is dead code.** A namespace class can be
 * written, tested and committed without ever being reachable from `Oms`, and
 * nothing fails: the tests construct the class directly with an `ApiClient`, so
 * they pass whether or not `client.ts` knows the class exists. That is exactly
 * how the first thirteen arrived. This walks the source for `class
 * *Namespace extends Resource` and asserts each one is reachable from a real
 * client, either at the top level or through a parent namespace.
 *
 * Both checks parse the source with the TypeScript compiler API rather than
 * grepping, for the same reason `scripts/check-isolate.ts` does: several of
 * these files contain the word "export" and the string `Namespace` inside JSDoc
 * and inside string literals, and only an AST can tell a declaration from
 * prose.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { Oms } from "../src/client";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Every `.ts` file under `src/`, excluding declaration files. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out.sort();
}

interface ModuleFacts {
  /** Names this module declares with an `export` modifier, or re-exports by name. */
  readonly names: string[];
  /** Absolute paths this module re-exports wholesale with `export * from`. */
  readonly stars: string[];
  /** `class X extends Resource` declarations, exported or not. */
  readonly namespaces: string[];
}

/** Resolves a relative specifier to `foo.ts` or `foo/index.ts`. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not that one; try the next shape.
    }
  }
  return undefined;
}

function readModule(file: string): ModuleFacts {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const names: string[] = [];
  const stars: string[] = [];
  const namespaces: string[] = [];

  for (const node of source.statements) {
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpecifier(file, node.moduleSpecifier.text);
        if (target) stars.push(target);
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) names.push(element.name.text);
      }
      continue;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const extendsResource = (node.heritageClauses ?? []).some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some((t) => t.expression.getText(source) === "Resource"),
      );
      if (extendsResource) namespaces.push(node.name.text);
    }

    const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) continue;

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      names.push(node.name.text);
    }
  }

  return { names, stars, namespaces };
}

const files = sourceFiles(SRC);
const modules = new Map<string, ModuleFacts>(files.map((file) => [file, readModule(file)]));
const rel = (file: string) => relative(SRC, file);

describe("public surface", () => {
  test("no two modules in the re-export graph export the same name", () => {
    const origins = new Map<string, Set<string>>();

    const visit = (file: string, seen: Set<string>): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const facts = modules.get(file);
      if (!facts) return;
      for (const name of facts.names) {
        const set = origins.get(name) ?? new Set<string>();
        set.add(rel(file));
        origins.set(name, set);
      }
      for (const star of facts.stars) visit(star, seen);
    };

    visit(join(SRC, "index.ts"), new Set());

    const collisions = [...origins.entries()]
      .filter(([, where]) => where.size > 1)
      .map(([name, where]) => `${name}: ${[...where].sort().join(" | ")}`)
      .sort();

    // An empty array in the message, so a failure names the collision rather
    // than reporting `1 !== 0`.
    expect(collisions).toEqual([]);
    expect(origins.size).toBeGreaterThan(500);
  });

  test("every module under src/resources is reachable from the barrel", () => {
    const reachable = new Set<string>();
    const walk = (file: string): void => {
      if (reachable.has(file)) return;
      reachable.add(file);
      for (const star of modules.get(file)?.stars ?? []) walk(star);
    };
    walk(join(SRC, "index.ts"));

    // `local/wordlist.ts` is deliberately not starred: `local/password.ts`
    // re-exports its single constant by name, and starring it as well would
    // make that name ambiguous and delete it from the barrel.
    const exempt = new Set(["local/wordlist.ts"]);

    const orphans = files
      .map(rel)
      .filter((file) => !exempt.has(file))
      .filter((file) => !reachable.has(join(SRC, file)));

    expect(orphans).toEqual([]);
  });
});

describe("namespace registry", () => {
  /** Walks `oms`, collecting the constructor name of every namespace on it. */
  function mountedNamespaces(): Map<string, string> {
    const oms = new Oms({ baseUrl: "https://api.test", fetch: async () => new Response("{}") });
    const found = new Map<string, string>();

    const visit = (node: object, path: string, depth: number): void => {
      if (depth > 4) return;
      for (const key of Object.keys(node)) {
        const value = (node as Record<string, unknown>)[key];
        if (typeof value !== "object" || value === null) continue;
        const name = value.constructor?.name;
        if (!name || !name.endsWith("Namespace")) continue;
        const here = `${path}.${key}`;
        if (found.has(name)) continue;
        found.set(name, here);
        visit(value, here, depth + 1);
      }
    };

    visit(oms, "oms", 0);
    return found;
  }

  test("every namespace class declared in src/resources is mounted on Oms", () => {
    const mounted = mountedNamespaces();

    const declared = files
      .filter((file) => rel(file).startsWith("resources/"))
      .flatMap((file) => modules.get(file)?.namespaces ?? [])
      .filter((name) => name.endsWith("Namespace"));

    const missing = declared.filter((name) => !mounted.has(name)).sort();
    expect(missing).toEqual([]);
    expect(declared.length).toBeGreaterThan(50);
  });

  test("the top-level namespaces are the ones three clients were told to use", () => {
    const oms = new Oms({ baseUrl: "https://api.test", fetch: async () => new Response("{}") });
    const top = Object.keys(oms)
      .filter((key) => {
        const value = (oms as unknown as Record<string, unknown>)[key];
        return typeof value === "object" && value !== null && value.constructor?.name?.endsWith("Namespace") === true;
      })
      .sort();

    expect(top).toEqual([
      "account",
      "admin",
      "auth",
      "chests",
      "content",
      "dynamicQrs",
      "forms",
      "ipLookup",
      "jobs",
      "library",
      "linkTrees",
      "media",
      "movies",
      "music",
      "notepads",
      "passkeys",
      "quotas",
      "realtime",
      "sessions",
      "shortLinks",
      "social",
      "storage",
      "tickets",
      "tools",
    ]);
  });

  test("session auth and OAuth are two different namespaces, not two spellings", () => {
    const oms = new Oms({ baseUrl: "https://api.test", fetch: async () => new Response("{}") });
    expect(oms.auth.constructor.name).toBe("AuthNamespace");
    expect(oms.sessions.constructor.name).toBe("AuthSessionsNamespace");
    expect(oms.auth).not.toBe(oms.sessions);
  });

  test("music groups its five families under one namespace", () => {
    const oms = new Oms({ baseUrl: "https://api.test", fetch: async () => new Response("{}") });
    // `http` is `Resource`'s protected field, which is still an own enumerable
    // property at runtime; `protected` is a compile-time idea only.
    const families = Object.keys(oms.music)
      .filter((key) => key !== "http")
      .sort();
    expect(families).toEqual(["artists", "imports", "playlists", "social", "songs"]);
  });
});
