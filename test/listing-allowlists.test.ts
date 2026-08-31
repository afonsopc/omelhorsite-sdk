/**
 * The column tuples each resource declares must match the filter allowlists
 * the API's controllers declare. A column the SDK names that the server does
 * not accept is a 400 at runtime; a column the server accepts that the SDK
 * does not name is a compile error for a legitimate filter.
 *
 * The server side is read from `test/fixtures/backend-list-allowlists.json`.
 * When a checkout of the API server sits next to this repository the fixture
 * is also checked against it, so a stale snapshot fails here rather than in
 * production.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BASE_FILTER_COLUMNS } from "../src/listing";
import { ACCOUNT_SESSION_FILTER_COLUMNS } from "../src/resources/account";
import {
  ADMIN_JOB_FILTER_COLUMNS,
  ADMIN_LLM_ASSIGNMENT_FILTER_COLUMNS,
  ADMIN_LLM_MODEL_FILTER_COLUMNS,
  ADMIN_LLM_PROVIDER_FILTER_COLUMNS,
  ADMIN_VOCAL_SEPARATION_FILTER_COLUMNS,
  LINKED_IDENTITY_FILTER_COLUMNS,
} from "../src/resources/admin";
import { USER_FILTER_COLUMNS } from "../src/resources/auth/sessions";
import {
  FEEDBACK_FILTER_COLUMNS,
  INTEL_ARTICLE_FILTER_COLUMNS,
  INTEL_ITEM_FILTER_COLUMNS,
  INTEL_REPORT_FILTER_COLUMNS,
  INTEL_SCRIPT_FILTER_COLUMNS,
  INTEL_SOURCE_FILTER_COLUMNS,
  JOKE_FILTER_COLUMNS,
  NOTIFICATION_FILTER_COLUMNS,
  SPACE_INVADERS_GAME_FILTER_COLUMNS,
} from "../src/resources/content";
import { JOB_FILTER_COLUMNS } from "../src/resources/jobs";
import { LLM_CHAT_FILTER_COLUMNS } from "../src/resources/llm";
import {
  BOOK_ANNOTATION_FILTER_COLUMNS,
  BOOK_EXTRA_OPTION_KEYS,
  BOOK_FILTER_COLUMNS,
  BOOK_SHELF_FILTER_COLUMNS,
} from "../src/resources/library";
import {
  MOVIE_ADDON_FILTER_COLUMNS,
  MOVIE_ADDON_GRANT_FILTER_COLUMNS,
  MOVIE_ADDON_GROUP_FILTER_COLUMNS,
  MOVIE_COLLECTION_FILTER_COLUMNS,
  MOVIE_COLLECTION_ITEM_FILTER_COLUMNS,
} from "../src/resources/movies";
import { ARTIST_FILTER_COLUMNS } from "../src/resources/music/artists";
import { SONG_IMPORT_FILTER_COLUMNS } from "../src/resources/music/imports";
import { PLAYLIST_FILTER_COLUMNS, PLAYLIST_SONG_FILTER_COLUMNS } from "../src/resources/music/playlists";
import { SONG_FILTER_COLUMNS } from "../src/resources/music/songs";
import { SHORT_LINK_FILTER_COLUMNS } from "../src/resources/shortLinks";
import {
  MESSAGE_EXTRA_OPTION_KEYS,
  MESSAGE_FILTER_COLUMNS,
  RELATIONSHIP_EXTRA_OPTION_KEYS,
  RELATIONSHIP_FILTER_COLUMNS,
} from "../src/resources/social";
import { FS_NODE_EXTRA_OPTION_KEYS, FS_NODE_FILTER_COLUMNS } from "../src/resources/storage";
import { TICKET_FILTER_COLUMNS, TICKET_MESSAGE_FILTER_COLUMNS } from "../src/resources/tickets";
import { parseControllerAllowlists, type BackendAllowlists } from "./support/backend-allowlists";
import { DEFAULT_CONTROLLERS_DIR, FIXTURE_PATH } from "./support/backend-paths";

const NONE: readonly string[] = [];

/** Resource path on the server, and what the SDK declares for it. */
const RESOURCES: Record<string, { columns: readonly string[]; extra?: readonly string[] }> = {
  "admin/jobs": { columns: ADMIN_JOB_FILTER_COLUMNS },
  "admin/llm_assignments": { columns: ADMIN_LLM_ASSIGNMENT_FILTER_COLUMNS },
  "admin/llm_models": { columns: ADMIN_LLM_MODEL_FILTER_COLUMNS },
  "admin/llm_providers": { columns: ADMIN_LLM_PROVIDER_FILTER_COLUMNS },
  "admin/vocal_separations": { columns: ADMIN_VOCAL_SEPARATION_FILTER_COLUMNS },
  artists: { columns: ARTIST_FILTER_COLUMNS },
  book_annotations: { columns: BOOK_ANNOTATION_FILTER_COLUMNS },
  book_shelves: { columns: BOOK_SHELF_FILTER_COLUMNS },
  books: { columns: BOOK_FILTER_COLUMNS, extra: BOOK_EXTRA_OPTION_KEYS },
  feedbacks: { columns: FEEDBACK_FILTER_COLUMNS },
  fs_grants: { columns: NONE },
  fs_nodes: { columns: FS_NODE_FILTER_COLUMNS, extra: FS_NODE_EXTRA_OPTION_KEYS },
  identities: { columns: LINKED_IDENTITY_FILTER_COLUMNS },
  intel_articles: { columns: INTEL_ARTICLE_FILTER_COLUMNS },
  intel_items: { columns: INTEL_ITEM_FILTER_COLUMNS },
  intel_reports: { columns: INTEL_REPORT_FILTER_COLUMNS },
  intel_scripts: { columns: INTEL_SCRIPT_FILTER_COLUMNS },
  intel_sources: { columns: INTEL_SOURCE_FILTER_COLUMNS },
  jobs: { columns: JOB_FILTER_COLUMNS },
  jokes: { columns: JOKE_FILTER_COLUMNS },
  llm_chats: { columns: LLM_CHAT_FILTER_COLUMNS },
  messages: { columns: MESSAGE_FILTER_COLUMNS, extra: MESSAGE_EXTRA_OPTION_KEYS },
  movie_addon_grants: { columns: MOVIE_ADDON_GRANT_FILTER_COLUMNS },
  movie_addon_groups: { columns: MOVIE_ADDON_GROUP_FILTER_COLUMNS },
  movie_addons: { columns: MOVIE_ADDON_FILTER_COLUMNS },
  movie_collection_items: { columns: MOVIE_COLLECTION_ITEM_FILTER_COLUMNS },
  movie_collections: { columns: MOVIE_COLLECTION_FILTER_COLUMNS },
  notifications: { columns: NOTIFICATION_FILTER_COLUMNS },
  playlist_songs: { columns: PLAYLIST_SONG_FILTER_COLUMNS },
  playlists: { columns: PLAYLIST_FILTER_COLUMNS },
  relationships: { columns: RELATIONSHIP_FILTER_COLUMNS, extra: RELATIONSHIP_EXTRA_OPTION_KEYS },
  sessions: { columns: ACCOUNT_SESSION_FILTER_COLUMNS },
  short_links: { columns: SHORT_LINK_FILTER_COLUMNS },
  song_imports: { columns: SONG_IMPORT_FILTER_COLUMNS },
  songs: { columns: SONG_FILTER_COLUMNS },
  space_invaders_games: { columns: SPACE_INVADERS_GAME_FILTER_COLUMNS },
  ticket_messages: { columns: TICKET_MESSAGE_FILTER_COLUMNS },
  tickets: { columns: TICKET_FILTER_COLUMNS },
  users: { columns: USER_FILTER_COLUMNS },
};

const fixture: BackendAllowlists = JSON.parse(readFileSync(fileURLToPath(FIXTURE_PATH), "utf8"));

function withBase(columns: readonly string[]): string[] {
  return [...new Set([...columns, ...BASE_FILTER_COLUMNS])].sort();
}

describe("filter columns match the server's allowlists", () => {
  for (const [resource, declared] of Object.entries(RESOURCES)) {
    test(resource, () => {
      const server = fixture[resource];
      expect(server).toBeDefined();
      expect(withBase(declared.columns)).toEqual(withBase([...server!.search, ...server!.custom]));
      expect([...(declared.extra ?? [])].sort()).toEqual([...server!.extra_options].sort());
    });
  }
});

describe("the fixture is current", () => {
  const available = existsSync(DEFAULT_CONTROLLERS_DIR);
  test.skipIf(!available)("matches the sibling checkout of the server", () => {
    const live = parseControllerAllowlists(DEFAULT_CONTROLLERS_DIR);
    for (const resource of Object.keys(RESOURCES)) {
      expect({ [resource]: fixture[resource] }).toEqual({ [resource]: live[resource] });
    }
  });
});
