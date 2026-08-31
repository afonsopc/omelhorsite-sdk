# @omelhorsite/sdk

TypeScript client for the [omelhorsite](https://omelhorsite.pt) API. Works in
browsers, Bun, Node 18+, React Native and Cloudflare Workers.

```sh
bun add @omelhorsite/sdk
```

```ts
import { Oms } from "@omelhorsite/sdk";

const oms = new Oms({ token: "..." });

const me = await oms.account.me();
const link = await oms.shortLinks.create({ url: "https://example.com" });
```

## Client

```ts
const oms = new Oms({
  token: "...",                     // omit for anonymous access
  baseUrl: "http://localhost:3000", // default: https://backend.omelhorsite.pt
  fetch: myFetch,                   // default: globalThis.fetch
  timeoutMs: 30_000,
  retry: { maxAttempts: 3 },        // or false
});
```

`token` can be a string, a function returning one, or a `TokenProvider` that
refreshes itself. On a first-party page use `new Oms({ sessionCookie: true })`
instead.

Some things work without a token (short links, notepads, chests, IP lookup,
the captcha-gated tools), at a smaller daily quota.

## Examples

Listing and paging:

```ts
import { collect } from "@omelhorsite/sdk";

const page = await oms.library.books.list({
  search: { title: "maias" },
  order: "created_at:desc",
  pageSize: 50,
});

page.items;           // this page
await page.next();    // the next one, or null
await collect(page, 1000); // flatten up to a limit
```

Uploading a file:

```ts
import { file } from "@omelhorsite/sdk";

const roots = await oms.storage.roots();
const [node] = await oms.storage.upload({
  parentId: roots.home!,
  files: [file(blob, "relatorio.pdf")],
});
```

Files are values (`Blob`, `Uint8Array`, `ReadableStream`), never paths. On
React Native pass the picker's `{ uri, name, type }` directly.

Running a tool (transcription, upscale, background removal, ...):

```ts
const result = await oms.tools.transcription.run(
  { audio: file(blob, "entrevista.m4a"), language: "pt" },
  { onProgress: (p) => console.log(p.status) },
);
```

`run` starts the job and waits for it. Use `create` + `oms.jobs.wait` if you
would rather come back to it later.

Talking to the assistant:

```ts
const chat = await oms.llm.chats.create();

for await (const event of oms.llm.chats.send(chat.id, { content: "Olá!" })) {
  if (event.type === "delta") process.stdout.write(event.delta);
}
```

An endpoint the SDK does not wrap yet:

```ts
const rows = await oms.http.get<{ id: string }[]>("/some/path");
```

## Namespaces

| | |
| --- | --- |
| `oms.auth` | OAuth: device grant, refresh, revoke, `whoami`. |
| `oms.sessions` `oms.passkeys` | Sign-in, sign-up, OTP, passkeys. |
| `oms.account` | The signed-in user, profile, sessions, usage. |
| `oms.storage` | Files and folders: upload, download, share. |
| `oms.music` | Songs, artists, playlists, jams. |
| `oms.movies` | Addons, collections, watch progress. |
| `oms.library` | Books, shelves, annotations. |
| `oms.llm` | Models and assistant chats. |
| `oms.search` | Web, image, news and video search. |
| `oms.social` | Direct messages, friends, group chats. |
| `oms.content` | Blogs, notifications, feedback, site status. |
| `oms.tools` | Media tools, each with its own daily quota. |
| `oms.jobs` `oms.quotas` | Background jobs and account limits. |
| `oms.tickets` | Support tickets. |
| `oms.shortLinks` `oms.notepads` `oms.dynamicQrs` `oms.chests` `oms.forms` `oms.linkTrees` | Things that end in a shareable URL. |
| `oms.ipLookup` | Geolocation for an IP. |
| `oms.realtime` | WebSocket: notifications, jobs, jams. |
| `oms.admin` | Administrator-only. |
| `oms.local` | Client-side helpers (passwords, QR codes). No network. |

## Errors

Everything thrown is an `OmsError`:

```ts
import { OmsApiError, OmsAuthError, OmsQuotaError } from "@omelhorsite/sdk";

try {
  await oms.storage.delete(id);
} catch (e) {
  if (e instanceof OmsQuotaError) wait(e.retryAfterMs);
  else if (e instanceof OmsAuthError) signIn();
  else if (e instanceof OmsApiError) console.log(e.status, e.message);
  else throw e;
}
```

`OmsNetworkError` means the API was never reached, `OmsTimeoutError` that the
request took too long.

## Developing

```sh
bun test
bun run typecheck
bun run build
```
