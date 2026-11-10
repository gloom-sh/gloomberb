/**
 * `gloom fn NOTE`: the quick notes the Notes pane opens, read where the pane
 * reads them (Gloom Cloud when signed in, the files on this device otherwise),
 * with no page drawn and no market data waited on.
 */
import { apiClient } from "../../../api-client";
import type { HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneRow } from "../../../types/headless";
import { logFailure } from "../../../utils/log-failure";
import { formatUtcTime } from "../../../utils/utc-time";
import { NotesFiles } from "./files";
import { CloudNotesStore, type NotesStore } from "./store";

export const NOTES_FRESHNESS: HeadlessPaneFreshness = { source: "Your notes", status: "not-a-feed", basis: "your notes", local: true };

/** A note's first line with text, which the text report shows; exports keep the whole note. */
function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/** The personal store the pane opens: Cloud for a saved session that still checks, else the files on disk. */
async function personalStore(dataDir: string): Promise<NotesStore> {
  if (apiClient.getSessionToken()) {
    const user = await apiClient.ensureVerifiedSession().catch(logFailure("notes.headless", "Check the saved session for NOTE failed", null));
    if (user) return new CloudNotesStore({ kind: "user" }, null);
  }
  return new NotesFiles(dataDir);
}

export const notesHeadless = {
  shape: "rows",
  description: "Your quick notes: each note's title, when it last changed and its text.",
  argument: { kind: "none" },
  options: [],
  columns: [
    { key: "title", header: "Note" },
    { key: "updated", header: "Updated", textFormat: (value) => (typeof value === "string" ? formatUtcTime(value) : "-") },
    { key: "text", header: "Text", textHeader: "First line", shrink: true, textFormat: (value) => firstLine(typeof value === "string" ? value : "") },
  ],
  discovery: { screenshotReadiness: "ready" },
  async load(_args, context) {
    const store = await personalStore(context.config.dataDir);
    const index = await store.loadQuickNotesIndex();
    const rows: HeadlessPaneRow[] = await Promise.all(
      [...index]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .map(async (entry) => ({
          id: entry.id,
          title: entry.title,
          updated: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
          text: (await store.load(store.quickNoteKey(entry.id))).trim(),
        })),
    );
    return {
      rows,
      empty: "No quick notes yet. Open NOTE in the app to write one.",
      freshness: NOTES_FRESHNESS,
    };
  },
} satisfies HeadlessPaneDefinition<"rows">;
