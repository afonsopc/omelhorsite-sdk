/**
 * `bun test` coverage for the `passkeys` namespace.
 *
 * One property matters more than every other assertion here: a WebAuthn
 * ceremony payload must reach the server BYTE FOR BYTE as the authenticator
 * produced it. The SDK has exactly one body-shaped rewrite in it, the null
 * sentinel, and the claim this file exists to pin is that no part of that
 * rewrite can touch these two endpoints. So the ceremony tests do not inspect a
 * parsed object: they compare the serialised request body string against
 * `JSON.stringify` of the very object that was passed in, and separately assert
 * that no `\b` appears anywhere in it. A future change that routed a ceremony
 * through `encodeQuery`, spread the credential into a new object, or grew a
 * body-side sentinel pass would fail here rather than in production, two
 * minutes into somebody's fingerprint.
 *
 * The rest covers the things the backend does that the type signature cannot
 * say: an index with no pagination, a `204` with no body, `retry: false` on the
 * two rate-limited login routes, and the base64url canonicaliser that keeps
 * React Native's padding out of a field the server compares byte-wise.
 */

import { describe, expect, test } from "bun:test";

import { ApiClient } from "../src/http";
import { OmsApiError, OmsAuthError, OmsQuotaError } from "../src/errors";
import {
  PasskeysNamespace,
  isPasskeyBase64Url,
  normalizePasskeyAssertionCredential,
  normalizePasskeyRegistrationCredential,
  passkeyBase64Url,
  type Passkey,
  type PasskeyAssertionCredential,
  type PasskeyRegistrationCredential,
} from "../src/resources/auth/passkeys";

const BASE_URL = "https://api.test";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly search: string;
  readonly body: string | undefined;
  readonly headers: Record<string, string>;
}

interface Harness {
  readonly passkeys: PasskeysNamespace;
  readonly calls: Call[];
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  /** Sent raw, for the `204` case where there is genuinely nothing. */
  readonly empty?: boolean;
  readonly headers?: Record<string, string>;
}

/** A client whose fetch records every request and replays a queue of answers. */
function harness(replies: Reply[], token: string | null = "secret-session-token"): Harness {
  const calls: Call[] = [];
  const queue = [...replies];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      method: init?.method ?? "GET",
      url: input,
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers,
    });

    const reply = queue.shift() ?? { status: 200, body: null };
    const status = reply.status ?? 200;
    if (reply.empty) return new Response(null, { status, headers: reply.headers });
    return new Response(JSON.stringify(reply.body ?? null), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...(reply.headers ?? {}) },
    });
  };

  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    ...(token === null ? {} : { tokens: { getToken: () => token } }),
  });
  return { passkeys: new PasskeysNamespace(http), calls };
}

function passkeyRow(overrides: Partial<Passkey> = {}): Passkey {
  return {
    id: "9d0f6b2e-4a1c-4d55-9f3f-2b0c1f4c7a11",
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-20T18:31:02.000Z",
    nickname: "MacBook",
    last_used_at: "2026-08-20T18:31:02.000Z",
    ...overrides,
  };
}

/**
 * A registration credential shaped exactly as a platform hands it over,
 * INCLUDING an explicit `null` inside `clientExtensionResults`. That null is
 * the tripwire: the sentinel rewrite would turn it into `"\b"`.
 */
function registrationCredential(): PasskeyRegistrationCredential {
  return {
    id: "AX9fZ0tGb1c",
    rawId: "AX9fZ0tGb1c",
    type: "public-key",
    response: {
      clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
      attestationObject: "o2NmbXRkbm9uZWdhdHRTdG10oA",
      transports: ["internal", "hybrid"],
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: { credProps: { rk: true }, appidExclude: null },
  };
}

function assertionCredential(): PasskeyAssertionCredential {
  return {
    id: "AX9fZ0tGb1c",
    rawId: "AX9fZ0tGb1c",
    type: "public-key",
    response: {
      clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
      authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4",
      signature: "MEUCIQDvXqNbA",
      userHandle: "dXNlci1oYW5kbGU",
    },
    clientExtensionResults: { appid: null },
  };
}

describe("passkeys.list", () => {
  test("reads the whole array with no pagination modifiers at all", async () => {
    const rows = [passkeyRow(), passkeyRow({ id: "b", nickname: null, last_used_at: null })];
    const { passkeys, calls } = harness([{ body: rows }]);

    const result = await passkeys.list();

    expect(result).toEqual(rows);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/webauthn_credentials");
    // The action is hand-written, not CrudActions: a `modifiers[page]` here
    // would be silently ignored by the server and would misreport the result as
    // one page of many.
    expect(calls[0]?.search).toBe("");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret-session-token");
  });

  test("a nickname the model normalised away comes back as null, not as spaces", async () => {
    const { passkeys } = harness([{ body: [passkeyRow({ nickname: null })] }]);
    const [row] = await passkeys.list();
    expect(row?.nickname).toBeNull();
  });

  test("401 without a credential surfaces as an auth error", async () => {
    const { passkeys } = harness([{ status: 401, body: "Unauthorized." }], null);
    await expect(passkeys.list()).rejects.toBeInstanceOf(OmsAuthError);
  });
});

describe("passkeys.remove", () => {
  test("encodes the id into the path and resolves on an empty 204", async () => {
    const { passkeys, calls } = harness([{ status: 204, empty: true }]);

    await expect(passkeys.remove("9d0f/6b2e")).resolves.toBeUndefined();

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.path).toBe("/webauthn_credentials/9d0f%2F6b2e");
  });

  test("404 for somebody else's passkey stays a plain API error", async () => {
    const { passkeys } = harness([{ status: 404, body: "Passkey not found." }]);
    const failure = await passkeys.remove("nope").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
  });
});

