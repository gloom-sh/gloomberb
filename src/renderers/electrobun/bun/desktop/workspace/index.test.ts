import { describe, expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig, findPaneInstance } from "../../../../../types/config";
import { createDesktopWorkspace } from "./index";

describe("desktop workspace", () => {
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
      activePanel: monitorLayout.activePanel ?? "left" as const,
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
