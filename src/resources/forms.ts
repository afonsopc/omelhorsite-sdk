/**
 * The `forms` namespace: hosted forms and the submissions they collect.
 *
 * A form has an owner-facing side (create, edit the schema, read submissions)
 * and a public side addressed by ENDPOINT rather than by id
 * (`GET /forms/by_endpoint/:endpoint`, `POST /form_submissions`), which is what
 * an anonymous respondent hits. The SDK exposes both; the public calls work
 * without a credential unless the form turns `settings.require_login` on.
 *
 * The endpoint belongs to a short link paired with the form, which is why
 * renaming it is a real operation and why availability has its own lookup.
 */

import { type ApiClient, Resource } from "../http";
import type { BaseRecord, FileInput, Id, Json, RequestOptions, Timestamp } from "../types";
import { SHORT_LINK_BASE_URL } from "./shortLinks";

/** The reserved short-link namespace a published form is served under. */
export const FORM_NAMESPACE = "f";

/**
 * Public prefix a published form resolves under, and the prefix
 * {@link Form.published_url} is built from server-side.
 */
export const FORM_BASE_URL = `${SHORT_LINK_BASE_URL}/${FORM_NAMESPACE}`;

/**
 * Publication state. Only `"published"` answers on the public side; `"draft"`
 * and `"archived"` both 404 there.
 */
export type FormStatus = "draft" | "published" | "archived";

/** Kinds of field the builder understands. Anything else is dropped. */
export type FormSchemaFieldType =
  | "short_text"
  | "long_text"
  | "email"
  | "number"
  | "single_choice"
  | "multi_choice"
  | "dropdown"
  | "statement"
  | "image";

/**
 * One choice of a `single_choice`, `multi_choice` or `dropdown` field, AS
 * READ back off a form.
 *
 * `id` is not optional here even though it is optional when writing: the
 * server mints a UUID for any option that arrives without one, so a stored
 * option always has one. Write with {@link FormSchemaFieldOptionInput}.
 */
export interface FormSchemaFieldOption {
  /** Stable within the form. */
  readonly id: string;
  readonly label: string;
}

/** One choice as WRITTEN. Omit `id` and the server mints a UUID. */
export interface FormSchemaFieldOptionInput {
  readonly id?: string;
  readonly label: string;
}

/**
 * One field of a form, AS READ back.
 *
 * `id` is the key answers are filed under - NOT the label.
 *
 * Five of these keys are non-optional because the server writes them on EVERY
 * field it keeps, whatever arrived: `id` (minted when absent), `type`, `label`
 * and `description` (an absent one is stored as `""`, not dropped) and
 * `required` (always a real boolean). The rest are genuinely absent from the
 * stored object when unused: `placeholder` is only kept when present,
 * `options` only for the three choice types, and `min`/`max` only for
 * `number`.
 *
 * Write with {@link FormSchemaFieldInput}, where all of that is optional.
 */
export interface FormSchemaField {
  readonly id: string;
  readonly type: FormSchemaFieldType;
  /** Never `null`; `""` for a field saved without one. */
  readonly label: string;
  /** Never `null`; `""` for a field saved without one. */
  readonly description: string;
  readonly required: boolean;
  readonly placeholder?: string;
  /** Only on the three choice types. */
  readonly options?: FormSchemaFieldOption[];
  /** Only on `number`, and only when one was set. */
  readonly min?: number;
  /** Only on `number`, and only when one was set. */
  readonly max?: number;
}

/**
 * One field as WRITTEN.
 *
 * Every key but `type` may be omitted. `type` may not: a field whose type is
 * not one of {@link FormSchemaFieldType} is dropped from the schema in
 * silence, which looks exactly like a field that was never sent.
 *
 * A {@link FormSchemaField} read off a form is assignable here, so the
 * read-edit-write round trip needs no mapping.
 */
export interface FormSchemaFieldInput {
  /** Omit and the server mints a UUID - which you then have to read back
   * before you can file an answer under it. */
  readonly id?: string;
  readonly type: FormSchemaFieldType;
  readonly label?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly options?: FormSchemaFieldOptionInput[];
  readonly min?: number;
  readonly max?: number;
}

