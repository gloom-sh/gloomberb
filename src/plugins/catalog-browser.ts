import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../data/fred-series";
import type { GloomPlugin } from "../types/plugin";
import { portfolioAnalyticsModule } from "./builtin/analytics";
import { alertsPlugin } from "./builtin/alerts";
import { browserGloomberbCloudPlugin } from "./builtin/cloud/browser";
import { changelogModule } from "./builtin/changelog";
import { chartComposerModule } from "./builtin/chart-composer";
import { connectionsModule } from "./builtin/connections";
import { correlationModule } from "./builtin/correlation";
import { cdsModule } from "./builtin/cds";
import { creditConditionsModule } from "./builtin/credit-conditions";
import { marketValuationModule } from "./builtin/market-valuation";
import {
  attachValuationPersistence,
  resetValuationPersistence,
} from "./builtin/market-valuation/cache";
import { economicCalendarModule } from "./builtin/econ";
import { futuresModule } from "./builtin/futures";
import { fxMatrixModule } from "./builtin/fx-matrix";
import { helpModule } from "./builtin/help";
import { positionSizerModule } from "./builtin/kelly-sizer";
import { layoutManagerModule } from "./builtin/layout-manager";
import { tickerNewsModule } from "./builtin/news";
import { optionsModule } from "./builtin/options";
import { optionsCalculatorModule } from "./builtin/options-calculator";
import { composeBuiltinPlugin, type PluginModule } from "./builtin/plugin-module";
import { portfolioListModule } from "./builtin/portfolio-list";
import { researchModule } from "./builtin/research";
import { scannerModule } from "./builtin/scanner";
import { sectorsModule } from "./builtin/sectors";
import { tickerDetailModule } from "./builtin/ticker-detail";
import { treasuryAuctionsModule } from "./builtin/treasury-auctions";
import { volatilityModule } from "./builtin/volatility";
import { worldIndicesModule } from "./builtin/world-indices";
import { worldVenueMapModule } from "./builtin/world-venue-map";
import { yieldCurveModule } from "./builtin/yield-curve";

const browserApplicationPlugin = composeBuiltinPlugin({
  id: "application",
  name: "Application",
  version: "1.0.0",
  description: "Core layout, help, and release information.",
  modules: [layoutManagerModule, helpModule, changelogModule, connectionsModule],
});

const browserPortfolioPlugin = composeBuiltinPlugin({
  id: "portfolio",
  name: "Portfolio",
  version: "1.0.0",
  description: "Portfolio and watchlist management, analytics, and position sizing.",
  toggleable: true,
  modules: [portfolioListModule, portfolioAnalyticsModule, positionSizerModule],
});

const browserTickerResearchPlugin = composeBuiltinPlugin({
  id: "ticker-research",
  name: "Ticker Research",
  version: "1.0.0",
  description: "Company overview, charts, financials, options, and research.",
  toggleable: true,
  modules: [
    tickerDetailModule,
    chartComposerModule,
    optionsModule,
    optionsCalculatorModule,
    researchModule,
  ],
});

const browserNewsPlugin = composeBuiltinPlugin({
  id: "news",
  name: "News",
  version: "1.0.0",
  description: "View latest news for each ticker.",
  toggleable: true,
  modules: [tickerNewsModule],
});

const browserMarketOverviewPlugin = composeBuiltinPlugin({
  id: "market-overview",
  name: "Market Overview",
  version: "1.0.0",
  description: "Global indices, scanners, sectors, FX, futures, and correlations.",
  toggleable: true,
  modules: [
    correlationModule,
    worldIndicesModule,
    worldVenueMapModule,
    scannerModule,
    sectorsModule,
    fxMatrixModule,
    futuresModule,
  ],
});

const browserFredResourcesModule: PluginModule = {
  setup(ctx) {
    attachFredSeriesPersistence(ctx.persistence);
    attachValuationPersistence(ctx.persistence);
  },
  dispose() {
    resetFredSeriesPersistence();
    resetValuationPersistence();
  },
};

const browserMacroPlugin = composeBuiltinPlugin({
  id: "macro",
  name: "Macro",
  version: "1.0.0",
  description: "Economic calendar, rates, volatility, credit spreads, single-name CDS, and Treasury auctions.",
  toggleable: true,
  modules: [
    browserFredResourcesModule,
    economicCalendarModule,
    yieldCurveModule,
    volatilityModule,
    creditConditionsModule,
    marketValuationModule,
    cdsModule,
    treasuryAuctionsModule,
  ],
});

/**
 * Reviewed browser catalog. Native brokers, filesystem/local-process plugins,
 * and modules whose data path is not available through Gloom Cloud or a
 * browser-safe public API are absent rather than registered behind stubs.
 */
export const browserBuiltinPlugins: readonly GloomPlugin[] = [
  browserGloomberbCloudPlugin,
  browserPortfolioPlugin,
  browserTickerResearchPlugin,
  browserApplicationPlugin,
  browserNewsPlugin,
  browserMarketOverviewPlugin,
  browserMacroPlugin,
  alertsPlugin,
];

export function getBrowserBuiltinPlugins(): readonly GloomPlugin[] {
  return browserBuiltinPlugins;
}
