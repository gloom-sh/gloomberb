import { ApiRequestError } from "../../../api-client/errors";
import type { PluginPersistence } from "../../../types/plugin";
import { debugLog } from "../../../utils/debug-log";
import { logFailure } from "../../../utils/log-failure";
import type { NotesFiles } from "./files";
import { splitNoteKey, type CloudNotesStore } from "./store";

const MIGRATED_AT_KEY = "notes:migratedAt";
const notesLog = debugLog.createLogger("notes");

export interface NotesMigrationResult {
  uploaded: number;
  skipped: number;
  /** Keys the server refused; they stay on disk. */
  rejected: string[];
}

export function notesMigratedAt(persistence: PluginPersistence | null): string | null {
  return persistence?.getState<string>(MIGRATED_AT_KEY) ?? null;
}

/**
 * First signed-in launch: every `.md` on disk goes up unless the cloud
 * already holds a newer copy. Files stay where they are; they are the export
 * format now. Idempotent through the migratedAt stamp, and a partial failure
 * leaves the stamp unset so the next launch retries. That includes a local
 * read: a note or quick notes index that cannot be read now waits for the
 * next launch while the rest go up, and a notes folder that cannot be read
 * rejects. A file that does not exist is not a failure.
 */
export async function migrateLocalNotes(
  files: NotesFiles,
  cloud: CloudNotesStore,
  persistence: PluginPersistence | null,
): Promise<NotesMigrationResult | null> {
  if (notesMigratedAt(persistence)) return null;
  const { entries: local, unreadable } = await files.listForMove();
  const quickIndex = await files.loadQuickNotesIndex({ strict: true })
    .catch(logFailure("notes.migration", "Read the quick notes index for the move to Gloom Cloud failed", null));
  const titles = new Map((quickIndex ?? []).map((entry) => [files.quickNoteKey(entry.id), entry.title]));
  const remote = new Map((await cloud.list()).map((entry) => [entry.key, entry]));

  let uploaded = 0;
  let skipped = 0;
  const rejected: string[] = [];
  // A key the server refuses (400) will be refused next launch too, so it is
  // logged once and does not block the stamp; anything else (network, auth)
  // rethrows so the whole import retries later.
  const save = async (key: string, text: string, title: string | null) => {
    try {
      await cloud.save(key, text, { title });
      uploaded += 1;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 400) {
        rejected.push(key);
        return;
      }
      throw error;
    }
  };
  for (const entry of local) {
    // Without the index a quick note's title is unknown, and a copy uploaded
    // untitled would keep that title once the index can be read again.
    if (!quickIndex && splitNoteKey(entry.key).kind === "quick") continue;
    const existing = remote.get(entry.key);
    const title = titles.get(entry.key) ?? null;
    // Empty files are placeholders the notes pane left behind; nothing to import.
    if (!entry.text.trim() && !title) {
      skipped += 1;
      continue;
    }
    if (existing && (existing.updatedAt >= entry.updatedAt || existing.text === entry.text)) {
      skipped += 1;
      continue;
    }
    if (existing) cloud.forgetRevision(entry.key);
    await save(entry.key, entry.text, title);
  }
  // Quick note tabs that exist in the index but have no body yet still get a title.
  for (const entry of quickIndex ?? []) {
    const key = files.quickNoteKey(entry.id);
    if (local.some((note) => note.key === key) || remote.has(key)) continue;
    await save(key, "", entry.title);
  }
  if (rejected.length > 0) {
    notesLog.warn(`${rejected.length} local note(s) were not accepted by Gloom Cloud and stay local`, { rejected });
  }
  if (unreadable > 0 || !quickIndex) {
    notesLog.warn("Some local notes could not be read; the move to Gloom Cloud tries again on the next launch");
    return { uploaded, skipped, rejected };
  }
  persistence?.setState(MIGRATED_AT_KEY, new Date().toISOString());
  return { uploaded, skipped, rejected };
}
