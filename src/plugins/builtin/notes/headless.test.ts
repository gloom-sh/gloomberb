import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { apiClient } from "../../../api-client";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext } from "../../../types/headless";
import { NotesFiles } from "./files";
import { notesHeadless } from "./headless";

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
