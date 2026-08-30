/** The feedback box and its admin queue. */

import { Resource } from "../../http";
import { listQuery, paginate } from "../../listing";
import type { BASE_FILTER_COLUMNS, ListParams } from "../../listing";
import type { FileOutput, Id, Paginated, RequestOptions, Timestamp } from "../../types";

/** Filter columns of `GET /feedbacks`, on top of {@link BASE_FILTER_COLUMNS}. */
export const FEEDBACK_FILTER_COLUMNS = Object.freeze(["status", "user_id"] as const);

/** Filters for {@link FeedbacksNamespace.list}. */
export type ListFeedbacksParams = ListParams<(typeof FEEDBACK_FILTER_COLUMNS)[number]>;

/**
 * Primary key of a feedback report. A STRING, not an integer: `feedbacks` is
 * one of the tables that moved to opaque random ids, and it is the only one in
 * this file that did.
 */
export type FeedbackId = Id;

/** Triage state of a report. */
export const FEEDBACK_STATUSES = ["new", "read", "archived"] as const;

/** One of {@link FEEDBACK_STATUSES}. */
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Longest report the endpoint accepts, in BYTES. */
export const FEEDBACK_CONTENT_MAX_BYTES = 5_000;

/** How many attachments survive one submission. Mirrors `MAX_ATTACHMENTS_COUNT`. */
export const FEEDBACK_MAX_ATTACHMENTS = 6;

/** Combined decoded size of the attachments that get stored. 10 MiB. */
export const FEEDBACK_MAX_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;

/** Longest single `data:` URL the attacher will decode. 15 MiB of base64. */
export const FEEDBACK_MAX_ATTACHMENT_DATA_URL_BYTES = 15 * 1024 * 1024;

/** Anonymous submissions allowed per hour per IP, before rack-attack answers 429. */
export const FEEDBACK_CREATE_RATE_LIMIT_PER_HOUR = 5;

/** How long an identical report from the same IP is folded into the first one. */
export const FEEDBACK_DUPLICATE_WINDOW_MS = 3 * 60 * 1000;

/** A stored attachment, as it appears on a report. Admin-visible only. */
export interface FeedbackAttachment {
  /** ActiveStorage blob id. An INTEGER, and the segment `attachmentUrl` needs. */
  readonly blob_id: number;
  readonly filename: string;
  readonly content_type: string;
  readonly byte_size: number;
}

/** The submitter, when they were signed in. Carries their email, so admin-only. */
export interface FeedbackSubmitter {
  readonly id: Id;
  readonly handle: string;
  readonly name: string;
  readonly email: string;
}

/**
 * A feedback report, as an admin reads it.
 *
 * Nobody else ever sees this shape: `viewable_by` is `user&.admin? ? all : none`,
 * so a non-admin's listing is empty and a non-admin's `show` is a 404. The
 * submitter cannot read back what they sent - {@link FeedbacksNamespace.create}
 * answers with an id and nothing else.
 */
