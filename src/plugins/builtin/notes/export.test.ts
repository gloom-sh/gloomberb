import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exportNotesToDirectory } from "./export";
import { NotesFiles } from "./files";
import type { NotesStore } from "./store";

test("a source whose notes cannot be read is reported as skipped, not as exported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-notes-export-"));
  try {
    const local = new NotesFiles(join(dir, "local"));
    await local.save("AAPL", "thesis");
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
      skipped: [{ label: "Desk", reason: "Fixture request unavailable" }],
    });
    expect(readdirSync(join(dir, "out"))).toEqual(["local"]);
    expect(existsSync(join(dir, "out", "Desk"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
