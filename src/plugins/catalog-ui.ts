import type { GloomPlugin } from "../types/plugin";
import type { LoadedExternalPlugin } from "./loader";
import { newsPlugin } from "./builtin/news";
import { notesPlugin } from "./builtin/notes";
import { customViewPlugin } from "./builtin/custom-view";
import { gloomberbCloudPlugin } from "./builtin/cloud";
import { alertsPlugin } from "./builtin/alerts";
import { researchSearchPlugin } from "./builtin/research-search";
import { marketHeatmapPlugin } from "./builtin/market-heatmap";
import { marketHaltsPlugin } from "./builtin/market-halts";
import { fearGreedPlugin } from "./builtin/fear-greed";
import {
  applicationPlugin,
  brokerPlugin,
  macroPlugin,
  marketOverviewPlugin,
  portfolioPlugin,
  tickerResearchPlugin,
} from "./builtin/composite-plugins";

export const uiBuiltinPlugins: GloomPlugin[] = [
  gloomberbCloudPlugin,
  portfolioPlugin,
  tickerResearchPlugin,
  brokerPlugin,
  applicationPlugin,
  newsPlugin,
  notesPlugin,
  customViewPlugin,
  marketOverviewPlugin,
  marketHeatmapPlugin,
  marketHaltsPlugin,
  fearGreedPlugin,
  macroPlugin,
  alertsPlugin,
  researchSearchPlugin,
];

/**
 * The plugin list for a UI renderer: the built-ins it ships with, plus any
 * external plugins that loaded and support this renderer.
 *
 * Deliberately not `getLoadablePlugins`, which is the CLI catalog and also
 * carries the Yahoo fallback provider and the debug plugin. Routing the desktop
 * through it would quietly change which plugins the app runs.
 */
export function getRendererPlugins(externalPlugins: readonly LoadedExternalPlugin[] = []): GloomPlugin[] {
  return [
    ...uiBuiltinPlugins,
    ...externalPlugins
      .filter((entry) => !entry.error && !entry.unsupportedTarget)
      .map((entry) => entry.plugin),
  ];
}