export interface Feedback {
  readonly id: FeedbackId;
  /** What the person wrote. Up to {@link FEEDBACK_CONTENT_MAX_BYTES} bytes. */
  readonly content: string;
  readonly status: FeedbackStatus;
  /**
   * The three context keys the controller keeps (`path`, `source`,
   * `user_agent`); everything else the client sent is dropped before the row
   * is written. `{}` when nothing was sent.
   */
  readonly context: Record<string, string>;
  /** The account that submitted it, or `null` for an anonymous report. */
  readonly user_id: Id | null;
  /** Reply address for an anonymous report, or `null`. */
  readonly email: string | null;
  /**
   * ISO country resolved from the submitter's IP by `FeedbackIntakeJob`.
   *
   * Written by a background job AFTER the response, so it is `null` on a row
   * read immediately after submission and fills in a moment later. Same for
   * {@link device_name}.
   */
  readonly country: string | null;
  /** Device name parsed out of the user agent, by the same background job. */
  readonly device_name: string | null;
  /** Expanded account, or `null` when the report was anonymous. */
  readonly user: FeedbackSubmitter | null;
  /** Screenshots, in submission order. Empty when none survived the filters. */
  readonly attachments: FeedbackAttachment[];
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

/** One screenshot, sent inline as a `data:` URL rather than as multipart. */
export interface FeedbackAttachmentInput {
  /**
   * A full `data:<mime>;base64,<payload>` URL. Anything that does not match
   * that exact regex - a bare base64 string, a `data:` URL that is not base64 -
   * is skipped in silence.
   */
  readonly data_url: string;
  /** Name to store. Sanitised server-side; defaults to `feedback-<id>-attachment-<n>.<ext>`. */
  readonly filename?: string;
}

/** Arguments for {@link FeedbacksNamespace.create}. */
export interface CreateFeedbackInput {
  /**
   * The report. Trimmed, and rejected when blank
   * (`400 "Feedback can't be empty"`) or over
   * {@link FEEDBACK_CONTENT_MAX_BYTES} BYTES - bytes, not characters, so
   * accented text runs out sooner than the number suggests
   * (`400 "Feedback is too long"`).
   */
  readonly content: string;
  /**
   * Reply address. Only meaningful for an anonymous report: a signed-in
   * submitter is linked by `user_id` and their account email is what the admin
   * sees. Validated against `URI::MailTo::EMAIL_REGEXP` when present.
   */
  readonly email?: string;
  /**
   * Where the report came from. Only `path`, `source` and `user_agent`
   * survive; every other key is dropped without an error.
   */
  readonly context?: {
    readonly path?: string;
    readonly source?: string;
    readonly user_agent?: string;
  };
  /**
   * Screenshots, at most {@link FEEDBACK_MAX_ATTACHMENTS}.
   *
   * Every rule here fails SILENTLY - the attacher logs and moves on, and the
   * submission still answers `201`. An attachment is dropped when it is not a
   * base64 `data:` URL, when its MIME type is not `image/*`, when the URL is
   * over {@link FEEDBACK_MAX_ATTACHMENT_DATA_URL_BYTES}, or when the running
   * decoded total passes {@link FEEDBACK_MAX_ATTACHMENTS_TOTAL_BYTES} (which
   * drops that one AND every one after it). Anything past the sixth is
   * discarded before the loop even starts. So do not treat a `201` as proof
   * the screenshots arrived; only an admin reading {@link Feedback.attachments}
   * can confirm that.
   *
   * Base64 is roughly 4/3 the size of the bytes, and the whole thing travels
   * inside one JSON body: production sits behind Cloudflare's ~100 MB request
   * cap, which rejects an oversized body with a `413` of its own before Rails
   * sees it.
   */
  readonly attachments?: readonly FeedbackAttachmentInput[];
  /**
   * Cloudflare Turnstile token. REQUIRED for an anonymous submission and
   * ignored for a signed-in one.
   *
   * Get the site key from {@link SiteConfigNamespace.get} first. Missing is
   * `400 "Captcha token missing"`; present but not verifying is
   * `403 "Captcha verification failed"`. A token is single-use at Cloudflare,
   * so it cannot be replayed - which also means an SDK-level retry of a failed
   * anonymous submission needs a FRESH token, not the same one.
   */
  readonly cf_turnstile_token?: string;
}

/**
 * The `feedbacks` namespace: the site's feedback box, plus its admin queue.
 *
 * Two audiences and one route table. {@link create} is the only thing a normal
 * caller can reach, and it is deliberately anonymous-friendly; everything else
 * is `before_action :require_admin!` and answers `401` with a `null` body to
 * anyone else.
 */
export class FeedbacksNamespace extends Resource {
  /**
   * `POST /feedbacks` - submits a report. `201` with `{"id": "..."}`, which is
   * unwrapped here to the id string.
   *
   * The response carries the id ALONE. There is no way to read the row back
   * without being an admin, so the id is only useful for correlating with a
   * support conversation.
   *
   * ## The ceilings, and why they are there
   *
   * This route has the only dedicated rack-attack bucket in this file:
   * **{@link FEEDBACK_CREATE_RATE_LIMIT_PER_HOUR} per hour, keyed on the IP**,
   * added after a bot pushed roughly 200 admin notification emails through it
   * in a single burst. It is keyed on the IP for EVERY caller, signed in or
   * not, so a shared egress address (an office, a mobile carrier's NAT, a
   * corporate VPN) shares the budget. Over it, `429` with
   * `{"error":"rate_limited"}`, which arrives here as an {@link OmsQuotaError}.
   *
   * On top of that the controller de-duplicates: the same `content` from the
   * same IP inside {@link FEEDBACK_DUPLICATE_WINDOW_MS} returns the id of the
   * EXISTING row with a `201` and writes nothing, attaches nothing and sends
   * no email. So a double-submitted form is harmless, and a retry inside the
   * window is genuinely idempotent - but note the flip side: a user who
   * legitimately sends the same short sentence twice in three minutes gets one
   * report, and the second submission's ATTACHMENTS are silently lost, because
   * the de-duplication branch returns before the attacher runs.
   *
   * ## What happens after the 201
   *
   * `FeedbackIntakeJob` runs on the queue: geo-locates the IP into
   * {@link Feedback.country}, parses the user agent into
   * {@link Feedback.device_name}, sends one coalesced email to every admin,
   * and fires a Discord alert. None of it blocks the response, and none of it
   * can fail the submission.
   *
   * The submitter's IP and user agent are stored on the row regardless of
   * whether they signed in. Say so in your UI if that matters.
   *
   * @throws {OmsApiError} 400 `"Feedback can't be empty"` / `"Feedback is too long"`
   *   / `"Captcha token missing"`; 403 `"Captcha verification failed"`.
   * @throws {OmsQuotaError} 429 once the per-IP hourly budget is spent.
   */
  async create(input: CreateFeedbackInput, options: RequestOptions = {}): Promise<FeedbackId> {
    const body = await this.http.post<{ id: FeedbackId }>("/feedbacks", input, options);
    return body.id;
  }

