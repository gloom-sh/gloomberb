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
import { membersPlugin } from "./builtin/members";
import { ipoCalendarPlugin } from "./builtin/ipo-calendar";
import { clinicalTrialsPlugin } from "./builtin/clinical-trials";
import { commentLettersPlugin } from "./builtin/comment-letters";
import { openFdaPlugin } from "./builtin/openfda";
import { altDataPlugin } from "./builtin/composite/alt-data";
import { applicationPlugin } from "./builtin/composite/application";
import { brokerPlugin } from "./builtin/composite/broker";
import { creditPlugin } from "./builtin/composite/credit";
import { cryptoPlugin } from "./builtin/composite/crypto";
import { earningsPlugin } from "./builtin/composite/earnings";
import { filingsPlugin } from "./builtin/composite/filings";
import { futuresCommoditiesPlugin } from "./builtin/composite/futures-commodities";
import { globalMarketsPlugin } from "./builtin/composite/global-markets";
import { optionsVolatilityPlugin } from "./builtin/composite/options-volatility";
import { ownershipPlugin } from "./builtin/composite/ownership";
import { portfolioPlugin } from "./builtin/composite/portfolio";
import { quantPlugin } from "./builtin/composite/quant";
import { ratesMacroPlugin } from "./builtin/composite/rates-macro";
import { screenersPlugin } from "./builtin/composite/screeners";
import { tickerCorePlugin } from "./builtin/composite/ticker-core";

export const uiBuiltinPlugins: GloomPlugin[] = [
  gloomberbCloudPlugin,
  portfolioPlugin,
  tickerCorePlugin,
  optionsVolatilityPlugin,
  ownershipPlugin,
  filingsPlugin,
  brokerPlugin,
  applicationPlugin,
  newsPlugin,
  notesPlugin,
  customViewPlugin,
  globalMarketsPlugin,
  screenersPlugin,
  futuresCommoditiesPlugin,
  cryptoPlugin,
  altDataPlugin,
  quantPlugin,
  marketHeatmapPlugin,
  marketHaltsPlugin,
  fearGreedPlugin,
  membersPlugin,
  ipoCalendarPlugin,
  clinicalTrialsPlugin,
  commentLettersPlugin,
  openFdaPlugin,
  ratesMacroPlugin,
  creditPlugin,
  earningsPlugin,
  alertsPlugin,
  researchSearchPlugin,
];

/**
 * The plugin list for a UI renderer: the built-ins it ships with, plus any
 * external plugins that loaded and support this renderer.
 *
 * Deliberately not `getLoadablePlugins`, which is the CLI catalog and also
 * carries the debug plugin. Routing the desktop
 * through it would quietly change which plugins the app runs.
 */
export function getRendererPlugins(externalPlugins: readonly LoadedExternalPlugin[] = []): GloomPlugin[] {
  return [
    ...uiBuiltinPlugins,
    ...externalPlugins
      .filter((entry) => !entry.error && !entry.unsupportedTarget && !entry.needsRestart)
      .map((entry) => entry.plugin),
  ];
}
