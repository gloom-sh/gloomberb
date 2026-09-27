import type { NotesFiles } from "./files";
import type { QuickNoteEntry } from "./model";
import { NotesStoreRegistry } from "./store";

export type TestNotesFiles = NotesFiles & { saves: Array<{ key: string; text: string }> };

/**
 * In-memory notes files keyed by symbol or quick note id, recording every
 * save. A `saveError` save is recorded and then fails without storing.
 */
export function createTestNotesFiles(options: {
  notes?: Record<string, string>;
  index?: QuickNoteEntry[];
  loadDelayMs?: number;
  saveError?: Error;
} = {}): TestNotesFiles {
  const saves: Array<{ key: string; text: string }> = [];
  const notes = new Map(Object.entries(options.notes ?? {}));
  const loadDelayMs = options.loadDelayMs ?? 0;
  return {
    saves,
    readOnly: false,
    owner: { kind: "user" },
    async load(key: string) {
      if (loadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, loadDelayMs));
      return notes.get(key) ?? "";
    },
    async save(key: string, text: string) {
      saves.push({ key, text });
      if (options.saveError) throw options.saveError;
      notes.set(key, text);
    },
    async delete() {},
    quickNoteKey(id: string) {
      return id;
    },
    async loadQuickNotesIndex() {
      return options.index ?? [];
    },
    async saveQuickNotesIndex() {},
  } as unknown as TestNotesFiles;
}

/** The tabs take a registry; while signed out it hands back the disk store. */
export function registryFor(files: NotesFiles): NotesStoreRegistry {
  return new NotesStoreRegistry({ persistence: null, files, isSignedIn: () => false });
}
