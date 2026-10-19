import { errorMessage } from "../../../utils/errors";
import type { NoteFileEntry, QuickNoteEntry } from "./files";
import type { NotesStore } from "./store";
import { noteOwnerKey, splitNoteKey } from "./store";

export interface NotesExportSource {
  label: string;
  store: NotesStore;
}

/**
 * What an export left out, and why: a whole source whose notes could not be
 * listed, or with `note`, one note of that source that could not be read.
 */
export interface NotesExportSkip {
  label: string;
  /** The note's symbol, or a quick note's title. */
  note?: string;
  reason: string;
}

export interface NotesExportResult {
  dir: string;
  files: number;
  /** The sources whose notes were written, in the order given. */
  exported: string[];
  skipped: NotesExportSkip[];
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
    const unreadable: Array<{ key: string; error: unknown }> = [];
    try {
      [entries, quick] = await Promise.all([
        source.store.list({ strict: true, skipped: (key, error) => unreadable.push({ key, error }) }),
        source.store.loadQuickNotesIndex(),
      ]);
    } catch (error) {
      skipped.push({ label: source.label, reason: errorMessage(error) });
      continue;
    }
    const titles = new Map(quick.map((entry) => [entry.id, entry.title]));
    for (const { key: noteKey, error } of unreadable) {
      const { kind, key } = splitNoteKey(noteKey);
      skipped.push({ label: source.label, note: kind === "quick" ? (titles.get(key) ?? key) : key, reason: errorMessage(error) });
    }
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

/** One line per skip, as `notes export` warns and the Export Notes command reports. */
export function describeExportSkip(skip: NotesExportSkip): string {
  return skip.note === undefined
    ? `Skipped ${skip.label}: its notes could not be read (${skip.reason}).`
    : `Skipped the ${skip.label} note ${skip.note}: it could not be read (${skip.reason}).`;
}

/** The Export Notes command's notice: the count, then what was skipped. */
export function exportNotice(result: NotesExportResult): { body: string; type: "success" | "error" } {
  const exported = `Exported ${result.files} ${result.files === 1 ? "note" : "notes"} to ${result.dir}`;
  if (result.skipped.length === 0) return { body: exported, type: "success" };
  const shown = result.skipped.slice(0, 3).map(describeExportSkip);
  const more = result.skipped.length - shown.length;
  return {
    body: [`${exported}.`, ...shown, ...(more > 0 ? [`${more} more could not be read.`] : [])].join(" "),
    type: "error",
  };
}

export function exportSourceLabel(store: NotesStore, teamName?: string): string {
  return store.owner.kind === "user" ? "mine" : (teamName ?? noteOwnerKey(store.owner));
}
