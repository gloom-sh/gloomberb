import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState } from "../../../../../core/state/app/state";
import { buildAppSessionSnapshot, reconcileAppSessionSnapshot } from "../../../../../core/state/session-persistence";
import { normalizeConfigForSave, normalizeLoadedConfig } from "../../../../../data/config/store/normalize";
import { cloneLayout, createBlankLayout, createDefaultConfig, createPaneInstance, findPaneInstance } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { addPaneFloating, getDockedPaneIds, removePane } from "../../../../../layout/pane-manager";
import { updatePaneInstance } from "../../../../../pane-settings";
import { MAIN_WINDOW_ID } from "../../../../desktop/screen-setup";
import { createDesktopWorkspace } from "./index";

const MAIN = MAIN_WINDOW_ID;
const SECOND = "window:two";
const LAY = "layout-marketplace:test";

function tabConfig() {
  const config = createDefaultConfig(":memory:");
  return { ...config, layouts: config.layouts.map((tab) => ({ ...tab, id: `tab:${tab.name.toLowerCase()}` })) };
}

function reduceSnapshot(snapshot: DesktopSharedStateSnapshot, action: Parameters<typeof appReducer>[1]) {
  const state = appReducer(createInitialState(snapshot.config), { type: "HYDRATE_DESKTOP_SNAPSHOT", snapshot });
  return appReducer(state, action);
}

function openLayouts(snapshot: DesktopSharedStateSnapshot, instanceId = LAY) {
  const pane = createPaneInstance("layout-marketplace", { instanceId });
  return reduceSnapshot(snapshot, {
    type: "UPDATE_LAYOUT",
    layout: addPaneFloating(snapshot.config.layout, pane, 160, 48),
    focusedPaneId: instanceId,
  });
}

