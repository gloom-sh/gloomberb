import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { createBrowserConfigStore, BROWSER_DATA_DIR } from "./config-host";
import { JsonPersistence } from "../../data/json-persistence";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "../../data/json-storage";
import { JsonTickerRepository } from "../../data/json-ticker-repository";
import { createTestTicker } from "../../test-support/ticker";
import { createTestBrokerAdapter } from "../../test-support/broker";
import { createMarginAccount } from "../../test-support/margin-account";
import { isBrokerAccountSnapshotKey, loadPersistedBrokerAccounts, persistBrokerAccounts } from "../../brokers/account-cache";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException("full", "QuotaExceededError");
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}

describe("browser local persistence", () => {
  test("falls back safely for malformed JSON and quota failures", () => {
    const storage = new MemoryStorage();
    storage.values.set("key", "{");
    const data = new SafeJsonStorage(storage, "key", { count: 0 });
    expect(data.get()).toEqual({ count: 0 });
    storage.values.set("wrong-shape", "[]");
    const shaped = new SafeJsonStorage(storage, "wrong-shape", { ok: true }, (value): value is { ok: boolean } => !!value && typeof value === "object" && !Array.isArray(value));
    expect(shaped.get()).toEqual({ ok: true });
    storage.failWrites = true;
    data.set({ count: 2 });
    expect(data.get()).toEqual({ count: 2 });
  });

  test("normalizes config and persists tickers, plugin state, and session state", async () => {
    const storage = new MemoryStorage();
    storage.values.set(BROWSER_STORAGE_KEYS.config, JSON.stringify({ theme: 42 }));
    const configStore = createBrowserConfigStore(storage);
    const config = await configStore.loadConfig(BROWSER_DATA_DIR);
    expect(config.theme).toBe(createDefaultConfig(BROWSER_DATA_DIR).theme);
    expect(config.onboardingComplete).toBe(true);
    config.baseCurrency = "EUR";
    await configStore.saveConfig(config);
    expect((await configStore.loadConfig(BROWSER_DATA_DIR)).baseCurrency).toBe("EUR");

    const tickers = new JsonTickerRepository(storage);
    await tickers.createTicker(createTestTicker("AAPL", "Apple Inc.").metadata);
    expect((await new JsonTickerRepository(storage).loadTicker("aapl"))?.metadata.ticker).toBe("AAPL");

    const persistence = new JsonPersistence(storage);
    persistence.pluginState.set("alerts", "draft", { enabled: true }, 2);
    persistence.sessions.set("app", { focusedPaneId: "portfolio-list:main" }, 1);
    const restored = new JsonPersistence(storage);
    expect(restored.pluginState.get("alerts", "draft", 2)?.value).toEqual({ enabled: true });
    expect(restored.pluginState.get("alerts", "draft", 1)).toBeNull();
    expect(restored.sessions.get("app", 1)?.value).toEqual({ focusedPaneId: "portfolio-list:main" });
  });

  test("keeps a broker account snapshot across a reload, as it keeps the positions", () => {
    const storage = new MemoryStorage();
    const instance = { id: "signed-in-test", brokerType: "signed-in", label: "Test broker", config: { broker: "test" }, enabled: true };
    const broker = createTestBrokerAdapter({ id: "signed-in", listAccounts: async () => [] });
    const account = createMarginAccount();
    const persistence = new JsonPersistence(storage, { keepResource: isBrokerAccountSnapshotKey });
    persistBrokerAccounts(persistence.resources, instance, broker, [account]);
    persistence.resources.set({ namespace: "plugin:signed-in", kind: "quote", entityKey: "AAA" }, { price: 1 }, {
      cachePolicy: { staleMs: 1_000, expireMs: 60_000 },
    });

    const reloaded = new JsonPersistence(storage, { keepResource: isBrokerAccountSnapshotKey });
    expect(loadPersistedBrokerAccounts(reloaded.resources, instance, broker)).toEqual([account]);
    expect(reloaded.resources.get({ namespace: "plugin:signed-in", kind: "quote", entityKey: "AAA" })).toBeNull();
  });
});
