import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
