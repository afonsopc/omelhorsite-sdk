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
import { ChestsNamespace } from "./resources/chests";
import { DynamicQrsNamespace } from "./resources/dynamicQrs";
import { FormsNamespace } from "./resources/forms";
import { IpLookupNamespace } from "./resources/ipLookup";
import { JobsNamespace } from "./resources/jobs";
import { LinkTreesNamespace } from "./resources/linkTrees";
import { NotepadsNamespace } from "./resources/notepads";
import { QuotasNamespace } from "./resources/quotas";
import { ShortLinksNamespace } from "./resources/shortLinks";
import { StorageNamespace } from "./resources/storage";
import { TicketsNamespace } from "./resources/tickets";
import { ToolsNamespace } from "./resources/tools/index";
import type { FetchLike, RetryOptions } from "./types";

/**
 * Anything accepted as a credential by {@link Oms}.
 *
 * A bare string is either kind of bearer token the API takes: a legacy opaque
 * `Session` UUID or an OAuth access token. A function is called on every
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
  /** API root. Defaults to `https://backend.omelhorsite.pt`. */
  readonly baseUrl?: string;
  /**
   * The fetch to talk through. Defaults to `globalThis.fetch`. Injecting one is
   * how a Worker adds a cache, how a test swaps in a double, and how the CLI
   * adds a proxy - the SDK never patches a global.
   */
  readonly fetch?: FetchLike;
  /** Headers merged into every request, below per-call headers. */
  readonly headers?: Record<string, string>;
  /** Default deadline for one call including its retries. `0` disables it. */
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
 * ```
 *
 * Isolate-safe: no `node:*`, no environment, no stdout. A file is always a
 * value (`Blob` / `Uint8Array` / `ReadableStream`), never a path.
 */
export class Oms {
  /**
   * The transport. Public on purpose: an endpoint the SDK has not wrapped yet
   * is still reachable with `oms.http.get("/some/path")`, which beats forking
   * the SDK to add one call.
   */
  readonly http: ApiClient;

  /** Signing in, refreshing, revoking, and the RFC 8628 device grant. */
  readonly auth: AuthNamespace;
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

    const tokens = options.tokens ?? providerFor(options.token);

    this.http = new ApiClient({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
      ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
    });

    this.auth = new AuthNamespace(this.http);
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
