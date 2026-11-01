import { describe, expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig, createPaneInstance, findPaneInstance } from "../../../../../types/config";
import { addPaneFloating } from "../../../../../layout/pane-manager";
import { updatePaneInstance } from "../../../../../pane-settings";
import { MAIN_WINDOW_ID } from "../../../../desktop/screen-setup";
import { createDesktopWorkspace } from "./index";

describe("desktop workspace", () => {
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