describe("passkeys.registrationOptions", () => {
  test("posts an empty JSON body and returns the options untouched", async () => {
    const options = {
      challenge: "Y2hhbGxlbmdl",
      timeout: 120_000,
      extensions: {},
      rp: { name: "O Melhor Site", id: "omelhorsite.pt" },
      user: { id: "dXNlcg", name: "a@b.pt", displayName: "A B" },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -37 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      excludeCredentials: [],
    };
    const { passkeys, calls } = harness([{ body: options }]);

    const result = await passkeys.registrationOptions();

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/webauthn_credentials/registration_options");
    expect(calls[0]?.body).toBe("{}");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    // `excludeCredentials: []` must survive as an empty array: an account with
    // no passkeys yet is not the same as one whose exclusion list is missing.
    expect(result.excludeCredentials).toEqual([]);
    expect(result.extensions).toEqual({});
    expect(result.rp.id).toBe("omelhorsite.pt");
  });

  test("401 when the challenge cache lost the entry", async () => {
    const { passkeys } = harness([
      { status: 401, body: "Registration challenge expired. Please try again." },
    ]);
    await expect(passkeys.registrationOptions()).rejects.toBeInstanceOf(OmsAuthError);
  });
});

describe("passkeys.register", () => {
  test("sends the credential byte for byte, with no sentinel anywhere", async () => {
    const credential = registrationCredential();
    const { passkeys, calls } = harness([{ status: 201, body: passkeyRow() }]);

    await passkeys.register({ credential, nickname: "Pixel" });

    const sent = calls[0]?.body ?? "";
    expect(sent).toBe(JSON.stringify({ credential, nickname: "Pixel" }));
    // The whole point of the namespace: no `\b` reached the wire, so the
    // explicit `appidExclude: null` inside clientExtensionResults survived.
    expect(sent).not.toContain("\b");
    expect(JSON.parse(sent).credential.clientExtensionResults.appidExclude).toBeNull();
    // And it travelled in the body, never as query parameters, which is the
    // one place the sentinel IS written.
    expect(calls[0]?.search).toBe("");
  });

  test("omits nickname entirely when there is none", async () => {
    const credential = registrationCredential();
    const { passkeys, calls } = harness([{ status: 201, body: passkeyRow() }]);

    await passkeys.register({ credential });

    expect(calls[0]?.body).toBe(JSON.stringify({ credential }));
    expect(calls[0]?.body).not.toContain("nickname");
  });

  test("passes the credential through by reference, without rebuilding it", async () => {
    // A key the SDK has never heard of must still arrive: whitelisting fields
    // would drop whatever the next platform adds, and the signature covers it.
    const credential = {
      ...registrationCredential(),
      somethingNewInTheSpec: { nested: [1, null, "x"] },
    } as unknown as PasskeyRegistrationCredential;
    const { passkeys, calls } = harness([{ status: 201, body: passkeyRow() }]);

    await passkeys.register({ credential });

    expect(JSON.parse(calls[0]?.body ?? "{}").credential.somethingNewInTheSpec).toEqual({
      nested: [1, null, "x"],
    });
  });

  test("a 500 from a malformed payload is not retried and is reported as it is", async () => {
    const { passkeys, calls } = harness([{ status: 500, body: "Internal Server Error" }]);
    const failure = await passkeys
      .register({ credential: registrationCredential() })
      .catch((error: unknown) => error);

    expect((failure as OmsApiError).status).toBe(500);
    // A POST is never replayed after a 5xx: one attempt, one record.
    expect(calls).toHaveLength(1);
  });
});