  /**
   * `GET /feedbacks` - the admin triage queue. **Admin only.**
   *
   * A non-admin is stopped by `before_action :require_admin!` with a `401`
   * whose body is `null` - no message to show the user, so write your own.
   * `Feedback.viewable_by` collapsing to `none` for a non-admin is the second
   * layer behind that, not the one you will hit.
   *
   * Filterable on `status` and `user_id`, plus the three defaults (`id`,
   * `created_at`, `updated_at`). Any other key is `400`.
   *
   * The scope is ordered `created_at DESC` before the DSL runs, and
   * `modifiers[order]` uses `reorder`, so passing {@link ListParams.order}
   * REPLACES that default rather than refining it.
   */
  async list(params: ListFeedbacksParams = {}, options: RequestOptions = {}): Promise<Paginated<Feedback>> {
    return paginate(params, 100, (at) =>
      this.http.get<Feedback[]>("/feedbacks", { ...options, query: listQuery(params, at) }),
    );
  }

  /**
   * `GET /feedbacks/:id` - one report in full. **Admin only**; anybody else
   * gets `401` with a `null` body.
   */
  async get(id: FeedbackId, options: RequestOptions = {}): Promise<Feedback> {
    return this.http.get<Feedback>(`/feedbacks/${encodeURIComponent(id)}`, options);
  }

  /**
   * `PATCH /feedbacks/:id` - moves a report through triage. **Admin only.**
   *
   * `status` is the only writable field: `update_params :status` is the whole
   * allowlist, so `content` and `email` cannot be edited, and a value outside
   * {@link FEEDBACK_STATUSES} is rejected by a `before_update` hook with
   * `400 "Invalid status"` before the model is touched.
   */
  async setStatus(id: FeedbackId, status: FeedbackStatus, options: RequestOptions = {}): Promise<Feedback> {
    return this.http.patch<Feedback>(`/feedbacks/${encodeURIComponent(id)}`, { status }, options);
  }

  /**
   * `DELETE /feedbacks/:id` - permanent, attachments included. `204`.
   * **Admin only.**
   */
  async destroy(id: FeedbackId, options: RequestOptions = {}): Promise<void> {
    await this.http.delete<void>(`/feedbacks/${encodeURIComponent(id)}`, options);
  }

  /**
   * `GET /feedbacks/:id/attachment/:blobId` - downloads one screenshot.
   * **Admin only.**
   *
   * The endpoint answers a `302` into object storage, not the bytes, so this
   * follows the redirect and buffers the result. That works in Bun and in
   * React Native; in a BROWSER it is the same CORS trap `account.picture`
   * documents - the redirect target does not accept a credentialed
   * cross-origin request, and the fetch fails after the 302. A web client
   * should point an `<img>` at {@link attachmentUrl} instead and let the
   * browser follow the redirect without credentials.
   */
  async attachment(id: FeedbackId, blobId: number, options: RequestOptions = {}): Promise<FileOutput> {
    return this.http.download(
      `/feedbacks/${encodeURIComponent(id)}/attachment/${encodeURIComponent(String(blobId))}`,
      options,
    );
  }

  /**
   * The absolute URL of an attachment, for an `<img src>` or an `<a href>`.
   *
   * Builds the string and makes no request, so it carries whatever credential
   * the BROWSER attaches - which for a cookie session on the API's own origin
   * is the session cookie, and for a bearer-token client is nothing at all. A
   * token-authenticated host has to fetch the bytes with {@link attachment}
   * instead; there is no query-string credential this SDK will mint for you.
   */
  attachmentUrl(id: FeedbackId, blobId: number): string {
    return this.http.url(`/feedbacks/${encodeURIComponent(id)}/attachment/${encodeURIComponent(String(blobId))}`);
  }
}
