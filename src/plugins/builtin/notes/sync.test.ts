import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { SyncApplyContext } from "../../../sync/types";
import { NotesFiles } from "./files";
import { createNotesSyncContributor } from "./sync";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createNotesFiles(): Promise<NotesFiles> {
  const directory = await mkdtemp(join(tmpdir(), "gloomberb-notes-sync-"));
  directories.push(directory);
  return new NotesFiles(directory);
}

const applyContext = { isCurrent: () => true } as unknown as SyncApplyContext;

test("resolves each note to whichever side wrote it last", async () => {
  const notesFiles = await createNotesFiles();
  await notesFiles.save("AAPL", "local aapl");
  await notesFiles.save("MSFT", "local msft");
  const contributor = createNotesSyncContributor(notesFiles);

  await contributor.apply?.({
    notes: [
      { key: "AAPL", text: "remote aapl", updatedAt: Date.now() + 60_000 },
      { key: "MSFT", text: "remote msft", updatedAt: Date.now() - 60_000 },
      { key: "TSLA", text: "remote tsla", updatedAt: Date.now() },
    ],
    quickNotes: [{ id: "note-1", title: "Remote", updatedAt: Date.now() }],
  }, applyContext);

  expect(await notesFiles.load("AAPL")).toBe("remote aapl");
  expect(await notesFiles.load("MSFT")).toBe("local msft");
  expect(await notesFiles.load("TSLA")).toBe("remote tsla");
  expect(await notesFiles.loadQuickNotesIndex()).toEqual([
    { id: "note-1", title: "Remote", updatedAt: expect.any(Number) },
  ]);

  const payload = await contributor.collect({} as never) as { notes: Array<{ key: string }> };
  expect(payload.notes.map((note) => note.key).sort()).toEqual(["AAPL", "MSFT", "TSLA"]);
});
