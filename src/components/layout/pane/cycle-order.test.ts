import { describe, expect, test } from "bun:test";
import type { PluginRegistry } from "../../../plugins/registry";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID } from "../../../types/config";
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
});
