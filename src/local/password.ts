/**
 * Password and passphrase generation. Local, offline, no credential.
 *
 * Randomness comes from `crypto.getRandomValues`, which every target runtime
 * has (browser, Worker, Bun, Node 19+). `Math.random` is NEVER acceptable here
 * and no fallback to it exists: if the platform has no WebCrypto, these
 * functions throw rather than quietly producing a guessable string.
 *
 * Selecting a character from an alphabet must use rejection sampling, not
 * `random % alphabet.length`: the modulo skews the distribution towards the
 * first `2^n mod len` characters, which is exactly the bias an attacker's
 * dictionary is built around.
 */

import { EFF_LONG_WORDLIST } from "./wordlist";

export { EFF_LONG_WORDLIST } from "./wordlist";

/** `a-z`. */
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

/** `A-Z`. */
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** `0-9`. */
const DIGITS = "0123456789";

/**
 * Punctuation the generator draws from.
 *
 * Four ASCII marks are deliberately missing: `"`, `'`, `` ` `` and `\`. They
 * survive a password field perfectly well and then break the first shell
 * command, CSV export or JSON blob the password is pasted into, which is how a
 * password ends up being reset rather than used. Put them back through
 * {@link PasswordAlphabet.extra} if your policy demands them.
 */
const SYMBOLS = "!#$%&()*+,-./:;<=>?@[]^_{|}~";

/**
 * Characters {@link PasswordAlphabet.avoidAmbiguous} removes: zero and capital
 * O, one and lowercase L and capital i, and the pipe that reads as any of them
 * in a narrow font.
 */
const AMBIGUOUS = "0O1lI|";

/** Bits of entropy a class contributes to {@link passwordStrength}'s estimate. */
const CLASS_SIZES = Object.freeze({
  lowercase: 26,
  uppercase: 26,
  digits: 10,
  /**
   * The 32 ASCII punctuation marks plus the space, not the 28 the generator
   * uses. The estimator has to describe a password it did not produce, and
   * assuming the smaller pool would overstate how much work a search costs.
   */
  symbols: 33,
});

/** Which character classes a generated password may draw from. */
export interface PasswordAlphabet {
  /** `a-z`. Defaults to true. */
  readonly lowercase?: boolean;
  /** `A-Z`. Defaults to true. */
  readonly uppercase?: boolean;
  /** `0-9`. Defaults to true. */
  readonly digits?: boolean;
  /** Punctuation. Defaults to true. See {@link SYMBOLS} for what is in it. */
  readonly symbols?: boolean;
  /**
   * Drop characters that are hard to tell apart when read aloud or off a
   * screen: `0O1lI|`. Defaults to false. Costs about 0.4 bits per character at
   * the full alphabet, which four extra characters of length more than repay.
   */
  readonly avoidAmbiguous?: boolean;
  /**
   * Extra characters to allow, beyond the classes above. Duplicates - of each
   * other or of a class already enabled - are collapsed, so a character cannot
   * be listed twice and skew the draw towards itself.
   */
  readonly extra?: string;
}

/** Options for {@link generatePassword}. */
export interface GeneratePasswordOptions extends PasswordAlphabet {
  /** Characters to produce. Defaults to 20. */
  readonly length?: number;
  /**
   * Guarantee at least one character from every enabled class.
   *
   * Defaults to true because password policies demand it. It costs a little
   * entropy: the result is a uniform draw from a smaller set, not from the
   * full alphabet. {@link passwordEntropyBits} accounts for the alphabet only,
   * so it slightly overstates a password generated this way.
   *
   * `extra` is not a class and is never forced.
   */
  readonly requireEachClass?: boolean;
}

/** Options for {@link generatePassphrase}. */
export interface GeneratePassphraseOptions {
  /** Words to join. Defaults to 5, which is the point where these get strong. */
  readonly words?: number;
  /** Separator between words. Defaults to `"-"`. */
  readonly separator?: string;
  /** Capitalise the first letter of each word. Defaults to false. */
  readonly capitalize?: boolean;
  /**
   * Append a random digit to one of the words, for policies that demand one.
   * Worth about 3.3 bits plus the choice of which word; it is a compliance
   * feature, not a security one.
   */
  readonly includeNumber?: boolean;
  /**
   * Word list to draw from. Defaults to {@link EFF_LONG_WORDLIST}. Supply your
   * own to generate in another language - the strength then follows YOUR list's
   * size, so a 200-word list makes a weak passphrase however many words you ask
   * for. Duplicate entries are not removed and would bias the draw.
   */
  readonly wordlist?: readonly string[];
}