/**
 * The field definition of a form, as read. Always `{ fields: [...] }`, never
 * `null` and never a bare array: a new form starts with an empty envelope and
 * the server rebuilds it on every write.
 */
export interface FormSchema {
  readonly fields: FormSchemaField[];
}

/**
 * The field definition as written. The server rebuilds it from scratch keeping
 * only the keys {@link FormSchemaFieldInput} names, so anything extra is lost
 * without a word - and a write that is not an object at all is silently read
 * as `{ fields: [] }`, which empties the form rather than failing.
 */
export interface FormSchemaInput {
  readonly fields: FormSchemaFieldInput[];
}

/**
 * Styling of a form. Colours must be `#RRGGBB`; images must be `data:image/`
 * URIs under 2 MB. Anything else in here is dropped silently.
 */
export interface FormTheme {
  readonly bg_color?: string;
  readonly fg_color?: string;
  readonly accent_color?: string;
  readonly card_color?: string;
  readonly mode?: "light" | "dark" | "custom";
  readonly font?: "inter" | "cantarell" | "system";
  /** `data:image/...` or `null` to clear. */
  readonly bg_image?: string | null;
  /** `data:image/...` or `null` to clear. */
  readonly logo_image?: string | null;
}

/** Behaviour switches. Like the theme, unknown keys are dropped. */
export interface FormSettings {
  readonly layout?: "one_per_screen" | "single_page";
  /** Makes the public form and its submissions require a credential. */
  readonly require_login?: boolean;
  readonly show_progress?: boolean;
  readonly collect_email?: boolean;
  /** These five are truncated to 500 characters. */
  readonly welcome_title?: string;
  readonly welcome_subtitle?: string;
  readonly submit_label?: string;
  readonly thank_you_title?: string;
  readonly thank_you_subtitle?: string;
}

/**
 * A hosted form, owner view.
 *
 * One shape, not two: index, show, create AND update all answer the same
 * record, and there is no richer variant to ask for. Every key below is on
 * every response.
 */
export interface Form extends BaseRecord {
  readonly user_id: Id;
  /** Never `null`; `""` for a form saved without one. Capped at 200 characters. */
  readonly title: string;
  readonly status: FormStatus;
  readonly schema: FormSchema;
  readonly theme: FormTheme;
  readonly settings: FormSettings;
  /** Public path segment, e.g. `"contacto"`. `null` if the pairing is broken. */
  readonly endpoint: string | null;
  /** Shareable short URL, or `null` while there is no endpoint. */
  readonly published_url: string | null;
  /**
   * Set the first time the form is published, and never cleared - archiving or
   * returning a form to draft leaves it standing, so this is "was ever
   * published", not "is published". Read `status` for that.
   *
   * The key is always present; the value is `null` until the first publish.
   */
  readonly published_at: Timestamp | null;
  /** Bumped by every `getPublic` call, the SDK's included. Never `null`. */
  readonly views_count: number;
  /** Answers recorded. Computed per request, so it is always current. */
  readonly submissions_count: number;
}

/**
 * The reduced form a public respondent is allowed to see.
 *
 * NOT a subset of {@link Form}: it carries `require_login` - which is not a
 * field on `Form` at all, only a key inside `settings` - and carries no
 * timestamps, no `user_id`, no counts and no `status`. Seven keys, always all
 * seven.
 */
export interface PublicForm {
  readonly id: Id;
  readonly title: string;
  readonly schema: FormSchema;
  readonly theme: FormTheme;
  readonly settings: FormSettings;
  readonly endpoint: string;
  readonly require_login: boolean;
}

/**
 * One answered form.
 *
 * Deliberately has no `updated_at`: a submission is never edited. Do not add
 * it here on the assumption that every record has one.
 *
 * All seven keys are always present; four of them are nullable.
 */
