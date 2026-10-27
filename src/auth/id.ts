/**
 * id.omelhorsite.pt issues every credential: the device flow, the token
 * endpoint, revocation and userinfo all live there. The API accepts its access
 * tokens.
 */

/** The OpenID issuer. */
export const ID_ISSUER = "https://id.omelhorsite.pt";

/** The endpoints the `auth` namespace calls, relative to the client's `idUrl`. */
export const ID_PATHS = Object.freeze({
  deviceAuthorization: "/oauth/v2/device_authorization",
  token: "/oauth/v2/token",
  revoke: "/oauth/v2/revoke",
  userinfo: "/oidc/v1/userinfo",
});

/**
 * The `client_id` of each first-party client at id.omelhorsite.pt. Not a
 * secret: it travels in the clear in every device authorization request.
 */
export const ID_CLIENT_IDS = Object.freeze({
  cli: "397015403030672651",
  mcp: "397015428062278923",
  video: "397015430411089163",
});

/** A refresh token is only issued when `offline_access` is asked for. */
export function withOfflineAccess(scope: string | undefined): string {
  const scopes = (scope ?? "openid").split(/\s+/).filter(Boolean);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  if (!scopes.includes("offline_access")) scopes.push("offline_access");
  return scopes.join(" ");
}
