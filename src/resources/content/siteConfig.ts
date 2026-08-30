/** The public configuration blob. */

import { Resource } from "../../http";
import type { RequestOptions } from "../../types";

/**
 * The public configuration blob. One key today; treat it as open, since this
 * is where any future "the browser needs to know this before signing in"
 * value will land.
 */
export interface SiteConfig {
  /**
   * Cloudflare Turnstile site key, for rendering the widget.
   *
   * `null` when the credential is not configured - in development, and in any
   * environment where the key was never set. A `null` here does NOT mean the
   * captcha is disabled server-side: `require_captcha_if_anonymous!` still
   * runs and still rejects an anonymous {@link FeedbacksNamespace.create}, so
   * a client that skips the widget because this was null will see a 400 it
   * cannot explain. Treat `null` as "anonymous submission is unavailable".
   */
  readonly turnstile_site_key: string | null;
}

/**
 * The `config` namespace: one anonymous GET that bootstraps the client.
 *
 * Deliberately tiny and deliberately public - it is the only thing a client
 * can read before it has any credential at all, and the only reason it exists
 * is that the Turnstile widget needs a site key before the anonymous feedback
 * form can be submitted.
 */
export class SiteConfigNamespace extends Resource {
  /**
   * `GET /config` - the public configuration blob.
   *
   * Anonymous, no side effects, reads no database. It is not cached
   * server-side and has no `ETag`, so it is a full round trip every time -
   * fetch it once at boot and hold it, do not call it per form.
   *
   * Counts against the general ceiling like everything else (120/min per IP
   * anonymous), and - the trap this file repeats - answers `403` if you attach
   * an OAuth access token to it, because no route here accepts one.
   */
  async get(options: RequestOptions = {}): Promise<SiteConfig> {
    return this.http.get<SiteConfig>("/config", options);
  }
}
