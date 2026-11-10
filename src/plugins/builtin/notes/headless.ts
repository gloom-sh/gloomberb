/**
 * `gloom fn NOTE`: the quick notes the Notes pane opens, read where the pane
 * reads them (Gloom Cloud when signed in, the files on this device otherwise),
 * with no page drawn and no market data waited on.
 */
import { apiClient } from "../../../api-client";
import type { HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneRow } from "../../../types/headless";
import type { PluginPersistence } from "../../../types/plugin";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { errorMessage } from "../../../utils/errors";
import { formatUtcTime } from "../../../utils/utc-time";
import { NotesFiles } from "./files";
import { CLOUD_NOTES_CACHE_SCHEMA_VERSION, CloudNotesStore, cloudNotesCacheKey, type NotesStore } from "./store";

export const NOTES_FRESHNESS: HeadlessPaneFreshness = { source: "Your notes", status: "not-a-feed", basis: "your notes", local: true };

const NOTES_PLUGIN_ID = "notes";
/** Note bodies read from Gloom Cloud at once: one request each, for a note this device has no current copy of. */
const CLOUD_NOTE_READS = 4;

/** A note's first line with text, which the text report shows; exports keep the whole note. */
function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * The notes plugin's saved state as the app left it, read only: the Cloud
 * store's copy of the notes it read, which answers a note that has not changed
 * since without a request, and every note offline. The report writes nothing.
 */
function savedNotesState(context: Pick<HeadlessPaneContext, "readSavedState">): Pick<PluginPersistence, "getState" | "setState"> {
  return {
    // A copy: the store edits what it reads before saving it back, which must not reach the app's state.
    getState: <T,>(key: string, options?: { schemaVersion?: number }) => {
      const saved = context.readSavedState?.<T>(NOTES_PLUGIN_ID, key, options?.schemaVersion)?.value;
      return saved == null ? null : structuredClone(saved);
    },
    setState: () => {},
  };
}

/**
 * The store the pane opens, and what the report says of it. A session that
 * checks reads Gloom Cloud; one Gloom Cloud cannot check (offline, the service
 * down) reads the copy this device saved, saying so and when it was saved, as
 * the pane shows it offline; without a session, the files on disk.
 */
async function personalStore(context: Pick<HeadlessPaneContext, "config" | "readSavedState">): Promise<{ store: NotesStore; offline?: { savedAt: number; reason: string } }> {
  if (!apiClient.getSessionToken()) return { store: new NotesFiles(context.config.dataDir) };
  const saved = savedNotesState(context);
  let user: Awaited<ReturnType<typeof apiClient.ensureVerifiedSession>>;
  try {
    user = await apiClient.ensureVerifiedSession();
  } catch (error) {
    const copy = context.readSavedState?.(NOTES_PLUGIN_ID, cloudNotesCacheKey({ kind: "user" }), CLOUD_NOTES_CACHE_SCHEMA_VERSION);
    if (!copy) throw new Error(`Gloom Cloud could not be reached (${errorMessage(error)}), and this device has no copy of your notes.`);
    return { store: new CloudNotesStore({ kind: "user" }, saved), offline: { savedAt: copy.savedAt, reason: errorMessage(error) } };
  }
  return user ? { store: new CloudNotesStore({ kind: "user" }, saved) } : { store: new NotesFiles(context.config.dataDir) };
}

export const notesHeadless = {
  shape: "rows",
  description: "Your quick notes: each note's title, when it last changed and its text.",
  // A user's notes reach Ask Gloom only when they paste them.
  askGloom: false,
  argument: { kind: "none" },
  options: [],
  columns: [
    { key: "title", header: "Note" },
    { key: "updated", header: "Updated", textFormat: (value) => (typeof value === "string" ? formatUtcTime(value) : "-") },
    { key: "text", header: "Text", textHeader: "First line", shrink: true, textFormat: (value) => firstLine(typeof value === "string" ? value : "") },
  ],
  discovery: { screenshotReadiness: "ready" },
  async load(_args, context) {
    const { store, offline } = await personalStore(context);
    const index = [...await store.loadQuickNotesIndex()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const rows: HeadlessPaneRow[] = await mapWithConcurrency(index, CLOUD_NOTE_READS, async (entry) => ({
      id: entry.id,
      title: entry.title,
      updated: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
      text: (await store.load(store.quickNoteKey(entry.id))).trim(),
    }));
    const savedAt = offline && new Date(offline.savedAt).toISOString();
    return {
      rows,
      empty: "No quick notes yet. Open NOTE in the app to write one.",
      freshness: savedAt ? { ...NOTES_FRESHNESS, asOf: savedAt } : NOTES_FRESHNESS,
      ...(offline ? {
        warnings: [`Gloom Cloud could not be reached (${offline.reason}): these are your notes as this device saved them at ${formatUtcTime(savedAt!)}.`],
      } : {}),
    };
  },
} satisfies HeadlessPaneDefinition<"rows">;
