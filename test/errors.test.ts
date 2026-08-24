/**
 * `bun test` coverage for the one thing about the error classes that a build
 * can silently break: the `name` field.
 *
 * `name` is part of the CLI's machine-readable envelope - `output.ts` copies it
 * into `{ ok: false, error: { name, code, ... } }` - so an agent keying off it
 * needs it to be the same string in every artefact. It is NOT taken from
 * `new.target.name`, because `bun build --minify` renames the classes and the
 * shipped `oms` binary then reported `name: "A"` while a dev run reported
 * `OmsNetworkError`. It is taken from a static string literal instead, which a
 * minifier cannot touch.
 *
 * The anonymous-subclass tests below are the ones that actually pin that down:
 * under `new.target.name` they would report the subclass's inferred name, so
 * they fail the moment anybody "simplifies" the assignment back.
 */

import { describe, expect, test } from "bun:test";

import {
  OmsApiError,
  OmsAuthError,
  OmsError,
  OmsNetworkError,
  OmsQuotaError,
  OmsTimeoutError,
} from "../src/errors";

describe("error names survive a minified build", () => {
  const cases: Array<{ expected: string; make: () => OmsError }> = [
    { expected: "OmsError", make: () => new OmsError("x") },
    { expected: "OmsApiError", make: () => new OmsApiError("x", { status: 500 }) },
    { expected: "OmsAuthError", make: () => new OmsAuthError("x", { status: 401 }) },
    { expected: "OmsQuotaError", make: () => new OmsQuotaError("x", { status: 429 }) },
    { expected: "OmsTimeoutError", make: () => new OmsTimeoutError("x") },
    { expected: "OmsNetworkError", make: () => new OmsNetworkError("x") },
  ];

  for (const entry of cases) {
    test(`${entry.expected} reports its own name`, () => {
      const error = entry.make();
      expect(error.name).toBe(entry.expected);
      expect(error.toJSON()["name"]).toBe(entry.expected);
    });
  }

  test("the name comes from a literal, not from the constructor's runtime name", () => {
    // A minifier renames the class but not the literal. An anonymous subclass
    // is the cheapest way to tell the two apart in an unminified test run:
    // `new.target.name` would answer "Anonymous" here.
    const Anonymous = class extends OmsApiError {};
    expect(new Anonymous("x", { status: 500 }).name).toBe("OmsApiError");

    const Timeout = class extends OmsTimeoutError {};
    expect(new Timeout("x").name).toBe("OmsTimeoutError");
  });

  test("every class's static literal matches the class it is on", () => {
    expect(OmsError.errorName).toBe("OmsError");
    expect(OmsApiError.errorName).toBe("OmsApiError");
    expect(OmsAuthError.errorName).toBe("OmsAuthError");
    expect(OmsQuotaError.errorName).toBe("OmsQuotaError");
    expect(OmsTimeoutError.errorName).toBe("OmsTimeoutError");
    expect(OmsNetworkError.errorName).toBe("OmsNetworkError");
  });

  test("they are still real Errors, and instanceof still narrows", () => {
    const quota = new OmsQuotaError("too much", { status: 429 });
    expect(quota).toBeInstanceOf(Error);
    expect(quota).toBeInstanceOf(OmsError);
    expect(quota).toBeInstanceOf(OmsApiError);
    expect(quota.code).toBe("rate_limited");
  });
});
