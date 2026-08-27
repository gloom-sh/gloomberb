import { describe, expect, test } from "bun:test";
import {
  createPaneInstance,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../types/config";
import {
  findFixedTickerPaneForSymbol,
  findTickerResearchFollower,
  resolveTickerActivation,
  resolveTickerNavigationReplacementPane,
  shouldFocusTickerNavigationTarget,
} from "./ticker-navigation";

function createLayout(instances: PaneInstanceConfig[]): LayoutConfig {
  return {
    dockRoot: { kind: "pane", instanceId: instances[0]?.instanceId ?? "" },
    instances,
    floating: instances.slice(1).map((instance, index) => ({
      instanceId: instance.instanceId,
      x: 2 + index,
      y: 2 + index,
      width: 40,
      height: 12,
    })),
    detached: [],
  };
}

describe("ticker source activation", () => {
  test("focuses a bound follower unless the caller asks for a new pane", () => {
    const layout = createLayout([
      createPaneInstance("portfolio-list", {
        instanceId: "portfolio-list:main",
        binding: { kind: "none" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:main",
        binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
      }),
    ]);

    expect(findTickerResearchFollower(layout, "portfolio-list:main")?.instanceId).toBe("ticker-detail:main");
    expect(resolveTickerActivation(layout, "portfolio-list:main")).toEqual({
      kind: "focus",
      paneId: "ticker-detail:main",
    });
    expect(resolveTickerActivation(layout, "portfolio-list:main", { newPane: true })).toEqual({ kind: "open" });
  });
});

describe("resolveTickerNavigationReplacementPane", () => {
  test("only replaces the Ticker Research pane that opened ticker navigation", () => {
    const layout = createLayout([
      createPaneInstance("portfolio-list", {
        instanceId: "portfolio-list:main",
        binding: { kind: "none" },
      }),
      createPaneInstance("comparison-chart", {
        instanceId: "comparison-chart:main",
        binding: { kind: "none" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:portfolio",
        binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:compare",
        binding: { kind: "follow", sourceInstanceId: "comparison-chart:main" },
      }),
    ]);

    expect(
      resolveTickerNavigationReplacementPane(layout, "comparison-chart:main")?.instanceId,
    ).toBeUndefined();
    expect(
      resolveTickerNavigationReplacementPane(layout, "ticker-detail:portfolio")?.instanceId,
    ).toBe("ticker-detail:portfolio");
  });
});

describe("findFixedTickerPaneForSymbol", () => {
  test("finds only a visible fixed pane for the requested symbol", () => {
    const layout = createLayout([
      createPaneInstance("portfolio-list", {
        instanceId: "portfolio-list:main",
        binding: { kind: "none" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:follow",
        binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:aapl",
        binding: { kind: "fixed", symbol: "AAPL" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:msft",
        binding: { kind: "fixed", symbol: "MSFT" },
      }),
    ]);

    expect(findFixedTickerPaneForSymbol(layout, "ticker-detail", "AAPL")?.instanceId).toBe("ticker-detail:aapl");
    expect(findFixedTickerPaneForSymbol(layout, "ticker-detail", "NVDA")).toBeNull();
  });

  test("does not let standalone shortcut panes collide with full Ticker Research", () => {
    const layout = createLayout([
      createPaneInstance("portfolio-list", {
        instanceId: "portfolio-list:main",
        binding: { kind: "none" },
      }),
      createPaneInstance("financial-analysis", {
        instanceId: "financial-analysis:AAPL",
        binding: { kind: "fixed", symbol: "AAPL" },
      }),
    ]);

    expect(findFixedTickerPaneForSymbol(layout, TICKER_RESEARCH_PANE_ID, "AAPL")).toBeNull();
    expect(findFixedTickerPaneForSymbol(layout, "financial-analysis", "AAPL")?.instanceId).toBe("financial-analysis:AAPL");
  });
});

describe("shouldFocusTickerNavigationTarget", () => {
  test("does not focus stale async ticker navigation after the user moves to another pane", () => {
    expect(shouldFocusTickerNavigationTarget({
      sourcePaneId: "comparison-chart:main",
      currentFocusedPaneId: "portfolio-list:main",
      targetPaneId: "ticker-detail:compare",
    })).toBe(false);
  });

  test("keeps focusing when the source pane still owns the latest interaction", () => {
    expect(shouldFocusTickerNavigationTarget({
      sourcePaneId: "comparison-chart:main",
      currentFocusedPaneId: "comparison-chart:main",
      targetPaneId: "ticker-detail:compare",
    })).toBe(true);
  });
});
