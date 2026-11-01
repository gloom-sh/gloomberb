import { describe, expect, test } from "bun:test";
import {
  createPaneInstance,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../types/config";
import type { PaneDef } from "../types/plugin";
import { resolveTickerRetargetPane, retargetTickerPane } from "./ticker-retarget";

const component = () => null;
const panes = new Map<string, PaneDef>([
  ["portfolio-list", { id: "portfolio-list", name: "Portfolio", component, defaultPosition: "left", tickerSource: true }],
  [TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID, name: "Ticker Research", component, defaultPosition: "right" }],
  ["options", { id: "options", name: "Options", component, defaultPosition: "right", tickerFollower: true }],
  ["options-positioning", { id: "options-positioning", name: "Options Positioning", component, defaultPosition: "right", tickerFollower: true }],
  // A chart follows only while it shows one security, as the chart composer's does.
  ["chart", {
    id: "chart", name: "Chart", component, defaultPosition: "right",
    tickerFollower: (pane) => pane.settings?.compare !== true,
  }],
  ["news", { id: "news", name: "News", component, defaultPosition: "right" }],
]);

function layoutOf(...instances: PaneInstanceConfig[]): LayoutConfig {
  return {
    dockRoot: { kind: "pane", instanceId: instances[0]!.instanceId },
    instances,
    floating: instances.slice(1).map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: index, width: 40, height: 12 })),
    detached: [],
  };
}

const pane = (instanceId: string, paneId: string, options: Partial<PaneInstanceConfig> = {}) => createPaneInstance(paneId, { instanceId, ...options });
const follows = (sourceInstanceId: string) => ({ binding: { kind: "follow" as const, sourceInstanceId } });
const fixed = (symbol: string) => ({ binding: { kind: "fixed" as const, symbol } });
const targetOf = (layout: LayoutConfig, paneId: string | null) => resolveTickerRetargetPane(layout, paneId, panes)?.instanceId ?? null;

describe("resolveTickerRetargetPane", () => {
  test("a pane on a fixed ticker changes itself", () => {
    const layout = layoutOf(pane("omon", "options", { title: "OMON SPY", ...fixed("SPY") }));
    expect(targetOf(layout, "omon")).toBe("omon");
  });

  test("a linked pane changes the single-ticker pane at the top of its chain, so the group moves together", () => {
    // The Options desk: OPX, OVDV and HIVG follow OMON; HIVG here follows OPX to make a chain.
    const layout = layoutOf(
      pane("omon", "options", { title: "OMON SPY", ...fixed("SPY") }),
      pane("opx", "options-positioning", follows("omon")),
      pane("hivg", "options-positioning", follows("opx")),
      pane("des", TICKER_RESEARCH_PANE_ID, follows("omon")),
    );
    for (const id of ["omon", "opx", "hivg", "des"]) expect(targetOf(layout, id)).toBe("omon");
  });

  test("a group linked to a list is pinned at its top pane; the list itself is never the target", () => {
    const layout = layoutOf(
      pane("list", "portfolio-list"),
      pane("des", TICKER_RESEARCH_PANE_ID, follows("list")),
      pane("chart", "chart", follows("des")),
      pane("omon", "options", { title: "OMON", ...follows("list") }),
    );
    expect(targetOf(layout, "des")).toBe("des");
    expect(targetOf(layout, "chart")).toBe("des");
    expect(targetOf(layout, "omon")).toBe("omon");
    expect(targetOf(layout, "list")).toBeNull();
  });

  test("a pane that shows no single ticker keeps opening a pane", () => {
    const layout = layoutOf(
      pane("des", TICKER_RESEARCH_PANE_ID, fixed("AAPL")),
      pane("news", "news", follows("des")),
      pane("compare", "chart", { ...fixed("AAPL"), settings: { compare: true } }),
      pane("ins", "options-positioning", { binding: { kind: "none" } }),
      pane("follows-ins", "options", follows("ins")),
      pane("unbound-des", TICKER_RESEARCH_PANE_ID, { binding: { kind: "none" } }),
    );
    expect(targetOf(layout, null)).toBeNull();
    expect(targetOf(layout, "news")).toBeNull();
    expect(targetOf(layout, "compare")).toBeNull();
    expect(targetOf(layout, "ins")).toBeNull();
    expect(targetOf(layout, "follows-ins")).toBeNull();
    // Ticker Research with nothing bound still takes the ticker, as it always has.
    expect(targetOf(layout, "unbound-des")).toBe("unbound-des");
  });

  test("a chain stops at a pane that does not follow single tickers, and a loop ends", () => {
    const layout = layoutOf(
      pane("compare", "chart", { ...fixed("AAPL"), settings: { compare: true } }),
      pane("omon", "options", { title: "OMON", ...follows("compare") }),
      pane("a", "options", follows("b")),
      pane("b", "options", follows("a")),
    );
    expect(targetOf(layout, "omon")).toBe("omon");
    expect(["a", "b"]).toContain(targetOf(layout, "a")!);
  });
});

describe("retargetTickerPane", () => {
  test("pins the target on the ticker, retitles it and leaves its followers and the list alone", () => {
    const layout = layoutOf(
      pane("list", "portfolio-list"),
      pane("omon", "options", { title: "OMON", ...follows("list") }),
      pane("opx", "options-positioning", follows("omon")),
      pane("des", TICKER_RESEARCH_PANE_ID, { title: "SPY", ...fixed("SPY") }),
      pane("named", "options", { title: "My hedges", ...fixed("SPY") }),
    );
    const retarget = (id: string) => {
      const next = retargetTickerPane(layout, layout.instances.find((instance) => instance.instanceId === id)!, "AAPL", { previous: "SPY" });
      return { next, pane: next.instances.find((instance) => instance.instanceId === id)! };
    };

    const omon = retarget("omon");
    expect(omon.pane).toMatchObject({ title: "OMON AAPL", binding: { kind: "fixed", symbol: "AAPL" } });
    expect(omon.next.instances.filter((instance) => instance.instanceId !== "omon")).toEqual(layout.instances.filter((instance) => instance.instanceId !== "omon"));
    expect(retarget("des").pane).toMatchObject({ title: "AAPL", binding: { kind: "fixed", symbol: "AAPL" } });
    // A title the user wrote stays.
    expect(retarget("named").pane.title).toBe("My hedges");
  });

  test("a pane that keeps its ticker in its settings moves it through retargetTicker", () => {
    const layout = layoutOf(pane("chart", "chart", { title: "GP SPY", ...fixed("SPY"), settings: { series: "SPY" } }));
    const calls: unknown[] = [];
    const paneDef: PaneDef = {
      ...panes.get("chart")!,
      retargetTicker: (instance, symbol, previous) => {
        calls.push({ binding: instance.binding, title: instance.title, symbol, previous });
        return { ...instance, settings: { series: symbol } };
      },
    };
    const next = retargetTickerPane(layout, layout.instances[0]!, "AAPL", { previous: "SPY", paneDef });
    expect(calls).toEqual([{ binding: { kind: "fixed", symbol: "AAPL" }, title: "GP AAPL", symbol: "AAPL", previous: "SPY" }]);
    expect(next.instances[0]).toMatchObject({ title: "GP AAPL", settings: { series: "AAPL" } });
  });
});
