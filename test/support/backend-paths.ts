import { fileURLToPath } from "node:url";

/** Where a sibling checkout of the API server keeps its controllers. */
export const DEFAULT_CONTROLLERS_DIR = fileURLToPath(
  new URL("../../../omelhorsite/backend/app/controllers/", import.meta.url),
);

/** The committed snapshot the allowlist test reads. */
export const FIXTURE_PATH = new URL("../fixtures/backend-list-allowlists.json", import.meta.url);
