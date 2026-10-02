import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState } from "../../../state/app/context";
import {
  createDefaultConfig,
  createPaneInstance,
  findPaneInstance,
  removePaneInstances,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
} from "../../../types/config";
import type { PaneDef } from "../../../types/plugin";
import { getPaneDisplayTitle } from "../pane/title";
import { tickerLinkMenuItems } from "./ticker-link-menu";

const panes = new Map<string, PaneDef>([
  ["portfolio-list", {
    id: "portfolio-list",
    name: "Portfolio",
    component: () => null,
    defaultPosition: "left",
    tickerSource: true,
  }],
  [TICKER_RESEARCH_PANE_ID, {
    id: TICKER_RESEARCH_PANE_ID,
    name: "Ticker Research",
    component: () => null,
    defaultPosition: "right",
  }],
  ["options-positioning", {
    id: "options-positioning",
    name: "Options Positioning",
    component: () => null,
    defaultPosition: "right",
    tickerFollower: true,
  }],
  ["options", { id: "options", name: "Options", component: () => null, defaultPosition: "right", tickerFollower: true }],
  ["vol-surface", { id: "vol-surface", name: "Volatility Surface", component: () => null, defaultPosition: "right" }],
  ["notes", { id: "notes", name: "Notes", component: () => null, defaultPosition: "right" }],
]);

describe("tickerLinkMenuItems", () => {
  test("pins the current ticker when unlinking and can link back to the source", () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-link-menu-test"));
    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "AAPL" };
    const target = findPaneInstance(state.config.layout, "ticker-detail:main")!;
    let layout: LayoutConfig = state.config.layout;

    expect(getPaneDisplayTitle(state, target, panes.get(TICKER_RESEARCH_PANE_ID)!, panes)).toBe(
      "AAPL  ⧉ Linked to Main Portfolio",
    );

    tickerLinkMenuItems({
      instance: target,
      layout,
      panes,
      state,
      persistLayout: (nextLayout) => { layout = nextLayout; },
    }).find((item) => item.id === "unlink:portfolio-list:main")?.onSelect?.();

    const pinned = findPaneInstance(layout, target.instanceId)!;
    expect(pinned.binding).toEqual({ kind: "fixed", symbol: "AAPL" });

    const previousFollower = createPaneInstance(TICKER_RESEARCH_PANE_ID, {
      instanceId: "ticker-detail:previous",
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
    });
    layout = {
      ...layout,
      instances: [...layout.instances, previousFollower],
      floating: [
        ...layout.floating,
        { instanceId: previousFollower.instanceId, x: 1, y: 1, width: 40, height: 12 },
      ],
    };
    const pinnedState = { ...state, config: { ...state.config, layout } };
    tickerLinkMenuItems({
      instance: pinned,
      layout,
      panes,
      state: pinnedState,
      persistLayout: (nextLayout) => { layout = nextLayout; },
    }).find((item) => item.id === "link:portfolio-list:main")?.onSelect?.();

    expect(findPaneInstance(layout, target.instanceId)?.binding).toEqual({
      kind: "follow",
      sourceInstanceId: "portfolio-list:main",
    });
    expect(findPaneInstance(layout, previousFollower.instanceId)?.binding).toEqual({
      kind: "fixed",
      symbol: "AAPL",
    });
  });

  // Any pane flagged tickerFollower links like DES, but only DES keeps one follower per source, the
  // header shows the live ticker, and a pane chained to a fixed pane gets no rows or suffix.
  test("a flagged pane follows a list, shows its ticker live, and pins on unlink or a closed source", () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-link-menu-follower-test"));
    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "AAPL" };
    const opx = createPaneInstance("options-positioning", {
      instanceId: "options-positioning:AAPL",
      title: "OPX AAPL",
      binding: { kind: "fixed", symbol: "AAPL" },
    });
    const surface = createPaneInstance("vol-surface", { instanceId: "vol-surface:SPY", binding: { kind: "fixed", symbol: "SPY" } });
    const chain = createPaneInstance("options", {
      instanceId: "options:desk",
      binding: { kind: "follow", sourceInstanceId: surface.instanceId },
    });
    const notes = createPaneInstance("notes", { instanceId: "notes:1", binding: { kind: "fixed", symbol: "AAPL" } });
    const added = [opx, surface, chain, notes];
    let layout: LayoutConfig = {
      ...state.config.layout,
      instances: [...state.config.layout.instances, ...added],
      floating: added.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: index, width: 40, height: 12 })),
    };
    const at = (nextLayout: LayoutConfig) => ({ ...state, config: { ...state.config, layout: nextLayout } });
    const menu = (instanceId: string, current = at(layout)) => tickerLinkMenuItems({
      instance: findPaneInstance(layout, instanceId)!,
      layout,
      panes,
      state: current,
      persistLayout: (nextLayout) => { layout = nextLayout; },
    });
    const title = (instanceId: string, current = at(layout)) => {
      const instance = findPaneInstance(current.config.layout, instanceId)!;
      return getPaneDisplayTitle(current, instance, panes.get(instance.paneId)!, panes);
    };

    expect(menu(notes.instanceId)).toEqual([]);
    // Following a fixed pane: it can move to a list, but there is no row to unlink from the hub.
    expect(menu(chain.instanceId).map((item) => item.id)).toEqual(["link:portfolio-list:main"]);
    expect(title(chain.instanceId)).toBe("Options: SPY");

    menu(opx.instanceId).find((item) => item.id === "link:portfolio-list:main")!.onSelect!();
    expect(findPaneInstance(layout, opx.instanceId)).toMatchObject({
      title: "OPX",
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
    });
    expect(findPaneInstance(layout, "ticker-detail:main")!.binding).toEqual({
      kind: "follow",
      sourceInstanceId: "portfolio-list:main",
    });
    expect(title(opx.instanceId)).toBe("OPX AAPL  ⧉ Linked to Main Portfolio");

    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "MSFT" };
    expect(title(opx.instanceId)).toBe("OPX MSFT  ⧉ Linked to Main Portfolio");

    const linked = layout;
    const unlink = menu(opx.instanceId).find((item) => item.id === "unlink:portfolio-list:main")!;
    expect(unlink.label).toBe("Unlink from Main Portfolio");
    unlink.onSelect!();
    expect(findPaneInstance(layout, opx.instanceId)).toMatchObject({
      title: "OPX MSFT",
      binding: { kind: "fixed", symbol: "MSFT" },
    });

    // Closing the list instead pins the follower the same way.
    const closed = appReducer(at(linked), {
      type: "UPDATE_LAYOUT",
      layout: removePaneInstances(linked, ["portfolio-list:main"]),
    }).config.layout;
    expect(findPaneInstance(closed, opx.instanceId)).toMatchObject({
      title: "OPX MSFT",
      binding: { kind: "fixed", symbol: "MSFT" },
    });
  });
});