describe("desktop workspace", () => {
  test("closing the last rendered docked pane keeps a concurrently moved pane docked with Layouts open", () => {
    const config = tabConfig();
    const existing = "portfolio-list:main";
    const moved = getDockedPaneIds(config.layouts[1]!.layout)[0]!;
    const layout = {
      ...createBlankLayout(),
      dockRoot: { kind: "pane" as const, instanceId: existing },
      instances: [findPaneInstance(config.layout, existing)!],
    };
    const workspace = createDesktopWorkspace({ ...config, layout }, null, [{ id: SECOND, layoutIds: ["tab:monitor"] }]);
    workspace.syncMainState(openLayouts(workspace.getWindowSnapshot(MAIN)!));
    workspace.syncMainState(reduceSnapshot(workspace.getSnapshot(), { type: "FOCUS_PANE", paneId: existing }));
    const held = workspace.getWindowSnapshot(MAIN)!;
    expect(held.focusedPaneId).toBe(existing);
    workspace.noteDelivered(MAIN, 1, held);

    expect(workspace.movePaneToWindow(moved, MAIN)).not.toBeNull();
    expect(getDockedPaneIds(workspace.getSnapshot().config.layout)).toEqual([existing, moved]);
    expect(workspace.getSnapshot().focusedPaneId).toBe(moved);
    const closed = reduceSnapshot(held, { type: "UPDATE_LAYOUT", layout: removePane(held.config.layout, existing) });
    expect(closed.focusedPaneId).toBe(LAY);
    const result = workspace.syncMainState(closed, 1);

    const normalized = normalizeConfigForSave(result.config);
    const { config: reloaded } = normalizeLoadedConfig(JSON.parse(JSON.stringify(normalized)), config.dataDir);
    expect(result.config.layout.floating.map((entry) => entry.instanceId)).toEqual([LAY]);
    for (const kept of [result.config.layout, result.config.layouts[0]!.layout, normalized.layout, reloaded.layout]) {
      expect(getDockedPaneIds(kept)).toEqual([moved]);
      expect(findPaneInstance(kept, moved)).toBeDefined();
      expect(findPaneInstance(kept, existing)).toBeUndefined();
    }
    expect(JSON.stringify(normalized)).not.toContain(LAY);
    expect(result.focusedPaneId).toBe(moved);
    for (const config of [result.config, normalized, reloaded]) {
      expect(config.layouts[config.activeLayoutIndex]!.focusedPaneId).toBe(moved);
    }
    expect(createDesktopWorkspace(reloaded, null).getSnapshot().focusedPaneId).toBe(moved);
  });

  test("opening Layouts from a held snapshot keeps a concurrent ordinary pane move", () => {
    const config = tabConfig();
    const moved = getDockedPaneIds(config.layouts[1]!.layout)[0]!;
    const workspace = createDesktopWorkspace(config, null, [{ id: SECOND, layoutIds: ["tab:monitor"] }]);
    const initial = workspace.getSnapshot();
    workspace.syncMainState(reduceSnapshot(initial, { type: "FOCUS_PANE", paneId: getDockedPaneIds(initial.config.layout)[0]! }));
    const held = workspace.getWindowSnapshot(MAIN)!;
    workspace.noteDelivered(MAIN, 1, held);
    const movedSnapshot = workspace.movePaneToWindow(moved, MAIN)!;
    const expectedOrder = getDockedPaneIds(movedSnapshot.config.layout);

    const opened = workspace.syncMainState(openLayouts(held), 1);
    expect(opened.focusedPaneId).toBe(LAY);
    expect(getDockedPaneIds(opened.config.layout)).toEqual(expectedOrder);
    expect(getDockedPaneIds(opened.config.layouts[opened.config.activeLayoutIndex]!.layout)).toEqual(expectedOrder);
    expect(findPaneInstance(opened.config.layout, moved)).toEqual(findPaneInstance(movedSnapshot.config.layout, moved));
  });

  test("a secondary renderer keeps Layouts live, closes and reopens it, and saves neither window's Layouts pane", () => {
    const workspace = createDesktopWorkspace(tabConfig(), null, [{ id: SECOND, layoutIds: ["tab:monitor"] }]);
    const mainLay = "layout-marketplace:main-test";
    const mainOpen = openLayouts(workspace.getWindowSnapshot(MAIN)!, mainLay);
    workspace.syncMainState({ ...mainOpen, paneState: { ...mainOpen.paneState, [mainLay]: { activeTabId: "team" } } });
    const opened = openLayouts(workspace.getWindowSnapshot(SECOND)!);
    const layState = { activeTabId: "community" };
    workspace.syncWindowState(SECOND, { ...opened, paneState: { ...opened.paneState, [LAY]: layState } });

    const own = workspace.getWindowSnapshot(MAIN)!;
    const { at, tab } = workspace.otherWindowTabs()[0]!;
    const regularPane = tab.layout.instances[0]!.instanceId;
    const pulled = [...own.config.layouts];
    pulled.splice(at, 0, { ...tab, layout: updatePaneInstance(tab.layout, regularPane, (pane) => ({ ...pane, title: "From another window" })) });
    workspace.replaceConfigFromWindow(MAIN, { ...own.config, layouts: pulled });

    const shown = workspace.getWindowSnapshot(SECOND)!;
    expect(findPaneInstance(shown.config.layout, regularPane)?.title).toBe("From another window");
    expect(shown.config.layout.floating.find((entry) => entry.instanceId === LAY))
      .toEqual(opened.config.layout.floating.find((entry) => entry.instanceId === LAY));
    expect(shown.paneState[LAY]).toEqual(layState);
    expect(shown.focusedPaneId).toBe(LAY);
    expect(reduceSnapshot(shown, { type: "FOCUS_PANE", paneId: LAY }).focusedPaneId).toBe(LAY);
    expect(workspace.getWindowSnapshot(MAIN)!.focusedPaneId).toBe(mainLay);
    expect(workspace.getWindowSnapshot(MAIN)!.paneState[LAY]).toBeUndefined();

    const current = workspace.getSnapshot();
    expect(JSON.stringify(current.config.layouts)).not.toContain("layout-marketplace");
    const json = JSON.stringify(normalizeConfigForSave(current.config));
    expect(json).not.toContain("layout-marketplace");
    const { config } = normalizeLoadedConfig(JSON.parse(json), current.config.dataDir);
    const session = buildAppSessionSnapshot(reduceSnapshot(current, { type: "FOCUS_PANE", paneId: mainLay }));
    const restarted = createDesktopWorkspace(config, reconcileAppSessionSnapshot(config, session), workspace.extraWindows());
    for (const windowId of [MAIN, SECOND]) {
      const cold = restarted.getWindowSnapshot(windowId)!;
      expect(JSON.stringify(cold)).not.toContain("layout-marketplace");
      expect(cold.config.layout.instances.length).toBeGreaterThan(0);
    }

    workspace.noteDelivered(SECOND, 1, shown);
    const closed = reduceSnapshot(shown, { type: "UPDATE_LAYOUT", layout: removePane(shown.config.layout, LAY) });
    expect(closed.focusedPaneId).not.toBe(LAY);
    workspace.syncWindowState(SECOND, closed, 1);
    const closedView = workspace.getWindowSnapshot(SECOND)!;
    expect(findPaneInstance(closedView.config.layout, LAY)).toBeUndefined();
    expect(closedView.paneState[LAY]).toBeUndefined();
    expect(closedView.focusedPaneId).toBe(closed.focusedPaneId);
    workspace.syncWindowState(SECOND, openLayouts(closedView, "layout-marketplace:reopened"));
    expect(workspace.getWindowSnapshot(SECOND)!.focusedPaneId).toBe("layout-marketplace:reopened");
  });

  test.each(["switch", "move"] as const)("%s drops Layouts even with identical tabs and a late snapshot", (operation) => {
    const base = tabConfig();
    const layout = createBlankLayout();
    const home = { ...base.layouts[0]!, layout };
    const config = { ...base, layout, layouts: [home, { ...home, id: "tab:copy" }, base.layouts[1]!] };
    const workspace = createDesktopWorkspace(config, null, [{ id: SECOND, layoutIds: ["tab:monitor"] }]);
    workspace.syncMainState(openLayouts(workspace.getWindowSnapshot(MAIN)!));
    const held = workspace.getWindowSnapshot(MAIN)!;
    workspace.noteDelivered(MAIN, 1, held);

    if (operation === "switch") workspace.activateLayout(MAIN, "tab:copy");
    else workspace.moveLayoutToWindow("tab:home", SECOND);
    workspace.syncMainState({ ...held, mainStateRevision: 1, config: { ...held.config, theme: "paper" }, paneState: { [LAY]: { activeTabId: "team" } } }, 1);

    const main = workspace.getWindowSnapshot(MAIN)!;
    expect(main.config.layouts[main.config.activeLayoutIndex]!.id).toBe("tab:copy");
    expect(main.config.theme).toBe("paper");
    expect(JSON.stringify(main)).not.toContain("layout-marketplace");
    expect(JSON.stringify(workspace.getWindowSnapshot(SECOND))).not.toContain("layout-marketplace");
  });

  test("late settings saves neither close nor resurrect Layouts, and detached frame updates stay saved without it", () => {
    const workspace = createDesktopWorkspace(tabConfig(), null);
    workspace.popOutPane("chat:main", { x: 100, y: 120, width: 800, height: 540 });
    const before = workspace.getWindowSnapshot(MAIN)!;
    workspace.noteDelivered(MAIN, 1, before);
    workspace.syncMainState(openLayouts(before), 1);
    const withLay = workspace.getWindowSnapshot(MAIN)!;
    workspace.noteDelivered(MAIN, 2, withLay);
    const frame = { x: 200, y: 220, width: 700, height: 440 };
    workspace.updateDetachedFrame("chat:main", frame);
    workspace.syncMainState({ ...before, mainStateRevision: 1, config: { ...before.config, theme: "paper" } }, 1);

    const shown = workspace.getWindowSnapshot(MAIN)!;
    expect(shown.focusedPaneId).toBe(LAY);
    expect(findPaneInstance(shown.config.layout, LAY)).toBeDefined();
    expect(shown.config.layouts[0]!.layout.detached).toEqual([{ instanceId: "chat:main", ...frame }]);
    expect(findPaneInstance(shown.config.layouts[0]!.layout, LAY)).toBeUndefined();
    expect(shown.config.theme).toBe("paper");

    const closed = reduceSnapshot(shown, { type: "UPDATE_LAYOUT", layout: removePane(shown.config.layout, LAY) });
    workspace.syncMainState(closed, 2);
    workspace.syncMainState({ ...withLay, mainStateRevision: 2, config: { ...withLay.config, theme: "green" } }, 2);
    const final = workspace.getWindowSnapshot(MAIN)!;
    expect(final.config.theme).toBe("green");
    expect(final.config.layout.detached).toEqual([{ instanceId: "chat:main", ...frame }]);
    expect(final.focusedPaneId).toBe(closed.focusedPaneId);
    expect(JSON.stringify(final)).not.toContain("layout-marketplace");
  });

  test("a config the main window saves after a cloud pull changes another window's tab only where the pull did", () => {
    const base = createDefaultConfig("/tmp/gloomberb-desktop");
    const config = { ...base, layouts: base.layouts.map((entry) => ({ ...entry, id: `tab:${entry.name.toLowerCase()}` })) };
    const second = "window:two";
    const workspace = createDesktopWorkspace(config, null, [{ id: second, layoutIds: ["tab:monitor"] }]);
    const told = workspace.otherWindowTabs();
    expect(told.map(({ at, tab }) => [at, tab.name])).toEqual([[1, "Monitor"]]);

    // The other window renames its tab before the main window hears of it.
    const shown = workspace.getWindowSnapshot(second)!;
    const renamed = structuredClone(shown);
    renamed.config.layouts[0]!.name = "Desk";
    renamed.mainStateRevision = 1;
    workspace.syncWindowState(second, renamed, null);
    expect(workspace.getWindowSnapshot(second)!.config.layouts.map((entry) => entry.name)).toEqual(["Desk"]);

    // A pull changes Macro; the main window saves every tab as it was told them.
    const main = workspace.getWindowSnapshot(MAIN_WINDOW_ID)!;
    const layouts = [...main.config.layouts];
    layouts.splice(told[0]!.at, 0, told[0]!.tab);
    const pulled = (macro: string, monitor: string) => ({
      ...main.config,
      layouts: layouts.map((entry) => (entry.id === "tab:macro" ? { ...entry, name: macro } : entry.id === "tab:monitor" ? { ...entry, name: monitor } : entry)),
      activeLayoutIndex: 0,
    });
    let saved = workspace.replaceConfigFromWindow(MAIN_WINDOW_ID, pulled("Rates", "Monitor"));
    expect(saved.config.layouts.map((entry) => entry.name)).toEqual(["Home", "Desk", "Rates"]);
    expect(workspace.getWindowSnapshot(second)!.config.layouts.map((entry) => entry.name)).toEqual(["Desk"]);

    // A tab the pull did change takes the pulled copy and stays in its window.
    workspace.otherWindowTabs();
    saved = workspace.replaceConfigFromWindow(MAIN_WINDOW_ID, pulled("Rates", "Pulled"));
    expect(saved.config.layouts.map((entry) => entry.name)).toEqual(["Home", "Pulled", "Rates"]);
    expect(workspace.getWindowSnapshot(second)!.config.layouts.map((entry) => entry.name)).toEqual(["Pulled"]);
  });

  test("a pane moved to a new window opens there in the one change, and one that cannot move opens no window", () => {
    const workspace = createDesktopWorkspace(createDefaultConfig("/tmp/gloomberb-desktop"), null);
    const paneId = workspace.getSnapshot().config.layout.instances[0]!.instanceId;

    expect(workspace.openWindow("window:none", { paneId: "gone:pane" })).toBeNull();
    expect(workspace.windowIds()).toEqual([MAIN_WINDOW_ID]);

    expect(workspace.openWindow("window:two", { paneId })).not.toBeNull();
    expect(workspace.windowIds()).toEqual([MAIN_WINDOW_ID, "window:two"]);
    expect(workspace.locatePane(paneId)?.windowId).toBe("window:two");
    const shown = workspace.getWindowSnapshot("window:two")!;
    expect(shown.config.layout.instances.map((entry) => entry.instanceId)).toEqual([paneId]);
  });

  test("popping out a pane persists it into the active layout", () => {
    const config = createDefaultConfig("/tmp/gloomberb-desktop");
    const workspace = createDesktopWorkspace(config, null);

    const snapshot = workspace.popOutPane("chat:main", {
      x: 100,
      y: 120,
      width: 800,
      height: 540,
    });

    expect(snapshot.config.layout.detached).toEqual([
      { instanceId: "chat:main", x: 100, y: 120, width: 800, height: 540 },
    ]);
    expect(snapshot.config.layouts[snapshot.config.activeLayoutIndex]?.layout.detached).toEqual([
      { instanceId: "chat:main", x: 100, y: 120, width: 800, height: 540 },
    ]);
    expect(snapshot.config.layout.floating.some((entry) => entry.instanceId === "chat:main")).toBe(false);
  });

  test("docking a detached pane onto a frame edge clears detached placement", () => {
    const config = createDefaultConfig("/tmp/gloomberb-desktop");
    const workspace = createDesktopWorkspace(config, null);
    workspace.popOutPane("chat:main", {
      x: 100,
      y: 120,
      width: 800,
      height: 540,
    });

    const snapshot = workspace.dockDetachedPane("chat:main", "left");

    expect(snapshot.config.layout.detached).toHaveLength(0);
    expect(snapshot.config.layout.dockRoot).not.toBeNull();
  });

  test("a renderer's older copy of the layout does not move a popped-out window back", () => {
    const config = createDefaultConfig("/tmp/gloomberb-desktop");
    const workspace = createDesktopWorkspace(config, null);
    const popped = workspace.popOutPane("chat:main", { x: 100, y: 120, width: 800, height: 540 });
    workspace.updateDetachedFrame("chat:main", { x: 220, y: 260, width: 640, height: 480 });
    const moved = { instanceId: "chat:main", x: 220, y: 260, width: 640, height: 480 };

    // A popped-out window saving the config it hydrated before the move.
    expect(workspace.replaceConfig(popped.config).config.layout.detached).toEqual([moved]);
    // The main window syncing state it built before the move, with its tabs
    // reordered since, so even the active index differs.
    const otherPane = popped.config.layout.instances.find((instance) => instance.instanceId !== "chat:main")!;
    const newlyOut = { instanceId: otherPane.instanceId, x: 10, y: 20, width: 700, height: 500 };
    const synced = workspace.syncMainState({
      ...popped,
      config: {
        ...popped.config,
        activeLayoutIndex: popped.config.activeLayoutIndex === 0 ? 1 : 0,
        layout: { ...cloneLayout(popped.config.layout), detached: [...popped.config.layout.detached, newlyOut] },
      },
      mainStateRevision: 5,
    });
    // A pane the main window newly pops out still opens where it says.
    expect(synced.config.layout.detached).toEqual([moved, newlyOut]);
    expect(synced.config.layouts[synced.config.activeLayoutIndex]?.layout.detached).toEqual([moved, newlyOut]);
  });

  // A popped-out window only rehydrates when its own pane changes, so the rest
  // of the layout it saves can predate a pane the main window just opened.
  test("a popped-out window's save keeps panes it has not seen and applies its own pane's edits", () => {
    const workspace = createDesktopWorkspace(createDefaultConfig("/tmp/gloomberb-desktop"), null);
    const popped = workspace.popOutPane("chat:main", { x: 100, y: 120, width: 800, height: 540 });
    const opened = createPaneInstance("news", { instanceId: "news:opened" });
    workspace.syncMainState({
      ...popped,
      config: { ...popped.config, layout: addPaneFloating(popped.config.layout, opened, 120, 40) },
      mainStateRevision: 1,
    });

    // Its own pane renamed, and (a popped-out Layouts pane) the open tab too.
    const saved = workspace.replaceConfigFromDetachedPane("chat:main", {
      ...popped.config,
      theme: "green",
      layout: updatePaneInstance(popped.config.layout, "chat:main", (instance) => ({ ...instance, title: "#general" })),
      layouts: popped.config.layouts.map((entry, index) => (
        index === popped.config.activeLayoutIndex ? { ...entry, name: "Trading" } : entry
      )),
    });

    expect(findPaneInstance(saved.config.layout, "news:opened")).toBeDefined();
    expect(findPaneInstance(saved.config.layout, "chat:main")?.title).toBe("#general");
    expect(saved.config.layouts[saved.config.activeLayoutIndex]?.name).toBe("Trading");
    expect(saved.config.theme).toBe("green");
    expect(saved.config.layout.detached.map((entry) => entry.instanceId)).toEqual(["chat:main"]);
    expect(saved.mainStateRevision).toBe(1);
  });

  test("docking from the menu remembers the window's frame, an edge drop does not", () => {
    const config = createDefaultConfig("/tmp/gloomberb-desktop");
    const workspace = createDesktopWorkspace(config, null);
    const rested = { x: 220, y: 260, width: 640, height: 480 };
    workspace.popOutPane("chat:main", { x: 100, y: 120, width: 800, height: 540 });
    workspace.updateDetachedFrame("chat:main", rested);

    const docked = workspace.dockDetachedPane("chat:main");
    expect(findPaneInstance(docked.config.layout, "chat:main")?.placementMemory?.detached).toEqual(rested);

    workspace.popOutPane("chat:main", rested);
    workspace.updateDetachedFrame("chat:main", { x: 1140, y: 300, width: 640, height: 480 });
    const dropped = workspace.dockDetachedPane("chat:main", "right");
    expect(findPaneInstance(dropped.config.layout, "chat:main")?.placementMemory?.detached).toEqual(rested);
  });

  test("ignores main-window state that arrives behind a newer layout revision", () => {
    const config = createDefaultConfig("/tmp/gloomberb-desktop-layout-revision");
    const workspace = createDesktopWorkspace(config, null);
    const initialSnapshot = workspace.getSnapshot();
    const monitorLayout = config.layouts[1]!;

    const newerSnapshot = {
      ...initialSnapshot,
      config: {
        ...initialSnapshot.config,
        layout: cloneLayout(monitorLayout.layout),
        activeLayoutIndex: 1,
      },
      paneState: monitorLayout.paneState ?? {},
      focusedPaneId: monitorLayout.focusedPaneId ?? null,
      mainStateRevision: 2,
    };
    const staleSnapshot = {
      ...initialSnapshot,
      mainStateRevision: 1,
    };

    workspace.syncMainState(newerSnapshot);
    const result = workspace.syncMainState(staleSnapshot);

    expect(result.mainStateRevision).toBe(2);
    expect(result.config.activeLayoutIndex).toBe(1);
    expect(result.config.layout).toEqual(monitorLayout.layout);
  });
});
