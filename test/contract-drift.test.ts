/**
 * `bun test` coverage for ONE question: does the shape the SDK declares match
 * the shape the backend actually emits?
 *
 * Every payload below is copied from what the Rails blueprint produces - the
 * field list of the blueprint plus the three keys `ApplicationBlueprint`
 * declares automatically, with the view the controller actually renders. They
 * are not shapes anyone found convenient; a payload here that drifts from a
 * blueprint is a bug in this file.
 *
 * The assertions come in two kinds, and both matter for a different reason.
 *
 * **Key-set equality.** `expectKeys` compares the WHOLE key set, sorted, not
 * just the keys a test happens to care about. This is the only assertion style
 * that catches the two failure modes that hurt when a host compiles against
 * these types: a field the SDK declares and the server never sends (which is
 * `undefined` at runtime and a lie in every editor), and a field the server
 * sends that the SDK does not name (which forces a cast at every call site).
 * A `toMatchObject` would catch neither.
 *
 * **Named regressions.** Four fields were declared here, or in the web app the
 * SDK is replacing, that no blueprint has ever rendered: `Job.updater_id`,
 * `Job.destroyer_id`, `DynamicQr.website_id` and `DynamicQr.website_managed`.
 * The first two are real columns on `jobs` that `JobBlueprint` does not
 * declare; the last two are residue of the websites feature, which was
 * extracted out of this backend and left no column behind. Each has a test
 * naming it, so that re-adding one is a red test rather than a plausible
 * patch.
 *
 * Nothing here asserts a TypeScript type directly, because a type is erased
 * before `bun test` runs. What is asserted is what a host would actually
 * observe: the keys that arrive, the values in them, and - where the SDK reads
 * a field to make a decision - the decision it reaches.
 */

import { describe, expect, test } from "bun:test";

import { OmsError } from "../src/errors";
import { ApiClient } from "../src/http";
import { DynamicQrsNamespace, type DynamicQr } from "../src/resources/dynamicQrs";
import { FormsNamespace, type Form, type FormSubmission } from "../src/resources/forms";
import { IpLookupNamespace } from "../src/resources/ipLookup";
import { JobsNamespace, type Job } from "../src/resources/jobs";
import { LinkTreesNamespace, type LinkTree, type PublicLinkTree } from "../src/resources/linkTrees";
import { NotepadsNamespace, type Notepad } from "../src/resources/notepads";
import { QuotasNamespace } from "../src/resources/quotas";
import { ShortLinksNamespace, type ShortLink } from "../src/resources/shortLinks";
import { BackgroundRemovalNamespace } from "../src/resources/tools/backgroundRemoval";
import { CaptionsNamespace, type CaptionJob } from "../src/resources/tools/captions";
import { DownloaderNamespace } from "../src/resources/tools/downloader";
import { JumpstyleNamespace, type JumpstyleJob } from "../src/resources/tools/jumpstyle";
import { TranscriptionNamespace, type Transcription } from "../src/resources/tools/transcription";
import { UpscaleNamespace, type Upscale } from "../src/resources/tools/upscale";
import {
  VocalSeparationNamespace,
  type VocalSeparation,
} from "../src/resources/tools/vocalSeparation";

const BASE_URL = "https://api.test";

/** One request the SDK made, so a test can assert the path and query too. */
interface RecordedCall {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly method: string;
}

interface Harness {
  readonly http: ApiClient;
  readonly calls: RecordedCall[];
}

/**
 * An {@link ApiClient} that answers every request with `body`.
 *
 * Authenticated by default, because almost every endpoint under test requires
 * a credential and an anonymous client would exercise a different branch of
 * the transport than the one a host will use.
 */
function harness(body: unknown, status = 200): Harness {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ path: url.pathname, query: url.searchParams, method: init?.method ?? "GET" });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };
  const http = new ApiClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    tokens: { getToken: () => "secret-session-token" },
  });
  return { http, calls };
}

/**
 * Asserts the record carries EXACTLY these keys.
 *
 * Sorted on both sides so the assertion does not depend on the order the
 * blueprint happens to declare fields in, and rendered as arrays rather than
 * as a boolean so a failure says which key is missing or extra.
 */
function expectKeys(record: object, keys: readonly string[]): void {
  expect(Object.keys(record).sort()).toEqual([...keys].sort());
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

/**
 * `JobBlueprint`: `ApplicationBlueprint`'s id/created_at/updated_at plus ten
 * declared fields. Rendered by `GET /jobs` and `GET /jobs/:id` alike.
 */
function jobPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "kQ7bN2mXpT",
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:00:31Z",
    job_type: "unknown",
    payload: {},
    status: "complete",
    progress: 100,
    result: { upscale_id: "aB3dE5fG7h", result_url: "https://cdn.test/upscaled.png" },
    error: null,
    started_at: "2026-08-29T10:00:02Z",
    finished_at: "2026-08-29T10:00:31Z",
    creator_id: "uSr1234567",
    worker_id: "worker-interactive-1",
    ...overrides,
  };
}

