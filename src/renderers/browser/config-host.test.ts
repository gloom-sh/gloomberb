import { expect, test } from "bun:test";
import { getDockedPaneIds } from "../../plugins/pane-manager/dock-tree";
import {
  BROWSER_RESEARCH_CHART_ID,
  BROWSER_RESEARCH_NEWS_ID,
  BROWSER_RESEARCH_PANE_ID,
  createBrowserConfigStore,
} from "./config-host";
import type { StorageLike } from "./storage";

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

test("a first visit opens one company across research, chart, and news panes", async () => {
  const store = createBrowserConfigStore(memoryStorage(), "?ticker=aapl&tab=financials");
  const config = await store.loadConfig("browser://local");

  expect(config.layouts[0]?.name).toBe("Research");
  expect(getDockedPaneIds(config.layout)).toEqual([
    BROWSER_RESEARCH_PANE_ID,
    BROWSER_RESEARCH_CHART_ID,
    BROWSER_RESEARCH_NEWS_ID,
  ]);

  const byId = new Map(config.layout.instances.map((instance) => [instance.instanceId, instance]));
  expect(byId.get(BROWSER_RESEARCH_PANE_ID)?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });
  expect(byId.get(BROWSER_RESEARCH_CHART_ID)?.binding).toEqual({
    kind: "follow",
    sourceInstanceId: BROWSER_RESEARCH_PANE_ID,
  });
  expect(byId.get(BROWSER_RESEARCH_NEWS_ID)?.binding).toEqual({
    kind: "follow",
    sourceInstanceId: BROWSER_RESEARCH_PANE_ID,
  });
  expect(config.layouts[0]?.paneState?.[BROWSER_RESEARCH_PANE_ID]).toEqual({ activeTabId: "financials" });
  expect(config.onboardingComplete).toBe(true);
});

test("a visit without a research link still opens NVDA", async () => {
  const store = createBrowserConfigStore(memoryStorage());
  const config = await store.loadConfig("browser://local");
  const research = config.layout.instances.find((instance) => instance.instanceId === BROWSER_RESEARCH_PANE_ID);
  expect(research?.binding).toEqual({ kind: "fixed", symbol: "NVDA" });
});

test("a returning visitor keeps the saved layout", async () => {
  const storage = memoryStorage();
  const first = createBrowserConfigStore(storage, "?ticker=NVDA");
  await first.saveConfig(await first.loadConfig("browser://local"));

  const second = createBrowserConfigStore(storage, "?ticker=MSFT");
  const restored = await second.loadConfig("browser://local");
  const research = restored.layout.instances.find((instance) => instance.instanceId === BROWSER_RESEARCH_PANE_ID);
  expect(research?.binding).toEqual({ kind: "fixed", symbol: "NVDA" });
  expect(getDockedPaneIds(restored.layout)).toHaveLength(3);
});
