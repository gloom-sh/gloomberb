import { expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppPersistence } from "../../../data/app-persistence";
import { createTestCliContext } from "../../../test-support/cli-context";
import { notesCliCommand } from "./cli";
import { NotesFiles } from "./files";
import { exportNotesToDirectory } from "./export";

test.each(["invalid", "unreadable", "missing"] as const)("notes export keeps quick note bodies and reports a %s title index", async (index) => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-notes-index-export-"));
  const persistence = new AppPersistence(":memory:");
  const notes = new NotesFiles(dir);
  const read = fs.readFile;
  let readFailure: ReturnType<typeof spyOn> | undefined;
  try {
    await notes.save("AAPL", "ticker note");
    await notes.save(notes.quickNoteKey("q1"), "first quick note");
    await notes.save(notes.quickNoteKey("q2"), "second quick note");
    if (index === "invalid") writeFileSync(join(dir, "__quick-notes-index__.json"), "{ broken");
    if (index === "unreadable") readFailure = spyOn(fs, "readFile").mockImplementation(((...args: Parameters<typeof read>) => {
      if (String(args[0]).endsWith("__quick-notes-index__.json")) return Promise.reject(new Error("Fixture index unavailable"));
      return read(...args);
    }) as typeof read);
    const cli = createTestCliContext({ config: { dataDir: dir }, dataDir: dir });
    cli.context.initServices = async () => ({ persistence, destroy: () => persistence.close() }) as never;
    await notesCliCommand.execute(["export", join(dir, "out")], cli.context);
    const result = cli.printed[0]!.result;
    expect(result.data).toEqual({ dir: join(dir, "out"), files: 3, sources: ["local"] });
    expect(readFileSync(join(dir, "out", "quick", "q1.md"), "utf8")).toBe("first quick note");
    expect(readFileSync(join(dir, "out", "quick", "q2.md"), "utf8")).toBe("second quick note");
    expect(readFileSync(join(dir, "out", "AAPL.md"), "utf8")).toBe("ticker note");
    if (index === "missing") expect(result.warnings).toBeUndefined();
    else {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain("Quick notes from local were exported using ids because their titles could not be read");
    }
  } finally {
    readFailure?.mockRestore();
    persistence.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one failed local note stat skips that note while exporting its peers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-notes-stat-export-"));
  const stat = fs.stat;
  const notes = new NotesFiles(dir);
  let statFailure: ReturnType<typeof spyOn> | undefined;
  try {
    await notes.save("AAPL", "first peer");
    await notes.save("BAD", "unreadable metadata");
    await notes.save("MSFT", "last peer");
    statFailure = spyOn(fs, "stat").mockImplementation(((...args: Parameters<typeof stat>) => {
      if (String(args[0]).endsWith("BAD.md")) return Promise.reject(new Error("Fixture note stat unavailable"));
      return stat(...args);
    }) as typeof stat);
    const result = await exportNotesToDirectory(join(dir, "out"), [{ label: "local", store: notes }]);
    expect(result).toEqual({
      dir: join(dir, "out"), files: 2, exported: ["local"],
      skipped: [{ label: "local", note: "BAD", reason: "Fixture note stat unavailable" }],
    });
    expect(readFileSync(join(dir, "out", "AAPL.md"), "utf8")).toBe("first peer");
    expect(readFileSync(join(dir, "out", "MSFT.md"), "utf8")).toBe("last peer");
  } finally {
    statFailure?.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
