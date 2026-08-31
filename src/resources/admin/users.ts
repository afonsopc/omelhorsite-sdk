/** `oms.admin.users`: editing any user's account. Administrators only. */

import { Resource } from "../../http";
import type { FileInput, Id, NativeFile, RequestOptions } from "../../types";
import type { User } from "../account";

/**
 * Fields an administrator may change on any account. Everything is optional;
 * omitted fields are left alone, `null` clears the nullable ones.
 *
 * `password` is only written when given and non-empty. `picture` makes the
 * request multipart; the image is re-encoded server-side and capped at 1024px.
 */
export interface AdminUpdateUserInput {
  readonly handle?: string;
  readonly name?: string;
  readonly bio?: string | null;
  readonly countryCode?: string;
  readonly emailIsPublic?: boolean;
  readonly genderIsPublic?: boolean;
  readonly gender?: string;
  readonly libraryPublic?: boolean;
  readonly libraryName?: string | null;
  readonly libraryDescription?: string | null;
  readonly language?: string;
  readonly shareListening?: boolean;
  readonly email?: string;
  /** Privilege group, e.g. `"administrator"`. */
  readonly group?: string;
  readonly password?: string;
  readonly allowedToUseSpotify?: boolean;
  readonly picture?: FileInput | NativeFile;
}

export class AdminUsersNamespace extends Resource {
  /**
   * `PATCH /users/:id` - edits any account, admin-only fields included.
   *
   * Answers the updated {@link User} as an administrator sees it.
   *
   * @throws {OmsAuthError} 401 for a non-administrator editing somebody else.
   * @throws {OmsApiError} 400 with the validation messages.
   */
  async update(id: Id, input: AdminUpdateUserInput, options: RequestOptions = {}): Promise<User> {
    const path = `/users/${encodeURIComponent(id)}`;
    const body = adminUpdateBody(input);
    if (input.picture === undefined) return this.http.patch<User>(path, body, options);
    return this.http.patchForm<User>(path, { ...body, picture: input.picture }, options);
  }
}

function adminUpdateBody(input: AdminUpdateUserInput): Record<string, string | boolean | null> {
  const body: Record<string, string | boolean | null> = {};
  const set = (key: string, value: string | boolean | null | undefined): void => {
    if (value !== undefined) body[key] = value;
  };
  set("handle", input.handle);
  set("name", input.name);
  set("bio", input.bio);
  set("country_code", input.countryCode);
  set("email_is_public", input.emailIsPublic);
  set("gender_is_public", input.genderIsPublic);
  set("gender", input.gender);
  set("library_public", input.libraryPublic);
  set("library_name", input.libraryName);
  set("library_description", input.libraryDescription);
  set("language", input.language);
  set("share_listening", input.shareListening);
  set("email", input.email);
  set("group", input.group);
  if (input.password) set("password", input.password);
  set("allowed_to_use_spotify", input.allowedToUseSpotify);
  return body;
}