describe("passkeys.authenticationOptions", () => {
  test("returns the handle beside the options", async () => {
    const challenge = {
      handle: "1c3f4b0a-2e5d-4c8f-9a7b-6d5e4f3c2b1a",
      options: {
        challenge: "Y2hhbGxlbmdl",
        timeout: 120_000,
        extensions: {},
        allowCredentials: [],
        rpId: "omelhorsite.pt",
        userVerification: "preferred",
      },
    };
    const { passkeys, calls } = harness([{ body: challenge }], null);

    const result = await passkeys.authenticationOptions();

    expect(calls[0]?.path).toBe("/webauthn_credentials/authentication_options");
    expect(calls[0]?.body).toBe("{}");
    // No credential was configured, so none was attached: this route is public
    // and the caller has no session yet by definition.
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    // Empty allowCredentials is the discoverable-login signal, not an omission.
    expect(result.options.allowCredentials).toEqual([]);
    expect(result.options.rpId).toBe("omelhorsite.pt");
    expect(result.handle).toBe(challenge.handle);
  });

  test("a 429 is surfaced rather than slept through", async () => {
    const { passkeys, calls } = harness(
      [
        { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "60" } },
        { body: { handle: "never-reached", options: {} } },
      ],
      null,
    );

    await expect(passkeys.authenticationOptions()).rejects.toBeInstanceOf(OmsQuotaError);
    expect(calls).toHaveLength(1);
  });

  test("an explicit retry option can opt back in", async () => {
    const { passkeys, calls } = harness(
      [
        { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "0" } },
        { body: { handle: "h", options: { challenge: "c", rpId: "localhost" } } },
      ],
      null,
    );

    const result = await passkeys.authenticationOptions({ retry: { maxAttempts: 2, baseDelayMs: 1 } });

    expect(result.handle).toBe("h");
    expect(calls).toHaveLength(2);
  });
});

describe("passkeys.authenticate", () => {
  test("sends credential and handle verbatim and returns the session token", async () => {
    const credential = assertionCredential();
    const session = {
      id: "5f0c",
      created_at: "2026-08-29T09:00:00.000Z",
      updated_at: "2026-08-29T09:00:00.000Z",
      user_id: "u-1",
      token: "brand-new-session-token",
      name: null,
      device_type: null,
    };
    const { passkeys, calls } = harness([{ status: 201, body: session }], null);

    const result = await passkeys.authenticate({ credential, handle: "the-handle" });

    const sent = calls[0]?.body ?? "";
    expect(sent).toBe(JSON.stringify({ credential, handle: "the-handle" }));
    expect(sent).not.toContain("\b");
    expect(JSON.parse(sent).credential.clientExtensionResults.appid).toBeNull();
    expect(calls[0]?.search).toBe("");
    expect(result.token).toBe("brand-new-session-token");
  });

  test("never replays an assertion: one 429, one attempt", async () => {
    const { passkeys, calls } = harness(
      [
        { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "30" } },
        { status: 201, body: { token: "would-be-wrong" } },
      ],
      null,
    );

    await expect(
      passkeys.authenticate({ credential: assertionCredential(), handle: "h" }),
    ).rejects.toBeInstanceOf(OmsQuotaError);
    expect(calls).toHaveLength(1);
  });

  test("the five 401 causes all arrive as one auth error carrying the server's own words", async () => {
    for (const message of [
      "Login challenge expired. Please try again.",
      "Unknown passkey.",
      "This account is deactivated.",
      "Passkey could not be verified.",
    ]) {
      const { passkeys } = harness([{ status: 401, body: message }], null);
      const failure = await passkeys
        .authenticate({ credential: assertionCredential(), handle: "h" })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OmsAuthError);
      expect(String((failure as Error).message)).toContain(message);
    }
  });
});

