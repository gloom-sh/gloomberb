import { expect, test } from "bun:test";
import { getDockedPaneIds } from "../../layout/pane-manager/dock-tree";
import { BROWSER_RESEARCH_PANE_ID, createBrowserConfigStore, createBrowserFirstScreenConfig } from "./config-host";
import type { StorageLike } from "../../data/json-storage";
import { TICKER_RESEARCH_PANE_ID } from "../../types/config";

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

test("a research link opens its ticker on the requested tab", async () => {
  const store = createBrowserConfigStore(memoryStorage(), "?ticker=aapl&tab=financials");
  const config = await store.loadConfig("browser://local");

  const research = config.layout.instances.find((instance) => instance.instanceId === BROWSER_RESEARCH_PANE_ID);
  expect(research?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });
  expect(config.layouts[0]?.paneState?.[BROWSER_RESEARCH_PANE_ID]).toEqual({ activeTabId: "financials" });
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
  expect(getDockedPaneIds(restored.layout)).toHaveLength(6);
});

test("the calm first screen opens the same research pane beside Help, stacked on a phone", () => {
  for (const portrait of [false, true]) {
    const config = createBrowserFirstScreenConfig("browser://local", "calm", { search: "?ticker=aapl&tab=financials", portrait });
    const research = config.layout.instances.find((instance) => instance.instanceId === BROWSER_RESEARCH_PANE_ID);
    expect(getDockedPaneIds(config.layout)).toEqual([BROWSER_RESEARCH_PANE_ID, "help:main"]);
    expect(config.layout.instances.map((instance) => instance.paneId)).toEqual([TICKER_RESEARCH_PANE_ID, "help"]);
    expect(research?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });
    expect(config.layout.dockRoot).toMatchObject({ kind: "split", axis: portrait ? "vertical" : "horizontal" });
    expect(config.layouts[0]).toMatchObject({
      focusedPaneId: BROWSER_RESEARCH_PANE_ID,
      paneState: { [BROWSER_RESEARCH_PANE_ID]: { activeTabId: "financials" } },
    });
    expect(config.layouts.slice(1).map((layout) => layout.name)).toEqual(["Monitor", "Macro"]);
  }
  // The control is the workspace a first visit loads today.
  const control = createBrowserFirstScreenConfig("browser://local", "control");
  expect(getDockedPaneIds(control.layout)).toHaveLength(6);
});
