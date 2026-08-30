/**
 * The `passkeys` namespace: WebAuthn credentials, and the two ceremonies that
 * create and spend them.
 *
 * Six routes hang off `/webauthn_credentials`, and they split in two:
 *
 * | route                       | credential | ceiling            |
 * | --------------------------- | ---------- | ------------------ |
 * | `GET    /`                  | required   | general 600/min    |
 * | `DELETE /:id`               | required   | general 600/min    |
 * | `POST   /registration_options` | required | general 600/min   |
 * | `POST   /registration`      | required   | general 600/min    |
 * | `POST   /authentication_options` | **none** | **20/min per IP** |
 * | `POST   /authentication`    | **none**   | **20/min per IP**  |
 *
 * The last two share ONE bucket, not one each: the throttle matches every
 * path that starts with `/webauthn_credentials/authentication`, and
 * `/authentication_options` starts with that string. Twenty POSTs a minute
 * from an IP covers both halves of every login attempt, so a NATed office gets
 * ten sign-ins a minute between them. Budget accordingly, and see the note on
 * {@link PasskeysNamespace.authenticate} for why neither of those two methods
 * retries a `429` on its own.
 *
 * ## The payloads go over the wire verbatim, and that is load-bearing
 *
 * A WebAuthn ceremony payload is a nested record of base64url strings that the
 * authenticator signed. Change one byte of it, anywhere, and the signature no
 * longer matches something the server can reconstruct - and the server does not
 * say so in those words. It says `500`, or it says "Passkey could not be
 * verified", two minutes after the user pressed their fingerprint.
 *
 * The SDK's one body-shaped rewrite is the null sentinel, and it is written
 * into query strings only, never into a JSON body. A ceremony travels in the
 * BODY, and every method here passes the caller's object straight to
 * `http.post` with no copy, no reshaping, and no key filtering: a `null`
 * inside survives as `null`. `test/passkeys.test.ts` pins the serialised body
 * byte for byte.
 *
 * The corollary is that nothing here normalises for you either. If your
 * platform is loose about base64 padding, run the credential through
 * {@link normalizePasskeyRegistrationCredential} /
 * {@link normalizePasskeyAssertionCredential} BEFORE calling, at the call site,
 * where the change is visible. See {@link passkeyBase64Url} for why React
 * Native needs that and a browser does not.
 *
 * ## What this namespace does not do
 *
 * It never calls `navigator.credentials` and never touches a native passkey
 * module. That is the host's job, in the host's runtime, and it is the half
 * that differs between runtimes:
 *
 * - browser: `@simplewebauthn/browser`'s `startRegistration` /
 *   `startAuthentication`, which take `optionsJSON` in the exact shape
 *   {@link PasskeyRegistrationOptions} / {@link PasskeyAuthenticationOptions}
 *   describe and hand back the exact shape the credential types describe;
 * - React Native: `react-native-passkeys`, best loaded lazily because it
 *   throws at import time when the native module is not linked;
 * - Bun / a Worker: there is no authenticator. `list` and `remove` work,
 *   the ceremonies cannot.
 *
 * The SDK owns the transport and the types on both sides of that call.
 */

import { Resource } from "../../http";
import type { AccountSession } from "../account";
import type { BaseRecord, Id, RequestOptions, Timestamp } from "../../types";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * One registered passkey.
 *
 * The payload is exactly `id`, `created_at`, `updated_at`, `nickname`,
 * `last_used_at`, and it is the same five fields whether it came from
 * `POST /registration` or from `GET /`.
 *
 * Nothing about the credential itself is ever rendered. The credential id,
 * the public key and the sign counter stay on the server; there is no field
 * here that identifies the authenticator, so a UI cannot say "your YubiKey"
 * or "this phone" unless the user typed a nickname.
 *
 * `id` is a STRING, like users and sessions and unlike songs and playlists.
 * Never do arithmetic on it.
 */