export interface FormSubmission {
  readonly id: Id;
  readonly form_id: Id;
  /** The respondent, or `null` when they answered anonymously. */
  readonly user_id: Id | null;
  /**
   * Answers keyed by {@link FormSchemaField.id}. An `image` answer is
   * `{ attachment_id, filename }`; a `number` is a float; a `multi_choice` is
   * an array of strings; everything else is a string.
   *
   * Only keys that match a field in the schema survive - anything else is
   * dropped in silence - so a submission can hold FEWER keys than were sent,
   * and an optional field nobody filled in is simply absent.
   */
  readonly answers: Record<string, Json>;
  /**
   * ISO 3166-1 alpha-2, lowercase, resolved from the respondent's IP.
   * `null` when the lookup found nothing.
   */
  readonly country: string | null;
  /** Parsed from the respondent's user agent. `null` when unparseable. */
  readonly device_name: string | null;
  /**
   * When the answers were recorded. Set on every submission the API creates,
   * so this is `null` only for an old row - but it is nullable, so check
   * before formatting it.
   */
  readonly completed_at: Timestamp | null;
  readonly created_at: Timestamp;
}

/** What `POST /form_attachments` answers with. Four keys, no `created_at`. */
export interface FormAttachment {
  readonly id: Id;
  readonly filename: string;
  /** JPEG, PNG, WebP, GIF or HEIC; a save with anything else is a 400. */
  readonly content_type: string;
  /** Absolute URL that serves the bytes inline, no credential required. */
  readonly url: string;
}

/**
 * `GET /forms/endpoint_availability`. Read `available`; the other two keys are
 * conditional and mutually exclusive.
 *
 * `reason` appears only on the rejected branch and only ever holds
 * `"invalid"` - the server has a single rejection reason for forms, covering
 * both a bad shape and a reserved word. (Link trees, which look
 * identical, do distinguish the two; see `LinkTreeSlugAvailability`.)
 * `suggestions` appears only on the well-formed-but-taken branch.
 */
export interface FormEndpointAvailability {
  readonly endpoint: string;
  /** Whether it matches the format and is not reserved. */
  readonly valid: boolean;
  readonly available: boolean;
  /** Only when `valid` is `false`. */
  readonly reason?: "invalid";
  /** Only when `valid` is `true` and `available` is `false`. */
  readonly suggestions?: string[];
}

/**
 * Arguments for creating a form.
 *
 * The form always starts as a `"draft"`: `status` is not writable here, only
 * through {@link UpdateFormInput}. `require_login` lives in `settings`.
 */
export interface CreateFormInput {
  /**
   * Optional, despite being the thing a person names the form by: the server
   * trims it and only validates its LENGTH (200 maximum), so an omitted title
   * saves an untitled form rather than failing. Pass one.
   */
  readonly title?: string;
  /**
   * Public path segment. Lowercased, 1 to 64 characters of `[a-z0-9_-]`
   * starting and ending alphanumeric, and never one of `new create index
   * admin api login signup help`.
   */
  readonly endpoint: string;
  readonly schema?: FormSchemaInput;
  readonly theme?: FormTheme;
  readonly settings?: FormSettings;
}

/**
 * Fields that can change afterwards. A true PATCH: only the keys you pass are
 * touched, and each of `schema`, `theme` and `settings` is replaced wholesale
 * rather than merged.
 */
export interface UpdateFormInput {
  readonly title?: string;
  /** Renames the paired short link, so the old public URL stops working. */
  readonly endpoint?: string;
  readonly schema?: FormSchemaInput;
  readonly theme?: FormTheme;
  readonly settings?: FormSettings;
  /**
   * An unrecognised status is IGNORED in silence and still answers 200 with
   * the old value, so read the returned form rather than trusting the code.
   */
  readonly status?: FormStatus;
}

/** Arguments for answering a form. */
export interface SubmitFormInput {
  /** The form's public endpoint, not its id. */
  readonly endpoint: string;
  /**
   * Answers keyed by {@link FormSchemaField.id}. Keys that are not in the
   * schema are discarded in silence, so send ids, never labels.
   */
  readonly answers: Record<string, Json>;
  /**
   * Files for `image` fields, keyed by the same field id. The SDK uploads each
   * one to `POST /form_attachments` first and folds the resulting
   * `{ attachment_id }` into `answers`, which is the shape the endpoint reads.
   *
   * Authenticated callers, in practice. Each of those uploads is a separate
   * request an anonymous caller has to pass a captcha for, and a Turnstile
   * token is single-use: one token cannot cover both an upload and the
   * submission. An anonymous caller uploads each file through
   * {@link FormSubmissionsNamespace.uploadAttachment} with its own fresh
   * token, then writes `{ attachment_id }` into `answers` by hand.
   */
  readonly files?: Record<string, FileInput>;
  /**
   * Turnstile token. Required while the caller is anonymous, ignored
   * otherwise. Single-use: one token pays for one request.
   */
  readonly captchaToken?: string;
}