describe("jobs", () => {
  test("carries the thirteen keys JobBlueprint declares, and no others", async () => {
    const { http } = harness(jobPayload());

    const job = await new JobsNamespace(http).get("kQ7bN2mXpT");

    expectKeys(job, [
      "id",
      "created_at",
      "updated_at",
      "job_type",
      "payload",
      "status",
      "progress",
      "result",
      "error",
      "started_at",
      "finished_at",
      "creator_id",
      "worker_id",
    ]);
  });

  test("does not carry updater_id or destroyer_id, which are columns the blueprint never renders", async () => {
    const { http } = harness(jobPayload());

    const job = (await new JobsNamespace(http).get("kQ7bN2mXpT")) as Job & Record<string, unknown>;

    // Both columns exist on the `jobs` table and both are indexed. Neither is
    // in `JobBlueprint`'s field list, so a client that declares them has been
    // reading undefined.
    expect(job["updater_id"]).toBeUndefined();
    expect(job["destroyer_id"]).toBeUndefined();
  });

  test("progress is a real number on a job that has not started, not null", async () => {
    const { http } = harness(
      jobPayload({ status: "pending", progress: 0, started_at: null, finished_at: null, result: null, worker_id: null }),
    );

    const job = await new JobsNamespace(http).get("kQ7bN2mXpT");

    // NOT NULL DEFAULT 0. Reading 0 as "unknown" and hiding the progress bar
    // is the bug this asserts against.
    expect(job.progress).toBe(0);
    expect(job.started_at).toBeNull();
    expect(job.worker_id).toBeNull();
  });

  test("an anonymous job carries a null creator_id rather than dropping the key", async () => {
    const { http } = harness(jobPayload({ creator_id: null }));

    const job = await new JobsNamespace(http).get("kQ7bN2mXpT");

    expect(job.creator_id).toBeNull();
    expect("creator_id" in job).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// short links
// ---------------------------------------------------------------------------

/** `ShortLinkBlueprint`, default view: the automatic trio, four fields, two associations. */
function shortLinkPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4821,
    created_at: "2026-08-01T09:15:00Z",
    updated_at: "2026-08-01T09:15:00Z",
    url: "https://example.com/a-long-address",
    endpoint: "k3f9",
    namespace: null,
    user_id: "uSr1234567",
    short_link_clicks: [
      {
        id: 91231,
        created_at: "2026-08-02T11:00:00Z",
        updated_at: "2026-08-02T11:00:00Z",
        country: "pt",
        device_name: "Firefox",
      },
    ],
    user: {
      id: "uSr1234567",
      created_at: "2025-01-04T08:00:00Z",
      updated_at: "2026-08-01T09:00:00Z",
      handle: "afonso",
      name: "Afonso",
      bio: null,
      country_code: "pt",
      email_is_public: false,
      gender_is_public: false,
      library_public: true,
      library_name: "A minha biblioteca",
      library_description: null,
    },
    ...overrides,
  };
}

describe("short links", () => {
  test("the listing inlines every click and the whole owner, not a count", async () => {
    const { http } = harness([shortLinkPayload()]);

    const page = await new ShortLinksNamespace(http).list();
    const [link] = page.items as ShortLink[];

    expectKeys(link!, [
      "id",
      "created_at",
      "updated_at",
      "url",
      "endpoint",
      "namespace",
      "user_id",
      "short_link_clicks",
      "user",
    ]);
    // The payload hazard, asserted rather than only documented: this is a
    // full array of click rows, so a busy link is a very large response.
    expect(link!.short_link_clicks).toHaveLength(1);
    expect(link!.short_link_clicks[0]!.country).toBe("pt");
    expect(link!.user?.handle).toBe("afonso");
  });

  test("the id is a number and the user_id beside it is a string", async () => {
    const { http } = harness([shortLinkPayload()]);

    const [link] = (await new ShortLinksNamespace(http).list()).items;

    // `short_links` kept its integer primary key while the rest of the API
    // moved to opaque strings, and both live on this one record.
    expect(typeof link!.id).toBe("number");
    expect(typeof link!.user_id).toBe("string");
  });

  test("an anonymous link nulls user and user_id rather than omitting them", async () => {
    const { http } = harness([shortLinkPayload({ user: null, user_id: null })]);

    const [link] = (await new ShortLinksNamespace(http).list()).items;

    expect(link!.user).toBeNull();
    expect(link!.user_id).toBeNull();
    expect("user" in link!).toBe(true);
  });

  test("a link nobody clicked carries an empty array, never null", async () => {
    const { http } = harness([shortLinkPayload({ short_link_clicks: [] })]);

    const [link] = (await new ShortLinksNamespace(http).list()).items;

    expect(link!.short_link_clicks).toEqual([]);
  });

  test("stats answers exactly five keys, and the daily window is the server's", async () => {
    const { http, calls } = harness({
      total_clicks: 3,
      last_click_at: "2026-08-02T11:00:00Z",
      clicks_daily: [{ date: "2026-08-02", count: 3 }],
      top_countries: [{ country: "pt", count: 3 }],
      top_devices: [{ device_name: "Firefox", count: 3 }],
    });

    const stats = await new ShortLinksNamespace(http).stats(4821);

    expectKeys(stats, ["total_clicks", "last_click_at", "clicks_daily", "top_countries", "top_devices"]);
    expect(calls[0]!.path).toBe("/short_links/4821/stats");
  });
});

// ---------------------------------------------------------------------------
// dynamic QRs
// ---------------------------------------------------------------------------

/** `DynamicQrBlueprint`: the automatic trio, four fields, plus the settings bag. */
function dynamicQrPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4822,
    created_at: "2026-08-10T14:00:00Z",
    updated_at: "2026-08-12T16:30:00Z",
    url: "https://example.com/menu",
    endpoint: "3f2a5c18-0000-4000-8000-000000000001",
    namespace: "qr",
    user_id: "uSr1234567",
    settings: { style: "rounded", fg_color: "#101010", error_correction_level: "H" },
    ...overrides,
  };
}

describe("dynamic QRs", () => {
  test("carries the eight keys DynamicQrBlueprint declares, and no others", async () => {
    const { http } = harness([dynamicQrPayload()]);

    const [qr] = await new DynamicQrsNamespace(http).list();

    expectKeys(qr!, ["id", "created_at", "updated_at", "url", "endpoint", "namespace", "user_id", "settings"]);
  });

  test("does not carry website_id or website_managed, which no column backs", async () => {
    const { http } = harness([dynamicQrPayload()]);

    const [qr] = (await new DynamicQrsNamespace(http).list()) as Array<DynamicQr & Record<string, unknown>>;

    // Residue of the websites feature, which was extracted out of this
    // backend entirely. There is no such column on `short_links` and no such
    // field on any blueprint.
    expect(qr!["website_id"]).toBeUndefined();
    expect(qr!["website_managed"]).toBeUndefined();
  });

  test("an unset settings bag arrives as {}, never null", async () => {
    const { http } = harness([dynamicQrPayload({ settings: {} })]);

    const [qr] = await new DynamicQrsNamespace(http).list();

    // The blueprint substitutes `link.qr_settings || {}`, so a code saved
    // before the styling existed still reads as an object.
    expect(qr!.settings).toEqual({});
  });

  test("the printed symbol encodes the redirect, not the destination", async () => {
    const { http } = harness([dynamicQrPayload()]);
    const qrs = new DynamicQrsNamespace(http);

    const [qr] = await qrs.list();

    expect(qrs.publicUrl(qr!)).toBe(`https://omelhor.site/qr/${qr!.endpoint}`);
    expect(qrs.publicUrl(qr!)).not.toContain("example.com");
  });
});