describe("passkeyBase64Url", () => {
  test("canonicalises standard base64 with padding into unpadded base64url", () => {
    expect(passkeyBase64Url("ab+/cd==", "credential.id")).toBe("ab-_cd");
    expect(passkeyBase64Url("  AX9fZ0tGb1c  ", "credential.id")).toBe("AX9fZ0tGb1c");
  });

  test("leaves an already-canonical value exactly as it is", () => {
    const value = "SZYN5YgOjGh0NBcPZHZgW4";
    expect(passkeyBase64Url(value, "f")).toBe(value);
    expect(isPasskeyBase64Url(value)).toBe(true);
  });

  test("rejects a truncated value instead of re-padding it into plausible bytes", () => {
    // Length 5, i.e. 1 mod 4: no base64 string is ever that length.
    expect(() => passkeyBase64Url("abcde", "credential.id")).toThrow(TypeError);
    expect(isPasskeyBase64Url("abcde")).toBe(false);
  });

  test("rejects non-strings, empties and non-base64 without quoting the value", () => {
    expect(() => passkeyBase64Url(null, "credential.id")).toThrow(TypeError);
    expect(() => passkeyBase64Url("", "credential.id")).toThrow(TypeError);
    expect(() => passkeyBase64Url("   ", "credential.id")).toThrow(TypeError);

    const secret = "not base64 at all!";
    const failure = (() => {
      try {
        passkeyBase64Url(secret, "credential.response.clientDataJSON");
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure?.message).toContain("credential.response.clientDataJSON");
    expect(failure?.message).not.toContain(secret);
  });

  test("isPasskeyBase64Url is false for a standard-alphabet or padded string", () => {
    expect(isPasskeyBase64Url("ab+/cd")).toBe(false);
    expect(isPasskeyBase64Url("abcd==")).toBe(false);
    expect(isPasskeyBase64Url(42)).toBe(false);
  });
});

describe("credential normalisers", () => {
  test("registration: fills a null rawId from id, which is the Android case", () => {
    const normalized = normalizePasskeyRegistrationCredential({
      id: "ab+/cd==",
      rawId: null,
      type: "public-key",
      response: { clientDataJSON: "e30=", attestationObject: "oA==" },
    });

    expect(normalized.id).toBe("ab-_cd");
    // Same bytes as `id`, which is what `valid_id?` compares. A null here
    // reaches `nil.end_with?` in the gem and answers 500.
    expect(normalized.rawId).toBe("ab-_cd");
    expect(normalized.response.clientDataJSON).toBe("e30");
    expect(normalized.response.attestationObject).toBe("oA");
  });

  test("registration: keeps only what the gem reads, and drops an empty transports list", () => {
    const normalized = normalizePasskeyRegistrationCredential({
      id: "AX9fZ0tGb1c",
      rawId: "AX9fZ0tGb1c",
      type: "public-key",
      response: {
        clientDataJSON: "e30",
        attestationObject: "oA",
        transports: [],
        publicKey: "a-large-useless-blob",
        publicKeyAlgorithm: -7,
      },
      clientExtensionResults: { credProps: { rk: true } },
    });

    expect(normalized.response).toEqual({ clientDataJSON: "e30", attestationObject: "oA" });
    expect("transports" in normalized.response).toBe(false);
    expect(normalized.clientExtensionResults).toEqual({ credProps: { rk: true } });
  });

  test("assertion: drops an empty userHandle instead of failing on it", () => {
    const normalized = normalizePasskeyAssertionCredential({
      id: "AX9fZ0tGb1c",
      rawId: "AX9fZ0tGb1c",
      type: "public-key",
      response: {
        clientDataJSON: "e30",
        authenticatorData: "SZYN5Y",
        signature: "MEUCIQ",
        userHandle: "",
      },
    });

    expect(normalized.response.userHandle).toBeUndefined();
    expect("userHandle" in normalized.response).toBe(false);
  });

  test("assertion: keeps a real userHandle, canonicalised", () => {
    const normalized = normalizePasskeyAssertionCredential({
      id: "AX9fZ0tGb1c",
      type: "public-key",
      response: {
        clientDataJSON: "e30",
        authenticatorData: "SZYN5Y",
        signature: "MEUCIQ",
        userHandle: "dXNlcg==",
      },
      authenticatorAttachment: "platform",
    });

    expect(normalized.response.userHandle).toBe("dXNlcg");
    expect(normalized.rawId).toBe("AX9fZ0tGb1c");
    expect(normalized.authenticatorAttachment).toBe("platform");
  });

  test("refuses a payload that is not shaped like a credential at all", () => {
    expect(() => normalizePasskeyRegistrationCredential(null)).toThrow(TypeError);
    expect(() => normalizePasskeyAssertionCredential({ id: "AX9f" })).toThrow(TypeError);
  });

  test("a normalised credential still travels verbatim through register", async () => {
    const credential = normalizePasskeyRegistrationCredential(registrationCredential());
    const { passkeys, calls } = harness([{ status: 201, body: passkeyRow() }]);

    await passkeys.register({ credential });

    expect(calls[0]?.body).toBe(JSON.stringify({ credential }));
  });
});