export interface Passkey extends BaseRecord {
  /**
   * User-chosen label, or `null`.
   *
   * The server trims it and stores a blank as `null`, so `"  "` comes back as
   * `null`, not as the spaces that were sent. A UI that echoes what it just
   * submitted will show the wrong thing; read the answer instead.
   */
  readonly nickname: string | null;
  /**
   * When this passkey last completed a sign-in, or `null` if it never has.
   *
   * Every sign-in also bumps `updated_at`, so a passkey's `updated_at` tracks
   * its last use rather than its last edit. There is no edit: the record has
   * no update route.
   */
  readonly last_used_at: Timestamp | null;
}

/**
 * What `POST /webauthn_credentials/authentication` answers with: the session,
 * plus the token, exactly as `POST /sessions` answers a password sign-in.
 *
 * This is an {@link AccountSession} with a `token`. That token is the new
 * credential, and it is shown ONCE. Persist it here or lose it.
 *
 * A browser gets the same token a second way, as an httpOnly cookie set
 * alongside the body. That is why a cookie-mode client can ignore `token`
 * entirely and still be signed in after the post-login reload: it
 * authenticates by cookie and deliberately never stores a token where a
 * script could read it. A token-mode client does the opposite and reads
 * `token`.
 */
export interface PasskeySession extends AccountSession {
  /** The bearer token for the new session. Rendered once, here, and never again. */
  readonly token: string;
}

// ---------------------------------------------------------------------------
// Wire types: the ceremony
// ---------------------------------------------------------------------------

/**
 * An `ArrayBuffer` after the only encoding this API speaks: unpadded base64url.
 *
 * The server uses it in BOTH directions: everything it sends has its `=`
 * padding chomped off, and everything it reads back it decodes the same way.
 *
 * A type alias, not a branded type, because a brand would force every caller to
 * cast the strings their platform just handed them and would buy nothing: the
 * check that matters happens on the server, over bytes. {@link passkeyBase64Url}
 * is the runtime check, for callers who want one.
 */
export type PasskeyBase64Url = string;

/** The three user-verification levels WebAuthn defines. */
export type PasskeyUserVerification = "required" | "preferred" | "discouraged";

/**
 * How an authenticator is reachable. The registered set is small, but the spec
 * grows it and a platform may report one this SDK has not heard of, so unknown
 * strings are accepted rather than rejected: the server stores transports as
 * opaque strings and never matches on them.
 */
export type PasskeyTransport = "usb" | "nfc" | "ble" | "smart-card" | "hybrid" | "internal" | (string & {});

/**
 * One credential the ceremony should exclude (registration) or allow
 * (authentication).
 *
 * The server emits `type` and `id` and NEVER `transports`, so a descriptor
 * that arrives from this API has exactly two keys. `transports` is here for
 * the other direction, where a platform reports it.
 */
export interface PasskeyCredentialDescriptor {
  readonly type: "public-key";
  /** The credential id, base64url. */
  readonly id: PasskeyBase64Url;
  readonly transports?: readonly PasskeyTransport[];
}

/** The relying party: `"O Melhor Site"` at `omelhorsite.pt`. */
export interface PasskeyRelyingParty {
  readonly name: string;
  /**
   * The registrable domain that owns the credential. Always sent.
   *
   * It is the domain of the UI, NOT of the API. Passkeys minted here are scoped
   * to `omelhorsite.pt` and its subdomains; `backend.omelhorsite.pt` serves the
   * ceremony but is not where it runs.
   */
  readonly id: string;
}

/**
 * The account the passkey will belong to.
 *
 * `id` is a server-minted opaque handle that exists for exactly this purpose,
 * assigned lazily on the first call to
 * {@link PasskeysNamespace.registrationOptions}. It is NOT the user's `id`, and the
 * distinction is the point: the value is stored on the authenticator, is
 * readable by anyone who gets hold of the device, and must therefore say
 * nothing about the account. `name` and `displayName`, by contrast, ARE the
 * email and the real name, because the OS shows them in the account picker.
 */
export interface PasskeyUserEntity {
  readonly id: PasskeyBase64Url;
  /** The account's email address. Shown by the OS. */
  readonly name: string;
  /** The account's display name. Shown by the OS. */
  readonly displayName: string;
}

/** One COSE algorithm the relying party will accept, by its registered id. */
export interface PasskeyCredentialParameter {
  readonly type: "public-key";
  /** COSE identifier: `-7` ES256, `-37` PS256, `-257` RS256, in that order. */
  readonly alg: number;
}

