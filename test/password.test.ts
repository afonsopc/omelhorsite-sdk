/**
 * Tests for `local/password.ts`.
 *
 * The module is pure and offline, so everything here is exact except the two
 * statistical checks, which are sized so that a false failure is far rarer than
 * a real bug: 60 000 draws over 3 buckets has a standard deviation of ~115
 * around a mean of 20 000, and the assertions allow 600.
 *
 * The anti-bias property is NOT tested statistically - a modulo bias of one
 * part in 2^32 is invisible to any sample you can afford. It is tested by
 * feeding `randomInt` a scripted random source and asserting that it rejects
 * the draws that would have skewed the distribution.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  EFF_LONG_WORDLIST,
  buildAlphabet,
  generatePassphrase,
  generatePassword,
  passwordEntropyBits,
  passwordStrength,
  randomInt,
} from "../src/local/password";

const AMBIGUOUS = [..."0O1lI|"];
const realCrypto = globalThis.crypto;

/** Swaps in a random source that hands out a scripted sequence of uint32s. */
function withScriptedRandom<T>(values: number[], body: () => T): T {
  let index = 0;
  const fake = {
    getRandomValues(buffer: Uint32Array): Uint32Array {
      if (index >= values.length) throw new Error("scripted random source exhausted");
      buffer[0] = values[index]!;
      index += 1;
      return buffer;
    },
  };
  Object.defineProperty(globalThis, "crypto", { value: fake, configurable: true, writable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true, writable: true });
  }
}

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true, writable: true });
});

describe("buildAlphabet", () => {
  test("defaults to all four classes with no duplicates", () => {
    const alphabet = buildAlphabet();
    expect(alphabet).toContain("a");
    expect(alphabet).toContain("Z");
    expect(alphabet).toContain("7");
    expect(alphabet).toContain("!");
    expect(new Set(alphabet).size).toBe(alphabet.length);
  });

  test("omits a disabled class entirely", () => {
    const alphabet = buildAlphabet({ symbols: false, digits: false });
    expect(alphabet).toBe("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  test("avoidAmbiguous removes exactly 0O1lI| and nothing else", () => {
    const full = buildAlphabet();
    const safe = buildAlphabet({ avoidAmbiguous: true });
    expect(full.length - safe.length).toBe(AMBIGUOUS.length);
    for (const char of AMBIGUOUS) expect(safe).not.toContain(char);
  });

  test("extra characters are appended and deduplicated against the classes", () => {
    // "a" and "1" are already in the pool; only the two new marks may be added.
    const base = buildAlphabet();
    const extended = buildAlphabet({ extra: "a1\\`" });
    expect(extended.length).toBe(base.length + 2);
    expect(new Set(extended).size).toBe(extended.length);
    expect(extended).toContain("\\");
  });

  test("describes an empty pool instead of throwing", () => {
    expect(buildAlphabet({ lowercase: false, uppercase: false, digits: false, symbols: false })).toBe("");
  });
});

describe("generatePassword", () => {
  test("defaults to 20 characters drawn from the default alphabet", () => {
    const alphabet = new Set(buildAlphabet());
    const password = generatePassword();
    expect(password).toHaveLength(20);
    for (const char of password) expect(alphabet.has(char)).toBe(true);
  });

  test("honours length", () => {
    expect(generatePassword({ length: 4 })).toHaveLength(4);
    expect(generatePassword({ length: 128 })).toHaveLength(128);
    // One character can only be asked for once the class floor is lifted.
    expect(generatePassword({ length: 1, requireEachClass: false })).toHaveLength(1);
  });

  test("requireEachClass places one character of every enabled class", () => {
    // Length 4 with four classes leaves no free slots, so each class must
    // appear exactly once - the strongest form of the assertion.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const password = generatePassword({ length: 4 });
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  test("the forced characters are not left sitting in class order", () => {
    // Without the shuffle every password would start with its lowercase
    // character, so seeing all four classes lead at least once proves it.
    const leaders = new Set<string>();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const first = generatePassword({ length: 4 })[0]!;
      if (/[a-z]/.test(first)) leaders.add("lower");
      else if (/[A-Z]/.test(first)) leaders.add("upper");
      else if (/[0-9]/.test(first)) leaders.add("digit");
      else leaders.add("symbol");
    }
    expect(leaders.size).toBe(4);
  });

  test("requireEachClass can be turned off", () => {
    const password = generatePassword({ length: 4, requireEachClass: false, uppercase: false, symbols: false });
    expect(password).toMatch(/^[a-z0-9]{4}$/);
  });

  test("never emits an ambiguous character when asked not to", () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const password = generatePassword({ length: 40, avoidAmbiguous: true });
      for (const char of AMBIGUOUS) expect(password).not.toContain(char);
    }
  });

  test("rejects a length that cannot hold one of each class", () => {
    expect(() => generatePassword({ length: 3 })).toThrow(RangeError);
    // Three classes fit in three characters.
    expect(generatePassword({ length: 3, symbols: false })).toHaveLength(3);
  });

  test("rejects a length that is not a positive integer", () => {
    expect(() => generatePassword({ length: 0 })).toThrow(RangeError);
    expect(() => generatePassword({ length: -5 })).toThrow(RangeError);
    expect(() => generatePassword({ length: 12.5 })).toThrow(RangeError);
    expect(() => generatePassword({ length: Number.NaN })).toThrow(RangeError);
  });

  test("rejects an empty alphabet", () => {
    expect(() =>
      generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }),
    ).toThrow(RangeError);
  });

  test("draws from `extra` when it is the only source", () => {
    const password = generatePassword({
      length: 12,
      lowercase: false,
      uppercase: false,
      digits: false,
      symbols: false,
      extra: "xy",
    });
    expect(password).toMatch(/^[xy]{12}$/);
  });

  test("two calls do not collide", () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 500; attempt += 1) seen.add(generatePassword({ length: 16 }));
    expect(seen.size).toBe(500);
  });
});

