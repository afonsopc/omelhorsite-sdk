/**
 * `Oms` - the single entry point of the SDK.
 *
 * Everything a caller can do hangs off one instance, grouped into namespaces by
 * domain. This is the object a model sees first in code mode, so the namespace
 * names are part of the contract: `oms.tools.transcription.create(...)` has to
 * be guessable without reading a page of docs.
 *
 * Constructing it is cheap and does no I/O: it builds an {@link ApiClient} and
 * the namespace objects, nothing else.
 */

import { AuthNamespace } from "./auth/index";
import type { TokenSet } from "./auth/tokens";
import { staticToken, tokenFromFunction } from "./auth/tokens";
import { ApiClient, type TokenProvider } from "./http";
import { local, type LocalNamespace } from "./local/index";
import { AccountNamespace } from "./resources/account";
import { AdminNamespace } from "./resources/admin";
import { PasskeysNamespace } from "./resources/auth/passkeys";
import { AuthSessionsNamespace } from "./resources/auth/sessions";
import { ChestsNamespace } from "./resources/chests";
import { ContentNamespace } from "./resources/content";
import { DynamicQrsNamespace } from "./resources/dynamicQrs";
import { FormsNamespace } from "./resources/forms";
import { IpLookupNamespace } from "./resources/ipLookup";
import { JobsNamespace } from "./resources/jobs";
import { LibraryNamespace } from "./resources/library";
import { LinkTreesNamespace } from "./resources/linkTrees";
import { LlmNamespace } from "./resources/llm";
import { MediaNamespace } from "./resources/media";
import { MoviesNamespace } from "./resources/movies";
import { MusicNamespace } from "./resources/music/index";
import { NotepadsNamespace } from "./resources/notepads";
import { QuotasNamespace } from "./resources/quotas";
import { RealtimeNamespace } from "./resources/realtime";
import { SearchNamespace } from "./resources/search";
import { ShortLinksNamespace } from "./resources/shortLinks";
import { SocialNamespace } from "./resources/social";
import { StorageNamespace } from "./resources/storage";
import { TicketsNamespace } from "./resources/tickets";
import { ToolsNamespace } from "./resources/tools/index";
import type { FetchLike, RetryOptions } from "./types";

/**
 * Anything accepted as a credential by {@link Oms}.
 *
 * A bare string is either kind of bearer token the API takes: a legacy opaque
 * session UUID or an OAuth access token. A function is called on every
 * request. A {@link TokenProvider} additionally gets a chance to refresh on a
 * 401 - see `auth/tokens.ts`.
 */
export type OmsCredential = string | TokenProvider | (() => string | null | Promise<string | null>) | null;

/** Constructor options for {@link Oms}. */
export interface OmsOptions {
  /**
   * The credential. Omit it for an anonymous client: several endpoints (short
   * links, notepads, chests, the captcha-gated tools, ip lookup) work without
   * one, at a smaller daily quota.
   */
  readonly token?: OmsCredential;
  /**
   * A provider that can refresh itself. Mutually exclusive with `token`;
   * passing both throws. Build one with `refreshingTokenProvider`.
   */
  readonly tokens?: TokenProvider;
  /**
   * Authenticate with the browser's httpOnly session cookie instead of a
   * token. First-party pages only, and never the default: see
   * {@link ApiClientOptions.sessionCookie} for why it has to be asked for
   * by name.
   *
   * ```ts
   * // on a first-party page, served from the same site as the API
   * const oms = new Oms({ sessionCookie: true });
   * ```
   */
  readonly sessionCookie?: boolean;
  /** API root. Defaults to `https://backend.omelhorsite.pt`. */
  readonly baseUrl?: string;
  /**
   * The fetch to talk through. Defaults to `globalThis.fetch`. Injecting one is
   * how a Worker adds a cache, how a test swaps in a double, and how a host
   * adds a proxy - the SDK never patches a global.
   */
  readonly fetch?: FetchLike;
  /** Headers merged into every request, below per-call headers. */
  readonly headers?: Record<string, string>;
  /** Default deadline for one attempt; a retry gets a fresh one. `0` disables it. */
  readonly timeoutMs?: number;
  /** Default backoff policy, or `false` to never retry. */
  readonly retry?: RetryOptions | false;
  /** Value for the `X-Oms-Client` header, e.g. `"oms-cli/0.3.1"`. */
  readonly clientName?: string;
}

