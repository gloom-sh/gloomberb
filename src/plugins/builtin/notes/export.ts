import { errorMessage } from "../../../utils/errors";
import type { NoteFileEntry, QuickNoteEntry } from "./files";
import type { NotesStore } from "./store";
import { noteOwnerKey, splitNoteKey } from "./store";

export interface NotesExportSource {
  label: string;
  store: NotesStore;
}

export interface NotesExportResult {
  dir: string;
  files: number;
  /** The sources whose notes were written, in the order given. */
  exported: string[];
  /** Sources whose notes could not be read, and why; none of their notes were written. */
  skipped: Array<{ label: string; reason: string }>;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "note";
}

/**
 * Writes every note as Markdown: ticker notes as `<SYMBOL>.md`, quick notes
 * under `quick/<title>.md`, one folder per owner when there are teams. The
 * disk store's own files are what they already are; the export is for the
 * cloud copies so nothing is locked in.
 */
export async function exportNotesToDirectory(
  dir: string,
  sources: readonly NotesExportSource[],
): Promise<NotesExportResult> {
  const fsModulePath = "fs/promises";
  const { mkdir, writeFile } = await import(fsModulePath) as typeof import("fs/promises");
  let files = 0;
  const exported: string[] = [];
  const skipped: NotesExportResult["skipped"] = [];
  for (const source of sources) {
    const folder = sources.length > 1 ? `${dir}/${safeFileName(source.label)}` : dir;
    let entries: NoteFileEntry[];
    let quick: QuickNoteEntry[];
    try {
      [entries, quick] = await Promise.all([source.store.list(), source.store.loadQuickNotesIndex()]);
    } catch (error) {
      skipped.push({ label: source.label, reason: errorMessage(error) });
      continue;
    }
    const titles = new Map(quick.map((entry) => [entry.id, entry.title]));
    for (const entry of entries) {
      const { kind, key } = splitNoteKey(entry.key);
      const path = kind === "quick"
        ? `${folder}/quick/${safeFileName(titles.get(key) ?? key)}.md`
        : `${folder}/${safeFileName(key)}.md`;
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await writeFile(path, entry.text, "utf-8");
      files += 1;
    }
    exported.push(source.label);
  }
  return { dir, files, exported, skipped };
}

export function exportSourceLabel(store: NotesStore, teamName?: string): string {
  return store.owner.kind === "user" ? "mine" : (teamName ?? noteOwnerKey(store.owner));
}
