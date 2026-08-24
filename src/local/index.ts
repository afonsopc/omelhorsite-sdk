/**
 * The `local` namespace: tools that run entirely on the caller's side.
 *
 * Two of the site's tools never touch the API - the password generator and the
 * QR renderer - and there is no reason to make a network round trip to use
 * them from the SDK. They live here, grouped so they are discoverable next to
 * everything else, and reachable BOTH as `oms.local.password.generate(...)` and
 * as a bare `import { generatePassword } from "@omelhorsite/sdk"`.
 *
 * Nothing in here takes an {@link ApiClient}, so nothing in here can be a
 * {@link Resource}. That is the tell: if a function needs a credential or a
 * base URL, it belongs under `resources/`, not here.
 *
 * Re-exports every sibling module so nobody has to touch this file again.
 */

import { generatePassphrase, generatePassword, passwordEntropyBits, passwordStrength } from "./password";
import { encodeQr, qrToDataUri, qrToSvg } from "./qr";

export * from "./password";
export * from "./qr";
// `wordlist.ts` is deliberately not starred here: it holds one constant and
// `password.ts` already re-exports it, so a second star would export the same
// binding twice for no gain.

/**
 * The grouped form, mounted on the client as `oms.local`.
 *
 * Frozen: it is shared by every client instance, so a mutation would leak
 * across them.
 */
export const local = Object.freeze({
  /** Password and passphrase generation, backed by WebCrypto. */
  password: Object.freeze({
    generate: generatePassword,
    passphrase: generatePassphrase,
    strength: passwordStrength,
    entropyBits: passwordEntropyBits,
  }),
  /** QR encoding and SVG rendering. */
  qr: Object.freeze({
    encode: encodeQr,
    toSvg: qrToSvg,
    toDataUri: qrToDataUri,
  }),
});

/** Type of the grouped {@link local} namespace. */
export type LocalNamespace = typeof local;
