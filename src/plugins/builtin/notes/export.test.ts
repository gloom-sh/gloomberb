import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exportNotesToDirectory, exportNotice } from "./export";
import { NotesFiles } from "./files";
import type { NotesStore } from "./store";

test("what an export could not read is reported as skipped, not as exported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-notes-export-"));
  try {
    const local = new NotesFiles(join(dir, "local"));
    await local.save("AAPL", "thesis");
    // A folder where a note should be cannot be read as one.
    mkdirSync(join(dir, "local", "BAD.md"));
    const offline = {
      owner: { kind: "team", teamId: "team-1" },
      readOnly: false,
      list: async () => { throw new Error("Fixture request unavailable"); },
      loadQuickNotesIndex: async () => [],
    } as unknown as NotesStore;

    const result = await exportNotesToDirectory(join(dir, "out"), [
      { label: "local", store: local },
      { label: "Desk", store: offline },
    ]);

    expect(result).toEqual({
      dir: join(dir, "out"),
      files: 1,
      exported: ["local"],
      skipped: [
        { label: "local", note: "BAD", reason: expect.any(String) },
        { label: "Desk", reason: "Fixture request unavailable" },
      ],
    });
    expect(readdirSync(join(dir, "out"))).toEqual(["local"]);
    expect(existsSync(join(dir, "out", "Desk"))).toBe(false);
    // The Export Notes command says so with the count.
    const notice = exportNotice(result);
    expect(notice.type).toBe("error");
    expect(notice.body).toContain("Skipped the local note BAD: it could not be read");
    expect(notice.body).toContain("Skipped Desk: its notes could not be read (Fixture request unavailable).");

    // A notes folder that cannot be listed is a skipped source, not an empty one.
    writeFileSync(join(dir, "not-a-folder"), "");
    const unlistable = await exportNotesToDirectory(join(dir, "out-2"), [{ label: "local", store: new NotesFiles(join(dir, "not-a-folder")) }]);
    expect(unlistable).toMatchObject({ files: 0, exported: [], skipped: [{ label: "local", reason: expect.any(String) }] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
