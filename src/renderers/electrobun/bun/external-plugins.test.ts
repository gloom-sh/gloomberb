import { expect, test } from "bun:test";
import { AppPersistence } from "../../../data/app-persistence";
import { TickerRepository } from "../../../data/ticker-repository";
import { PluginRegistry } from "../../../plugins/registry";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { deactivateExternalPlugin } from "./external-plugins";

test("native cleanup failure is rejected on retries after unregister dropped the registration; a fresh runtime can stop it", async () => {
  const persistence = new AppPersistence(":memory:");
  const registry = new PluginRegistry(createTestDataProvider(), new TickerRepository(persistence.tickers), persistence);
  const restarted = new PluginRegistry(createTestDataProvider(), new TickerRepository(persistence.tickers), persistence);
  let cleanupCalls = 0;
  try {
    await registry.register({ id: "cleanup-fixture", name: "Cleanup fixture", version: "1.0.0", dispose() {
      cleanupCalls++;
      throw new Error("Cleanup did not finish");
    } });
    expect(() => deactivateExternalPlugin(registry, "cleanup-fixture")).toThrow("Restart before removing it.");
    expect(registry.allPlugins.has("cleanup-fixture")).toBe(false);
    expect(() => deactivateExternalPlugin(registry, "cleanup-fixture")).toThrow("Restart before removing it.");
    expect(cleanupCalls).toBe(1);

    await restarted.register({ id: "cleanup-fixture", name: "Cleanup fixture", version: "1.0.0", dispose() { cleanupCalls++; } });
    deactivateExternalPlugin(restarted, "cleanup-fixture");
    expect(restarted.allPlugins.has("cleanup-fixture")).toBe(false);
    expect(cleanupCalls).toBe(2);
  } finally {
    registry.destroy();
    restarted.destroy();
    persistence.close();
  }
});
