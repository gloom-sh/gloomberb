import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BROKER_CAPABILITY_ID, CapabilityRegistry, NOTES_FILES_CAPABILITY_ID, type BrokerStatusEvent } from "../../../capabilities";
import type { AppServices } from "../../../core/app-services";
import { exportSourceLabel } from "../../../plugins/builtin/notes/export";
import { NotesFiles, remoteNotesFilesIO } from "../../../plugins/builtin/notes/files";
import { migrateLocalNotes } from "../../../plugins/builtin/notes/migration";
import type { CloudNotesStore } from "../../../plugins/builtin/notes/store";
import { createTestBrokerAdapter } from "../../../test-support/broker";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import { registerElectrobunCoreCapabilities } from "./core-capabilities";

test("the desktop broker stream distinguishes an absent status from a reported disconnect", async () => {
  const instance: BrokerInstanceConfig = { id: "demo", brokerType: "demo", label: "Demo", config: {} };
  const registry = new CapabilityRegistry();
  const brokers = new Map([[instance.brokerType, createTestBrokerAdapter()]]);
  const config = { ...createDefaultConfig("/tmp/gloomberb-desktop-brokers"), brokerInstances: [instance] };
  registerElectrobunCoreCapabilities({
    getConfig: () => config,
    getServices: () => ({ pluginRegistry: { capabilities: registry, brokers } }) as unknown as AppServices,
  });
  const firstStatus = async () => {
    const events: BrokerStatusEvent[] = [];
    const subscription = await registry.subscribe<BrokerStatusEvent>(
      BROKER_CAPABILITY_ID, "status", { instanceId: instance.id }, (event) => events.push(event),
      { renderer: true },
    );
    registry.unsubscribe(subscription);
    return events[0]?.status;
  };

  expect(await firstStatus()).toEqual({ state: "disconnected", reported: false, updatedAt: 0 });

  const disconnected = { state: "disconnected", updatedAt: 0 } as const;
  brokers.set(instance.brokerType, createTestBrokerAdapter({ getStatus: () => disconnected }));
  expect(await firstStatus()).toEqual(disconnected);
});

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
    // The move lists strictly through the Bun process too: a folder it cannot
    // read rejects there, where everyday listing still reads it as no notes.
    const notAFolder = join(dataDir, "AAPL.md");
    const unlistable = new NotesFiles(notAFolder, remoteNotesFilesIO(notAFolder, invoke));
    await expect(unlistable.listForMove()).rejects.toBeDefined();
    expect(await unlistable.list()).toEqual([]);

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