// ---------------------------------------------------------------------------
// notepads
// ---------------------------------------------------------------------------

describe("notepads", () => {
  test("show_or_create answers four keys and NO id", async () => {
    const { http } = harness({
      created_at: "2026-08-29T12:00:00Z",
      updated_at: "2026-08-29T12:00:00Z",
      slug: "quick-brown-fox",
      content: "",
      short_link_endpoint: "quick-brown-fox",
    });

    const pad = await new NotepadsNamespace(http).showOrCreate({ slug: "quick-brown-fox" });

    // The numeric primary key is excluded from the default view AND from
    // :extended, because a pad's slug is its only authorisation.
    expectKeys(pad, ["created_at", "updated_at", "slug", "content", "short_link_endpoint"]);
    expect((pad as Notepad & Record<string, unknown>)["id"]).toBeUndefined();
  });

  test("update answers the bare record, without the short link endpoint", async () => {
    const { http, calls } = harness({
      created_at: "2026-08-29T12:00:00Z",
      updated_at: "2026-08-29T12:05:00Z",
      slug: "quick-brown-fox",
      content: "olá",
    });

    const pad = await new NotepadsNamespace(http).update("quick-brown-fox", "olá");

    expectKeys(pad, ["created_at", "updated_at", "slug", "content"]);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/notepads/quick-brown-fox");
  });

  test("a fresh pad's content is the empty string, not null", async () => {
    const { http } = harness({
      created_at: "2026-08-29T12:00:00Z",
      updated_at: "2026-08-29T12:00:00Z",
      slug: "lazy-dog",
      content: "",
      short_link_endpoint: "lazy-dog",
    });

    const pad = await new NotepadsNamespace(http).showOrCreate({ slug: "lazy-dog" });

    expect(pad.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// forms
// ---------------------------------------------------------------------------

/** `FormBlueprint`: the automatic trio plus nine fields. One view, no :extended. */
function formPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fRm1234567",
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-08-20T18:00:00Z",
    user_id: "uSr1234567",
    title: "Contacto",
    status: "published",
    schema: {
      fields: [
        {
          id: "1f0d2c3b-0000-4000-8000-000000000001",
          type: "short_text",
          label: "Nome",
          description: "",
          required: true,
        },
      ],
    },
    theme: { mode: "dark", accent_color: "#7c3aed" },
    settings: { layout: "one_per_screen", require_login: false },
    endpoint: "contacto",
    published_url: "https://omelhor.site/f/contacto",
    published_at: "2026-07-02T09:00:00Z",
    views_count: 214,
    submissions_count: 17,
    ...overrides,
  };
}

describe("forms", () => {
  test("carries the fourteen keys FormBlueprint declares, and no others", async () => {
    const { http } = harness([formPayload()]);

    const [form] = await new FormsNamespace(http).list();

    expectKeys(form!, [
      "id",
      "created_at",
      "updated_at",
      "user_id",
      "title",
      "status",
      "schema",
      "theme",
      "settings",
      "endpoint",
      "published_url",
      "published_at",
      "views_count",
      "submissions_count",
    ]);
  });

  test("a draft carries published_at as null rather than omitting it", async () => {
    const { http } = harness([formPayload({ status: "draft", published_at: null, published_url: null })]);

    const [form] = (await new FormsNamespace(http).list()) as Array<Form & Record<string, unknown>>;

    // The blueprint declares the field unconditionally, so the key is always
    // there. A type that made it optional would push every reader into a
    // needless `?? null`.
    expect("published_at" in form!).toBe(true);
    expect(form!.published_at).toBeNull();
  });

  test("a stored schema field always has an id, a description and a required flag", async () => {
    const { http } = harness(formPayload());

    const form = await new FormsNamespace(http).get("fRm1234567");
    const [field] = form.schema.fields;

    // `Forms::InputSanitizer#field` writes all three on every field it keeps:
    // the id is minted, and label/description are coerced with `.to_s`, so an
    // omitted description is stored as "" rather than dropped.
    expect(field!.id).toBe("1f0d2c3b-0000-4000-8000-000000000001");
    expect(field!.description).toBe("");
    expect(field!.required).toBe(true);
  });

  test("a submission has created_at and deliberately no updated_at", async () => {
    const { http } = harness([
      {
        id: "sUb1234567",
        form_id: "fRm1234567",
        user_id: null,
        answers: { "1f0d2c3b-0000-4000-8000-000000000001": "Afonso" },
        country: "pt",
        device_name: "Firefox",
        completed_at: "2026-08-25T14:22:03Z",
        created_at: "2026-08-25T14:22:03Z",
      },
    ]);

    const [submission] = (await new FormsNamespace(http).submissions.list({
      formId: "fRm1234567",
    })) as Array<FormSubmission & Record<string, unknown>>;

    expectKeys(submission!, [
      "id",
      "form_id",
      "user_id",
      "answers",
      "country",
      "device_name",
      "completed_at",
      "created_at",
    ]);
    // FormSubmissionBlueprint inherits Blueprinter::Base directly, precisely
    // so that ApplicationBlueprint's automatic updated_at cannot creep in.
    expect(submission!["updated_at"]).toBeUndefined();
  });

  test("the public view is a hand-built hash with require_login, not a Form", async () => {
    const { http, calls } = harness({
      id: "fRm1234567",
      title: "Contacto",
      schema: { fields: [] },
      theme: {},
      settings: { require_login: true },
      endpoint: "contacto",
      require_login: true,
    });

    const form = await new FormsNamespace(http).getPublic("contacto");

    expectKeys(form, ["id", "title", "schema", "theme", "settings", "endpoint", "require_login"]);
    expect(calls[0]!.path).toBe("/forms/by_endpoint/contacto");
  });

  test("the public URL matches the published_url the server builds", async () => {
    const { http } = harness(formPayload());
    const forms = new FormsNamespace(http);

    const form = await forms.get("fRm1234567");

    // `published_url` is null for a form that was never published, and
    // comparing against a null would pass vacuously for the wrong reason.
    // Assert it is there first, so an unpublished fixture fails loudly.
    expect(form.endpoint).toBeString();
    expect(form.published_url).toBeString();
    expect(forms.publicUrl(form.endpoint as string)).toBe(form.published_url as string);
  });
});

// ---------------------------------------------------------------------------
// link trees
// ---------------------------------------------------------------------------

/** `LinkTreeBlueprint`, default view: the automatic trio plus twelve fields. */
function linkTreePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lTr1234567",
    created_at: "2026-06-01T08:00:00Z",
    updated_at: "2026-08-28T20:00:00Z",
    user_id: "uSr1234567",
    slug: "afonso",
    title: "Afonso",
    bio: null,
    avatar_data_url: null,
    theme: { button_style: "rounded" },
    items: [
      {
        id: "9a8b7c6d-0000-4000-8000-000000000001",
        label: "GitHub",
        url: "https://github.com/afonsopc",
      },
    ],
    clicks_by_item: { "9a8b7c6d-0000-4000-8000-000000000001": 12 },
    cv_url: null,
    cv_filename: null,
    public_url: "https://omelhor.site/t/afonso",
    short_link_endpoint: "afonso",
    short_link_namespace: "t",
    ...overrides,
  };
}

describe("link trees", () => {
  test("the owner view carries all fifteen keys the default view declares", async () => {
    const { http } = harness([linkTreePayload()]);

    const [tree] = (await new LinkTreesNamespace(http).list()) as LinkTree[];

    expectKeys(tree!, [
      "id",
      "created_at",
      "updated_at",
      "user_id",
      "slug",
      "title",
      "bio",
      "avatar_data_url",
      "theme",
      "items",
      "clicks_by_item",
      "cv_url",
      "cv_filename",
      "public_url",
      "short_link_endpoint",
      "short_link_namespace",
    ]);
    expect(tree!.bio).toBeNull();
    expect(tree!.short_link_namespace).toBe("t");
  });

  test("the public view drops exactly the seven keys :public excludes", async () => {
    const owner = linkTreePayload();
    const publicView = { ...owner };
    for (const key of [
      "user_id",
      "clicks_by_item",
      "public_url",
      "short_link_endpoint",
      "short_link_namespace",
      "created_at",
      "updated_at",
    ]) {
      delete (publicView as Record<string, unknown>)[key];
    }
    const { http } = harness(publicView);

    const tree = (await new LinkTreesNamespace(http).getPublic("afonso")) as PublicLinkTree &
      Record<string, unknown>;

    // A Blueprinter view INHERITS the default view's fields, so id, cv_url and
    // cv_filename survive the exclusions. Assuming the opposite has caused
    // bugs in this repo before.
    expectKeys(tree, ["id", "slug", "title", "bio", "avatar_data_url", "theme", "items", "cv_url", "cv_filename"]);
    expect(tree["created_at"]).toBeUndefined();
    expect(tree["user_id"]).toBeUndefined();
  });

  test("a stored item always has an id, because clicks are filed under it", async () => {
    const { http } = harness([linkTreePayload()]);

    const [tree] = await new LinkTreesNamespace(http).list();
    const [item] = tree!.items;

    expect(item!.id).toBe("9a8b7c6d-0000-4000-8000-000000000001");
    expect(tree!.clicks_by_item[item!.id]).toBe(12);
  });

  test("stats add clicks_by_item on top of the five short-link keys", async () => {
    const { http } = harness({
      total_clicks: 30,
      last_click_at: "2026-08-28T19:00:00Z",
      clicks_daily: [{ date: "2026-08-28", count: 4 }],
      top_countries: [{ country: "pt", count: 30 }],
      top_devices: [{ device_name: "Safari", count: 21 }],
      clicks_by_item: { "9a8b7c6d-0000-4000-8000-000000000001": 12 },
    });

    const stats = await new LinkTreesNamespace(http).stats("lTr1234567");

    expectKeys(stats, [
      "total_clicks",
      "last_click_at",
      "clicks_daily",
      "top_countries",
      "top_devices",
      "clicks_by_item",
    ]);
    // The two counts measure different things and will not add up: the totals
    // come from the paired short link (page visits), clicks_by_item from the
    // tree (link clicks).
    expect(stats.total_clicks).not.toBe(stats.clicks_by_item["9a8b7c6d-0000-4000-8000-000000000001"]);
  });

  test("the public URL matches the public_url the server builds", async () => {
    const { http } = harness([linkTreePayload()]);
    const trees = new LinkTreesNamespace(http);

    const [tree] = await trees.list();

    expect(trees.publicUrl(tree!.slug)).toBe(tree!.public_url);
  });
});

// ---------------------------------------------------------------------------
// quotas
// ---------------------------------------------------------------------------

describe("quotas", () => {
  test("every entry carries the same seven keys, whatever it measures", async () => {
    const { http } = harness({
      authenticated: true,
      quotas: [
        {
          resource: "transcription_seconds",
          unit: "seconds",
          period: "daily",
          used: 600,
          limit: 3600,
          remaining: 3000,
          unlimited: false,
        },
        {
          resource: "music_storage_bytes",
          unit: "bytes",
          period: "total",
          used: 1_073_741_824,
          limit: 107_374_182_400,
          remaining: 106_300_440_576,
          unlimited: false,
        },
      ],
    });

    const report = await new QuotasNamespace(http).list();

    // The point of the catalogue: one shape for every resource, so a reader
    // does not have to know that audio is metered in seconds and music in
    // bytes to understand the answer.
    for (const entry of report.quotas) {
      expectKeys(entry, ["resource", "unit", "period", "used", "limit", "remaining", "unlimited"]);
    }
  });

  test("resource, unit and period arrive as plain strings, not as Ruby symbols", async () => {
    const { http } = harness({
      authenticated: true,
      quotas: [
        {
          resource: "jumpstyle_edits",
          unit: "count",
          period: "daily",
          used: 2,
          limit: 15,
          remaining: 13,
          unlimited: false,
        },
      ],
    });

    const entry = await new QuotasNamespace(http).get("jumpstyle_edits");

    expect(entry?.resource).toBe("jumpstyle_edits");
    expect(entry?.period).toBe("daily");
    expect(entry?.period).not.toBe(":daily");
  });

  test("an unlimited account nulls limit and remaining rather than sending a huge number", async () => {
    const { http } = harness({
      authenticated: true,
      quotas: [
        {
          resource: "caption_seconds",
          unit: "seconds",
          period: "daily",
          used: 120,
          limit: null,
          remaining: null,
          unlimited: true,
        },
      ],
    });

    const entry = await new QuotasNamespace(http).get("caption_seconds");

    // Float::INFINITY has no JSON spelling, so `limit_json` sends null. A
    // client reading null as zero would refuse work on the one account that
    // has no ceiling at all.
    expect(entry?.limit).toBeNull();
    expect(entry?.unlimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ip lookup
// ---------------------------------------------------------------------------

describe("ip lookup", () => {
  test("answers exactly five keys and no GeoIP city payload", async () => {
    const { http, calls } = harness({
      ip: "8.8.8.8",
      country: "us",
      asn: 15169,
      organization: "GOOGLE",
      network: "8.8.8.0/24",
    });

    const result = await new IpLookupNamespace(http).get("8.8.8.8");

    // The database behind this is the iptoasn.com IP-to-ASN table, not a
    // GeoIP City database: there is no city, no coordinates, no timezone.
    expectKeys(result, ["ip", "country", "asn", "organization", "network"]);
    expect(calls[0]!.path).toBe("/ip_lookup/8.8.8.8");
  });

  test("the country is lowercase, and 'unknown' rather than null for a gap", async () => {
    const { http } = harness({
      ip: "192.0.2.1",
      country: "unknown",
      asn: 0,
      organization: "",
      network: "192.0.2.0/24",
    });

    const result = await new IpLookupNamespace(http).mine();

    expect(result.country).toBe("unknown");
    expect(result.country).not.toBe(result.country.toUpperCase());
    // Both substitutes the MMDB builder writes, neither of them null.
    expect(result.asn).toBe(0);
    expect(result.organization).toBe("");
  });

  test("'mine' is a literal path segment, not a client-side rewrite", async () => {
    const { http, calls } = harness({
      ip: "77.54.191.38",
      country: "pt",
      asn: 2860,
      organization: "NOS-COMUNICACOES",
      network: "77.54.0.0/16",
    });

    await new IpLookupNamespace(http).mine();

    expect(calls[0]!.path).toBe("/ip_lookup/mine");
  });
});

// ---------------------------------------------------------------------------
// tools: the shared row
// ---------------------------------------------------------------------------

/** The five keys every tool blueprint declares in its default view. */
const TOOL_BASE_KEYS = ["id", "created_at", "updated_at", "status", "error", "finished_at", "user_id", "ip_address"];

/** `UpscaleBlueprint`, :extended - which is what BOTH its routes render. */
function upscalePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aB3dE5fG7h",
    created_at: "2026-08-29T10:00:00Z",
    updated_at: "2026-08-29T10:00:31Z",
    status: "complete",
    scale: "4",
    error: null,
    finished_at: "2026-08-29T10:00:31Z",
    user_id: "uSr1234567",
    ip_address: null,
    result_url: "https://cdn.test/upscaled.png",
    ...overrides,
  };
}

describe("tools: upscale", () => {
  test("show renders :extended, so result_url is present and null before it finishes", async () => {
    const { http } = harness(
      upscalePayload({ status: "pending", finished_at: null, result_url: null }),
    );

    const record = (await new UpscaleNamespace(http).get("aB3dE5fG7h")) as Upscale & Record<string, unknown>;

    expectKeys(record, [...TOOL_BASE_KEYS, "scale", "result_url"]);
    expect(record.result_url).toBeNull();
    // UpscaleBlueprint has no progress_percent at all; progress for this tool
    // lives on the Job row the create call names.
    expect(record["progress_percent"]).toBeUndefined();
  });

  test("scale is the string '4', not the number 4", async () => {
    const { http } = harness(upscalePayload());

    const record = await new UpscaleNamespace(http).get("aB3dE5fG7h");

    // The allow-list is `%w[2 3 4]` and the comparison is on strings, so
    // sending 4 and sending "4" are not the same request.
    expect(record.scale).toBe("4");
    expect(typeof record.scale).toBe("string");
  });

  test("create merges job_id and watch_token onto the rendered row", async () => {
    const { http } = harness(
      upscalePayload({
        status: "pending",
        finished_at: null,
        result_url: null,
        user_id: null,
        ip_address: "77.54.191.38",
        job_id: "kQ7bN2mXpT",
        watch_token: "eyJfcmFpbHMiOnsibWVzc2FnZSI6ImFiYyJ9fQ",
      }),
      201,
    );

    const created = await new UpscaleNamespace(http).create({
      file: { data: new Blob([new Uint8Array([1, 2, 3])]), filename: "in.png" },
      scale: "4",
    });

    expectKeys(created, [...TOOL_BASE_KEYS, "scale", "result_url", "job_id", "watch_token"]);
    expect(created.job_id).toBe("kQ7bN2mXpT");
    // The anonymous branch: no owner, an address instead, and a token that is
    // the only way to poll the job.
    expect(created.user_id).toBeNull();
    expect(created.ip_address).toBe("77.54.191.38");
  });

  test("resultUrl explains an unfinished run instead of returning an empty string", async () => {
    const { http } = harness(upscalePayload({ status: "processing", finished_at: null, result_url: null }));
    const upscale = new UpscaleNamespace(http);

    const record = await upscale.get("aB3dE5fG7h");

    expect(() => upscale.resultUrl(record)).toThrow(OmsError);
    expect(() => upscale.resultUrl(record)).toThrow(/still "processing"/);
  });
});

describe("tools: background removal", () => {
  test("carries the base row plus result_url, and nothing else", async () => {
    const { http } = harness({
      id: "bR3dE5fG7h",
      created_at: "2026-08-29T10:00:00Z",
      updated_at: "2026-08-29T10:00:12Z",
      status: "complete",
      error: null,
      finished_at: "2026-08-29T10:00:12Z",
      user_id: "uSr1234567",
      ip_address: null,
      result_url: "https://cdn.test/cutout.png",
    });

    const record = await new BackgroundRemovalNamespace(http).get("bR3dE5fG7h");

    expectKeys(record, [...TOOL_BASE_KEYS, "result_url"]);
  });

  test("a create whose tracking row could not be read sends watch_token as null", async () => {
    const { http, calls } = harness(
      {
        id: "bR3dE5fG7h",
        created_at: "2026-08-29T10:00:00Z",
        updated_at: "2026-08-29T10:00:00Z",
        status: "complete",
        error: null,
        finished_at: "2026-08-29T10:00:00Z",
        user_id: "uSr1234567",
        ip_address: null,
        result_url: "https://cdn.test/cutout.png",
        job_id: "kQ7bN2mXpT",
        watch_token: null,
      },
      201,
    );
    const removals = new BackgroundRemovalNamespace(http);

    const created = await removals.create({
      file: { data: new Blob([new Uint8Array([1])]), filename: "in.png" },
    });

    // `signed_id` is called on a row that may not have been found, so this key
    // is null rather than absent. Passing null through as `?watch_token=null`
    // would turn a working authenticated poll into a 404.
    expect(created.watch_token).toBeNull();
    expect(calls[0]!.query.has("watch_token")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tools: transcription
// ---------------------------------------------------------------------------

describe("tools: transcription", () => {
  test("carries every :extended field, present-and-null while it is still running", async () => {
    const { http } = harness({
      id: "tRn1234567",
      created_at: "2026-08-29T09:00:00Z",
      updated_at: "2026-08-29T09:00:05Z",
      status: "processing",
      model_id: "large-v3-turbo",
      duration_seconds: 754,
      language: null,
      detected_language: null,
      error: null,
      finished_at: null,
      user_id: "uSr1234567",
      ip_address: null,
      has_original: true,
      progress_percent: 42,
      text: null,
      srt_url: null,
      vtt_url: null,
    });

    const record = (await new TranscriptionNamespace(http).get("tRn1234567")) as Transcription;

    expectKeys(record, [
      ...TOOL_BASE_KEYS,
      "model_id",
      "duration_seconds",
      "language",
      "detected_language",
      "has_original",
      "progress_percent",
      "text",
      "srt_url",
      "vtt_url",
    ]);
    // The transcript is withheld until the run completes so that polling a
    // long file does not drag it across the wire every few seconds.
    expect(record.text).toBeNull();
    expect(record.has_original).toBe(true);
  });

  test("has_original is a real boolean, never null", async () => {
    const { http } = harness({
      id: "tRn1234567",
      created_at: "2026-08-29T09:00:00Z",
      updated_at: "2026-08-29T09:12:00Z",
      status: "complete",
      model_id: "large-v3-turbo",
      duration_seconds: 754,
      language: "pt",
      detected_language: "pt",
      error: null,
      finished_at: "2026-08-29T09:12:00Z",
      user_id: "uSr1234567",
      ip_address: null,
      has_original: false,
      progress_percent: null,
      text: "olá mundo",
      srt_url: "https://cdn.test/subs.srt",
      vtt_url: "https://cdn.test/subs.vtt",
    });

    const record = await new TranscriptionNamespace(http).get("tRn1234567");

    // `original_audio.attached?` - a predicate, so it cannot be null even
    // after the 24-hour sweep has taken the audio.
    expect(record.has_original).toBe(false);
    expect(record.progress_percent).toBeNull();
  });

  test("the models list is unwrapped out of its one-key envelope", async () => {
    const { http, calls } = harness({
      models: [
        { id: "large-v3-turbo", translation_key: "models.largeV3Turbo", default: true },
        { id: "medium", translation_key: "models.medium", default: false },
      ],
    });

    const models = await new TranscriptionNamespace(http).models();

    expect(calls[0]!.path).toBe("/transcriptions/models");
    expect(models.map((model) => model.id)).toEqual(["large-v3-turbo", "medium"]);
    expect(models.filter((model) => model.default)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// tools: vocal separation
// ---------------------------------------------------------------------------

/** `VocalSeparationBlueprint`, :extended - what both routes render. */
function separationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "vSp1234567",
    created_at: "2026-08-29T08:00:00Z",
    updated_at: "2026-08-29T08:00:01Z",
    status: "pending",
    model_id: "bs-roformer",
    duration_seconds: 212,
    error: null,
    finished_at: null,
    song_id: null,
    user_id: "uSr1234567",
    ip_address: null,
    has_vocals: false,
    has_instrumental: false,
    has_original: true,
    song_title: null,
    progress_percent: null,
    queue_position: 2,
    vocals_url: null,
    instrumental_url: null,
    ...overrides,
  };
}

describe("tools: vocal separation", () => {
  test("carries every :extended field, queue_position included", async () => {
    const { http } = harness(separationPayload());

    const record = (await new VocalSeparationNamespace(http).get("vSp1234567")) as VocalSeparation;

    expectKeys(record, [
      ...TOOL_BASE_KEYS,
      "model_id",
      "duration_seconds",
      "song_id",
      "song_title",
      "has_original",
      "has_vocals",
      "has_instrumental",
      "progress_percent",
      "queue_position",
      "vocals_url",
      "instrumental_url",
    ]);
    expect(record.queue_position).toBe(2);
  });

  test("song_id is a NUMBER, because songs kept an integer primary key", async () => {
    const { http } = harness(
      separationPayload({ song_id: 90210, song_title: "Um Tema", status: "complete", finished_at: "2026-08-29T08:40:00Z", queue_position: null }),
    );

    const record = await new VocalSeparationNamespace(http).get("vSp1234567");

    // `vocal_separations.song_id` is a bigint pointing at `songs`. Every other
    // id in the tools family is an opaque string, and this one is not.
    expect(typeof record.song_id).toBe("number");
    expect(record.song_id).toBe(90210);
  });

  test("a song-owned separation is refused by name, not blamed on the retention sweep", async () => {
    const { http } = harness(
      separationPayload({
        song_id: 90210,
        song_title: "Um Tema",
        status: "complete",
        finished_at: "2026-08-29T08:40:00Z",
        queue_position: null,
        has_vocals: true,
        has_instrumental: true,
      }),
    );
    const separations = new VocalSeparationNamespace(http);

    const record = await separations.get("vSp1234567");

    // The guard used to test song_id for a string and therefore never fired,
    // so a song-owned run fell through and was reported as a swept artefact.
    expect(() => separations.stemUrl(record, "vocals")).toThrow(/filesystem nodes/);
    expect(() => separations.stemUrl(record, "vocals")).not.toThrow(/swept/);
  });

  test("the song-owned check tests for a present id, not for a JavaScript type", async () => {
    // A host that deserialised the row itself can widen a bigint to a string.
    // That is a wrong type, not a run that suddenly has no song, so the guard
    // still fires rather than answering the wrong question loudly.
    const { http } = harness(
      separationPayload({
        song_id: "90210",
        song_title: "Um Tema",
        status: "complete",
        finished_at: "2026-08-29T08:40:00Z",
        queue_position: null,
      }),
    );
    const separations = new VocalSeparationNamespace(http);

    const record = await separations.get("vSp1234567");

    expect(() => separations.stemUrl(record, "vocals")).toThrow(/filesystem nodes/);
  });

  test("an uploaded run keeps song_id null and hands back the stem URL", async () => {
    const { http } = harness(
      separationPayload({
        status: "complete",
        finished_at: "2026-08-29T08:40:00Z",
        queue_position: null,
        has_vocals: true,
        has_instrumental: true,
        vocals_url: "https://cdn.test/vocals.wav",
        instrumental_url: "https://cdn.test/instrumental.wav",
      }),
    );
    const separations = new VocalSeparationNamespace(http);

    const record = await separations.get("vSp1234567");

    expect(record.song_id).toBeNull();
    expect(separations.stemUrl(record, "instrumental")).toBe("https://cdn.test/instrumental.wav");
  });
});

// ---------------------------------------------------------------------------
// tools: captions
// ---------------------------------------------------------------------------

/** `CaptionJobBlueprint`, :extended - what every caption route renders. */
function captionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cAp1234567",
    created_at: "2026-08-29T07:00:00Z",
    updated_at: "2026-08-29T07:00:02Z",
    status: "uploaded",
    filename: "take-3.mp4",
    width: 1080,
    height: 1920,
    fps: 30.0,
    duration: 187.4,
    language: null,
    window_start: null,
    window_end: null,
    transcribed_seconds: 0,
    error: null,
    finished_at: null,
    user_id: "uSr1234567",
    ip_address: null,
    words: null,
    progress_percent: null,
    render_stage: null,
    output_url: null,
    ...overrides,
  };
}

describe("tools: captions", () => {
  test("carries every :extended field on a freshly uploaded job", async () => {
    const { http } = harness(captionPayload());

    const record = (await new CaptionsNamespace(http).get("cAp1234567")) as CaptionJob;

    expectKeys(record, [
      ...TOOL_BASE_KEYS,
      "filename",
      "width",
      "height",
      "fps",
      "duration",
      "language",
      "window_start",
      "window_end",
      "transcribed_seconds",
      "words",
      "progress_percent",
      "render_stage",
      "output_url",
    ]);
  });

  test("the probed numbers are real numbers, and transcribed_seconds starts at 0", async () => {
    const { http } = harness(captionPayload());

    const record = await new CaptionsNamespace(http).get("cAp1234567");

    // All five columns are NOT NULL with a numeric default, so none of them is
    // ever null and 0 means "not probed yet", not "unknown".
    expect(record.width).toBe(1080);
    expect(record.fps).toBe(30);
    expect(record.transcribed_seconds).toBe(0);
  });

  test("an empty word list arrives as null, because the blueprint renders words.presence", async () => {
    const { http } = harness(captionPayload());

    const record = await new CaptionsNamespace(http).get("cAp1234567");

    // The column is NOT NULL DEFAULT '[]', but `[].presence` is nil in Ruby,
    // so the empty case reaches the wire as null and never as [].
    expect(record.words).toBeNull();
    expect("words" in record).toBe(true);
  });

  test("words carry text/t0/t1, not word/start/end", async () => {
    const { http } = harness(
      captionPayload({
        status: "transcribed",
        language: "pt",
        window_start: 0,
        window_end: 30,
        transcribed_seconds: 30,
        words: [
          { text: "olá", t0: 0.42, t1: 0.71 },
          { text: "mundo", t0: 0.75, t1: 1.2 },
        ],
      }),
    );

    const record = await new CaptionsNamespace(http).get("cAp1234567");

    // These are the keys the render endpoint permits. A word object built any
    // other way is dropped server-side and the render fails with "No words to
    // render", which looks nothing like a key-naming mistake.
    expectKeys(record.words![0]!, ["text", "t0", "t1"]);
  });

  test("fonts unwraps the envelope and answers [] when the sidecar is down", async () => {
    const listed = harness({ fonts: ["montserrat", "inter", "anton"] });
    const down = harness({ fonts: [] });

    expect(await new CaptionsNamespace(listed.http).fonts()).toEqual(["montserrat", "inter", "anton"]);
    expect(listed.calls[0]!.path).toBe("/caption_jobs/fonts");
    // The controller rescues a sidecar failure into `{ fonts: [] }` with a 200,
    // so an empty list means "could not ask" just as much as "none".
    expect(await new CaptionsNamespace(down.http).fonts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tools: jumpstyle
// ---------------------------------------------------------------------------

describe("tools: jumpstyle", () => {
  test("carries every :extended field, and never a pending status", async () => {
    const { http } = harness({
      id: "jMp1234567",
      created_at: "2026-08-29T06:00:00Z",
      updated_at: "2026-08-29T06:00:00Z",
      status: "processing",
      track_filename: "hardstyle.mp3",
      n_clips: 7,
      duration: 30.0,
      seed: 48213,
      density: "normal",
      rapid_fire: false,
      bpm: null,
      error: null,
      finished_at: null,
      user_id: "uSr1234567",
      ip_address: null,
      stage: "cutting",
      progress_percent: 18,
      detected_bpm: 150.0,
      output_url: null,
    });

    const record = (await new JumpstyleNamespace(http).get("jMp1234567")) as JumpstyleJob;

    expectKeys(record, [
      ...TOOL_BASE_KEYS,
      "track_filename",
      "n_clips",
      "duration",
      "seed",
      "density",
      "rapid_fire",
      "bpm",
      "stage",
      "progress_percent",
      "detected_bpm",
      "output_url",
    ]);
    // The controller forwards the files to the sidecar inside the create
    // request, so a row that exists has already started.
    expect(record.status).toBe("processing");
  });

  test("the seed is on the row, which is the only way to reproduce a cut", async () => {
    const { http } = harness({
      id: "jMp1234567",
      created_at: "2026-08-29T06:00:00Z",
      updated_at: "2026-08-29T06:04:00Z",
      status: "complete",
      track_filename: "hardstyle.mp3",
      n_clips: 7,
      duration: 30.0,
      seed: 48213,
      density: "hyper",
      rapid_fire: true,
      bpm: null,
      error: null,
      finished_at: "2026-08-29T06:04:00Z",
      user_id: "uSr1234567",
      ip_address: null,
      stage: null,
      progress_percent: null,
      detected_bpm: 150.0,
      output_url: "https://cdn.test/edit.mp4",
    });

    const record = await new JumpstyleNamespace(http).get("jMp1234567");

    expect(record.seed).toBe(48213);
    expect(record.rapid_fire).toBe(true);
    // Once the row settles, detected_bpm stops being the sidecar's live guess
    // and becomes whatever was saved.
    expect(record.detected_bpm).toBe(150);
    expect(record.stage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tools: downloader
// ---------------------------------------------------------------------------

describe("tools: downloader", () => {
  test("the create answer has no id of its own, so request_id is mapped onto one", async () => {
    const { http } = harness({ request_id: "dLd1234567", target: "https://example.com/watch?v=x" }, 200);

    const job = await new DownloaderNamespace(http).createJob({ sourceUrl: "https://example.com/watch?v=x" });

    // The sidecar answers exactly two keys and neither is called `id`. Both
    // originals are kept alongside the mapped one.
    expect(job.id).toBe("dLd1234567");
    expect(job.request_id).toBe("dLd1234567");
    expect(job.target).toBe("https://example.com/watch?v=x");
    // Nothing about status: a fresh job has none at all.
    expect(job.status).toBeUndefined();
  });

  test("a progress answer carries no id either, so the one asked with is stamped back on", async () => {
    const { http } = harness({
      status: "downloading",
      message: "downloading 42%",
      progress: 0.42,
      title: "Um Tema",
      uploader: "Alguém",
      duration_s: 212,
      source_url: "https://example.com/watch?v=x",
    });

    const job = await new DownloaderNamespace(http).getJob("dLd1234567");

    expect(job.id).toBe("dLd1234567");
    // A FRACTION, not a percentage - the one number in the whole SDK that is
    // scaled 0..1 rather than 0..100.
    expect(job.progress).toBe(0.42);
  });

  test("it finishes on 'complete' and fails on 'failed', the tool spellings", async () => {
    const { http } = harness({ status: "complete", message: "saved Um Tema.mp3", progress: 1 });

    const job = await new DownloaderNamespace(http).getJob("dLd1234567");

    expect(job.status).toBe("complete");
    // The failure reason rides on `message`, not on `error`: this sidecar has
    // no error key at all.
    expect(job.error).toBeUndefined();
  });

  test("artwork candidates are unwrapped out of their envelope", async () => {
    const { http, calls } = harness({
      items: [
        { url: "https://cdn.test/art.jpg", thumb_url: null, source: "itunes", width: 1400, height: 1400, label: "Álbum", subtitle: "Artista" },
      ],
    });

    const items = await new DownloaderNamespace(http).artworkSearch({ artist: "Artista", title: "Um Tema" });

    expect(calls[0]!.path).toBe("/tools_downloader/artwork_search");
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe("https://cdn.test/art.jpg");
  });

  test("fileUrl names the endpoint and carries no credential in the query", async () => {
    const { http } = harness({});

    const url = new DownloaderNamespace(http).fileUrl("dLd1234567");

    expect(url).toBe(`${BASE_URL}/tools_downloader/jobs/dLd1234567/file`);
    // The token belongs in an Authorization header. Copying it into a URL puts
    // it in browser history, in the Referer and in every proxy log on the way.
    expect(url).not.toContain("token");
  });
});