/** Arguments for staging one file against a public form. */
export interface UploadFormAttachmentInput {
  /** The form's public endpoint. */
  readonly endpoint: string;
  /** JPEG, PNG, WebP, GIF or HEIC, up to 8 MB. */
  readonly file: FileInput;
  /**
   * Turnstile token. Required while the caller is anonymous, ignored
   * otherwise. Single-use: one token pays for one upload.
   */
  readonly captchaToken?: string;
}

/** Filters for {@link FormSubmissionsNamespace.list}. */
export interface ListFormSubmissionsParams {
  readonly formId: Id;
}

/** Submissions of a form, reachable as `oms.forms.submissions`. */
export class FormSubmissionsNamespace extends Resource {
  /**
   * `GET /form_submissions?form_id=...` - the answers, newest first. Owner
   * only.
   *
   * Not paginated: the endpoint takes no page modifier and hard-caps itself at
   * the 500 most recent, so a busy form silently loses its tail. That is why
   * this returns an array rather than a `Paginated` that could never advance.
   */
  async list(params: ListFormSubmissionsParams, options: RequestOptions = {}): Promise<FormSubmission[]> {
    return this.http.get<FormSubmission[]>("/form_submissions", {
      ...options,
      query: { form_id: params.formId },
    });
  }

  /**
   * `POST /form_submissions` - answers a published form.
   *
   * Anonymous unless the form sets `settings.require_login`, in which case an
   * anonymous caller gets 401. Answers are coerced to the type each field
   * declares and the whole payload is capped at 200 000 bytes of JSON.
   *
   * Answers only the new submission's id: the server does not echo the record
   * back, and the respondent has no permission to read it afterwards.
   *
   * Not retried by default: a replayed submission would be recorded twice.
   */
  async create(input: SubmitFormInput, options: RequestOptions = {}): Promise<{ id: Id }> {
    const answers = { ...input.answers };

    for (const [fieldId, file] of Object.entries(input.files ?? {})) {
      const attachment = await this.uploadAttachment(
        {
          endpoint: input.endpoint,
          file,
          ...(input.captchaToken === undefined ? {} : { captchaToken: input.captchaToken }),
        },
        options,
      );
      answers[fieldId] = { attachment_id: attachment.id };
    }

    return this.http.post<{ id: Id }>(
      "/form_submissions",
      { endpoint: input.endpoint, answers, cf_turnstile_token: input.captchaToken },
      { retry: false, ...options },
    );
  }

  /**
   * `POST /form_attachments` - stages one image against a published form and
   * hands back the id an `image` answer refers to.
   *
   * Called for you by {@link create} when you pass `files`; reach for it
   * directly only to upload before the rest of the answers are ready.
   * Throttled to 30 an hour per IP for anonymous callers.
   */
  async uploadAttachment(input: UploadFormAttachmentInput, options: RequestOptions = {}): Promise<FormAttachment> {
    return this.http.postForm<FormAttachment>(
      "/form_attachments",
      {
        endpoint: input.endpoint,
        file: input.file,
        cf_turnstile_token: input.captchaToken,
      },
      { retry: false, ...options },
    );
  }
}

/** The `forms` namespace, reachable as `oms.forms`. */
export class FormsNamespace extends Resource {
  /** Answers to a form, and the files staged against one. */
  readonly submissions: FormSubmissionsNamespace;

  constructor(http: ApiClient) {
    super(http);
    this.submissions = new FormSubmissionsNamespace(http);
  }

  /**
   * `GET /forms` - the forms you own, most recently edited first, each with
   * its submission count.
   *
   * Not paginated and not filterable: the endpoint takes no modifiers and
   * answers with the whole set.
   */
  async list(options: RequestOptions = {}): Promise<Form[]> {
    return this.http.get<Form[]>("/forms", options);
  }

