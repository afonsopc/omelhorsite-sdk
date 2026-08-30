# @omelhorsite/sdk

Public TypeScript client for the omelhorsite API, published on npm.

## Rules

- Commit messages are in English. Short subject, imperative mood, no trailer.
- This package is public. Its readers do not know, and must not need to know,
  how the server or the other clients are built. Do not mention Rails classes,
  controllers, the web app, the CLI, the MCP server, or any internal repo in
  code, comments, JSDoc or the README. Describe behaviour, not implementation.
- Keep comments scarce. A comment earns its place by stating a fact the code
  cannot show (a server rule, a limit, a trap). No narration of what the code
  does, no history of how it used to be.
- Isolate-safe: no `node:*`, `process`, `console`, or `Date.now` at module top
  level in `src/`. `bun run check:isolate` enforces it.
- Three runtimes are first-class: browser (session cookie), React Native
  (token, no `ReadableStream`, files as `{ uri, name, type }`) and Bun.
- Use bun for everything (`bun test`, `bun run typecheck`, `bun run build`).
- Every `list()` speaks the listing DSL through `src/listing.ts`: `ListParams`
  for the parameter shape, `listQuery` for the wire, `paginate` for paging.
  Filter columns and `extra_options` keys are declared as `as const` tuples
  next to the resource, and `test/listing-allowlists.test.ts` checks them.
- Before publishing: `bun test && bun run typecheck && bun run check:isolate
  && bun run build`, then bump the version.
