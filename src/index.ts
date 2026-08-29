/**
 * `@omelhorsite/sdk` - the TypeScript client for the omelhorsite API.
 *
 * ```ts
 * import { Oms } from "@omelhorsite/sdk";
 *
 * const oms = new Oms({ token: process.env.OMS_TOKEN }); // in HOST code, not here
 * const link = await oms.shortLinks.create({ url: "https://example.com" });
 * ```
 *
 * This package is the product; the CLI and the MCP server are two clients of
 * it. Three rules make that work, and they are not negotiable:
 *
 * 1. It runs in a Cloudflare-Worker-class isolate. No `node:*`, no `process`,
 *    no filesystem, no stdout. `fetch` is injectable through the constructor.
 * 2. Files are values - `Blob`, `Uint8Array`, `ReadableStream` - never paths.
 *    Turning a path into bytes is the host's job. React Native is the single
 *    exception, and only on multipart endpoints: a picked `{ uri, name, type }`
 *    (`NativeFile`) goes to the wire verbatim because RN's `FormData` streams
 *    it off disk and a `Blob` there uploads truncated.
 * 3. The TYPES are the public interface. In code mode a model reads the `.d.ts`
 *    and nothing else, so a name or a JSDoc line carries as much weight as the
 *    behaviour behind it.
 *
 * Everything is re-exported flat. There is no deep-import path into `src/`,
 * so internals can move without breaking a caller.
 */

export * from "./auth/index";
export * from "./client";
export * from "./errors";
export * from "./http";
export * from "./local/index";
export * from "./resources/index";
export * from "./types";

// `import` + `export default`, not `export { Oms as default } from "./client"`.
// Oms already leaves this module by way of the `export *` above, and naming it
// a second time in a re-export FROM the same path makes bun's bundler emit a
// reference to a binding it renamed (`Export 'Oms2' is not defined in module`).
// It never showed inside the workspace, where the entry resolves to this source
// file and nothing is bundled - only in the published build.
import { Oms } from "./client";

export default Oms;
