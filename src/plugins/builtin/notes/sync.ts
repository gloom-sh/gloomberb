import type { SyncContributor } from "../../../sync/types";
import type { NoteFileEntry, NotesFiles, QuickNoteEntry } from "./files";

// The server rejects snapshots over 1.5MB, and notes share it with portfolios.
const MAX_NOTE_CHARS = 100_000;
const MAX_NOTES_CHARS = 400_000;

interface SyncedNote {
  key: string;
  text: string;
  updatedAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseNotes(value: unknown): SyncedNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (
    isPlainObject(entry) && typeof entry.key === "string" && typeof entry.text === "string"
      ? [{
        key: entry.key,
        text: entry.text,
        updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : 0,
      }]
      : []
  ));
}

function parseQuickNotes(value: unknown): QuickNoteEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (
    isPlainObject(entry) && typeof entry.id === "string" && typeof entry.title === "string"
      ? [{
        id: entry.id,
        title: entry.title,
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
      }]
      : []
  ));
}

function withinBudget(entries: NoteFileEntry[]): SyncedNote[] {
  const notes: SyncedNote[] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.text.length > MAX_NOTE_CHARS) continue;
    if (total + entry.text.length > MAX_NOTES_CHARS) break;
    total += entry.text.length;
    notes.push(entry);
  }
  return notes;
}

/**
 * Notes live in files rather than app state, so they carry their own
 * timestamps and merge per note: newest write wins, identical text is left
 * alone so the two sides converge instead of ping-ponging.
 *
 * ponytail: deletions do not propagate, a note deleted on one device comes
 * back from the cloud. Add tombstones if that turns out to matter.
 */
export function createNotesSyncContributor(notesFiles: NotesFiles): SyncContributor {
  return {
    id: "notes",
    schemaVersion: 1,
    collect: async () => ({
      // list() is newest first, so the budget keeps the notes worked on last.
      notes: withinBudget(await notesFiles.list()),
      quickNotes: await notesFiles.loadQuickNotesIndex(),
    }),
    apply: async (payload, { isCurrent }) => {
      if (!isPlainObject(payload)) return;
      const local = new Map((await notesFiles.list()).map((entry) => [entry.key, entry]));

      for (const remote of parseNotes(payload.notes)) {
        if (!isCurrent()) return;
        const current = local.get(remote.key);
        if (current && (current.text === remote.text || current.updatedAt >= remote.updatedAt)) continue;
        await notesFiles.save(remote.key, remote.text);
      }

      if (!isCurrent()) return;
      const merged = new Map((await notesFiles.loadQuickNotesIndex()).map((entry) => [entry.id, entry]));
      let changed = false;
      for (const remote of parseQuickNotes(payload.quickNotes)) {
        const current = merged.get(remote.id);
        if (current && (current.updatedAt ?? 0) >= (remote.updatedAt ?? 0)) continue;
        merged.set(remote.id, remote);
        changed = true;
      }
      if (changed) await notesFiles.saveQuickNotesIndex([...merged.values()]);
    },
  };
}