/**
 * The omelhorsite API client.
 *
 * ```ts
 * import { Oms } from "@omelhorsite/sdk";
 *
 * const oms = new Oms({ token: "..." });
 * const me = await oms.account.me();
 * const link = await oms.shortLinks.create({ url: "https://example.com" });
 * const songs = await oms.music.songs.list({ artist: "Nina Simone" });
 * const cable = oms.realtime.connect({ token, socket: (u) => new WebSocket(u) });
 * ```
 *
 * ## Two credentials, two namespaces
 *
 * `oms.sessions` mints the opaque session token, which carries the whole
 * account. `oms.auth` runs OAuth, whose tokens are scoped and, because an
 * endpoint with no declared scope refuses every OAuth token, cannot reach most
 * of the API at all. `oms.realtime` accepts only the first
 * kind. Picking the wrong one shows up as a `403 insufficient_scope`, or on the
 * cable as a connection that is silently anonymous.
 *
 * ## Isolate-safe
 *
 * No `node:*`, no environment, no stdout, and `fetch` is injectable. A file is
 * normally a VALUE (`Blob` / `Uint8Array` / `ReadableStream`), never a path,
 * because turning a path into bytes is the host's job.
 *
 * The one exception is React Native, which cannot produce a usable `Blob` from
 * a picked file: there, pass the picker's `{ uri, name, type }`
 * ({@link NativeFile}) straight into a form bag and the transport appends it
 * verbatim for RN's networking layer to stream off disk. That works on
 * multipart endpoints only - the storage direct-upload path has to read and MD5
 * the bytes, so it rejects a `NativeFile` with a message saying so rather than
 * failing at the object store.
 */
export class Oms {
  /**
   * The transport. Public on purpose: an endpoint the SDK has not wrapped yet
   * is still reachable with `oms.http.get("/some/path")`, which beats forking
   * the SDK to add one call.
   */
  readonly http: ApiClient;

  /** OAuth: refreshing, revoking, the RFC 8628 device grant, OIDC discovery. */
  readonly auth: AuthNamespace;
  /** Password sign-in, sign-up, and the emailed six-digit ceremonies. */
  readonly sessions: AuthSessionsNamespace;
  /** WebAuthn credentials: register one, sign in with one, list, revoke. */
  readonly passkeys: PasskeysNamespace;
  /** The signed-in user, their profile, and their usage report. */
  readonly account: AccountNamespace;
  /** Support tickets and their message threads. */
  readonly tickets: TicketsNamespace;
  /** The virtual filesystem: nodes, uploads, downloads, sharing grants. */
  readonly storage: StorageNamespace;
  /** Short links and their click statistics. */
  readonly shortLinks: ShortLinksNamespace;
  /** Anonymous shared notepads. */
  readonly notepads: NotepadsNamespace;
  /** QR codes whose target can be changed after printing. */
  readonly dynamicQrs: DynamicQrsNamespace;
  /** Geolocation and network metadata for an IP address. */
  readonly ipLookup: IpLookupNamespace;
  /** Ephemeral drop boxes for passing files between devices. */
  readonly chests: ChestsNamespace;
  /** Hosted forms and their submissions. */
  readonly forms: FormsNamespace;
  /** Link-in-bio pages and their click statistics. */
  readonly linkTrees: LinkTreesNamespace;
  /** Background jobs: listing, polling and watching. There is no cancel. */
  readonly jobs: JobsNamespace;
  /** Every ceiling on the account - tools, storage and music - in one call. */
  readonly quotas: QuotasNamespace;
  /** The metered media tools, each with its own daily quota. */
  readonly tools: ToolsNamespace;
  /** Songs, artists, playlists, imports, jams and the music assistant. */
  readonly music: MusicNamespace;
  /** The canonical bytes of the music library, by media id. */
  readonly media: MediaNamespace;
  /** Direct messages, friendships and blocks, group chats. */
  readonly social: SocialNamespace;
  /** The book library: uploads, shelves, annotations, the study assistant. */
  readonly library: LibraryNamespace;
  /** Stremio addons, collections and watch progress. Session credential only. */
  readonly movies: MoviesNamespace;
  /** Blogs, notifications, feedback, jokes, site config and the status page. */
  readonly content: ContentNamespace;
  /** OAuth client registration for anyone, plus the `/admin/*` routes. */
  readonly admin: AdminNamespace;
  /** Web search: web, images, news and videos through the site's own engine. */
  readonly search: SearchNamespace;
  /** The language models the signed-in person may pick, and their own usage. */
  readonly llm: LlmNamespace;
  /**
   * The WebSocket connection: playback handoff, jams, notifications, job
   * progress. Opens nothing until {@link RealtimeNamespace.connect} is called,
   * and wants a session token rather than the client's own credential - see
   * that method for why.
   */
  readonly realtime: RealtimeNamespace;