/** Constraints on which authenticator may answer, and how. */
export interface PasskeyAuthenticatorSelection {
  readonly authenticatorAttachment?: "platform" | "cross-platform";
  readonly residentKey?: "required" | "preferred" | "discouraged";
  readonly requireResidentKey?: boolean;
  readonly userVerification?: PasskeyUserVerification;
}

/**
 * `POST /webauthn_credentials/registration_options` - the arguments for
 * `navigator.credentials.create()`, camelCased and base64url-encoded.
 *
 * Every optional field below is optional because the server drops a falsy
 * attribute, not because it sometimes omits a field on purpose. What it
 * actually sends:
 *
 * - `challenge`, `timeout` (120000), `extensions` (`{}`), `rp`, `user`,
 *   `pubKeyCredParams` (ES256, PS256, RS256), `authenticatorSelection`
 *   (`residentKey` and `userVerification`, both `"preferred"`), and
 *   `excludeCredentials`, which is `[]` for an account with no passkeys yet
 *   rather than absent;
 * - NOT `attestation`. The key is absent, so the platform applies its own
 *   default (`"none"`).
 *
 * Pass this object to the platform whole. Do not rebuild it field by field
 * unless your platform needs you to: `react-native-passkeys` does, because its
 * native Record decoder trips on `extensions: {}`.
 */
export interface PasskeyRegistrationOptions {
  readonly challenge: PasskeyBase64Url;
  /** Milliseconds the platform may keep its sheet open. 120000. See the TTL warning on {@link PasskeysNamespace.registrationOptions}. */
  readonly timeout?: number;
  readonly extensions?: Record<string, unknown>;
  readonly rp: PasskeyRelyingParty;
  readonly user: PasskeyUserEntity;
  readonly pubKeyCredParams: readonly PasskeyCredentialParameter[];
  readonly attestation?: string;
  readonly authenticatorSelection?: PasskeyAuthenticatorSelection;
  /**
   * The passkeys this account already has, so the authenticator refuses to
   * enrol itself twice. Present but empty for a first passkey.
   *
   * This is what makes "register" idempotent from the user's point of view, and
   * it is enforced by the AUTHENTICATOR, not by the server: re-registering an
   * excluded device fails in the OS sheet, so the caller sees a platform error
   * and never an HTTP one.
   */
  readonly excludeCredentials?: readonly PasskeyCredentialDescriptor[];
}

/**
 * `options` from `POST /webauthn_credentials/authentication_options` - the
 * arguments for `navigator.credentials.get()`.
 *
 * `allowCredentials` is always present and always `[]`: the server sends no
 * allow list, and spells that as `[]` rather than omitting the key. An empty
 * allow list IS the feature - it makes the ceremony discoverable, so the OS
 * offers whatever passkeys it holds for the domain and the user picks an
 * account. That is why sign-in needs no email field.
 *
 * `rpId` is always present too, which matters because `react-native-passkeys`
 * requires it.
 */
export interface PasskeyAuthenticationOptions {
  readonly challenge: PasskeyBase64Url;
  readonly timeout?: number;
  readonly extensions?: Record<string, unknown>;
  /** Empty, and deliberately so: an empty allow list means discoverable login. */
  readonly allowCredentials?: readonly PasskeyCredentialDescriptor[];
  /** `"omelhorsite.pt"` in production, `"localhost"` in development. */
  readonly rpId: string;
  readonly userVerification?: PasskeyUserVerification;
}

/**
 * The whole answer from `POST /webauthn_credentials/authentication_options`:
 * the ceremony arguments plus the handle that identifies the challenge.
 *
 * The handle exists because the login ceremony has no session to key a
 * challenge against. The server keeps the challenge under the handle and hands
 * you the handle; you give it back with the assertion. Treat it as a
 * single-use nonce: it is a random UUID, it lives two minutes, and
 * {@link PasskeysNamespace.authenticate} spends it.
 */
export interface PasskeyAuthenticationChallenge {
  readonly handle: string;
  readonly options: PasskeyAuthenticationOptions;
}

