import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { DesktopViewIds } from "../../shared/protocol";

/**
 * The copy on disk of the ids the desktop view keeps in its WebView storage
 * (view/view-ids.ts), in the data folder beside the install id. That storage
 * belongs to the app's bundle identifier, and this copy is what a build under
 * another identifier starts from.
 */
const FILE_NAME = "desktop-view-ids.json";
const KEY = /^gloomberb\.[a-z0-9.-]{1,64}$/i;
const MAX_IDS = 16;
const MAX_VALUE_LENGTH = 4096;

function viewIdsPath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

/** The entries of `raw` shaped like view ids: a storage key of this app's and a short string. */
function parseViewIds(raw: unknown): DesktopViewIds {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const ids: DesktopViewIds = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_IDS)) {
    if (KEY.test(key) && typeof value === "string" && value.length > 0 && value.length <= MAX_VALUE_LENGTH) ids[key] = value;
  }
  return ids;
}

/** What the data folder keeps; nothing when the file is missing or unreadable. */
export function readDesktopViewIds(dataDir: string): DesktopViewIds {
  try {
    return parseViewIds(JSON.parse(readFileSync(viewIdsPath(dataDir), "utf8")));
  } catch {
    // Intentional ignore: no copy yet (a first launch, or a build from before it was kept), so the view keeps what it has.
    return {};
  }
}

/** Replaces the copy with what the view sent, written whole or not at all. Throws when it cannot, so the view tries again. */
export function saveDesktopViewIds(dataDir: string, ids: unknown): void {
  const path = viewIdsPath(dataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temporary, JSON.stringify(parseViewIds(ids)));
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