/** How strong a password looks, for a meter in a UI. */
export interface PasswordStrength {
  /** Shannon entropy of the generator that could have produced it, in bits. */
  readonly bits: number;
  /** Coarse bucket derived from `bits`, for colouring a bar. */
  readonly label: "very-weak" | "weak" | "fair" | "strong" | "very-strong";
  /** Which classes appear in the string. */
  readonly classes: {
    readonly lowercase: boolean;
    readonly uppercase: boolean;
    readonly digits: boolean;
    /** True for any character that is not an ASCII letter or digit, accents included. */
    readonly symbols: boolean;
  };
  /** Distinct characters used. A long password of two characters is not long. */
  readonly uniqueChars: number;
}

/**
 * Generates a random password.
 *
 * ```ts
 * generatePassword();                                  // 20 chars, all classes
 * generatePassword({ length: 32, symbols: false });     // alphanumeric only
 * generatePassword({ length: 16, avoidAmbiguous: true }); // safe to read aloud
 * ```
 *
 * @throws {RangeError} when `length` is not a positive integer, when the
 *   options leave no characters to draw from, or when `requireEachClass` needs
 *   more characters than `length` allows.
 * @throws {Error} when the runtime has no `crypto.getRandomValues`.
 */
export function generatePassword(options: GeneratePasswordOptions = {}): string {
  const length = options.length ?? 20;
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`Password length must be a positive integer, got ${String(options.length)}.`);
  }

  const alphabet = buildAlphabet(options);
  if (alphabet.length === 0) {
    throw new RangeError("No characters to draw from: every class is disabled and `extra` is empty.");
  }

  const requireEachClass = options.requireEachClass ?? true;
  const required = requireEachClass ? enabledClassPools(options) : [];

  if (required.length > length) {
    throw new RangeError(
      `A ${length}-character password cannot contain one of each of the ${required.length} enabled classes. ` +
        "Raise `length` or set `requireEachClass: false`.",
    );
  }

  const chars: string[] = [];
  for (const pool of required) chars.push(pickFrom(pool));
  while (chars.length < length) chars.push(pickFrom(alphabet));

  // The forced characters went in first, so without this they would always sit
  // at the front in class order - a pattern worth exactly as much to an
  // attacker as it sounds.
  shuffle(chars);
  return chars.join("");
}

/**
 * Generates a passphrase from a word list.
 *
 * ```ts
 * generatePassphrase();                                // "cactus-mural-...-..."
 * generatePassphrase({ words: 7, separator: " " });
 * ```
 *
 * Words are drawn WITH replacement, so a word can repeat. That is deliberate:
 * drawing without replacement would make each word depend on the ones before
 * it and quietly lower the entropy of the phrase.
 *
 * @throws {RangeError} when `words` is not a positive integer or the word list
 *   is empty.
 * @throws {Error} when the runtime has no `crypto.getRandomValues`.
 */
