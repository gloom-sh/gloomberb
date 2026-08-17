import type { GloomPlugin } from "../types/plugin";
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
  marketOverviewPlugin,
  macroPlugin,
  alertsPlugin,
];

export function getRendererBuiltinPlugins(): GloomPlugin[] {
  return uiBuiltinPlugins;
}
