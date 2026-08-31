# @omelhorsite/sdk

[![npm](https://img.shields.io/npm/v/@omelhorsite/sdk)](https://www.npmjs.com/package/@omelhorsite/sdk)

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

- `oms.auth` - OAuth: device grant, refresh, revoke, `whoami`.
- `oms.sessions`, `oms.passkeys` - sign-in, sign-up, OTP, passkeys.
- `oms.account` - the signed-in user, profile, sessions, usage. `oms.account.notificationPreferences` decides, per notification kind, whether it shows in the inbox and whether it is emailed; the security kinds always email, unless the master switch is off.
- `oms.storage` - files and folders: upload, download, share.
- `oms.music` - songs, artists, playlists, jams.
- `oms.movies` - addons, collections, watch progress.
- `oms.library` - books, shelves, annotations.
- `oms.llm` - models and assistant chats.
- `oms.search` - web, image, news and video search.
- `oms.social` - direct messages, friends, group chats.
- `oms.content` - blogs, notifications, feedback, site status. `oms.content.notifications.unsubscribe(token)` honours the link at the foot of a notification email and needs no credential.
- `oms.tools` - media tools, each with its own daily quota.
- `oms.jobs`, `oms.quotas` - background jobs and account limits.
- `oms.tickets` - support tickets.
- `oms.shortLinks`, `oms.notepads`, `oms.dynamicQrs`, `oms.chests`, `oms.forms`, `oms.linkTrees` - things that end in a shareable URL.
- `oms.ipLookup` - geolocation for an IP.
- `oms.realtime` - WebSocket: notifications, jobs, jams.
- `oms.admin` - administrator-only.
- `oms.local` - client-side helpers (passwords, QR codes). No network.

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
