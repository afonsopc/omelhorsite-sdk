/** `oms.admin.eventAlerts` - the Discord alert catalogue. Administrators only. */

import { Resource } from "../../http";
import type { RequestOptions } from "../../types";

/** One event in the alert catalogue. */
export interface AdminEventAlert {
  /** Stable identifier, e.g. `"oauth_client_created"`. */
  readonly event: string;
  /** Short human label. */
  readonly label: string;
  /** What the event means and when it fires. */
  readonly description: string;
  /**
   * The fields the Discord message carries, in order. Always starts with
   * `"Actor"`, and when {@link AdminEventAlert.includes_geo} is true the next
   * three are `"IP"`, `"Country"` and `"Network"`.
   */
  readonly fields: string[];
  /** Whether the message carries the actor's IP and its geo enrichment. */
  readonly includes_geo: boolean;
  /** Whether this particular event is currently switched on. */
  readonly enabled: boolean;
}

/**
 * What {@link AdminEventAlertsNamespace.list} answers with.
 *
 * Self-describing on purpose: the catalogue is built by the server, so adding
 * or removing an event needs no client change. Render the array, do not
 * hardcode the events.
 */
export interface AdminEventAlertsCatalog {
  /** Whether alerts are actually being sent right now. */
  readonly delivering: boolean;
  /**
   * Whether a webhook URL is configured at all.
   *
   * The two booleans are not the same question, and the pair is the diagnosis:
   * `webhook_configured: false` means nothing was ever set up, while
   * `webhook_configured: true` with `delivering: false` means it is configured
   * and switched off (a non-production environment, typically).
   */
  readonly webhook_configured: boolean;
  readonly events: AdminEventAlert[];
}

/**
 * `oms.admin.eventAlerts` - **administrators only**. The catalogue of activity
 * alerts sent to Discord.
 *
 * Read-only, and there is exactly one route. Nothing here switches an event on
 * or off: `enabled` is decided by the server's configuration, and the only way
 * to change it is to change that. This answers "what would be reported, and is
 * anything being reported at all".
 */
export class AdminEventAlertsNamespace extends Resource {
  /**
   * `GET /admin/event_alerts`.
   *
   * @throws {OmsAuthError} 403 for a non-admin.
   */
  async list(options: RequestOptions = {}): Promise<AdminEventAlertsCatalog> {
    const body = await this.http.get<Partial<AdminEventAlertsCatalog>>("/admin/event_alerts", options);
    return {
      delivering: body?.delivering ?? false,
      webhook_configured: body?.webhook_configured ?? false,
      events: body?.events ?? [],
    };
  }
}
