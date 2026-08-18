import type { GloomPlugin } from "../types/plugin";
import { aiPlugin } from "./builtin/ai";
import { alertsPlugin } from "./builtin/alerts";
import { gloomberbCloudPlugin } from "./builtin/cloud";
import {
  applicationPlugin,
  brokerPlugin,
  macroPlugin,
  marketOverviewPlugin,
  portfolioPlugin,
} from "./builtin/composite-plugins";
import { debugPlugin } from "./builtin/debug";
import { newsPlugin } from "./builtin/news";
import { notesPlugin } from "./builtin/notes";
import { substackPlugin } from "./builtin/substack";
import { tickerResearchBackendPlugin } from "./builtin/ticker-research-backend-plugin";
import { yahooPlugin } from "./builtin/yahoo";
import { ibkrPlugin } from "./ibkr";
import { publicPlugin } from "./broker-sync/public";
import { robinhoodPlugin } from "./broker-sync/robinhood";
import { simpleFinPlugin } from "./broker-sync/simplefin";
import { predictionMarketsBackendPlugin } from "./prediction-markets/backend-plugin";
import { pollsBackendPlugin } from "./builtin/polls/backend-plugin";

const desktopBackendPlugins: GloomPlugin[] = [
  yahooPlugin,
  gloomberbCloudPlugin,
  portfolioPlugin,
  tickerResearchBackendPlugin,
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
  predictionMarketsBackendPlugin,
  pollsBackendPlugin,
  marketOverviewPlugin,
  macroPlugin,
  alertsPlugin,
  debugPlugin,
];

export function getDesktopBackendPlugins(): GloomPlugin[] {
  return desktopBackendPlugins;
}
