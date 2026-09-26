import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CapabilityRegistry, NOTES_FILES_CAPABILITY_ID } from "../../../capabilities";
import type { AppServices } from "../../../core/app-services";
import { exportSourceLabel } from "../../../plugins/builtin/notes/export";
import { NotesFiles, remoteNotesFilesIO } from "../../../plugins/builtin/notes/files";
import { migrateLocalNotes } from "../../../plugins/builtin/notes/migration";
import type { CloudNotesStore } from "../../../plugins/builtin/notes/store";
import { registerElectrobunCoreCapabilities } from "./core-capabilities";

test("desktop notes reach the terminal's files through the Bun process", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gloomberb-desktop-notes-"));
  try {
    writeFileSync(join(dataDir, "AAPL.md"), "thesis");
    writeFileSync(join(dataDir, "__quick-notes-index__.json"), JSON.stringify([{ id: "q1", title: "Ideas" }]));
    mkdirSync(join(dataDir, "BLOCKED.md"));

    const registry = new CapabilityRegistry();
    registerElectrobunCoreCapabilities({
      getConfig: () => { throw new Error("unused"); },
      getServices: () => ({ pluginRegistry: { capabilities: registry } }) as unknown as AppServices,
    });
    const invoke = (operationId: string, payload: unknown) => (
      registry.invoke(NOTES_FILES_CAPABILITY_ID, operationId, payload, { renderer: true })
    );
    // What the desktop view's notes plugin builds.
    const files = new NotesFiles(dataDir, remoteNotesFilesIO(dataDir, invoke));

    // Signed out, export labels the personal store by its owner.
    expect(exportSourceLabel(files)).toBe("mine");

    // The first signed-in launch lists every local note and uploads it.
    const uploads: Array<[string, string, string | null]> = [];
    const cloud = {
      list: async () => [],
      save: async (key: string, text: string, options?: { title?: string | null }) => {
        uploads.push([key, text, options?.title ?? null]);
      },
      forgetRevision() {},
    } as unknown as CloudNotesStore;
    await migrateLocalNotes(files, cloud, null);
    expect(uploads).toEqual([["AAPL", "thesis", null], ["__note-q1__", "", "Ideas"]]);

    // An unreadable note is an error, not an empty note the next save overwrites.
    await expect(files.load("BLOCKED")).rejects.toBeDefined();
    await files.save("MSFT", "desktop edit");
    expect(readFileSync(join(dataDir, "MSFT.md"), "utf-8")).toBe("desktop edit");
    // A symbol with a "/" saves into a subfolder, as the desktop always has.
    await files.save("BRK/B", "slash");
    expect(readFileSync(join(dataDir, "BRK", "B.md"), "utf-8")).toBe("slash");
    await expect(invoke("read", { dataDir, file: "config.json" })).rejects.toThrow("not a notes file");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