describe("randomInt", () => {
  test("rejects a draw that would introduce modulo bias", () => {
    // max = 3e9 => limit = 3e9, so any draw at or above it must be discarded
    // rather than folded back with %, which is exactly the bias being avoided.
    const value = withScriptedRandom([3_500_000_000, 4_294_967_295, 42], () => randomInt(3_000_000_000));
    expect(value).toBe(42);
  });

  test("accepts the first in-range draw and consumes nothing more", () => {
    const value = withScriptedRandom([7], () => randomInt(3));
    expect(value).toBe(1);
  });

  test("needs no randomness at all for a single-value range", () => {
    expect(withScriptedRandom([], () => randomInt(1))).toBe(0);
  });

  test("rejects a range that is not an integer in [1, 2^32]", () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-1)).toThrow(RangeError);
    expect(() => randomInt(2.5)).toThrow(RangeError);
    expect(() => randomInt(2 ** 32 + 1)).toThrow(RangeError);
  });

  test("refuses to run without WebCrypto instead of falling back to Math.random", () => {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    expect(() => randomInt(10)).toThrow(/getRandomValues/);
  });

  test("stays inside the range and covers it roughly evenly", () => {
    const counts = [0, 0, 0];
    for (let draw = 0; draw < 60_000; draw += 1) counts[randomInt(3)]! += 1;
    for (const count of counts) {
      expect(count).toBeGreaterThan(19_400);
      expect(count).toBeLessThan(20_600);
    }
  });
});