  /** `GET /forms/:id` - the full definition, owner view. */
  async get(id: Id, options: RequestOptions = {}): Promise<Form> {
    return this.http.get<Form>(`/forms/${encodeURIComponent(id)}`, options);
  }

  /**
   * `GET /forms/by_endpoint/:endpoint` - the respondent's view. Answers only
   * for a published form; a draft is a 404.
   *
   * Every call INCREMENTS the form's `views_count`. Do not use it to poll for
   * changes, and do not call it on behalf of the owner: use {@link get}.
   *
   * @throws {OmsAuthError} 401 when the form requires a login and there is none.
   */
  async getPublic(endpoint: string, options: RequestOptions = {}): Promise<PublicForm> {
    return this.http.get<PublicForm>(`/forms/by_endpoint/${encodeURIComponent(endpoint)}`, options);
  }

  /**
   * `GET /forms/endpoint_availability` - whether an endpoint is free, with
   * alternatives when it is not. The server is still the authority: create can
   * lose a race and answer 400.
   */
  async endpointAvailability(endpoint: string, options: RequestOptions = {}): Promise<FormEndpointAvailability> {
    return this.http.get<FormEndpointAvailability>("/forms/endpoint_availability", {
      ...options,
      query: { endpoint },
    });
  }

  /** {@link endpointAvailability} reduced to its verdict. */
  async endpointAvailable(endpoint: string, options: RequestOptions = {}): Promise<boolean> {
    const availability = await this.endpointAvailability(endpoint, options);
    return availability.available;
  }

  /**
   * `POST /forms` - creates the form and reserves its endpoint in one
   * transaction. The form starts as a draft; publish it with
   * {@link update}.
   *
   * Not retried by default: a replayed create would fail on the endpoint being
   * taken by its own first attempt.
   */
  async create(input: CreateFormInput, options: RequestOptions = {}): Promise<Form> {
    return this.http.post<Form>(
      "/forms",
      {
        title: input.title,
        endpoint: input.endpoint,
        schema: input.schema,
        theme: input.theme,
        settings: input.settings,
      },
      { retry: false, ...options },
    );
  }

  /** `PATCH /forms/:id`. Only the keys you pass are touched. */
  async update(id: Id, input: UpdateFormInput, options: RequestOptions = {}): Promise<Form> {
    return this.http.patch<Form>(`/forms/${encodeURIComponent(id)}`, updateBody(input), options);
  }

  /** Convenience over {@link update} with `status: "published"`. */
  async publish(id: Id, options: RequestOptions = {}): Promise<Form> {
    return this.update(id, { status: "published" }, options);
  }

  /** `DELETE /forms/:id`. Takes the submissions and the endpoint with it. */
  async delete(id: Id, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/forms/${encodeURIComponent(id)}`, options);
  }

  /**
   * `GET /form_attachments/:id` - one file a respondent uploaded.
   *
   * Served inline with `X-Content-Type-Options: nosniff`, and readable by
   * anyone holding the id.
   */
  async attachment(attachmentId: Id, options: RequestOptions = {}): Promise<Blob> {
    const response = await this.http.raw("GET", `/form_attachments/${encodeURIComponent(attachmentId)}`, options);
    return response.blob();
  }

  /**
   * The public URL an endpoint is served from. Pure string building, no
   * request, and the same string the server puts in {@link Form.published_url}.
   *
   * Prefer `form.published_url` when you are holding a record - it is the
   * server's own answer and it is `null` exactly when the pairing is broken,
   * which this cannot know. Reach for this when all you have is an endpoint:
   * after {@link endpointAvailability}, or in a client that stores endpoints
   * rather than forms.
   */
  publicUrl(endpoint: string): string {
    return `${FORM_BASE_URL}/${endpoint}`;
  }
}

/**
 * Builds the PATCH body, keeping only the keys the caller actually passed.
 *
 * The endpoint treats an explicit `null` as a value and an absent key as
 * "leave alone". `JSON.stringify` drops `undefined`, which is exactly the
 * distinction we want.
 */
function updateBody(input: UpdateFormInput): Record<string, unknown> {
  return {
    title: input.title,
    endpoint: input.endpoint,
    schema: input.schema,
    theme: input.theme,
    settings: input.settings,
    status: input.status,
  };
}
