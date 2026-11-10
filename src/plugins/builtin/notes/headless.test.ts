import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { apiClient, type CloudNote } from "../../../api-client";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext } from "../../../types/headless";
import { NotesFiles } from "./files";
import { notesHeadless } from "./headless";
import { cloudNotesCacheKey } from "./store";

test("fn NOTE reads the quick notes signed out from the files, newest first, without drawing the pane", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gloomberb-notes-report-"));
  const previousToken = apiClient.getSessionToken();
  apiClient.setSessionToken(null);
  try {
    const files = new NotesFiles(dataDir);
    await files.saveQuickNotesIndex([
      { id: "older", title: "Ports", updatedAt: Date.parse("2026-11-09T09:00:00Z") },
      { id: "newer", title: "Pre-CPI memo", updatedAt: Date.parse("2026-11-10T11:10:00Z") },
    ]);
    await files.save(files.quickNoteKey("older"), "China port calls up on the week");
    await files.save(files.quickNoteKey("newer"), "\nHormuz transits down on the year.\nCL=F 85.71\n");
    const context = { config: createDefaultConfig(dataDir), signal: new AbortController().signal } as unknown as HeadlessPaneContext;
    const result = await notesHeadless.load({ argument: null, options: {} } as never, context);
    expect(result.rows.map((row) => [row.title, row.updated, row.text])).toEqual([
      ["Pre-CPI memo", "2026-11-10T11:10:00.000Z", "Hormuz transits down on the year.\nCL=F 85.71"],
      ["Ports", "2026-11-09T09:00:00.000Z", "China port calls up on the week"],
    ]);
    expect(result.freshness).toMatchObject({ local: true });
  } finally {
    apiClient.setSessionToken(previousToken);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

const cloudNote = (index: number): CloudNote => ({
  id: `n${index}`,
  owner: { kind: "user", id: "me" },
  kind: "quick",
  key: `q${index}`,
  title: `Note ${index}`,
  revision: 1,
  content: `Body ${index}`,
  updatedBy: { id: "me", username: "ada", displayName: "Ada" },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: new Date(Date.parse("2026-11-01T00:00:00Z") + index * 60_000).toISOString(),
});

// Signed in, NOTE read every note at once, and offline it fell back to the signed-out files without a word.
test("fn NOTE signed in reads Gloom Cloud a few notes at a time, and offline the copy this device saved, saying so", async () => {
  const notes = Array.from({ length: 10 }, (_, index) => cloudNote(index));
  let inFlight = 0;
  let mostInFlight = 0;
  const session = spyOn(apiClient, "ensureVerifiedSession").mockResolvedValue({ emailVerified: true } as never);
  const verified = spyOn(apiClient, "isVerified").mockReturnValue(true);
  const spies = [
    session,
    verified,
    spyOn(apiClient, "getSessionToken").mockReturnValue("session"),
    spyOn(apiClient, "listCloudNotes").mockResolvedValue(notes.map(({ content, ...rest }) => ({ ...rest, size: content.length }))),
    spyOn(apiClient, "getCloudNote").mockImplementation(async (id: string) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return notes.find((note) => note.id === id) ?? null;
    }),
  ];
  // The copy the app saved holds note 9 at its current revision: it is not asked for again.
  const copy = { [`__note-q9__`]: { id: "n9", revision: 1, title: "Note 9", content: "Body 9", updatedAt: notes[9]!.updatedAt, updatedBy: "@ada" } };
  const savedAt = Date.parse("2026-11-10T08:00:00Z");
  const readSavedState = ((pluginId: string, key: string) => (
    pluginId === "notes" && key === cloudNotesCacheKey({ kind: "user" }) ? { value: copy, savedAt } : null
  )) as HeadlessPaneContext["readSavedState"];
  const context = { config: createDefaultConfig("/tmp/notes-report-cloud"), signal: new AbortController().signal, readSavedState } as unknown as HeadlessPaneContext;
  try {
    const online = await notesHeadless.load({ argument: null, options: {} } as never, context);
    expect(online.rows.map((row) => row.title)).toEqual(notes.map((note) => note.title).reverse());
    expect(online.rows[0]).toMatchObject({ title: "Note 9", text: "Body 9" });
    expect(apiClient.getCloudNote).toHaveBeenCalledTimes(9);
    expect(mostInFlight).toBe(4);
    expect(online.warnings).toBeUndefined();

    // Offline: the saved copy, with a line naming when it was saved.
    session.mockRejectedValue(new Error("Unable to reach Gloom Cloud"));
    verified.mockReturnValue(false);
    const offline = await notesHeadless.load({ argument: null, options: {} } as never, context);
    expect(offline.rows.map((row) => [row.title, row.text])).toEqual([["Note 9", "Body 9"]]);
    expect(offline.warnings).toEqual([expect.stringContaining("as this device saved them at 2026-11-10 08:00 UTC")]);
    expect(offline.freshness).toMatchObject({ asOf: "2026-11-10T08:00:00.000Z" });
    // With no saved copy, the report fails rather than show other notes.
    const bare = { ...context, readSavedState: () => null } as HeadlessPaneContext;
    await expect(notesHeadless.load({ argument: null, options: {} } as never, bare)).rejects.toThrow("this device has no copy of your notes");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
