/**
 * Refreshes `test/fixtures/backend-list-allowlists.json` from a checkout of
 * the API server.
 *
 *   bun test/support/sync-backend-allowlists.ts [path/to/app/controllers]
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONTROLLERS_DIR, FIXTURE_PATH } from "./backend-paths";
import { parseControllerAllowlists } from "./backend-allowlists";

const controllersDir = Bun.argv[2] ?? DEFAULT_CONTROLLERS_DIR;
const allowlists = parseControllerAllowlists(controllersDir);
writeFileSync(fileURLToPath(FIXTURE_PATH), `${JSON.stringify(allowlists, null, 2)}\n`);
