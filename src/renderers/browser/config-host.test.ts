import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { isDockStack } from "../../layout/pane-manager/dock-stack";
import { getDockedPaneIds } from "../../layout/pane-manager/dock-tree";
import { BROWSER_RESEARCH_PANE_ID, createBrowserConfigStore } from "./config-host";
import { BROWSER_STORAGE_KEYS, type StorageLike } from "../../data/json-storage";
import { startBootFrameRecorder } from "../dom/boot-frame";
import { BOOT_FRAME_BUILD_GLOBAL } from "../dom/boot-frame-page";

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
  expect(getDockedPaneIds(config.layout)).toHaveLength(6);
});

test("a phone gets every starter tab as one stack, the company's research in front, and keeps it", async () => {
  // 390x844 upright and 844x390 on its side, in 8x18 px cells; 768x1024 holds the grid.
  const open = async (width: number, height: number, storage = memoryStorage()) =>
    createBrowserConfigStore(storage, "?ticker=NVDA", () => ({ width: width / 8, height: height / 18 })).loadConfig("browser://local");
  for (const [width, height] of [[390, 844], [844, 390]] as const) {
    const config = await open(width, height);
    for (const saved of config.layouts) expect(isDockStack(saved.layout.dockRoot)).toBe(true);
    const research = config.layouts[0]!.layout.dockRoot!;
    expect(isDockStack(research) && research.tabs.active).toBe(BROWSER_RESEARCH_PANE_ID);
    expect(getDockedPaneIds(config.layout).slice(0, 3)).toEqual([BROWSER_RESEARCH_PANE_ID, "chart-composer:research", "ticker-news:research"]);
  }
  const tablet = await open(768, 1024);
  expect(tablet.layouts.some((saved) => isDockStack(saved.layout.dockRoot))).toBe(false);

  // The grid saved on a wide window stays a grid when the same visitor comes back on a narrow one.
  const storage = memoryStorage();
  const wide = createBrowserConfigStore(storage, "", () => ({ width: 180, height: 50 }));
  await wide.saveConfig(await wide.loadConfig("browser://local"));
  expect(isDockStack((await open(390, 844, storage)).layout.dockRoot)).toBe(false);
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

test("Reset All Data leaves no launch frame, even one the closing page would save", async () => {
  const storage = memoryStorage();
  const window = new Window({ width: 1200, height: 800 });
  (window as unknown as Record<string, unknown>)[BOOT_FRAME_BUILD_GLOBAL] = "b";
  window.document.body.innerHTML = '<div id="root"><div data-gloom-role="pane-window"></div><div data-gloom-role="status-bar">Home</div></div>';
  const doc = window.document as unknown as Document;
  startBootFrameRecorder({
    doc,
    root: doc.getElementById("root")!,
    save: (frame) => storage.setItem(BROWSER_STORAGE_KEYS.bootFrame, JSON.stringify(frame)),
  });
  window.dispatchEvent(new window.Event("pagehide"));
  expect(storage.getItem(BROWSER_STORAGE_KEYS.bootFrame)).not.toBeNull();

  await createBrowserConfigStore(storage).resetAllData("browser://local");
  // The page reloads after a reset, and hides on the way, with a layout the recorder has not saved yet.
  doc.querySelector('[data-gloom-role="status-bar"]')!.textContent = "Setup";
  window.dispatchEvent(new window.Event("pagehide"));
  expect(storage.getItem(BROWSER_STORAGE_KEYS.bootFrame)).toBeNull();
  await window.happyDOM.close();
});
