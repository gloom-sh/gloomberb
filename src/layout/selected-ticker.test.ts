import { expect, test } from "bun:test";
import { createInitialState } from "../core/state/app/state";
import {
  createDefaultConfig,
  createPaneInstance,
  TICKER_RESEARCH_PANE_ID,
  type DockLayoutNode,
  type PaneInstanceConfig,
} from "../types/config";
import { commandPromptTicker, selectedLayoutTicker } from "./selected-ticker";

function dockOf(ids: readonly string[]): DockLayoutNode {
  const [first, ...rest] = ids;
  if (!first) throw new Error("empty dock");
  if (rest.length === 0) return { kind: "pane", instanceId: first };
  return {
    kind: "split",
    axis: "horizontal",
    ratio: 0.5,
    first: { kind: "pane", instanceId: first },
    second: dockOf(rest),
  };
}

function layoutState(instances: PaneInstanceConfig[], focusedPaneId: string | null) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-selected-ticker"));
  state.focusedPaneId = focusedPaneId;
  state.config.layout = {
    dockRoot: dockOf(instances.map((instance) => instance.instanceId)),
    instances,
    floating: [],
    detached: [],
  };
  return state;
}

test("a linked desk keeps its ticker selected while a market pane is focused", () => {
  const des = createPaneInstance(TICKER_RESEARCH_PANE_ID, {
    instanceId: "des",
    binding: { kind: "fixed", symbol: "MSTR:XMEX" },
  });
  const chart = createPaneInstance("chart-composer", {
    instanceId: "chart",
    binding: { kind: "follow", sourceInstanceId: "des" },
  });
  const financials = createPaneInstance("financial-analysis", {
    instanceId: "fa",
    binding: { kind: "follow", sourceInstanceId: "des" },
  });
  const news = createPaneInstance("news-top", { instanceId: "news", binding: { kind: "none" } });
  const state = layoutState([des, chart, financials, news], "news");

  expect(selectedLayoutTicker(state)).toEqual({
    rootInstanceId: "des",
    symbol: "MSTR:XMEX",
    memberCount: 3,
  });
  expect(commandPromptTicker(state)).toEqual({ rootInstanceId: "des", symbol: "MSTR:XMEX" });
});

test("a focused research pane shows its ticker without inventing a link", () => {
  const des = createPaneInstance(TICKER_RESEARCH_PANE_ID, {
    instanceId: "des",
    binding: { kind: "fixed", symbol: "AAPL" },
  });
  const news = createPaneInstance("news-top", { instanceId: "news", binding: { kind: "none" } });
  const focused = layoutState([des, news], "des");

  expect(commandPromptTicker(focused)).toEqual({ rootInstanceId: "des", symbol: "AAPL" });
  focused.focusedPaneId = "news";
  expect(selectedLayoutTicker(focused)).toBeNull();
  expect(commandPromptTicker(focused)).toBeNull();
});

test("a market-wide board stays out of the prompt until it follows a ticker", () => {
  const board = createPaneInstance("catalysts", { instanceId: "catl", binding: { kind: "none" } });
  const news = createPaneInstance("news-top", { instanceId: "news", binding: { kind: "none" } });
  const state = layoutState([board, news], "catl");

  expect(selectedLayoutTicker(state)).toBeNull();
  expect(commandPromptTicker(state)).toBeNull();
});