export function generatePassphrase(options: GeneratePassphraseOptions = {}): string {
  const count = options.words ?? 5;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Passphrase word count must be a positive integer, got ${String(options.words)}.`);
  }

  const wordlist = options.wordlist ?? EFF_LONG_WORDLIST;
  if (wordlist.length === 0) throw new RangeError("The word list is empty.");

  const separator = options.separator ?? "-";
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const word = wordlist[randomInt(wordlist.length)];
    words.push(options.capitalize ? capitalizeWord(word) : word);
  }

  if (options.includeNumber) {
    const at = randomInt(words.length);
    words[at] = `${words[at]}${randomInt(10)}`;
  }

  return words.join(separator);
}

/**
 * Describes a password's strength.
 *
 * This is an ENTROPY ESTIMATE of the alphabet, not a crack-time prediction: it
 * cannot tell that `"Password123!"` is in every dictionary on earth, and it
 * will happily call it fair. Present it as a hint, never as a verdict, and
 * never as a gate on what a user may choose.
 *
 * A passphrase is measured by its characters, not by its words, so
 * {@link generatePassphrase} output reads as far stronger here than its real
 * per-word entropy. Use `words * log2(wordlist.length)` for those instead.
 */
export function passwordStrength(password: string): PasswordStrength {
  const classes = {
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    digits: /[0-9]/.test(password),
    symbols: /[^a-zA-Z0-9]/.test(password),
  };

  let alphabetSize = 0;
  if (classes.lowercase) alphabetSize += CLASS_SIZES.lowercase;
  if (classes.uppercase) alphabetSize += CLASS_SIZES.uppercase;
  if (classes.digits) alphabetSize += CLASS_SIZES.digits;
  if (classes.symbols) alphabetSize += CLASS_SIZES.symbols;

  // Spreading iterates by code point, so an emoji counts once rather than twice.
  const uniqueChars = new Set([...password]).size;
  const bits = Math.round(passwordEntropyBits([...password].length, alphabetSize) * 10) / 10;

  return { bits, label: labelFor(bits), classes, uniqueChars };
}

/**
 * Bits of entropy in `length` characters drawn uniformly from an alphabet of
 * `alphabetSize`: `length * log2(alphabetSize)`.
 *
 * Returns `0` rather than throwing for a degenerate input (empty password, an
 * alphabet of one character), because a one-character alphabet genuinely
 * carries no information and a meter should show zero, not blow up.
 */
export function passwordEntropyBits(length: number, alphabetSize: number): number {
  if (!Number.isFinite(length) || !Number.isFinite(alphabetSize)) return 0;
  if (length <= 0 || alphabetSize <= 1) return 0;
  return length * Math.log2(alphabetSize);
}

/**
 * Builds the character pool a {@link PasswordAlphabet} describes.
 *
 * Exported so a caller can show the user exactly what the generator will draw
 * from, and so the tests can assert the ambiguity filter.
 *
 * Returns an empty string when the options enable nothing - it describes, it
 * does not validate. {@link generatePassword} is where that becomes an error.
 */
export function buildAlphabet(options: PasswordAlphabet = {}): string {
  const pools: string[] = [];
  if (options.lowercase ?? true) pools.push(LOWERCASE);
  if (options.uppercase ?? true) pools.push(UPPERCASE);
  if (options.digits ?? true) pools.push(DIGITS);
  if (options.symbols ?? true) pools.push(SYMBOLS);
  if (options.extra) pools.push(options.extra);

  return dedupe(pools.join(""), options.avoidAmbiguous ?? false);
}

/**
 * Uniform random integer in `[0, max)` from `crypto.getRandomValues`, using
 * rejection sampling so the distribution has no modulo bias.
 *
 * The loop is unbounded on purpose. It rejects at most `max / 2^32` of its
 * draws, which for every alphabet in this module is far below one in a
 * thousand, so it terminates immediately in practice and stays correct rather
 * than falling back to a biased answer after N tries.
 *
 * @throws {RangeError} when `max` is not an integer in `[1, 2^32]`.
 * @throws {Error} when the runtime has no `crypto.getRandomValues`.
 */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max < 1 || max > 0x1_0000_0000) {
    throw new RangeError(`randomInt(max) needs an integer in [1, 2^32], got ${String(max)}.`);
  }
  if (max === 1) return 0;

  const random = randomSource();
  // Largest multiple of `max` that fits in a uint32. Anything at or above it
  // would make the low residues more likely than the high ones.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);

  for (;;) {
    random(buffer);
    const value = buffer[0];
    if (value < limit) return value % max;
  }
}

/** Resolves WebCrypto once, with a message that says what is missing. */
function randomSource(): (buffer: Uint32Array) => void {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error(
      "crypto.getRandomValues is unavailable. Password generation refuses to fall back to Math.random.",
    );
  }
  return (buffer) => {
    source.getRandomValues(buffer);
  };
}

/** One uniformly-chosen character of `pool`. */
function pickFrom(pool: string): string {
  return pool[randomInt(pool.length)];
}

/** Fisher-Yates, in place, with unbiased indices. */
function shuffle(items: string[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const swap = items[i];
    items[i] = items[j];
    items[j] = swap;
  }
}

/**
 * The pools `requireEachClass` must place one character from. A pool the
 * ambiguity filter emptied is dropped rather than making the call impossible.
 */
function enabledClassPools(options: PasswordAlphabet): string[] {
  const avoid = options.avoidAmbiguous ?? false;
  const pools: string[] = [];
  if (options.lowercase ?? true) pools.push(dedupe(LOWERCASE, avoid));
  if (options.uppercase ?? true) pools.push(dedupe(UPPERCASE, avoid));
  if (options.digits ?? true) pools.push(dedupe(DIGITS, avoid));
  if (options.symbols ?? true) pools.push(dedupe(SYMBOLS, avoid));
  return pools.filter((pool) => pool.length > 0);
}

/**
 * Collapses duplicates, preserving order, and optionally strips the ambiguous
 * characters. Duplicates matter: a character listed twice would be twice as
 * likely to be drawn.
 */
function dedupe(pool: string, avoidAmbiguous: boolean): string {
  const seen = new Set<string>();
  let out = "";
  for (const char of pool) {
    if (seen.has(char)) continue;
    if (avoidAmbiguous && AMBIGUOUS.includes(char)) continue;
    seen.add(char);
    out += char;
  }
  return out;
}

/** Uppercases the first code point, leaving the rest alone. */
function capitalizeWord(word: string): string {
  if (word.length === 0) return word;
  const [first, ...rest] = [...word];
  return first.toUpperCase() + rest.join("");
}

/**
 * Buckets for a strength bar. The boundaries follow the usual reading of
 * offline-attack cost: under 28 bits falls to a laptop, 60 is comfortable
 * against a well-funded attacker, 80 is not worth attacking.
 */
function labelFor(bits: number): PasswordStrength["label"] {
  if (bits < 28) return "very-weak";
  if (bits < 36) return "weak";
  if (bits < 60) return "fair";
  if (bits < 80) return "strong";
  return "very-strong";
}
