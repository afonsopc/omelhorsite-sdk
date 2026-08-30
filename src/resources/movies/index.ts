/** The `movies` namespace: Stremio addons, collections and watch progress, reachable as `oms.movies`. */

import type { ApiClient } from "../../http";
import { Resource } from "../../http";
import { MovieAddonsNamespace } from "./addons";
import { MovieCollectionsNamespace } from "./collections";
import { MovieWatchProgressesNamespace } from "./watchProgress";

export * from "./types";
export * from "./addons";
export * from "./collections";
export * from "./watchProgress";

/**
 * The `movies` namespace, reachable as `oms.movies`.
 *
 * Everything under it needs a session or a personal token. An OAuth access
 * token cannot reach any of it: every route answers
 * `403 {"error":"insufficient_scope", "message": "This endpoint is not
 * reachable with an OAuth access token..."}` - one of the few structured error
 * bodies the API emits. That is a deliberate gate, not an oversight to route
 * around.
 */
export class MoviesNamespace extends Resource {
  /** Installed Stremio addons, plus `.groups` and `.grants` for sharing them. */
  readonly addons: MovieAddonsNamespace;
  /** Favourites and hand-made lists, plus `.items` for their contents. */
  readonly collections: MovieCollectionsNamespace;
  /** Playback position per title or episode; "Continuar a ver". */
  readonly watchProgress: MovieWatchProgressesNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.addons = new MovieAddonsNamespace(http);
    this.collections = new MovieCollectionsNamespace(http);
    this.watchProgress = new MovieWatchProgressesNamespace(http);
  }
}
