import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { debugLog } from "../../../utils/debug-log";
import { NotesFiles } from "./files";

test("NotesFiles.delete ignores only missing files", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gloomberb-notes-"));
  const notes = new NotesFiles(dataDir);
  mkdirSync(join(dataDir, "blocked.md"));

  try {
    await expect(notes.delete("missing")).resolves.toBeUndefined();
    await expect(notes.delete("blocked")).rejects.toBeDefined();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an unreadable quick notes index reads as empty and logs one fixed line", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gloomberb-notes-"));
  const notes = new NotesFiles(dataDir);
  writeFileSync(join(dataDir, "__quick-notes-index__.json"), "{ private-title");
  const before = debugLog.getEntries({ source: "notes.files" }).length;

  try {
    expect(await notes.loadQuickNotesIndex()).toEqual([]);
    expect(await notes.loadQuickNotesIndex()).toEqual([]);
    const logged = debugLog.getEntries({ source: "notes.files" }).slice(before);
    expect(logged.map(({ level, message, data }) => ({ level, message, data }))).toEqual([
      { level: "warn", message: "Read the quick notes index failed", data: undefined },
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
