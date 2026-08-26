import { describe, expect, test } from "bun:test";
import { createInitialState } from "../../../state/app/context";
import {
  createDefaultConfig,
  createPaneInstance,
  findPaneInstance,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
} from "../../../types/config";
import type { PaneDef } from "../../../types/plugin";
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
]);

describe("tickerLinkMenuItems", () => {
  test("pins the current ticker when unlinking and can link back to the source", () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-link-menu-test"));
    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "AAPL" };
    const target = findPaneInstance(state.config.layout, "ticker-detail:main")!;
    let layout: LayoutConfig = state.config.layout;

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
});
