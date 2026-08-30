/**
 * Compile-time guard for decision #2: the SDK core must run inside a
 * Cloudflare-Worker-class isolate.
 *
 * `node:*` imports already fail to resolve, because every tsconfig in this
 * workspace sets `"types": []` and no `@types/node` is installed. What was
 * still reachable was the ambient `process` object, which a contributor coming
 * from a Node codebase reaches for by reflex.
 *
 * Declaring it as a string type turns `process.env.OMS_TOKEN` into a compile
 * error whose message says what to do instead, rather than into code that
 * silently works on Node and explodes in a Worker.
 *
 * This file is a declaration script (no imports, no exports), so the
 * declarations below are global to the `packages/core` project only. The CLI
 * and MCP packages do not include it: they are host code and are allowed a
 * runtime.
 *
 * `console` cannot be guarded the same way - lib.dom.d.ts already declares it
 * and a second declaration is a duplicate-identifier error. The core must not
 * write to it, and that rule is enforced by review, not by the compiler.
 */

declare const process: "The SDK core runs in an isolate and has no process. Take the value through the Oms constructor (baseUrl, token, fetch) instead of reading the environment.";

declare const require: "The SDK core is ESM only and has no require. Use a static import.";

declare const __dirname: "The SDK core has no filesystem. Files enter and leave as Blob / Uint8Array / ReadableStream, never as paths.";

declare const __filename: "The SDK core has no filesystem. Files enter and leave as Blob / Uint8Array / ReadableStream, never as paths.";