/**
 * What the authenticator produced during registration, ready to be posted back.
 *
 * `id` and `rawId` are BOTH required, and both must be the same credential id
 * in base64url. This is not belt-and-braces: the server decodes each one
 * separately and compares the BYTES. Send them out of step and you get a
 * `500`, not a `400` - see the warning on {@link PasskeysNamespace.register}.
 *
 * The server reads `clientDataJSON`, `attestationObject` and `transports` from
 * `response` and ignores anything else in it, so a browser's `getPublicKey()` /
 * `publicKey` extras are harmless. They are also pointless bytes on a phone's
 * connection.
 */
export interface PasskeyRegistrationCredential {
  readonly id: PasskeyBase64Url;
  /** The same id again. Required, non-null: see the type's own note. */
  readonly rawId: PasskeyBase64Url;
  readonly type: "public-key";
  readonly response: {
    readonly clientDataJSON: PasskeyBase64Url;
    readonly attestationObject: PasskeyBase64Url;
    readonly transports?: readonly PasskeyTransport[];
  };
  readonly authenticatorAttachment?: string;
  /** Whatever the client extensions returned. `{}` when there were none. */
  readonly clientExtensionResults?: Record<string, unknown>;
}

/**
 * What the authenticator produced during sign-in, ready to be posted back.
 *
 * Same `id` / `rawId` rule as {@link PasskeyRegistrationCredential}, same
 * consequence for getting it wrong.
 *
 * `userHandle` is what a discoverable ceremony returns as the account the user
 * picked, and this server does NOT read it: it looks the credential up by its
 * id instead. Send it anyway if the platform gave you one, but do
 * not synthesise one, and never treat its absence as a failure.
 */
export interface PasskeyAssertionCredential {
  readonly id: PasskeyBase64Url;
  /** The same id again. Required, non-null: see {@link PasskeyRegistrationCredential}. */
  readonly rawId: PasskeyBase64Url;
  readonly type: "public-key";
  readonly response: {
    readonly clientDataJSON: PasskeyBase64Url;
    readonly authenticatorData: PasskeyBase64Url;
    readonly signature: PasskeyBase64Url;
    readonly userHandle?: PasskeyBase64Url;
  };
  readonly authenticatorAttachment?: string;
  readonly clientExtensionResults?: Record<string, unknown>;
}

/** Arguments for {@link PasskeysNamespace.register}. */
export interface RegisterPasskeyInput {
  /** The attestation the platform just produced. Sent verbatim. */
  readonly credential: PasskeyRegistrationCredential;
  /**
   * Optional label. Blank and whitespace-only strings are stored as `null`,
   * so there is no point sending `" "` to clear
   * anything - there is nothing to clear, the record cannot be updated.
   */
  readonly nickname?: string;
}

