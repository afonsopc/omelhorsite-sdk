/** The `content` namespace and everything under it. */

import { type ApiClient, Resource } from "../../http";
import { AnalysisNamespace } from "./analysis";
import { BlogsNamespace } from "./blogs";
import { FeedbacksNamespace } from "./feedbacks";
import { IntelNamespace } from "./intel/index";
import { JokesNamespace } from "./jokes";
import { NotificationsNamespace } from "./notifications";
import { ServiceUsagesNamespace } from "./serviceUsages";
import { ServicesStatusNamespace } from "./servicesStatus";
import { SiteConfigNamespace } from "./siteConfig";
import { SpaceInvadersNamespace } from "./spaceInvaders";

export * from "./analysis";
export * from "./blogs";
export * from "./feedbacks";
export * from "./intel/index";
export * from "./jokes";
export * from "./notifications";
export * from "./serviceUsages";
export * from "./servicesStatus";
export * from "./siteConfig";
export * from "./spaceInvaders";

/**
 * The `content` namespace, reachable as `oms.content`.
 *
 * An umbrella over ten unrelated corners of the API. Nothing is shared between
 * them, so mount the sub-namespaces directly if a flatter surface reads better
 * - each one is exported on its own.
 */
export class ContentNamespace extends Resource {
  /** Blogs, blog posts and subscriptions. `.posts` hangs off it. */
  readonly blogs: BlogsNamespace;
  /** The notification inbox. HTTP half only; the cable pushes the rest. */
  readonly notifications: NotificationsNamespace;
  /** The feedback box, and its admin queue. */
  readonly feedbacks: FeedbacksNamespace;
  /** The joke table behind the loading screens. */
  readonly jokes: JokesNamespace;
  /** The public config blob a client reads before it has a credential. */
  readonly config: SiteConfigNamespace;
  /** The status page: live probes and the 90-day uptime report. */
  readonly status: ServicesStatusNamespace;
  /** Per-user "which parts of the site do you open" counters. */
  readonly serviceUsages: ServiceUsagesNamespace;
  /** Two admin storage reports. */
  readonly analysis: AnalysisNamespace;
  /** The Space Invaders leaderboard. */
  readonly spaceInvaders: SpaceInvadersNamespace;
  /**
   * Intel: seven typed families over the backend's own tables, with the
   * untyped sidecar passthrough kept on `.proxy`. See {@link IntelNamespace}.
   */
  readonly intel: IntelNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.blogs = new BlogsNamespace(http);
    this.notifications = new NotificationsNamespace(http);
    this.feedbacks = new FeedbacksNamespace(http);
    this.jokes = new JokesNamespace(http);
    this.config = new SiteConfigNamespace(http);
    this.status = new ServicesStatusNamespace(http);
    this.serviceUsages = new ServiceUsagesNamespace(http);
    this.analysis = new AnalysisNamespace(http);
    this.spaceInvaders = new SpaceInvadersNamespace(http);
    this.intel = new IntelNamespace(http);
  }
}
