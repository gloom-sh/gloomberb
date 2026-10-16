import { afterEach, beforeEach, spyOn, type Mock } from "bun:test";
import * as configStore from "../data/config/store";
import { flushPendingPersistence } from "../state/persist-scheduler";
import type { AppConfig } from "../types/config";

/**
 * Capture each test's config writes and drain its queued saves before restoring
 * the store. Register after a renderer harness in the same scope so unmount
 * runs before the drain.
 */
export function captureConfigSaves(): AppConfig[] {
  const saved: AppConfig[] = [];
  let save: Mock<typeof configStore.saveConfig>;

  beforeEach(() => {
    saved.length = 0;
    save = spyOn(configStore, "saveConfig").mockImplementation(async (config) => {
      saved.push(config);
    });
  });

  afterEach(async () => {
    try {
      await flushPendingPersistence();
    } finally {
      save.mockRestore();
    }
  });

  return saved;
}
