import { expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CapabilityRegistry, NOTES_FILES_CAPABILITY_ID } from "../../../capabilities";
import type { AppServices } from "../../../core/app-services";
import { NotesFiles, remoteNotesFilesIO } from "../../../plugins/builtin/notes/files";
import { exportNotesToDirectory } from "../../../plugins/builtin/notes/export";
import { registerElectrobunCoreCapabilities } from "./core-capabilities";

test("desktop export reports one stat failure across RPC while strict migration still rejects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-desktop-export-"));
  const stat = fs.stat;
  const failure = Object.assign(new Error("Fixture stat refused"), { code: "EACCES" });
  const registry = new CapabilityRegistry();
  registerElectrobunCoreCapabilities({
    getConfig: () => { throw new Error("unused"); },
    getServices: () => ({ pluginRegistry: { capabilities: registry } }) as unknown as AppServices,
  });
  const files = new NotesFiles(dir, remoteNotesFilesIO(dir, async (operationId, payload) => {
    // The transport cannot carry functions or Error instances as callbacks.
    return JSON.parse(JSON.stringify(await registry.invoke(NOTES_FILES_CAPABILITY_ID, operationId,
      JSON.parse(JSON.stringify(payload)), { renderer: true })));
  }));
  const mockStat = spyOn(fs, "stat").mockImplementation(((...args: Parameters<typeof stat>) => {
    const path = String(args[0]);
    if (path.endsWith("BAD.md")) return Promise.reject(failure);
    if (path.endsWith("GONE.md")) return Promise.reject(Object.assign(new Error("Deleted since listing"), { code: "ENOENT" }));
    return stat(...args);
  }) as typeof stat);
  try {
    writeFileSync(join(dir, "AAPL.md"), "readable peer");
    writeFileSync(join(dir, "BAD.md"), "blocked metadata");
    writeFileSync(join(dir, "GONE.md"), "deleted during listing");
    const result = await exportNotesToDirectory(join(dir, "out"), [{ label: "local", store: files }]);
    expect(result).toEqual({
      dir: join(dir, "out"), files: 1, exported: ["local"],
      skipped: [{ label: "local", note: "BAD", reason: "Fixture stat refused" }],
    });
    expect(readFileSync(join(dir, "out", "AAPL.md"), "utf8")).toBe("readable peer");
    await expect(files.listForMove()).rejects.toThrow("Fixture stat refused");
    await expect(files.list({ strict: true })).rejects.toThrow("Fixture stat refused");
  } finally {
    mockStat.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
