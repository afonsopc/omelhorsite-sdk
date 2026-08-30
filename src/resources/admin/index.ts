/** The `admin` namespace: OAuth client management and the operator surface. */

import { Resource } from "../../http";
import { AuthorizedApplicationsNamespace } from "./authorizedApplications";
import { AdminChestsNamespace } from "./chests";
import { AdminEventAlertsNamespace } from "./eventAlerts";
import { LinkedIdentitiesNamespace } from "./identities";
import { AdminJobsNamespace } from "./jobs";
import { MyOauthApplicationsNamespace } from "./myOauthApplications";
import { AdminNotepadsNamespace } from "./notepads";
import { AdminOauthApplicationsNamespace } from "./oauthApplications";
import { AdminQuotasNamespace } from "./quotas";
import { AdminShortLinksNamespace } from "./shortLinks";
import { AdminVocalSeparationsNamespace } from "./vocalSeparations";

export * from "./authorizedApplications";
export * from "./chests";
export * from "./eventAlerts";
export * from "./identities";
export * from "./jobs";
export * from "./myOauthApplications";
export * from "./notepads";
export * from "./oauthApplications";
export * from "./quotas";
export * from "./shortLinks";
export * from "./types";
export * from "./vocalSeparations";

/**
 * The `admin` namespace, reachable as `oms.admin`.
 *
 * A container and nothing else: it has no methods of its own, because the
 * eleven routes underneath it answer to three different publics and putting a
 * bare `list()` here would hide which one a caller had reached. Read the module
 * documentation at the top of this file for the table.
 *
 * The short version, and the rule to check a call site against:
 *
 * ```ts
 * // Any authenticated user, about themselves:
 * await oms.admin.myApplications.list();          // clients I registered
 * await oms.admin.authorizedApplications.list();  // apps I gave access to
 * await oms.admin.identities.list();              // logins linked to my account
 *
 * // Administrators only. Everything below answers 403 to everybody else.
 * await oms.admin.oauthApplications.pending();    // the review queue
 * await oms.admin.quotas.get("someone");          // somebody else's ceilings
 * await oms.admin.jobs.list();                    // every job on the server
 * ```
 *
 * A client that is not sure whether the signed-in person is an administrator
 * should read `group` off `oms.account` once and branch on it, rather than
 * calling an `/admin/*` route to find out: the `403` is real, cheap to trigger
 * and easy to mistake for a broken credential.
 */
export class AdminNamespace extends Resource {
  /** Your own registered OAuth clients. Any authenticated user. */
  readonly myApplications: MyOauthApplicationsNamespace;
  /** Applications holding a token for your account. Any authenticated user. */
  readonly authorizedApplications: AuthorizedApplicationsNamespace;
  /** Social logins linked to your account. Any authenticated user. */
  readonly identities: LinkedIdentitiesNamespace;

  /** The OAuth client registry and review queue. **Administrators only.** */
  readonly oauthApplications: AdminOauthApplicationsNamespace;
  /** Another person's quota ceilings. **Administrators only.** */
  readonly quotas: AdminQuotasNamespace;
  /** Every background job on the server. **Administrators only.** */
  readonly jobs: AdminJobsNamespace;
  /** Every public short link and its traffic. **Administrators only.** */
  readonly shortLinks: AdminShortLinksNamespace;
  /** Every vocal separation run on the server. **Administrators only.** */
  readonly vocalSeparations: AdminVocalSeparationsNamespace;
  /** Aggregate chest statistics. **Administrators only.** */
  readonly chests: AdminChestsNamespace;
  /** Aggregate notepad statistics. **Administrators only.** */
  readonly notepads: AdminNotepadsNamespace;
  /** The Discord alert catalogue. **Administrators only.** */
  readonly eventAlerts: AdminEventAlertsNamespace;

  constructor(http: ConstructorParameters<typeof Resource>[0]) {
    super(http);
    this.myApplications = new MyOauthApplicationsNamespace(http);
    this.authorizedApplications = new AuthorizedApplicationsNamespace(http);
    this.identities = new LinkedIdentitiesNamespace(http);
    this.oauthApplications = new AdminOauthApplicationsNamespace(http);
    this.quotas = new AdminQuotasNamespace(http);
    this.jobs = new AdminJobsNamespace(http);
    this.shortLinks = new AdminShortLinksNamespace(http);
    this.vocalSeparations = new AdminVocalSeparationsNamespace(http);
    this.chests = new AdminChestsNamespace(http);
    this.notepads = new AdminNotepadsNamespace(http);
    this.eventAlerts = new AdminEventAlertsNamespace(http);
  }
}
