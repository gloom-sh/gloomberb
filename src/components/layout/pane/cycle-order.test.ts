import { describe, expect, test } from "bun:test";
import type { PluginRegistry } from "../../../plugins/registry";
import { buildDockStack } from "../../../layout/pane-manager/dock-stack";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID, type LayoutConfig } from "../../../types/config";
import { getVisiblePaneCycleOrder } from "./cycle-order";

function createRegistry(options: {
  paneIds: readonly string[];
  disabledPaneIds?: Record<string, readonly string[]>;
}): PluginRegistry {
  return {
    panes: new Map(options.paneIds.map((paneId) => [paneId, {}])),
    getPluginPaneIds: (pluginId: string) => [...(options.disabledPaneIds?.[pluginId] ?? [])],
  } as unknown as PluginRegistry;
}

describe("getVisiblePaneCycleOrder", () => {
  test("skips disabled and unregistered panes when cycling focus", () => {
    const config = createDefaultConfig("/tmp/gloomberb-pane-cycle-order");
    const registry = createRegistry({
      paneIds: ["portfolio-list", "chat", TICKER_RESEARCH_PANE_ID],
      disabledPaneIds: { chat: ["chat"] },
    });

    expect(getVisiblePaneCycleOrder(config.layout, registry, ["chat"])).toEqual([
      "portfolio-list:main",
      "ticker-detail:main",
    ]);
  });

  // Docked: a pane, then a stack showing "b" over "c". Floating: a stack
  // showing "e" over "d", then a window of its own.
  const registry = createRegistry({ paneIds: ["portfolio-list"] });
  const instance = (instanceId: string) => ({ instanceId, paneId: "portfolio-list" });
  const layout: LayoutConfig = {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "a" },
      second: buildDockStack(["b", "c"], "b")!,
    },
    instances: ["a", "b", "c", "d", "e", "f"].map(instance),
    floating: [
      { instanceId: "d", x: 0, y: 0, width: 20, height: 8, stack: "s", zIndex: 50 },
      { instanceId: "e", x: 0, y: 0, width: 20, height: 8, stack: "s", zIndex: 51 },
      { instanceId: "f", x: 30, y: 0, width: 20, height: 8, zIndex: 52 },
    ],
    detached: [],
  } as LayoutConfig;

  test("steps through the tab a stack shows and never one it hides", () => {
    expect(getVisiblePaneCycleOrder(layout, registry, [])).toEqual(["a", "b", "e", "f"]);
    // Focus on a hidden tab (a click on it, a pane opened there) moves on from where it is.
    expect(getVisiblePaneCycleOrder(layout, registry, [], { focusedPaneId: "c" })).toEqual(["a", "b", "c", "e", "f"]);
  });

  test("passes by the docked panes a floating window covers, and keeps the focused one in place", () => {
    expect(getVisiblePaneCycleOrder(layout, registry, [], { covered: new Set(["a"]) })).toEqual(["b", "e", "f"]);
    expect(getVisiblePaneCycleOrder(layout, registry, [], { covered: new Set(["a"]), focusedPaneId: "a" }))
      .toEqual(["a", "b", "e", "f"]);
  });

  test("with nothing else to go to, the covered panes stay in the order", () => {
    const docked = { ...layout, floating: [] } as LayoutConfig;
    expect(getVisiblePaneCycleOrder(docked, registry, [], { covered: new Set(["a", "b"]), focusedPaneId: "a" }))
      .toEqual(["a", "b"]);
  });
});
