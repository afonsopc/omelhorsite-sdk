/**
 * Session authentication: the credential the website and the mobile apps use.
 *
 * This is NOT `src/auth/`. The SDK has two authentication systems because the
 * API has two, and they are not two spellings of one thing:
 *
 * | | `src/auth/` -> `oms.auth` | this directory |
 * |---|---|---|
 * | credential | OAuth access token (JWT) | opaque `Session` token or cookie |
 * | who issues it | `/oauth/token`, the device grant | `POST /sessions/adopt` |
 * | authority | only the granted scopes | the whole account |
 * | who uses it | third-party apps and automation | first-party apps |
 * | reaches | endpoints declaring an `oauth_scope` | everything |
 *
 * `enforce_oauth_scope!` denies by omission, so an OAuth token cannot reach
 * most of the API at all. A first-party client signs in with
 * OAuth through Pocket ID and holds a session token;
 * a third-party client does the device grant and holds a scoped one.
 *
 * The two namespaces mount at the top level rather than under a shared parent,
 * because `oms.auth` is already taken by OAuth:
 *
 * ```ts
 * // Send the browser to `${baseUrl}/auth/pocket_id?mode=signin`; it comes back
 * // with `?ticket=...`.
 * const anon = new Oms({ baseUrl });
 * const session = await anon.sessions.adopt(ticket);
 * const oms = new Oms({ baseUrl, token: session.token });
 *
 * await oms.account.sessions.list();  // the sessions you already have
 * await oms.sessions.signOut();       // end the one you are holding
 * ```
 *
 * Note the neighbouring `oms.account.sessions`, which lists and relabels
 * sessions. The split is deliberate: this namespace CREATES and DESTROYS the
 * credential, `account.sessions` administers the ones that exist.
 */

export * from "./sessions";
