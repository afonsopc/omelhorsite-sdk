# `@omelhorsite/sdk`

The TypeScript client for the omelhorsite API.

```ts
import { Oms } from "@omelhorsite/sdk";

const oms = new Oms({ token: myToken });

const me = await oms.auth.whoami();
const link = await oms.shortLinks.create({ url: "https://example.com" });
```

```sh
bun add @omelhorsite/sdk
```

## What shapes every signature

**It runs anywhere `fetch` runs.** Browsers, Bun, Node 18+, React Native and
Cloudflare-Worker-class isolates. Nothing in the package touches `node:*`,
`process`, the filesystem or `console`; `fetch` is injectable.

**Files are values, never paths.** `Blob`, `Uint8Array` or `ReadableStream`
in; `Blob` out. On React Native a picked `{ uri, name, type }` is accepted as
it is and streamed by the platform.

**The types are the documentation.** Everything is exported flat from the
package root, and the JSDoc on each method carries the rate limits, quota
units and traps of the endpoint behind it.

## Constructing a client

```ts
import { Oms } from "@omelhorsite/sdk";

const oms = new Oms({
  token: "...",                      // string, function, TokenProvider, or omitted
  baseUrl: "http://localhost:3000",  // defaults to https://backend.omelhorsite.pt
  fetch: myFetch,                    // defaults to globalThis.fetch
  headers: { "X-Trace": id },        // merged under per-call headers
  timeoutMs: 30_000,                 // per attempt; 0 disables
  retry: { maxAttempts: 3 },         // or false to never retry
  clientName: "my-worker/1.0",       // becomes X-Oms-Client
});
```

Constructing does no I/O. `oms.withToken(other)` returns a copy under a
different identity rather than mutating one.

Omitting the token is legitimate: short links, notepads, chests, IP lookup and
the captcha-gated tools all work anonymously, at a smaller daily quota. A
browser on the API's own site can use the session cookie instead with
`new Oms({ sessionCookie: true })`.

**Injecting `fetch` is the extension point.** A cache, a test double, a proxy:
none of them patch a global.

```ts
const oms = new Oms({
  token,
  fetch: (url, init) => fetch(url, { ...init, cf: { cacheTtl: 60 } }),
});
```

An endpoint the SDK has not wrapped yet is still reachable:

```ts
const rows = await oms.http.get<{ id: string }[]>("/some/new/path");
```

## Namespaces

| | |
| --- | --- |
| `oms.auth` | OAuth: device grant, refresh, revoke, `whoami`, `userinfo`. |
| `oms.sessions` `oms.passkeys` | Session sign-in, sign-up, OTP, passkeys. |
| `oms.account` | The signed-in user, their profile, sessions and usage. |
| `oms.storage` | The virtual filesystem: nodes, uploads, downloads, grants. |
| `oms.media` | Resolving stored media to URLs. |
| `oms.music` | Songs, artists, playlists, imports, likes, jams, the social feed. |
| `oms.movies` | Addons, collections, watch progress. |
| `oms.search` | Web search: web, images, news and videos, with suggestions and infoboxes. |
| `oms.llm` | The language models you may pick, your own usage, and your conversations with the assistant (`oms.llm.chats`, streamed answers; the assistant may search the web and read pages, and each streamed answer reports every tool it used as a `tool` event and stores them as `tool_calls`, with `duration_ms`/`first_token_ms` for the answer); administrators configure providers, models, feature assignments and see everybody's cost under `oms.admin.llm*`. |
| `oms.library` | Books, shelves, annotations, the study assistant. |
| `oms.social` | Direct messages, relationships, group chats. |
| `oms.content` | Blogs, notifications, feedbacks, jokes, site status, intel. |
| `oms.tools` | The metered media tools, each with its own daily quota. |
| `oms.jobs` | Background jobs: list, get, wait, watch. |
| `oms.quotas` | Every ceiling on the account in one call. |
| `oms.tickets` | Support tickets and their message threads. |
| `oms.shortLinks` `oms.notepads` `oms.dynamicQrs` `oms.chests` `oms.forms` `oms.linkTrees` | Everything that ends in a shareable URL. |
| `oms.ipLookup` | Geolocation and network metadata for an IP. |
| `oms.admin` | Administrator-only views and actions. |
| `oms.realtime` | The WebSocket channel: notifications, jobs, jams. |
| `oms.local` | Pure client-side helpers. No network, no credential. |

## Listing and filtering

Every `list()` takes the same query language, typed per resource:

```ts
const page = await oms.library.books.list({
  search: { title: "maias" },            // partial, accent-insensitive
  exactSearch: { format: "epub" },       // equality; an array is IN, null is IS NULL
  extraOptions: { scope: "mine" },       // endpoint-specific, only where declared
  order: "created_at:desc",              // "column:asc" | "column:desc"
  page: 2,
  pageSize: 50,                          // capped at 500 by the server
});
```

The columns each resource accepts are string-literal unions, so a key the
server would reject with `400` is a compile error instead. Most resources also
offer camelCased shortcuts (`userId`, `withUser`, `ownerHandle`) that write
into the same buckets.

The result is a `Paginated<T>`: `items`, `page`, `pageSize`, `hasMore` and
`next()`. Two helpers walk it:

```ts
import { collect, pages } from "@omelhorsite/sdk";

const all = await collect(page, 5000);           // flatten, up to a limit
for await (const p of pages(page)) { ... }       // or one page at a time
```

Always pass a limit to `collect`; a listing can be very long.

## Files

A `FileInput` always carries a filename, because the API derives the stored
name and, for the media tools, the container format from it:

```ts
import { file } from "@omelhorsite/sdk";

const audio = file(blob, "entrevista.m4a");
const bytes = file(new Uint8Array(buffer), "dump.sql", { contentType: "application/sql" });
const streamed = file(response.body!, "big.mov", { size: contentLength });
```

Pass `size` when you know it: it lets `storage.upload` choose the multipart
path (32 MiB and up) without buffering the stream to measure it.

Downloads come back as a `Blob`, or as a `FileOutput` when the server's
filename and content type matter:

```ts
const out = await oms.storage.download(nodeId);
const { stream } = await oms.storage.downloadStream(nodeId);
```

## Uploading to storage

Bytes go straight to object storage through a presigned URL and are bound to
the node at the end.

```ts
const roots = await oms.storage.roots();

const nodes = await oms.storage.upload(
  { parentId: roots.home!, files: [file(blob, "relatorio.pdf")], concurrency: 4 },
  { onProgress: (p) => report(p.loaded, p.total) },
);
```

In a browser or on React Native, progress is reported byte by byte (the bytes
travel through `XMLHttpRequest`); elsewhere it arrives per finished file or
part. The same goes for every other upload: pass `onUploadProgress` in the
options of `tools.*.create`, `library.books.create` or
`chests.entries.createWithUpload`. A file rejected on its own (quota, name
collision) does not throw; it is missing from the returned array, so compare
lengths when partial success matters.

## Long jobs: `create` / `get`, and `run`

Every metered tool is asynchronous: the server enqueues the work and answers
with a row in `"pending"`, plus a `job_id` and, for an anonymous caller, a
`watch_token` scoped to that one job.

```ts
const started = await oms.tools.transcription.create({ audio, language: "pt" });
const now = await oms.tools.transcription.get(started.id);

const done = await oms.tools.transcription.run(
  { audio, language: "pt" },
  { onProgress: (p) => report(p.status), waitTimeoutMs: 15 * 60_000 },
);
```

`run` is `create` plus `jobs.wait`. Use `create` on hosts with a wall-clock
budget or nowhere to hold a wait: start the job, keep the id, pick it up later.

Waiting resolves for both `"complete"` and `"failed"`: a failed job is an
answer, not a transport error. Check the status before reading the result.

```ts
const job = await oms.jobs.wait({ id: started.job_id!, watchToken: started.watch_token });
if (job.status === "failed") throw new Error(job.error ?? "the job failed");
```

A finished job says `status: "complete"`, not `"completed"`, and the
downloader spells its own terminal state `"done"`. Compare against the exported
constants, never against a literal.

Check the quota before starting something expensive:

```ts
const quota = await oms.tools.transcription.quota();
if (!quota.unlimited && (quota.remaining_seconds ?? 0) < 60) return;
```

## Errors

Every failure is an `OmsError` subclass carrying what is needed to decide
between retrying, re-scoping and giving up.

```ts
import { OmsApiError, OmsAuthError, OmsQuotaError, OmsTimeoutError, readInsufficientScope } from "@omelhorsite/sdk";

try {
  await oms.storage.delete(id);
} catch (thrown) {
  if (thrown instanceof OmsQuotaError) return retryAfter(thrown.retryAfterMs);

  const missing = readInsufficientScope(thrown);
  if (missing) return askForScopes(missing.scope);

  if (thrown instanceof OmsAuthError) return signInAgain();
  if (thrown instanceof OmsApiError) log(thrown.status, thrown.fieldErrors);
  throw thrown;
}
```

`OmsNetworkError` means the API was never reached; `OmsTimeoutError` with
`code === "aborted"` means your own `signal` fired. Retries are on by default
for idempotent requests, with backoff and jitter. Pass `retry: false` to any
create you would rather see fail than duplicate.

## OAuth

The device grant, in full. `/oauth/token` authenticates with `client_id` in
the form body; a stray `Authorization` header breaks it, so start from a
client with no token.

```ts
import { Oms, OAuthTokenProvider, decodeIdToken } from "@omelhorsite/sdk";

const anon = new Oms({ baseUrl, fetch });

const grant = await anon.auth.device.start({ clientId, scope: "openid storage:read" });
show(grant.verificationUriComplete ?? grant.verificationUri, grant.userCode);

const set = await anon.auth.device.wait({
  clientId,
  deviceCode: grant.deviceCode,
  intervalMs: grant.intervalMs,
  expiresAt: grant.expiresAt,
});

const tokens = new OAuthTokenProvider({
  store: myTokenStore,
  refresh: (refreshToken) => anon.auth.refresh(refreshToken, { clientId }),
});
await tokens.set(set);

const oms = new Oms({ baseUrl, fetch, tokens });     // refreshes itself on a 401
```

`decodeIdToken(set.idToken)` reads the claims. `sub` is the user id, stable
and the only identifier safe to key on; the handle and the email are mutable.

Access tokens live two hours. `OMS_SCOPES` is the full list the server
defines; ask for the narrowest set that does the job.

## Local helpers

No network, no credential:

```ts
import { generatePassphrase, generatePassword, passwordStrength, qrToSvg } from "@omelhorsite/sdk";

const phrase = generatePassphrase({ words: 5, capitalize: true });
const score = passwordStrength(generatePassword({ length: 20 }));
const svg = qrToSvg("https://example.com");
```

## Testing against it

Inject a fetch. There is no global to stub:

```ts
const oms = new Oms({
  token: "test",
  fetch: async () => new Response(JSON.stringify({ id: "1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
});
```

## Developing

```sh
bun test
bun run typecheck
bun run check:isolate
bun run build
```
