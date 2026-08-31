import { describe, expect, test } from "bun:test";

import { OmsApiError } from "../src/errors";
import { ApiClient } from "../src/http";
import { AccountNamespace, type NotificationPreferences } from "../src/resources/account";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  NotificationsNamespace,
  type NotificationCategory,
  type NotificationKind,
} from "../src/resources/content/notifications";

const BASE_URL = "https://api.test";

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

function harness(body: unknown, status = 200, { anonymous = false } = {}) {
  const calls: RecordedCall[] = [];
  const http = new ApiClient({
    baseUrl: BASE_URL,
    ...(anonymous ? {} : { tokens: { getToken: () => "t" } }),
    fetch: async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        path: new URL(input).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { http, calls };
}

describe("the notification catalogue", () => {
  test("NOTIFICATION_KINDS is the agreed list, in presentation order", () => {
    // Written out rather than derived: adding, renaming or reordering a kind
    // is a deliberate change to the public surface, and it has to show up
    // here.
    expect([...NOTIFICATION_KINDS]).toEqual([
      "security_new_session",
      "security_password_changed",
      "security_email_changed",
      "security_passkey_added",
      "security_app_authorized",
      "friendship_request",
      "friendship_accepted",
      "user_followed",
      "message_received",
      "group_chat_message",
      "jam_invite",
      "fs_grant_received",
      "chest_expires_soon",
      "vocal_separation_done",
      "vocal_separation_failed",
      "transcription_done",
      "transcription_failed",
      "upscale_done",
      "upscale_failed",
      "background_removal_done",
      "background_removal_failed",
      "caption_job_done",
      "caption_job_failed",
      "jumpstyle_job_done",
      "jumpstyle_job_failed",
      "song_import_done",
      "song_import_failed",
      "spotify_sync_done",
      "spotify_sync_failed",
      "artist_import_done",
      "blog_new_post",
      "form_submission_received",
      "ticket_reply",
      "ticket_status_changed",
      "intel_report_ready",
      "intel_source_failing",
      "oauth_application_approved",
      "oauth_application_rejected",
      "admin_oauth_application_submitted",
      "admin_ticket_created",
      "admin_feedback_received",
    ]);
  });

  test("NOTIFICATION_CATEGORIES is the agreed list, in presentation order", () => {
    expect([...NOTIFICATION_CATEGORIES]).toEqual([
      "security",
      "social",
      "storage",
      "tools",
      "music",
      "library",
      "forms",
      "tickets",
      "intel",
      "oauth",
      "admin",
    ]);
  });

  test("no kind is listed twice", () => {
    expect(new Set(NOTIFICATION_KINDS).size).toBe(NOTIFICATION_KINDS.length);
  });

  test("the unions are the tuples", () => {
    const kind: NotificationKind = "security_new_session";
    const category: NotificationCategory = "security";
    // @ts-expect-error a kind outside the catalogue is a compile error
    const unknownKind: NotificationKind = "something_else";
    // @ts-expect-error a category outside the catalogue is a compile error
    const unknownCategory: NotificationCategory = "misc";
    expect([kind, category, unknownKind, unknownCategory]).toHaveLength(4);
  });
});

function preferences(): NotificationPreferences {
  return {
    emails_enabled: true,
    kinds: [
      {
        kind: "security_new_session",
        category: "security",
        in_app: true,
        email: true,
        email_locked: true,
        coalesce_minutes: null,
      },
      {
        kind: "message_received",
        category: "social",
        in_app: true,
        email: false,
        email_locked: false,
        coalesce_minutes: 10,
      },
    ],
  };
}

describe("account.notificationPreferences", () => {
  test("get reads /notification_preferences with no body", async () => {
    const { http, calls } = harness(preferences());

    const result = await new AccountNamespace(http).notificationPreferences.get();

    expect(calls).toEqual([
      { method: "GET", path: "/notification_preferences", body: undefined, authorization: "Bearer t" },
    ]);
    expect(result).toEqual(preferences());
    expect(result.kinds[0]?.coalesce_minutes).toBeNull();
    expect(result.kinds[1]?.coalesce_minutes).toBe(10);
  });

  test("update patches the master switch and the kinds it was given, in snake_case", async () => {
    const { http, calls } = harness(preferences());

    await new AccountNamespace(http).notificationPreferences.update({
      emailsEnabled: false,
      kinds: {
        message_received: { email: true },
        user_followed: { inApp: false },
        ticket_reply: { inApp: true, email: false },
      },
    });

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/notification_preferences",
        body: {
          emails_enabled: false,
          kinds: {
            message_received: { email: true },
            user_followed: { in_app: false },
            ticket_reply: { in_app: true, email: false },
          },
        },
        authorization: "Bearer t",
      },
    ]);
  });

  test("update sends only what was given: no master switch, no kinds", async () => {
    const { http, calls } = harness(preferences());

    await new AccountNamespace(http).notificationPreferences.update({ kinds: { jam_invite: { email: true } } });
    await new AccountNamespace(http).notificationPreferences.update({ emailsEnabled: true });

    expect(calls[0]?.body).toEqual({ kinds: { jam_invite: { email: true } } });
    expect(calls[1]?.body).toEqual({ emails_enabled: true });
  });

  test("update answers the full set, same as get", async () => {
    const { http } = harness(preferences());

    const result = await new AccountNamespace(http).notificationPreferences.update({ emailsEnabled: true });

    expect(result).toEqual(preferences());
  });

  test("turning email off on a locked kind is the server's 422, passed through", async () => {
    const { http } = harness("security_new_session emails cannot be turned off", 422);

    const failure = await new AccountNamespace(http).notificationPreferences
      .update({ kinds: { security_new_session: { email: false } } })
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(422);
  });
});

describe("notifications.unsubscribe", () => {
  test("posts the token, anonymously, and answers the masked address", async () => {
    const { http, calls } = harness({ ok: true, email: "a***@b.pt" }, 200, { anonymous: true });

    const result = await new NotificationsNamespace(http).unsubscribe("tok.en");

    expect(calls).toEqual([
      { method: "POST", path: "/notifications/unsubscribe", body: { token: "tok.en" }, authorization: null },
    ]);
    expect(result).toEqual({ ok: true, email: "a***@b.pt" });
  });

  test("an invalid or expired token is the server's 404, passed through", async () => {
    const { http } = harness("Resource not found", 404, { anonymous: true });

    const failure = await new NotificationsNamespace(http).unsubscribe("stale").catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(OmsApiError);
    expect((failure as OmsApiError).status).toBe(404);
  });
});
