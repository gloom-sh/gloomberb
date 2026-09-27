import { cloneLayout, createDefaultConfig, type LayoutConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";

function paneDef(id: string, name: string, icon: string): PaneDef {
  return { id, name, icon, component: () => null, defaultPosition: "left" };
}

/** The installed pane types gallery tests see. "mystery-pane" is deliberately not installed. */
export const testPanes = new Map<string, PaneDef>([
  ["portfolio-list", paneDef("portfolio-list", "Portfolio", "P")],
  ["ticker-research", paneDef("ticker-research", "Ticker Research", "T")],
  ["chat", paneDef("chat", "Chat", "M")],
  ["ticker-chart", paneDef("ticker-chart", "Chart", "C")],
]);

/** The default layout plus a floating NVDA chart and a detached pane of an uninstalled type. */
export function testLayout(): LayoutConfig {
  const layout = cloneLayout(createDefaultConfig("/tmp/gloomberb-layout-marketplace-test").layout);
  layout.instances = [
    ...layout.instances,
    { instanceId: "ticker-chart:1", paneId: "ticker-chart", binding: { kind: "fixed", symbol: "NVDA" } },
    { instanceId: "mystery:1", paneId: "mystery-pane" },
  ];
  layout.floating = [{ instanceId: "ticker-chart:1", x: 20, y: 6, width: 60, height: 20 }];
  layout.detached = [{ instanceId: "mystery:1", x: 120, y: 4, width: 50, height: 18 }];
  return layout;
}
