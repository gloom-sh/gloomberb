import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState, resolveTickerForPane } from "../../core/state/app/state";
import { insertAtRootEdge } from "../../layout/pane-manager";
import { createDefaultConfig, findPaneInstance, type AppConfig, type LayoutConfig, type PaneInstanceConfig } from "../../types/config";
import type { DesktopSharedStateSnapshot } from "../../types/desktop-window";
import { MAIN_WINDOW_ID } from "./screen-setup";
import {
  addWindow,
  closeWindow,
  createWindowLayouts,
  extraWindowRecords,
  layoutMoveBlock,
  mergeWindowSnapshot,
  moveLayoutToWindow,
  movePaneToWindow,
  projectWindow,
  windowOfLayout,
  type WindowLayouts,
} from "./window-layouts";

const SECOND = "window:two";

/** Home, Monitor and Macro with ids, Home active in the main window. */
function baseConfig(): AppConfig {
  const config = createDefaultConfig("/tmp/gloom-window-layouts");
  return {
    ...config,
    layouts: config.layouts.map((entry) => ({ ...entry, id: `tab:${entry.name.toLowerCase()}` })),
  };
}

function start(records = [{ id: SECOND, layoutIds: ["tab:monitor"] }]): WindowLayouts {
  return createWindowLayouts(baseConfig(), { paneState: {}, focusedPaneId: null, statusBarVisible: true }, records);
}

function tabNames(snapshot: DesktopSharedStateSnapshot | null): string[] {
  return snapshot?.config.layouts.map((entry) => entry.name) ?? [];
}

/** A layout with one more pane, docked on the right. */
function withPane(layout: LayoutConfig, instance: PaneInstanceConfig): LayoutConfig {
  return insertAtRootEdge({ ...layout, instances: [...layout.instances, instance] }, instance.instanceId, "right");
}

/** What a window does to the projection it holds before sending it back. */
function edit(snapshot: DesktopSharedStateSnapshot, change: (config: AppConfig) => AppConfig): DesktopSharedStateSnapshot {
  return { ...snapshot, config: change(structuredClone(snapshot.config)) };
}

