import { describe, expect, test } from "bun:test";
import { cloneLayout, createBlankLayout, createDefaultConfig } from "../../../types/config";
import { appReducer, createInitialState } from "./index";
import { removePane } from "../../../plugins/pane-manager";

describe("appReducer command bar state", () => {
  test("tracks layout undo and redo history", () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const defaultRatio = initial.config.layout.dockRoot && initial.config.layout.dockRoot.kind === "split"
      ? initial.config.layout.dockRoot.ratio
      : null;
    const changedLayout = cloneLayout(initial.config.layout);
    if (!changedLayout.dockRoot || changedLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    changedLayout.dockRoot.ratio = 0.5;

    const withHistory = appReducer(initial, { type: "PUSH_LAYOUT_HISTORY" });
    const changed = appReducer(withHistory, { type: "UPDATE_LAYOUT", layout: changedLayout });

    expect(changed.layoutHistory[0]?.past).toHaveLength(1);
    expect(changed.config.layout.dockRoot && changed.config.layout.dockRoot.kind === "split"
      ? changed.config.layout.dockRoot.ratio
      : null).toBe(0.5);

    const undone = appReducer(changed, { type: "UNDO_LAYOUT" });
    expect(undone.config.layout.dockRoot && undone.config.layout.dockRoot.kind === "split"
      ? undone.config.layout.dockRoot.ratio
      : null).toBe(defaultRatio);
    expect(undone.layoutHistory[0]?.future).toHaveLength(1);

    const redone = appReducer(undone, { type: "REDO_LAYOUT" });
    expect(redone.config.layout.dockRoot && redone.config.layout.dockRoot.kind === "split"
      ? redone.config.layout.dockRoot.ratio
      : null).toBe(0.5);
    expect(redone.layoutHistory[0]?.past).toHaveLength(1);
  });

  test("keeps layout history isolated per saved layout", () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const defaultRatio = initial.config.layout.dockRoot && initial.config.layout.dockRoot.kind === "split"
      ? initial.config.layout.dockRoot.ratio
      : null;
    const newLayoutIndex = initial.config.layouts.length;

    const firstLayout = cloneLayout(initial.config.layout);
    if (!firstLayout.dockRoot || firstLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    firstLayout.dockRoot.ratio = 0.45;
    let state = appReducer(initial, { type: "PUSH_LAYOUT_HISTORY" });
    state = appReducer(state, { type: "UPDATE_LAYOUT", layout: firstLayout });
    state = appReducer(state, { type: "NEW_LAYOUT", name: "Research" });

    const noUndoOnFreshLayout = appReducer(state, { type: "UNDO_LAYOUT" });
    expect(noUndoOnFreshLayout.config.activeLayoutIndex).toBe(newLayoutIndex);
    expect(noUndoOnFreshLayout.config.layout).toEqual(createBlankLayout());
    expect(noUndoOnFreshLayout.focusedPaneId).toBeNull();

    const secondLayout = cloneLayout(initial.config.layout);
    if (!secondLayout.dockRoot || secondLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    secondLayout.dockRoot.ratio = 0.55;
    state = appReducer(noUndoOnFreshLayout, { type: "PUSH_LAYOUT_HISTORY" });
    state = appReducer(state, { type: "UPDATE_LAYOUT", layout: secondLayout });

    const backToFirst = appReducer(state, { type: "SWITCH_LAYOUT", index: 0 });
    const firstUndone = appReducer(backToFirst, { type: "UNDO_LAYOUT" });
    expect(firstUndone.config.activeLayoutIndex).toBe(0);
    expect(firstUndone.config.layout.dockRoot && firstUndone.config.layout.dockRoot.kind === "split"
      ? firstUndone.config.layout.dockRoot.ratio
      : null).toBe(defaultRatio);

    const backToSecond = appReducer(firstUndone, { type: "SWITCH_LAYOUT", index: newLayoutIndex });
    const secondUndone = appReducer(backToSecond, { type: "UNDO_LAYOUT" });
    expect(secondUndone.config.activeLayoutIndex).toBe(newLayoutIndex);
    expect(secondUndone.config.layout).toEqual(createBlankLayout());
  });

  test("reorders saved layouts without changing the active workspace", () => {
    const config = createDefaultConfig("/tmp/gloomberb-layout-reorder-test");
    const baseLayout = cloneLayout(config.layout);
    config.layouts = [
      { name: "Home", layout: cloneLayout(baseLayout) },
      { name: "Research", layout: cloneLayout(baseLayout) },
      { name: "News", layout: cloneLayout(baseLayout) },
    ];
    config.activeLayoutIndex = 1;
    config.layout = cloneLayout(config.layouts[1]!.layout);

    const historyLayout = (ratio: number) => {
      const layout = cloneLayout(baseLayout);
      if (!layout.dockRoot || layout.dockRoot.kind !== "split") {
        throw new Error("expected split dock root");
      }
      layout.dockRoot.ratio = ratio;
      return layout;
    };

    const state = {
      ...createInitialState(config),
      paneState: {
        "ticker-detail:main": { activeTabId: "financials" },
      },
      focusedPaneId: "ticker-detail:main",
      layoutHistory: {
        0: { past: [historyLayout(0.41)], future: [] },
        1: { past: [historyLayout(0.52)], future: [] },
        2: { past: [historyLayout(0.63)], future: [] },
      },
    };

    const next = appReducer(state, { type: "REORDER_LAYOUT", fromIndex: 0, toIndex: 2 });

    expect(next.config.layouts.map((layout) => layout.name)).toEqual(["Research", "News", "Home"]);
    expect(next.config.activeLayoutIndex).toBe(0);
    expect(next.config.layout).toEqual(state.config.layout);
    expect(next.paneState).toEqual(state.paneState);
    expect(next.config.layouts[0]?.paneState?.["ticker-detail:main"]?.activeTabId).toBe("financials");
    expect(next.layoutHistory[0]?.past[0]?.dockRoot).toMatchObject({ kind: "split", ratio: 0.52 });
    expect(next.layoutHistory[1]?.past[0]?.dockRoot).toMatchObject({ kind: "split", ratio: 0.63 });
    expect(next.layoutHistory[2]?.past[0]?.dockRoot).toMatchObject({ kind: "split", ratio: 0.41 });
  });

  test("keeps saved layout operations coherent after a reorder", () => {
    const config = createDefaultConfig("/tmp/gloomberb-layout-operations-test");
    const baseLayout = cloneLayout(config.layout);
    config.layouts = [
      { name: "Home", layout: cloneLayout(baseLayout) },
      { name: "Research", layout: cloneLayout(baseLayout) },
      { name: "News", layout: cloneLayout(baseLayout) },
    ];
    config.activeLayoutIndex = 1;
    config.layout = cloneLayout(config.layouts[1]!.layout);

    let state = createInitialState(config);
    state = appReducer(state, { type: "REORDER_LAYOUT", fromIndex: 0, toIndex: 2 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual(["Research", "News", "Home"]);
    expect(state.config.activeLayoutIndex).toBe(0);

    state = appReducer(state, { type: "RENAME_LAYOUT", index: 0, name: "Overview" });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual(["Overview", "News", "Home"]);

    state = appReducer(state, { type: "DUPLICATE_LAYOUT", index: 0 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual([
      "Overview",
      "News",
      "Home",
      "Overview Copy",
    ]);
    expect(state.config.activeLayoutIndex).toBe(3);

    state = appReducer(state, { type: "SWITCH_LAYOUT", index: 1 });
    expect(state.config.activeLayoutIndex).toBe(1);
    expect(state.config.layouts[state.config.activeLayoutIndex]?.name).toBe("News");

    state = appReducer(state, { type: "NEW_LAYOUT", name: "Scratch" });
    expect(state.config.layouts.at(-1)?.name).toBe("Scratch");
    expect(state.config.activeLayoutIndex).toBe(4);
    expect(state.config.layout).toEqual(createBlankLayout());

    state = appReducer(state, { type: "DELETE_LAYOUT", index: 4 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual([
      "Overview",
      "News",
      "Home",
      "Overview Copy",
    ]);
    expect(state.config.activeLayoutIndex).toBe(3);

    state = appReducer(state, { type: "DELETE_LAYOUT", index: 1 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual([
      "Overview",
      "Home",
      "Overview Copy",
    ]);
    expect(state.config.activeLayoutIndex).toBe(2);
    expect(state.config.layouts[state.config.activeLayoutIndex]?.name).toBe("Overview Copy");
  });

  test("installs marketplace layouts as independent editable copies", () => {
    const config = createDefaultConfig("/tmp/gloomberb-marketplace-install-test");
    config.layouts.push(
      { name: "Research", layout: cloneLayout(config.layout) },
      { name: "Research (2)", layout: cloneLayout(config.layout) },
    );
    const marketplaceLayout = cloneLayout(config.layout);
    if (!marketplaceLayout.dockRoot || marketplaceLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    marketplaceLayout.dockRoot.ratio = 0.72;

    const installed = appReducer(createInitialState(config), {
      type: "INSTALL_LAYOUT_COPY",
      name: "Research",
      layout: marketplaceLayout,
      paneState: {
        "ticker-detail:main": {
          pluginState: { "prediction-markets": { searchQuery: "fed" } },
        },
      },
    });

    expect(installed.config.layouts.at(-1)?.name).toBe("Research (3)");
    expect(installed.config.activeLayoutIndex).toBe(installed.config.layouts.length - 1);
    expect(installed.config.layout.dockRoot).toMatchObject({ kind: "split", ratio: 0.72 });
    expect(installed.paneState["ticker-detail:main"]).toMatchObject({
      pluginState: { "prediction-markets": { searchQuery: "fed" } },
    });

    marketplaceLayout.dockRoot.ratio = 0.2;
    expect(installed.config.layout.dockRoot).toMatchObject({ kind: "split", ratio: 0.72 });
  });

  test("restores an explicit focus target after a layout removes the focused pane", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test-focus-restore");
    const nextLayout = removePane(config.layout, "ticker-detail:main");
    const state = {
      ...createInitialState(config),
      focusedPaneId: "ticker-detail:main",
      previousFocusedPaneId: "portfolio-list:main",
    };

    const next = appReducer(state, {
      type: "UPDATE_LAYOUT",
      layout: nextLayout,
      focusedPaneId: "portfolio-list:main",
    });

    expect(next.focusedPaneId).toBe("portfolio-list:main");
    expect(next.config.layouts[next.config.activeLayoutIndex]?.focusedPaneId).toBe("portfolio-list:main");
  });

  test("preserves the restore source while activating a pane in another panel", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test-focus-activation");
    let state = {
      ...createInitialState(config),
      focusedPaneId: "portfolio-list:main",
      previousFocusedPaneId: null,
      activePanel: "left" as const,
    };

    state = appReducer(state, { type: "SET_ACTIVE_PANEL", panel: "right", preserveFocus: true });
    expect(state.activePanel).toBe("right");
    expect(state.focusedPaneId).toBe("portfolio-list:main");
    expect(state.previousFocusedPaneId).toBeNull();

    state = appReducer(state, { type: "FOCUS_PANE", paneId: "ticker-detail:main" });
    expect(state.focusedPaneId).toBe("ticker-detail:main");
    expect(state.previousFocusedPaneId).toBe("portfolio-list:main");

    const restored = appReducer(state, {
      type: "UPDATE_LAYOUT",
      layout: removePane(state.config.layout, "ticker-detail:main"),
      focusedPaneId: state.previousFocusedPaneId,
    });

    expect(restored.focusedPaneId).toBe("portfolio-list:main");
  });

  test("tracks manual update-check feedback", () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const checking = appReducer(initial, { type: "SET_UPDATE_CHECK_IN_PROGRESS", checking: true });
    const noticed = appReducer(checking, { type: "SET_UPDATE_NOTICE", notice: "Already on v0.3.1" });

    expect(checking.updateCheckInProgress).toBe(true);
    expect(noticed.updateNotice).toBe("Already on v0.3.1");
  });

  test("clears stale update notices when an update becomes available", () => {
    const initial = {
      ...createInitialState(createDefaultConfig("/tmp/gloomberb-test")),
      updateNotice: "Already on v0.3.1",
    };
    const next = appReducer(initial, {
      type: "SET_UPDATE_AVAILABLE",
      release: {
        version: "0.3.2",
        tagName: "v0.3.2",
        downloadUrl: "https://example.com/gloomberb.gz",
        publishedAt: "2026-04-03T00:00:00Z",
        updateAction: { kind: "self" },
        compressed: true,
      },
    });

    expect(next.updateAvailable?.version).toBe("0.3.2");
    expect(next.updateNotice).toBeNull();
  });
});
