import { debtMaturitiesModule } from "./builtin/debt-maturities";
import { shortVolumeModule } from "./builtin/short-volume";
import { timeSalesModule } from "./builtin/time-sales";
import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../data/fred-series";
import type { GloomPlugin } from "../types/plugin";
import type { LoadedExternalPlugin } from "./loader";
import { portfolioAnalyticsModule } from "./builtin/analytics";
import { earningsCallsModule } from "./builtin/earnings-calls";
import { browserDividendYieldModule } from "./builtin/dividend-yield/browser";
import { executivesModule } from "./builtin/executives";
import { filingEventsModule } from "./builtin/filing-events";
import { riskFactorsModule } from "./builtin/risk-factors";
import { researchSearchPlugin } from "./builtin/research-search";
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
import { econStatisticsModule } from "./builtin/econ-statistics";
import { futuresModule } from "./builtin/futures";
import { futuresCurveModule } from "./builtin/futures-curve";
import { cotModule } from "./builtin/cot";
import { fxMatrixModule } from "./builtin/fx-matrix";
import { helpModule } from "./builtin/help";
import { positionSizerModule } from "./builtin/kelly-sizer";
import { layoutManagerModule } from "./builtin/layout-manager";
import { tickerNewsModule } from "./builtin/news";
import { browserNewsWireModule } from "./builtin/news/wire";
import { secModule } from "./builtin/sec";
import { insiderModule } from "./builtin/insider";
import { jobsModule } from "./builtin/jobs";
import { optionsModule } from "./builtin/options";
import { optionsScenarioModule } from "./builtin/options-scenario";
import { optionsCalculatorModule } from "./builtin/options-calculator";
import { volSurfaceModule } from "./builtin/vol-surface";
import { realizedVolModule } from "./builtin/realized-vol";
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
import { bondCalculatorModule } from "./builtin/bond-calculator";
import { yieldCurveModule } from "./builtin/yield-curve";
import { centralBankRatesModule } from "./builtin/central-bank-rates";
import { moneyMarketsModule } from "./builtin/money-markets";
import { ratePathModule } from "./builtin/rate-path";

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
    optionsScenarioModule,
    volSurfaceModule,
    realizedVolModule,
    timeSalesModule,
    researchModule,
    shortVolumeModule,
    debtMaturitiesModule,
    browserDividendYieldModule,
    earningsCallsModule,
    executivesModule,
    riskFactorsModule,
    filingEventsModule,
    // Filings and Form 4s come through Gloom Cloud, behind a sign-in wall.
    secModule,
    insiderModule,
    // Hiring data is a Gloom Cloud Pro dataset.
    jobsModule,
  ],
});

const browserNewsPlugin = composeBuiltinPlugin({
  id: "news",
  name: "News",
  version: "1.0.0",
  description: "Market news wire and company news for each ticker.",
  toggleable: true,
  modules: [tickerNewsModule, browserNewsWireModule],
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
    futuresCurveModule,
    cotModule,
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
    econStatisticsModule,
    yieldCurveModule,
    ratePathModule,
    moneyMarketsModule,
    bondCalculatorModule,
    centralBankRatesModule,
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
  researchSearchPlugin,
];

export function getBrowserBuiltinPlugins(): readonly GloomPlugin[] {
  return browserBuiltinPlugins;
}

/**
 * The plugin list the hosted web app runs: the reviewed built-ins above plus the
 * plugins compiled into the build from their own repositories, which arrive as
 * loaded modules rather than imports (see `renderers/browser/bundled-plugins.ts`).
 *
 * A plugin that failed to load is dropped here and reported by the marketplace,
 * so one broken bundle cannot take the app down with it.
 */
export function getBrowserPlugins(
  bundledPlugins: readonly LoadedExternalPlugin[] = [],
): readonly GloomPlugin[] {
  return [
    ...browserBuiltinPlugins,
    ...bundledPlugins.filter((entry) => !entry.error && !entry.unsupportedTarget).map((entry) => entry.plugin),
  ];
}
