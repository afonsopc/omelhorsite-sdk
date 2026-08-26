# `@omelhorsite/sdk`

The TypeScript client for the omelhorsite API. The CLI and the MCP server are
clients of this package, not the other way round.

```ts
import { Oms } from "@omelhorsite/sdk";

const oms = new Oms({ token: myToken });

const me = await oms.auth.whoami();
const link = await oms.shortLinks.create({ url: "https://example.com" });
```

## Three rules that shape every signature

**1. It runs in a Cloudflare-Worker-class isolate.** No `node:*`, no `process`,
no filesystem, no `console`. Only platform APIs: `fetch`, Web Streams,
WebCrypto, `Blob`, `FormData`, `AbortController`. This is enforced at compile
time - `src/isolate-guard.d.ts` declares a poisoned `process`, so reaching for
one is a type error, not a runtime surprise in production.

**2. Files are values, never paths.** `Blob`, `Uint8Array`, `ReadableStream` in;
`Blob` out. Turning a path into bytes is the host's job, because the isolate has
no path to turn.

**3. The types are the public interface.** Everything is re-exported flat from
the package root; there is no deep import into `src/`. In code mode a model
reads the `.d.ts` and nothing else, so the JSDoc carries the rate limits, the
quota units and the places the backend surprises you.

## Installing

Today it is a workspace dependency:

```json
{ "dependencies": { "@omelhorsite/sdk": "workspace:*" } }
```

It ships as TypeScript source, no build step. Bun and any bundler resolve it
directly. Nothing is published to a registry yet.

## Constructing a client

```ts
import { Oms } from "@omelhorsite/sdk";

const oms = new Oms({
  token: "...",                      // string, function, TokenProvider, or omitted
  baseUrl: "http://localhost:3000",  // defaults to https://backend.omelhorsite.pt
  fetch: myFetch,                    // defaults to globalThis.fetch
  headers: { "X-Trace": id },        // merged under per-call headers
  timeoutMs: 30_000,                 // whole call, retries included; 0 disables
  retry: { maxAttempts: 3 },         // or false to never retry
  clientName: "my-worker/1.0",       // becomes X-Oms-Client
});
```

Constructing does no I/O. `oms.withToken(other)` returns a copy under a
different identity rather than mutating one, so an in-flight request can never
finish under the wrong credential.

Omitting the token is legitimate: short links, notepads, chests, IP lookup and
the captcha-gated tools all work anonymously, at a smaller daily quota.

**Injecting `fetch` is the extension point.** A Worker that wants a cache, a
test that wants a double, a host that wants a proxy - none of them patch a
global:

```ts
const oms = new Oms({
  token,
  fetch: (url, init) => fetch(url, { ...init, cf: { cacheTtl: 60 } }),
});
```

An endpoint the SDK has not wrapped yet is still reachable, which beats forking
the package to add one call:

```ts
const rows = await oms.http.get<{ id: string }[]>("/some/new/path");
```

## Namespaces

| | |
| --- | --- |
| `oms.auth` | Device grant, refresh, revoke, `whoami`, `userinfo`. |
| `oms.account` | The signed-in user, their profile, their usage report. |
| `oms.storage` | The virtual filesystem: nodes, uploads, downloads, grants. |
| `oms.tools` | The metered media tools, each with its own daily quota. |
| `oms.quotas` | Every ceiling on the account - tools, storage and music - in one call. |
| `oms.jobs` | Background jobs: list, get, wait, watch. The API has no cancel. |
| `oms.tickets` | Support tickets and their message threads. |
| `oms.shortLinks` `oms.notepads` `oms.dynamicQrs` `oms.chests` `oms.forms` `oms.linkTrees` | Everything that ends in a shareable URL. |
| `oms.ipLookup` | Geolocation and network metadata for an IP. |
| `oms.local` | Pure client-side helpers. No network, no credential. |

## Files

A `FileInput` always carries a filename, because the API derives the stored name
and, for the media tools, the container format from it. The `file()` helper
exists so that requirement stays visible at the call site:

```ts
import { file } from "@omelhorsite/sdk";

const audio = file(blob, "entrevista.m4a");
const bytes = file(new Uint8Array(buffer), "dump.sql", { contentType: "application/sql" });
const streamed = file(response.body!, "big.mov", { size: contentLength });
```

Pass `size` when you know it: it lets `storage.upload` pick the multipart path
(anything from 32 MiB up) without buffering the stream to measure it. A stream
without a size gets buffered, which for a 2 GB file is not what you want.

Downloads come back as a `Blob`, or as a `FileOutput` when the server's
filename and content type matter:

```ts
const out = await oms.storage.download(nodeId);   // { data, filename, contentType, size }
const { stream } = await oms.storage.downloadStream(nodeId);  // for large files
```

## Uploading to storage

Bytes never pass through Rails. `upload` mints a plan, sends the bytes straight
to object storage with a presigned URL, and binds the blob at the end.

```ts
const roots = await oms.storage.roots();

const nodes = await oms.storage.upload(
  { parentId: roots.home!, files: [file(blob, "relatorio.pdf")], concurrency: 4 },
  { onProgress: (p) => report(p.loaded, p.total) },
);
```

Progress arrives per finished file or part, never per byte: `fetch` has no
upload-progress event, and faking one would be a lie. A file rejected on its own
(quota, name collision) does not throw - it is simply missing from the returned
array, so compare lengths when partial success matters.

## Pagination

Every listing returns a `Paginated<T>` with a `load` function, and two helpers
consume it:

```ts
import { collect, pages } from "@omelhorsite/sdk";

const first = await oms.storage.list({ parentId, pageSize: 500 });

const all = await collect(first, 5000);          // flatten, up to a limit
for await (const page of pages(first)) { ... }   // or one page at a time
```

