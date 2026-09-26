import { debtMaturitiesModule } from "./builtin/debt-maturities";
import { revenueBreakdownModule } from "./builtin/revenue-breakdown";
import { cryptoBoardModule } from "./builtin/crypto-board";
import { shortVolumeModule } from "./builtin/short-volume";
import { timeSalesModule } from "./builtin/time-sales";
import { estimateRevisionsModule } from "./builtin/estimate-revisions";
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
import { relativeRotationModule } from "./builtin/relative-rotation";
import { equityScreenerModule } from "./builtin/equity-screener";
import { correlationModule } from "./builtin/correlation";
import { cdsModule } from "./builtin/cds";
import { creditConditionsModule } from "./builtin/credit-conditions";
import { marketValuationModule } from "./builtin/market-valuation";
import { macroSharedResourcesModule } from "./builtin/macro-resources";
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
import { ivHistoryModule } from "./builtin/iv-history";
import { backtestModule } from "./builtin/backtest";
import { composeBuiltinPlugin } from "./builtin/plugin-module";
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
import {
  applicationPluginMeta,
  macroPluginMeta,
  marketOverviewPluginMeta,
  newsPluginMeta,
  portfolioPluginMeta,
  tickerResearchPluginMeta,
} from "./builtin/builtin-plugin-meta";

const browserApplicationPlugin = composeBuiltinPlugin({
  ...applicationPluginMeta,
  modules: [layoutManagerModule, helpModule, changelogModule, connectionsModule],
});

const browserPortfolioPlugin = composeBuiltinPlugin({
  ...portfolioPluginMeta,
  modules: [portfolioListModule, portfolioAnalyticsModule, positionSizerModule],
});

const browserTickerResearchPlugin = composeBuiltinPlugin({
  ...tickerResearchPluginMeta,
  modules: [
    tickerDetailModule,
    chartComposerModule,
    optionsModule,
    optionsCalculatorModule,
    optionsScenarioModule,
    volSurfaceModule,
    realizedVolModule,
    ivHistoryModule,
    backtestModule,
    timeSalesModule,
    estimateRevisionsModule,
    researchModule,
    shortVolumeModule,
    debtMaturitiesModule,
    revenueBreakdownModule,
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
  ...newsPluginMeta,
  modules: [tickerNewsModule, browserNewsWireModule],
});

const browserMarketOverviewPlugin = composeBuiltinPlugin({
  ...marketOverviewPluginMeta,
  description: "Global indices, scanners, sectors, FX, futures, and correlations.",
  modules: [
    correlationModule,
    relativeRotationModule,
    equityScreenerModule,
    worldIndicesModule,
    worldVenueMapModule,
    scannerModule,
    sectorsModule,
    fxMatrixModule,
    futuresModule,
    futuresCurveModule,
    cotModule,
    cryptoBoardModule,
  ],
});

const browserMacroPlugin = composeBuiltinPlugin({
  ...macroPluginMeta,
  description: "Economic calendar, rates, volatility, credit spreads, single-name CDS, and Treasury auctions.",
  modules: [
    macroSharedResourcesModule,
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