  /**
   * Pure client-side helpers that touch no network and need no credential
   * (password generation, QR encoding). Also exported standalone as `local`,
   * for a caller who wants them without building a client.
   */
  readonly local: LocalNamespace = local;

  constructor(options: OmsOptions = {}) {
    if (options.tokens && options.token !== undefined && options.token !== null) {
      throw new TypeError("Pass either `token` or `tokens` to the Oms constructor, not both.");
    }
    if (options.sessionCookie && (options.tokens || (options.token !== undefined && options.token !== null))) {
      throw new TypeError("Pass either `sessionCookie` or a token to the Oms constructor, not both.");
    }

    const tokens = options.tokens ?? providerFor(options.token);

    this.http = new ApiClient({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(options.sessionCookie === undefined ? {} : { sessionCookie: options.sessionCookie }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
    });

    this.auth = new AuthNamespace(this.http);
    this.sessions = new AuthSessionsNamespace(this.http);
    this.passkeys = new PasskeysNamespace(this.http);
    this.account = new AccountNamespace(this.http);
    this.tickets = new TicketsNamespace(this.http);
    this.storage = new StorageNamespace(this.http);
    this.shortLinks = new ShortLinksNamespace(this.http);
    this.notepads = new NotepadsNamespace(this.http);
    this.dynamicQrs = new DynamicQrsNamespace(this.http);
    this.ipLookup = new IpLookupNamespace(this.http);
    this.chests = new ChestsNamespace(this.http);
    this.forms = new FormsNamespace(this.http);
    this.linkTrees = new LinkTreesNamespace(this.http);
    this.jobs = new JobsNamespace(this.http);
    this.quotas = new QuotasNamespace(this.http);
    this.tools = new ToolsNamespace(this.http);
    this.music = new MusicNamespace(this.http);
    this.media = new MediaNamespace(this.http);
    this.social = new SocialNamespace(this.http);
    this.library = new LibraryNamespace(this.http);
    this.movies = new MoviesNamespace(this.http);
    this.content = new ContentNamespace(this.http);
    this.admin = new AdminNamespace(this.http);
    this.realtime = new RealtimeNamespace(this.http);
    this.search = new SearchNamespace(this.http);
    this.llm = new LlmNamespace(this.http);
  }

  /** The API root this client talks to, with no trailing slash. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /**
   * A copy of this client with a different credential, sharing nothing else.
   *
   * Cheaper and safer than mutating: a token swap mid-flight would let an
   * in-progress request finish under the wrong identity.
   */
  withToken(token: OmsCredential): Oms {
    return new Oms({ baseUrl: this.http.baseUrl, token });
  }

  /** Convenience over {@link withToken} for an OAuth {@link TokenSet}. */
  withTokenSet(tokens: TokenSet): Oms {
    return this.withToken(tokens.accessToken);
  }
}

/** Normalises whatever the caller passed as `token` into a provider. */
function providerFor(credential: OmsCredential | undefined): TokenProvider | undefined {
  if (credential === undefined || credential === null) return undefined;
  if (typeof credential === "string") return staticToken(credential);
  if (typeof credential === "function") return tokenFromFunction(credential);
  return credential;
}
