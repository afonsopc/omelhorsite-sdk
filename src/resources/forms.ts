/**
 * The `forms` namespace: hosted forms and the submissions they collect.
 *
 * A form has an owner-facing side (create, edit the schema, read submissions)
 * and a public side addressed by ENDPOINT rather than by id
 * (`GET /forms/by_endpoint/:endpoint`, `POST /form_submissions`), which is what
 * an anonymous respondent hits. The SDK exposes both; the public calls work
 * without a credential unless the form turns `settings.require_login` on.
 *
 * The endpoint is not a column on the form: it lives on a short link paired
 * with it, which is why renaming it is a real operation and why availability
 * has its own lookup.
 */

import { type ApiClient, Resource } from "../http";
import type { BaseRecord, FileInput, Id, Json, RequestOptions, Timestamp } from "../types";

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

/** One choice of a `single_choice`, `multi_choice` or `dropdown` field. */
export interface FormSchemaFieldOption {
  /** Stable within the form. The server mints one when you leave it out. */
  readonly id?: string;
  readonly label: string;
}

/**
 * One field of a form.
 *
 * `id` is the key answers are filed under - NOT the label. Leave it out on
 * create and the server mints a UUID, which you then have to read back before
 * you can submit anything.
 */
export interface FormSchemaField {
  readonly id?: string;
  readonly type: FormSchemaFieldType;
  readonly label: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly placeholder?: string;
  /** Only meaningful on the three choice types. */
  readonly options?: FormSchemaFieldOption[];
  /** Only meaningful on `number`. */
  readonly min?: number;
  /** Only meaningful on `number`. */
  readonly max?: number;
}

/**
 * The field definition of a form. The server rebuilds this from scratch on
 * every write, keeping only the keys above, so anything extra is lost without
 * a word.
 */
export interface FormSchema {
  readonly fields: FormSchemaField[];
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

/** A hosted form, owner view. */
export interface Form extends BaseRecord {
  readonly user_id: Id;
  readonly title: string;
  readonly status: FormStatus;
  readonly schema: FormSchema;
  readonly theme: FormTheme;
  readonly settings: FormSettings;
  /** Public path segment, e.g. `"contacto"`. `null` if the pairing is broken. */
  readonly endpoint: string | null;
  /** Shareable short URL, or `null` while there is no endpoint. */
  readonly published_url: string | null;
  /** Set the first time the form is published, and never cleared. */
  readonly published_at?: Timestamp | null;
  readonly views_count: number;
  readonly submissions_count: number;
}

/** The reduced form a public respondent is allowed to see. */
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
 * Deliberately has no `updated_at`: a submission is never edited, and the
 * blueprint leaves the field out rather than render a lie.
 */
export interface FormSubmission {
  readonly id: Id;
  readonly form_id: Id;
  /** The respondent, when they were signed in. */
  readonly user_id?: Id | null;
  /**
   * Answers keyed by {@link FormSchemaField.id}. An `image` answer is
   * `{ attachment_id, filename }`; a `number` is a float; a `multi_choice` is
   * an array of strings; everything else is a string.
   */
  readonly answers: Record<string, Json>;
  /** Resolved from the respondent's IP. */
  readonly country?: string | null;
  /** Parsed from the respondent's user agent. */
  readonly device_name?: string | null;
  readonly completed_at?: Timestamp | null;
  readonly created_at: Timestamp;
}

/** What `POST /form_attachments` answers with. */
export interface FormAttachment {
  readonly id: Id;
  readonly filename: string;
  readonly content_type: string;
  /** Absolute URL that serves the bytes inline, no credential required. */
  readonly url: string;
}

/**
 * `GET /forms/endpoint_availability`. Read `available`; `suggestions` is only
 * present when the endpoint is well formed but taken.
 */
export interface FormEndpointAvailability {
  readonly endpoint: string;
  /** Whether it matches the format and is not reserved. */
  readonly valid: boolean;
  readonly available: boolean;
  /** `"invalid"` when the format or the reserved list rejected it. */
  readonly reason?: string;
  readonly suggestions?: string[];
}

/**
 * Arguments for creating a form.
 *
 * The form always starts as a `"draft"`: `status` is not writable here, only
 * through {@link UpdateFormInput}. `require_login` lives in `settings`.
 */
export interface CreateFormInput {
  readonly title: string;
  /**
   * Public path segment. Lowercased, 1 to 64 characters of `[a-z0-9_-]`
   * starting and ending alphanumeric, and never one of `new create index
   * admin api login signup help`.
   */
  readonly endpoint: string;
  readonly schema?: FormSchema;
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
  readonly schema?: FormSchema;
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
}

/**
 * Builds the PATCH body, keeping only the keys the caller actually passed.
 *
 * The endpoint reads `params.key?(...)`, so an explicit `null` is a value and
 * an absent key is "leave alone". `JSON.stringify` drops `undefined`, which is
 * exactly the distinction we want.
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