describe("window layouts", () => {
  test("each window is sent its own tabs, with its active tab as the layout", () => {
    const state = start();
    const main = projectWindow(state, MAIN_WINDOW_ID)!;
    const second = projectWindow(state, SECOND)!;
    expect(tabNames(main)).toEqual(["Home", "Macro"]);
    expect(tabNames(second)).toEqual(["Monitor"]);
    expect(second.config.activeLayoutIndex).toBe(0);
    expect(second.config.layout).toEqual(state.config.layouts[1]!.layout);
    // The config every surface saves still has every tab, in its order.
    expect(state.config.layouts.map((entry) => entry.name)).toEqual(["Home", "Monitor", "Macro"]);
  });

  test("a window opened for tabs that are gone is not opened again", () => {
    const state = start([{ id: SECOND, layoutIds: ["tab:deleted-elsewhere"] }]);
    expect(state.windowIds).toEqual([MAIN_WINDOW_ID]);
    expect(tabNames(projectWindow(state, MAIN_WINDOW_ID))).toEqual(["Home", "Monitor", "Macro"]);
  });

  test("a window's renames, new tabs and order land among its own tabs only", () => {
    let state = addWindow(start(), "window:three", { layoutId: "tab:macro" });
    const held = projectWindow(state, SECOND)!;
    const sent = edit(held, (config) => ({
      ...config,
      layouts: [
        { ...config.layouts[0]!, name: "Monitor 2" },
        { id: "tab:new", name: "Scratch", layout: config.layouts[0]!.layout, paneState: {} },
      ].reverse(),
      activeLayoutIndex: 1,
    }));
    state = mergeWindowSnapshot(state, SECOND, held, sent);
    expect(tabNames(projectWindow(state, SECOND))).toEqual(["Scratch", "Monitor 2"]);
    expect(tabNames(projectWindow(state, MAIN_WINDOW_ID))).toEqual(["Home"]);
    expect(tabNames(projectWindow(state, "window:three"))).toEqual(["Macro"]);
    expect(windowOfLayout(state, "tab:new")).toBe(SECOND);
  });

  test("a window drawing an older state does not undo another window's change", () => {
    let state = start();
    const secondHeld = projectWindow(state, SECOND)!;
    const mainHeld = projectWindow(state, MAIN_WINDOW_ID)!;
    // The main window changes the theme and renames its tab.
    state = mergeWindowSnapshot(state, MAIN_WINDOW_ID, mainHeld, edit(mainHeld, (config) => ({
      ...config,
      theme: "paper",
      layouts: config.layouts.map((entry, index) => (index === 0 ? { ...entry, name: "Desk" } : entry)),
    })));
    // The second window, not yet sent that, changes a watchlist.
    state = mergeWindowSnapshot(state, SECOND, secondHeld, edit(secondHeld, (config) => ({
      ...config,
      watchlists: [...config.watchlists, { id: "tech", name: "Tech" }],
    })));
    expect(state.config.theme).toBe("paper");
    expect(state.config.layouts[0]!.name).toBe("Desk");
    expect(state.config.watchlists.map((entry) => entry.id)).toEqual(["watchlist", "tech"]);
  });

  test("a window's tab deletion removes only that tab", () => {
    let state = addWindow(start(), "window:three", { layoutId: "tab:macro" });
    state = moveLayoutToWindow(state, "tab:macro", SECOND);
    const held = projectWindow(state, SECOND)!;
    state = mergeWindowSnapshot(state, SECOND, held, edit(held, (config) => ({
      ...config,
      layouts: config.layouts.filter((entry) => entry.id !== "tab:monitor"),
      activeLayoutIndex: 0,
    })));
    expect(state.config.layouts.map((entry) => entry.id)).toEqual(["tab:home", "tab:macro"]);
    // The third window lost its only tab to the second, so it closed.
    expect(state.windowIds).toEqual([MAIN_WINDOW_ID, SECOND]);
  });

  test("a tab pulled into the main window that another window shows keeps its window", () => {
    let state = start();
    const held = projectWindow(state, MAIN_WINDOW_ID)!;
    const monitor = state.config.layouts.find((entry) => entry.id === "tab:monitor")!;
    state = mergeWindowSnapshot(state, MAIN_WINDOW_ID, held, edit(held, (config) => ({
      ...config,
      layouts: [config.layouts[0]!, { ...monitor, name: "Monitor (pulled)" }, config.layouts[1]!],
    })));
    expect(windowOfLayout(state, "tab:monitor")).toBe(SECOND);
    expect(tabNames(projectWindow(state, SECOND))).toEqual(["Monitor (pulled)"]);
    expect(tabNames(projectWindow(state, MAIN_WINDOW_ID))).toEqual(["Home", "Macro"]);
  });

  test("moving a tab makes it the active tab where it lands; the main window keeps its last tab", () => {
    let state = start();
    state = moveLayoutToWindow(state, "tab:home", SECOND);
    expect(projectWindow(state, SECOND)!.config.layouts[projectWindow(state, SECOND)!.config.activeLayoutIndex]!.id).toBe("tab:home");
    expect(state.config.layouts[state.config.activeLayoutIndex]!.id).toBe("tab:macro");
    expect(layoutMoveBlock(state, "tab:macro", SECOND)).toBe("last-main-tab");
    expect(moveLayoutToWindow(state, "tab:macro", SECOND)).toBe(state);
    expect(extraWindowRecords(state)).toEqual([
      { id: SECOND, layoutIds: ["tab:home", "tab:monitor"], activeLayoutId: "tab:home" },
    ]);
  });

  test("closing a window gives its tabs back to the main window where they were", () => {
    const state = closeWindow(moveLayoutToWindow(start(), "tab:macro", SECOND), SECOND);
    expect(state.windowIds).toEqual([MAIN_WINDOW_ID]);
    expect(tabNames(projectWindow(state, MAIN_WINDOW_ID))).toEqual(["Home", "Monitor", "Macro"]);
  });

  test("a new tab sent again before the window took its id stays one tab", () => {
    let state = start();
    const held = projectWindow(state, SECOND)!;
    const blank = { name: "Scratch", layout: held.config.layout, paneState: {} };
    const sent = edit(held, (config) => ({ ...config, layouts: [...config.layouts, blank] }));
    state = mergeWindowSnapshot(state, SECOND, held, sent);
    // Built on the same state, with a pane added to the new tab meanwhile.
    state = mergeWindowSnapshot(state, SECOND, held, edit(sent, (config) => ({
      ...config,
      layouts: config.layouts.map((entry) => (entry.name === "Scratch" ? { ...entry, paneState: { added: {} } } : entry)),
    })));
    const tabs = projectWindow(state, SECOND)!.config.layouts;
    expect(tabs.map((entry) => entry.name)).toEqual(["Monitor", "Scratch"]);
    expect(tabs[1]!.paneState).toEqual({ added: {} });
  });

  test("a new window starts on an empty tab of its own", () => {
    const state = addWindow(start([]), SECOND);
    const second = projectWindow(state, SECOND)!;
    expect(second.config.layouts).toHaveLength(1);
    expect(second.config.layout.instances).toEqual([]);
    expect(tabNames(projectWindow(state, MAIN_WINDOW_ID))).toEqual(["Home", "Monitor", "Macro"]);
  });

  test("a follower of a pane in another window stays linked when its window switches to its tab, its source showing a ticker or not", () => {
    const config = baseConfig();
    const monitor = config.layouts.findIndex((entry) => entry.id === "tab:monitor");
    const macro = config.layouts.findIndex((entry) => entry.id === "tab:macro");
    let sources = config.layouts[monitor]!.layout;
    sources = withPane(sources, { instanceId: "source:aapl", paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" } });
    // A list with nothing selected yet.
    sources = withPane(sources, { instanceId: "source:none", paneId: "portfolio-list", params: { collectionId: "main" }, binding: { kind: "none" } });
    let followers = config.layouts[macro]!.layout;
    followers = withPane(followers, { instanceId: "follower:aapl", paneId: "ticker-detail", binding: { kind: "follow", sourceInstanceId: "source:aapl" } });
    followers = withPane(followers, { instanceId: "follower:none", paneId: "ticker-detail", binding: { kind: "follow", sourceInstanceId: "source:none" } });
    config.layouts[monitor] = { ...config.layouts[monitor]!, layout: sources };
    config.layouts[macro] = { ...config.layouts[macro]!, layout: followers };
    const state = createWindowLayouts(config, { paneState: {}, focusedPaneId: null, statusBarVisible: true }, [{ id: SECOND, layoutIds: ["tab:monitor"] }]);

    // The main window shows Home; its Macro tab's followers are listed all the same.
    const main = projectWindow(state, MAIN_WINDOW_ID)!;
    expect(main.linkedTickers).toEqual({ "source:aapl": "AAPL", "source:none": "" });
    let view = appReducer(createInitialState(main.config), { type: "HYDRATE_DESKTOP_SNAPSHOT", snapshot: main });
    view = appReducer(view, { type: "SWITCH_LAYOUT", index: view.config.layouts.findIndex((entry) => entry.id === "tab:macro") });
    expect(findPaneInstance(view.config.layout, "follower:aapl")?.binding).toEqual({ kind: "follow", sourceInstanceId: "source:aapl" });
    expect(findPaneInstance(view.config.layout, "follower:none")?.binding).toEqual({ kind: "follow", sourceInstanceId: "source:none" });
    expect(resolveTickerForPane(view, "follower:aapl")).toBe("AAPL");
    expect(resolveTickerForPane(view, "follower:none")).toBeNull();
  });

  test("a pane moves with its state and links into the other window's active tab", () => {
    const config = baseConfig();
    const home = config.layouts[0]!;
    const paneId = home.layout.instances[0]!.instanceId;
    const follower = { instanceId: "follower", paneId: "ticker-detail", binding: { kind: "follow" as const, sourceInstanceId: paneId } };
    config.layouts[0] = {
      ...home,
      layout: { ...home.layout, instances: [...home.layout.instances, follower] },
    };
    config.layout = config.layouts[0]!.layout;
    let state = createWindowLayouts(
      config,
      { paneState: { [paneId]: { cursorSymbol: "AAPL" }, follower: { activeTabId: "news" } }, focusedPaneId: "follower", statusBarVisible: true },
      [{ id: SECOND, layoutIds: ["tab:monitor"] }],
    );
    state = movePaneToWindow(state, "follower", SECOND);
    const second = projectWindow(state, SECOND)!;
    expect(findPaneInstance(second.config.layout, "follower")?.binding).toEqual({ kind: "follow", sourceInstanceId: paneId });
    expect(second.paneState.follower).toEqual({ activeTabId: "news" });
    expect(second.focusedPaneId).toBe("follower");
    // The link keeps working from the other window: it is sent the ticker its source shows.
    expect(second.linkedTickers).toEqual({ [paneId]: "AAPL" });
    const moved = mergeWindowSnapshot(state, MAIN_WINDOW_ID, projectWindow(state, MAIN_WINDOW_ID), {
      ...projectWindow(state, MAIN_WINDOW_ID)!,
      paneState: { [paneId]: { cursorSymbol: "MSFT" } },
    });
    expect(projectWindow(moved, SECOND)!.linkedTickers).toEqual({ [paneId]: "MSFT" });
    const main = projectWindow(state, MAIN_WINDOW_ID)!;
    expect(findPaneInstance(main.config.layout, "follower")).toBeUndefined();
    expect(main.focusedPaneId).toBeNull();
    expect(main.paneState.follower).toBeUndefined();
  });
});