Always pass a limit to `collect`. A directory with 300k nodes is a real thing
that has happened here.

## Long jobs: `create` / `get`, and `run`

Every metered tool is asynchronous. The server enqueues work and answers
immediately with a row in `"pending"`, plus a `job_id` and - for an anonymous
caller - a `watch_token` scoped to that one job.

So every tool namespace has the same three-part shape:

```ts
// start: returns as soon as the work is enqueued
const started = await oms.tools.transcription.create({ audio, language: "pt" });

// poll: one request, no waiting
const now = await oms.tools.transcription.get(started.id);

// or let the SDK poll for you
const done = await oms.tools.transcription.run(
  { audio, language: "pt" },
  { onProgress: (p) => report(p.status), waitTimeoutMs: 15 * 60_000 },
);
```

`run` is `create` plus `jobs.wait`, and it is the right call in a script or at a
terminal. **The split exists because in half the places this SDK is meant to
run, `run` is unusable:**

- **A Worker has a wall-clock budget.** Holding a poll loop open for a
  five-minute transcription burns the invocation and then dies without the
  result. Start the job, return the id, and pick it up on the next request.
- **A request/response host has nowhere to put the wait.** An HTTP handler, an
  MCP tool call and a queue consumer all want to hand back an id now and answer
  later. That is what `oms tools ... --no-wait` and `oms tools status` are built
  on.
- **The polling policy belongs in one place.** `jobs.wait` starts at
  `pollIntervalMs`, backs off towards a ceiling, honours the caller's `signal`,
  and gives up at `waitTimeoutMs`. No tool module opens a second loop.

Waiting resolves for **both** `"completed"` and `"failed"`: a failed job is an
answer, not a transport error. Check the status before reading the result.

```ts
const job = await oms.jobs.wait({ id: started.job_id!, watchToken: started.watch_token });
if (job.status === "failed") throw new Error(job.error ?? "the job failed");
```

**A trap worth naming once.** A finished tool row says `status: "complete"`. A
finished row in the generic job table says `"completed"`. The downloader's
sidecar says `"done"`. Three spellings of one idea, in three different tables.
Compare against the constants, never against a literal you typed from memory.

Check the quota before starting something expensive. The unit differs per tool -
seconds of media for the audio and video tools, edits for jumpstyle:

```ts
const quota = await oms.tools.transcription.quota();
if (!quota.unlimited && (quota.remaining_seconds ?? 0) < 60) return;
```

## Errors

Every failure is an `OmsError` subclass carrying the context needed to decide
between retrying, re-scoping and giving up.

```ts
import { OmsApiError, OmsAuthError, OmsQuotaError, OmsTimeoutError, readInsufficientScope } from "@omelhorsite/sdk";

try {
  await oms.storage.delete(id);
} catch (thrown) {
  if (thrown instanceof OmsQuotaError) return retryAfter(thrown.retryAfterMs);

  const missing = readInsufficientScope(thrown);
  if (missing) return askForScopes(missing.scope);   // 403 with a scope requirement

  if (thrown instanceof OmsAuthError) return signInAgain();
  if (thrown instanceof OmsApiError) log(thrown.status, thrown.fieldErrors);
  throw thrown;
}
```

`OmsNetworkError` means the API was never reached; `OmsTimeoutError` with
`code === "aborted"` means your own `signal` fired. Retries are on by default
for idempotent requests with backoff and jitter. **Pass `retry: false` to any
create you would rather see fail than duplicate** - a replayed short link mints
a second one under a different endpoint.

## Auth

The device grant, in full. Note which calls carry a credential and which must
not: `/oauth/token` authenticates with `client_id` in the form body and a
stray `Authorization` header breaks it.

```ts
import { Oms, OAuthTokenProvider, decodeIdToken } from "@omelhorsite/sdk";

const anon = new Oms({ baseUrl, fetch });            // NO token

const grant = await anon.auth.device.start({ clientId: "oms-cli", scope: "openid storage:read" });
show(grant.verificationUriComplete ?? grant.verificationUri, grant.userCode);

const set = await anon.auth.device.wait({
  clientId: "oms-cli",
  deviceCode: grant.deviceCode,
  intervalMs: grant.intervalMs,
  expiresAt: grant.expiresAt,
});

const tokens = new OAuthTokenProvider({
  store: myTokenStore,                                // yours: the SDK writes no files
  refresh: (refreshToken) => anon.auth.refresh(refreshToken, { clientId: "oms-cli" }),
});
await tokens.set(set);

const oms = new Oms({ baseUrl, fetch, tokens });     // refreshes itself on a 401
```

`decodeIdToken(set.idToken)` reads the claims. **`sub` is `users.id`** - stable,
and the only identifier safe to key on. The handle and the email are mutable.

Access tokens live two hours. `OMS_SCOPES` is the full list the server defines;
ask for the narrowest set that does the job.

## Local helpers

No network, no credential, importable on their own:

```ts
import { generatePassphrase, generatePassword, passwordStrength, qrToSvg } from "@omelhorsite/sdk";

const phrase = generatePassphrase({ words: 5, capitalize: true });
const score = passwordStrength(generatePassword({ length: 20 }));
const svg = qrToSvg("https://example.com");
```

## Testing against it

Inject a fetch. There is no global to stub and no network to mock at a lower
level:

```ts
const oms = new Oms({
  token: "test",
  fetch: async (url, init) => new Response(JSON.stringify({ id: "1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
});
```

```sh
bun test
bun run typecheck
```

**After any change to `src/`, regenerate the MCP server's type catalogue:**

```sh
bun run --filter '@omelhorsite/mcp' build:types
```

The MCP server serves these declarations to models as its entire interface. A
stale catalogue means the model is reading a signature that no longer exists.