/** Arguments for {@link PasskeysNamespace.authenticate}. */
export interface AuthenticatePasskeyInput {
  /** The assertion the platform just produced. Sent verbatim. */
  readonly credential: PasskeyAssertionCredential;
  /** The `handle` from {@link PasskeysNamespace.authenticationOptions}. Single use. */
  readonly handle: string;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Any base64 alphabet, standard or URL-safe, once padding has been stripped. */
const BASE64_ANY = /^[A-Za-z0-9+/_-]+$/;

/** The URL-safe alphabet only. */
const BASE64URL_ONLY = /^[A-Za-z0-9_-]+$/;

/**
 * Canonicalises one ceremony field into unpadded base64url.
 *
 * Accepts standard base64 and base64url, padded or not, and always emits
 * unpadded base64url: `+` becomes `-`, `/` becomes `_`, trailing `=` goes away.
 *
 * ## Who needs this
 *
 * A browser does not. `@simplewebauthn/browser` already emits unpadded
 * base64url on both sides, so a browser credential can be posted straight
 * through.
 *
 * React Native does. Each platform re-encodes in its own native layer on the
 * way out of the OS, and they do not agree with each other about padding; iOS
 * in particular re-pads on the way in and strips on the way out. That would be
 * harmless if the server were lenient, and on most fields it is - it re-pads a
 * short string and accepts either alphabet. It is NOT lenient about one
 * thing: it decodes `id` and `rawId` SEPARATELY and demands
 * identical bytes, so a platform that pads one and not the other loses the
 * ceremony at the very last step, with a 500 and nothing in the message.
 *
 * Isolate-safe: two regexes and string methods, no platform API at all.
 *
 * @param field Name used in the error message. The VALUE is never included:
 *   these strings are signed material and a `clientDataJSON` in a log is a
 *   record of who signed in from where.
 * @throws {TypeError} when the value is not a string, is empty, is outside both
 *   base64 alphabets, or has a length of `1 mod 4`. That last one is not a
 *   padding question: no base64 string is ever 1 mod 4 characters long, so such
 *   a value is truncated, and re-padding it would produce plausible bytes that
 *   fail verification much later.
 */
export function passkeyBase64Url(value: unknown, field: string): PasskeyBase64Url {
  if (typeof value !== "string") throw new TypeError(`${field}: expected a base64url string, got ${typeof value}.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${field}: empty.`);
  const unpadded = trimmed.replace(/=+$/, "");
  if (!BASE64_ANY.test(unpadded)) throw new TypeError(`${field}: not base64.`);
  const url = unpadded.replace(/\+/g, "-").replace(/\//g, "_");
  if (url.length % 4 === 1) throw new TypeError(`${field}: truncated base64 (length is 1 mod 4).`);
  return url;
}

/**
 * Non-throwing predicate for a value that is ALREADY canonical unpadded
 * base64url. Use it to decide whether normalising is needed at all;
 * {@link passkeyBase64Url} is what does the normalising.
 */
export function isPasskeyBase64Url(value: unknown): value is PasskeyBase64Url {
  return typeof value === "string" && value.length > 0 && BASE64URL_ONLY.test(value) && value.length % 4 !== 1;
}

/** Reads an optional list of transport strings, dropping anything unusable. */
function transportList(value: unknown): PasskeyTransport[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  // An empty list is returned as `undefined` rather than `[]` on purpose: the
  // server reads an empty array in a request body as absent anyway.
  return list.length > 0 ? list : undefined;
}

/** Reads an optional object field, defaulting to `undefined` rather than `{}`. */
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) throw new TypeError(`${field}: expected an object.`);
  return record;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Android's Kotlin credential record declares `rawId: String? = null`, so it
 * genuinely arrives absent. Falling back to `id` is correct rather than merely
 * convenient: they are the same value by definition, and the server compares
 * their decoded bytes.
 *
 * Sending the `null` through instead is the failure this exists to prevent:
 * the server answers a `500` with no clue in it.
 */
function resolveRawId(source: Record<string, unknown>, id: PasskeyBase64Url): PasskeyBase64Url {
  return source.rawId === undefined || source.rawId === null ? id : passkeyBase64Url(source.rawId, "credential.rawId");
}

/**
 * Rebuilds a registration credential in the canonical encoding, keeping only
 * the fields the server reads.
 *
 * Call it at the call site, on what the platform handed you, and pass the
 * result to {@link PasskeysNamespace.register}. It is NOT applied inside
 * `register`, because the promise this namespace makes is that what you pass is
 * what goes on the wire; a silent rewrite of signed material is exactly the
 * thing that must not happen behind a caller's back.
 *
 * Drops `getPublicKey`, `publicKey`, `getPublicKeyAlgorithm` and
 * `getAuthenticatorData` from `response`: the server reads `clientDataJSON`,
 * `attestationObject` and `transports` and nothing else, and the dropped
 * fields are large.
 *
 * @throws {TypeError} through {@link passkeyBase64Url} when a required field is
 *   missing or not base64.
 */
export function normalizePasskeyRegistrationCredential(raw: unknown): PasskeyRegistrationCredential {
  const source = requireRecord(raw, "credential");
  const response = requireRecord(source.response, "credential.response");
  const id = passkeyBase64Url(source.id, "credential.id");
  const transports = transportList(response.transports);
  const attachment = optionalString(source.authenticatorAttachment);
  const extensions = optionalRecord(source.clientExtensionResults);

  return {
    id,
    rawId: resolveRawId(source, id),
    type: "public-key",
    response: {
      clientDataJSON: passkeyBase64Url(response.clientDataJSON, "credential.response.clientDataJSON"),
      attestationObject: passkeyBase64Url(response.attestationObject, "credential.response.attestationObject"),
      ...(transports ? { transports } : {}),
    },
    ...(attachment ? { authenticatorAttachment: attachment } : {}),
    ...(extensions ? { clientExtensionResults: extensions } : {}),
  };
}

/**
 * Rebuilds an assertion credential in the canonical encoding. The companion of
 * {@link normalizePasskeyRegistrationCredential}, with the same contract and
 * the same reason for not being applied automatically.
 *
 * `userHandle` is dropped when the platform reported it as `null` or `""`,
 * which several do for a non-discoverable credential. The server does not read
 * it, so an absent one costs nothing, whereas an empty string would have to
 * survive `passkeyBase64Url` and could not.
 *
 * @throws {TypeError} when a required field is missing or not base64.
 */
export function normalizePasskeyAssertionCredential(raw: unknown): PasskeyAssertionCredential {
  const source = requireRecord(raw, "credential");
  const response = requireRecord(source.response, "credential.response");
  const id = passkeyBase64Url(source.id, "credential.id");
  const attachment = optionalString(source.authenticatorAttachment);
  const extensions = optionalRecord(source.clientExtensionResults);
  const rawUserHandle = response.userHandle;
  const userHandle =
    rawUserHandle === undefined || rawUserHandle === null || rawUserHandle === ""
      ? undefined
      : passkeyBase64Url(rawUserHandle, "credential.response.userHandle");

  return {
    id,
    rawId: resolveRawId(source, id),
    type: "public-key",
    response: {
      clientDataJSON: passkeyBase64Url(response.clientDataJSON, "credential.response.clientDataJSON"),
      authenticatorData: passkeyBase64Url(response.authenticatorData, "credential.response.authenticatorData"),
      signature: passkeyBase64Url(response.signature, "credential.response.signature"),
      ...(userHandle ? { userHandle } : {}),
    },
    ...(attachment ? { authenticatorAttachment: attachment } : {}),
    ...(extensions ? { clientExtensionResults: extensions } : {}),
  };
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

/** The `passkeys` namespace, reachable as `oms.passkeys`. */
export class PasskeysNamespace extends Resource {
  /**
   * `GET /webauthn_credentials` - every passkey of the signed-in user, newest
   * first.
   *
   * Returns a plain array, and that is the whole story: unlike almost every
   * other index in this API it has NO list DSL, NO `modifiers[page]`, NO
   * `search` / `exact_search`, and NO `ETag` / `304`. Sending those parameters
   * is not an error either: a filter is silently ignored rather than rejected
   * with a `400`.
   *
   * Hence no `Paginated` and no `PageParams` here. An account's passkey count
   * is bounded by how many devices a person owns, and the server would return
   * all of them regardless of what was asked.
   *
   * The order is newest-created first, so it does not change when a passkey
   * is used.
   *
   * Requires a credential. General authenticated ceiling, 600/min.
   *
   * @throws {OmsAuthError} 401 with no credential.
   */
  async list(options: RequestOptions = {}): Promise<Passkey[]> {
    return this.http.get<Passkey[]>("/webauthn_credentials", options);
  }

  /**
   * `DELETE /webauthn_credentials/:id` - removes one passkey. `204`, no body.
   *
   * The lookup is scoped to the caller, so somebody else's id is a `404` and
   * never a `403`: the endpoint does not confirm that the id exists. An
   * administrator is no exception.
   *
   * Nothing stops the last passkey being removed. There is no "you would lock
   * yourself out" guard, because passwords and OAuth identities are still
   * there; a caller whose UI presents passkeys as the only sign-in method owns
   * that warning itself.
   *
   * Deleting is one-way and the credential on the device is NOT revoked - the
   * user keeps a dead passkey in their OS keychain that will offer itself at
   * the next sign-in and then fail with "Unknown passkey."
   *
   * Requires a credential. General authenticated ceiling, 600/min.
   *
   * @throws {OmsApiError} 404 `"Passkey not found."` for an unknown id, or for
   *   one belonging to someone else.
   */
  async remove(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/webauthn_credentials/${encodeURIComponent(id)}`, options);
  }

  /**
   * `POST /webauthn_credentials/registration_options` - starts enrolment and
   * returns the arguments for `navigator.credentials.create()`.
   *
   * Two side effects, both of which matter:
   *
   * 1. **It assigns the account's WebAuthn user handle on first use.** An
   *    account that has never touched passkeys gets one minted here. That
   *    handle is then permanent and is what every passkey on this account is
   *    bound to.
   * 2. **It caches a challenge under a key that is per USER, not per call.**
   *    Calling this twice for one account
   *    OVERWRITES the first challenge, so two registrations in flight at once
   *    means the older one fails verification with "Registration challenge
   *    expired" even though nothing expired. Do not call it speculatively, do
   *    not call it to warm a screen, and do not let a button fire it twice.
   *
   * The challenge lives **two minutes**, and the `timeout`
   * inside the options is also 120000. Those are the same number, and the cache
   * clock starts BEFORE the response is even sent, so a user who lets the OS
   * sheet sit open for its full advertised timeout arrives after the challenge
   * has gone. Treat 2 minutes as the budget for the whole round trip.
   *
   * Requires a credential. General authenticated ceiling, 600/min.
   *
   * An empty JSON object is sent as the body. The server reads nothing from
   * it; it is there so the request carries `Content-Type: application/json`
   * like every other POST in this API rather than arriving bodyless.
   */
  async registrationOptions(options: RequestOptions = {}): Promise<PasskeyRegistrationOptions> {
    return this.http.post<PasskeyRegistrationOptions>("/webauthn_credentials/registration_options", {}, options);
  }

  /**
   * `POST /webauthn_credentials/registration` - finishes enrolment. `201` with
   * the new {@link Passkey}.
   *
   * `input.credential` is posted VERBATIM. Nothing here copies it, reshapes it,
   * filters its keys or rewrites a `null` inside it, because the server checks
   * a signature over those exact bytes.
   *
   * ## The failure modes, and which of them are honest
   *
   * A verification failure is a `400`. Some of what can go wrong here is not
   * treated as one, and reaches you as a `500`:
   *
   * - `type` that is not exactly `"public-key"`, or an `id` and `rawId` whose
   *   decoded bytes differ;
   * - `rawId` absent or `null`. See {@link normalizePasskeyRegistrationCredential},
   *   which fills `rawId` from `id` for the Android case where the platform
   *   really does send `null`.
   *
   * `credential` absent altogether is the one malformed shape that is still a
   * `400`.
   *
   * So a `500` from this endpoint is a malformed payload, not an outage, and it
   * is the single most likely thing to be wrong on a client that hand-builds
   * the credential. A genuine verification failure - wrong challenge, wrong
   * origin, bad attestation - is the `400` `"Passkey registration could not be
   * verified."`.
   *
   * The default retry policy applies, which for a POST means only a `429` is
   * replayed. That is safe here: the challenge is only deleted after a
   * successful save, so a rate-limited attempt leaves the ceremony intact.
   *
   * Requires a credential. General authenticated ceiling, 600/min - this route
   * is NOT in the 20/min webauthn bucket, which covers `authentication*` only.
   *
   * @throws {OmsAuthError} 401 `"Registration challenge expired. Please try
   *   again."` when more than two minutes passed since
   *   {@link registrationOptions}, or when a second call to it overwrote this
   *   ceremony's challenge.
   * @throws {OmsApiError} 400 when verification fails, or when the passkey
   *   cannot be stored - which in practice means this authenticator is already
   *   registered and `excludeCredentials` did not stop it.
   */
  async register(input: RegisterPasskeyInput, options: RequestOptions = {}): Promise<Passkey> {
    return this.http.post<Passkey>(
      "/webauthn_credentials/registration",
      // The credential object is referenced, never spread: a copy would be an
      // opportunity to lose a key, and there is nothing to gain by making one.
      input.nickname === undefined
        ? { credential: input.credential }
        : { credential: input.credential, nickname: input.nickname },
      options,
    );
  }

  /**
   * `POST /webauthn_credentials/authentication_options` - starts a sign-in and
   * returns the challenge handle plus the arguments for
   * `navigator.credentials.get()`.
   *
   * **Send this with NO credential.** The route accepts anonymous callers,
   * and the whole point is that there is no session yet. The transport always
   * attaches `Authorization` when the client
   * holds a token, and the caller cannot strip it per request, so a client that
   * might be signed in should build an anonymous one for the login flow.
   *
   * The ceremony is discoverable: `allowCredentials` comes back empty, the OS
   * shows every passkey it holds for the domain, and the user picks the
   * account. There is no email step, and asking for one would not help.
   *
   * Each call mints a fresh `handle` and caches a challenge under it for two
   * minutes, so unlike {@link registrationOptions} concurrent calls do not
   * fight: they are independent ceremonies. They do share the rate limit.
   *
   * **20 requests per minute per IP, shared with {@link authenticate}.**
   *
   * Retrying is off here, which deviates from the transport's default of
   * replaying a `429`. The reason is the clock rather than safety: the replay
   * sleeps out `Retry-After`, which the server sets from a one-minute window,
   * and then hands back a challenge that lives two minutes and still has an OS
   * sheet and a second rate-limited request ahead of it. Waiting silently
   * inside the SDK is likelier to produce a login that dies at the last step
   * than one that succeeds. Surfacing the `429` lets the caller back off
   * visibly and start a fresh ceremony. Pass `retry: {}` to opt back in.
   *
   * @throws {OmsQuotaError} 429 when the shared per-IP bucket is spent.
   */
  async authenticationOptions(options: RequestOptions = {}): Promise<PasskeyAuthenticationChallenge> {
    return this.http.post<PasskeyAuthenticationChallenge>(
      "/webauthn_credentials/authentication_options",
      {},
      { retry: false, ...options },
    );
  }

  /**
   * `POST /webauthn_credentials/authentication` - finishes a sign-in. `201`
   * with a {@link PasskeySession} carrying the new token.
   *
   * **Send this with NO credential** and read `token` off the answer; that
   * token is the credential from here on. A browser additionally receives the
   * same token as an httpOnly cookie and can ignore the body field entirely.
   *
   * `input.credential` is posted VERBATIM, for the same reason and with the
   * same care as {@link register}.
   *
   * ## An assertion is spent exactly once, so nothing here is replayed
   *
   * The server discards the challenge BEFORE it verifies anything. Once a
   * request has reached it the handle is gone whatever the outcome, so a
   * second attempt carrying the same body answers `401 "Login
   * challenge expired."` and reports the wrong cause for whatever actually
   * went wrong.
   *
   * The transport's default policy already declines to replay a `POST` after a
   * torn connection or a `5xx`, which is exactly right for that reason. The one
   * outcome it WOULD replay is a `429`, and this method turns that off as well.
   * A `429` is answered before the request is performed, so it genuinely did
   * not spend the handle; but `Retry-After` is set from a one-minute window,
   * the challenge lives two minutes, and the OS sheet has already eaten part of
   * that. Sleeping through the rate limit inside the SDK converts it into an
   * expired challenge, silently, and reports the failure at the wrong endpoint.
   * Surface it instead and start a new ceremony from
   * {@link authenticationOptions}.
   *
   * A `500` here means the same malformed-payload family described on
   * {@link register}: a missing `rawId`, a wrong `type`, an `id` that does not
   * decode to the same bytes as `rawId`.
   *
   * **20 requests per minute per IP, shared with
   * {@link authenticationOptions}.** Every sign-in attempt costs two.
   *
   * @throws {OmsAuthError} 401 for all five of: an expired or already-spent
   *   handle (`"Login challenge expired. Please try again."`); a credential the
   *   server has never seen (`"Unknown passkey."`); a deactivated account
   *   (`"This account is deactivated."`); a failed signature, wrong origin or
   *   wrong challenge (`"Passkey could not be verified."`); and a sign counter
   *   that did not advance, which the server treats as a cloned authenticator
   *   and reports as that same message. Note that passkeys synced through a
   *   keychain report a counter of `0` forever, and `0` against `0` is let
   *   through, so that last case does not fire for them.
   * @throws {OmsQuotaError} 429 when the shared per-IP bucket is spent.
   */
  async authenticate(input: AuthenticatePasskeyInput, options: RequestOptions = {}): Promise<PasskeySession> {
    return this.http.post<PasskeySession>(
      "/webauthn_credentials/authentication",
      { credential: input.credential, handle: input.handle },
      { retry: false, ...options },
    );
  }
}