describe("generatePassphrase", () => {
  test("defaults to five words from the bundled list", () => {
    const words = generatePassphrase({ separator: " " }).split(" ");
    expect(words).toHaveLength(5);
    const list = new Set(EFF_LONG_WORDLIST);
    for (const word of words) expect(list.has(word)).toBe(true);
  });

  test("the bundled list is the full EFF long list", () => {
    expect(EFF_LONG_WORDLIST).toHaveLength(7776);
    expect(new Set(EFF_LONG_WORDLIST).size).toBe(7776);
  });

  test("honours the word count and the separator", () => {
    expect(generatePassphrase({ words: 8, separator: "." }).split(".").length).toBeGreaterThanOrEqual(8);
    expect(generatePassphrase({ words: 1, separator: " " }).split(" ")).toHaveLength(1);
  });

  test("a hyphen inside a word means the default separator is not a safe split", () => {
    // Four EFF entries carry a hyphen; this pins the caveat the docs call out.
    const hyphenated = EFF_LONG_WORDLIST.filter((word) => word.includes("-"));
    expect(hyphenated).toEqual(["drop-down", "felt-tip", "t-shirt", "yo-yo"]);
  });

  test("capitalize uppercases the first letter of every word", () => {
    const words = generatePassphrase({ words: 6, separator: " ", capitalize: true }).split(" ");
    for (const word of words) expect(word[0]).toBe(word[0]!.toUpperCase());
  });

  test("includeNumber appends a digit to exactly one word", () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const words = generatePassphrase({ words: 4, separator: " ", includeNumber: true }).split(" ");
      expect(words.filter((word) => /[0-9]$/.test(word))).toHaveLength(1);
      expect(words.join("")).toMatch(/^[a-z-]+[0-9][a-z-]*$/);
    }
  });

  test("draws with replacement from a custom list", () => {
    expect(generatePassphrase({ words: 3, separator: " ", wordlist: ["solo"] })).toBe("solo solo solo");
  });

  test("rejects a bad word count or an empty list", () => {
    expect(() => generatePassphrase({ words: 0 })).toThrow(RangeError);
    expect(() => generatePassphrase({ words: 1.5 })).toThrow(RangeError);
    expect(() => generatePassphrase({ wordlist: [] })).toThrow(RangeError);
  });
});

describe("passwordEntropyBits", () => {
  test("is length * log2(alphabetSize)", () => {
    expect(passwordEntropyBits(20, 90)).toBeCloseTo(20 * Math.log2(90), 10);
    expect(passwordEntropyBits(1, 2)).toBe(1);
  });

  test("is zero for a degenerate input rather than throwing", () => {
    expect(passwordEntropyBits(0, 90)).toBe(0);
    expect(passwordEntropyBits(20, 1)).toBe(0);
    expect(passwordEntropyBits(20, 0)).toBe(0);
    expect(passwordEntropyBits(Number.NaN, 90)).toBe(0);
  });
});

describe("passwordStrength", () => {
  test("reports which classes are present", () => {
    expect(passwordStrength("abc").classes).toEqual({
      lowercase: true,
      uppercase: false,
      digits: false,
      symbols: false,
    });
    expect(passwordStrength("aB3!").classes).toEqual({
      lowercase: true,
      uppercase: true,
      digits: true,
      symbols: true,
    });
  });

  test("treats a non-ASCII character as a symbol", () => {
    expect(passwordStrength("café").classes.symbols).toBe(true);
  });

  test("counts distinct code points", () => {
    expect(passwordStrength("aaaa").uniqueChars).toBe(1);
    expect(passwordStrength("abcabc").uniqueChars).toBe(3);
    expect(passwordStrength("\u{1F600}\u{1F600}").uniqueChars).toBe(1);
  });

  test("buckets on the entropy estimate", () => {
    expect(passwordStrength("").label).toBe("very-weak");
    expect(passwordStrength("abcde").label).toBe("very-weak");
    expect(passwordStrength(generatePassword({ length: 8 })).label).toBe("fair");
    expect(passwordStrength(generatePassword({ length: 20 })).label).toBe("very-strong");
  });

  test("is an alphabet estimate and cannot see a dictionary word", () => {
    // Documented limitation, pinned so nobody mistakes it for a verdict.
    expect(passwordStrength("Password123!").label).toBe("strong");
  });
});
