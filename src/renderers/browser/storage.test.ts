import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { createBrowserConfigStore, BROWSER_DATA_DIR } from "./config-host";
import { BrowserPersistence } from "./persistence";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./storage";
import { BrowserTickerRepository } from "./ticker-repository";

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

    const tickers = new BrowserTickerRepository(storage);
    await tickers.createTicker({
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    });
    expect((await new BrowserTickerRepository(storage).loadTicker("aapl"))?.metadata.ticker).toBe("AAPL");

    const persistence = new BrowserPersistence(storage);
    persistence.pluginState.set("alerts", "draft", { enabled: true }, 2);
    persistence.sessions.set("app", { focusedPaneId: "portfolio-list:main" }, 1);
    const restored = new BrowserPersistence(storage);
    expect(restored.pluginState.get("alerts", "draft", 2)?.value).toEqual({ enabled: true });
    expect(restored.pluginState.get("alerts", "draft", 1)).toBeNull();
    expect(restored.sessions.get("app", 1)?.value).toEqual({ focusedPaneId: "portfolio-list:main" });
  });
});
