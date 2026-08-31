import type { GloomPlugin } from "../types/plugin";
import type { LoadedExternalPlugin } from "./loader";
import { newsPlugin } from "./builtin/news";
import { notesPlugin } from "./builtin/notes";
import { substackPlugin } from "./builtin/substack";
import { aiPlugin } from "./builtin/ai";
import { gloomberbCloudPlugin } from "./builtin/cloud";
import { ibkrPlugin } from "./ibkr";
import { publicPlugin } from "./broker-sync/public";
import { robinhoodPlugin } from "./broker-sync/robinhood";
import { simpleFinPlugin } from "./broker-sync/simplefin";
import { predictionMarketsPlugin } from "./prediction-markets";
import { pollsPlugin } from "./builtin/polls";
import { alertsPlugin } from "./builtin/alerts";
import {
  applicationPlugin,
  brokerPlugin,
  macroPlugin,
  marketOverviewPlugin,
  portfolioPlugin,
} from "./builtin/composite-plugins";
import { tickerResearchPlugin } from "./builtin/ticker-research-plugin";

export const uiBuiltinPlugins: GloomPlugin[] = [
  gloomberbCloudPlugin,
  portfolioPlugin,
  tickerResearchPlugin,
  brokerPlugin,
  ibkrPlugin,
  publicPlugin,
  robinhoodPlugin,
  simpleFinPlugin,
  applicationPlugin,
  newsPlugin,
  substackPlugin,
  notesPlugin,
  aiPlugin,
  predictionMarketsPlugin,
  pollsPlugin,
  marketOverviewPlugin,
  macroPlugin,
  alertsPlugin,
];

export function getRendererBuiltinPlugins(): GloomPlugin[] {
  return uiBuiltinPlugins;
}

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
