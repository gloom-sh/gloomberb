import { creditDocumentsModule } from "./builtin/credit-documents";
import { attentionModule } from "./builtin/attention";
import { companyAttentionModule } from "./builtin/company-attention";
import { catalystsModule } from "./builtin/catalysts";
import { companyKpisModule } from "./builtin/company-kpis";
import { powerModule } from "./builtin/power";
import { perpsModule } from "./builtin/perps";
import { exposureModule } from "./builtin/exposure";
import { supplyChainModule } from "./builtin/supply-chain";
import { awardsModule } from "./builtin/awards";
import { debtMaturitiesModule } from "./builtin/debt-maturities";
import { fixedIncomeModule } from "./builtin/fixed-income";
import { primaryDealersModule } from "./builtin/primary-dealers";
import { traceBondsModule } from "./builtin/trace-bonds";
import { treasuryDailyModule } from "./builtin/treasury-daily";
import { revenueBreakdownModule } from "./builtin/revenue-breakdown";
import { mnaModule } from "./builtin/mna";
import { cryptoBoardModule } from "./builtin/crypto-board";
import { cryptoEtfFlowsModule } from "./builtin/crypto-etf-flows";
import { shortInterestModule } from "./builtin/short-interest";
import { shortVolumeModule } from "./builtin/short-volume";
import { socialMentionsModule } from "./builtin/social-mentions";
import { timeSalesModule } from "./builtin/time-sales";
import { estimateRevisionsModule } from "./builtin/estimate-revisions";
import type { GloomPlugin } from "../types/plugin";
import type { LoadedExternalPlugin } from "./loader";
import { portfolioAnalyticsModule } from "./builtin/analytics";
import { earningsCallsModule } from "./builtin/earnings-calls";
import { earningsModule } from "./builtin/earnings";
import { holdersModule } from "./builtin/holders";
import { thirteenFModule } from "./builtin/thirteenf";
import { browserDividendYieldModule } from "./builtin/dividend-yield/browser";
import { executivesModule } from "./builtin/executives";
import { filingEventsModule } from "./builtin/filing-events";
import { riskFactorsModule } from "./builtin/risk-factors";
import { researchSearchPlugin } from "./builtin/research-search";
import { alertsPlugin } from "./builtin/alerts";
import { marketHeatmapPlugin } from "./builtin/market-heatmap";
import { marketHaltsPlugin } from "./builtin/market-halts";
import { fearGreedPlugin } from "./builtin/fear-greed";
import { membersPlugin } from "./builtin/members";
import { ipoCalendarPlugin } from "./builtin/ipo-calendar";
import { clinicalTrialsPlugin } from "./builtin/clinical-trials";
import { commentLettersPlugin } from "./builtin/comment-letters";
import { openFdaPlugin } from "./builtin/openfda";
import { browserGloomberbCloudPlugin } from "./builtin/cloud/browser";
import { changelogModule } from "./builtin/changelog";
import { roadmapModule } from "./builtin/roadmap";
import { chartComposerModule } from "./builtin/chart-composer";
import { connectionsModule } from "./builtin/connections";
import { relativeRotationModule } from "./builtin/relative-rotation";
import { equityScreenerModule } from "./builtin/equity-screener";
import { correlationModule } from "./builtin/correlation";
import { cdsModule } from "./builtin/cds";
import { creditBoardsModule } from "./builtin/credit-boards";
import { creditConditionsModule } from "./builtin/credit-conditions";
import { marketValuationModule } from "./builtin/market-valuation";
import { macroSharedResourcesModule } from "./builtin/macro-resources";
import { economicCalendarModule } from "./builtin/econ";
import { cpiModule } from "./builtin/cpi";
import { econStatisticsModule } from "./builtin/econ-statistics";
import { futuresModule } from "./builtin/futures";
import { futuresCurveModule } from "./builtin/futures-curve";
import { cotModule } from "./builtin/cot";
import { doeModule } from "./builtin/doe";
import { commodityBalancesModule } from "./builtin/commodity-balances";
import { jodiModule } from "./builtin/jodi";
import { commoditiesEnergyModule } from "./builtin/commodities-energy";
import { gpuModule } from "./builtin/gpu";
import { fxMatrixModule } from "./builtin/fx-matrix";
import { docsModule } from "./builtin/docs";
import { helpModule } from "./builtin/help";
import { positionSizerModule } from "./builtin/kelly-sizer";
import { layoutManagerModule } from "./builtin/layout-manager";
import { tickerNewsModule } from "./builtin/news";
import { browserNewsWireModule } from "./builtin/news/wire";
import { secModule } from "./builtin/sec";
import { insiderModule } from "./builtin/insider";
import { jobsModule } from "./builtin/jobs";
import { optionsModule } from "./builtin/options";
import { optionsPositioningModule } from "./builtin/options-positioning";
import { optionsScenarioModule } from "./builtin/options-scenario";
import { optionsCalculatorModule } from "./builtin/options-calculator";
import { volSurfaceModule } from "./builtin/vol-surface";
import { realizedVolModule } from "./builtin/realized-vol";
import { seasonalityModule } from "./builtin/seasonality";
import { earningsRippleModule } from "./builtin/earnings-ripple";
import { reverseDcfModule } from "./builtin/reverse-dcf";
import { peBandModule } from "./builtin/pe-band";
import { macroDayModule } from "./builtin/macro-day";
import { ivHistoryModule } from "./builtin/iv-history";
import { backtestModule } from "./builtin/backtest";
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
import {
  applicationPluginMeta,
  creditPluginMeta,
  earningsPluginMeta,
  filingsPluginMeta,
  optionsVolatilityPluginMeta,
  ownershipPluginMeta,
  ratesMacroPluginMeta,
  tickerCorePluginMeta,
  altDataPluginMeta,
  cryptoPluginMeta,
  futuresCommoditiesPluginMeta,
  globalMarketsPluginMeta,
  quantPluginMeta,
  screenersPluginMeta,
  newsPluginMeta,
  portfolioPluginMeta,
} from "./builtin/builtin-plugin-meta";
import { FIXED_INCOME_HOSTS } from "./builtin/fixed-income/model";

const browserApplicationPlugin = composeBuiltinPlugin({
  ...applicationPluginMeta,
  modules: [layoutManagerModule, helpModule, changelogModule, connectionsModule, docsModule, roadmapModule],
});

const runtimeOnly = (module: PluginModule): PluginModule => {
  const { panes: _panes, paneTemplates: _paneTemplates, ...runtime } = module;
  return runtime;
};

const browserPortfolioPlugin = composeBuiltinPlugin({
  ...portfolioPluginMeta,
  modules: [portfolioListModule, portfolioAnalyticsModule, positionSizerModule],
});

// Ticker Research's successors with browser-safe data paths.
const browserTickerCorePlugin = composeBuiltinPlugin({
  ...tickerCorePluginMeta,
  modules: [
    tickerDetailModule,
    chartComposerModule,
    researchModule,
    estimateRevisionsModule,
    companyKpisModule,
    revenueBreakdownModule,
    browserDividendYieldModule,
    reverseDcfModule,
    peBandModule,
    executivesModule,
    timeSalesModule,
  ],
});

const browserOptionsVolatilityPlugin = composeBuiltinPlugin({
  ...optionsVolatilityPluginMeta,
  modules: [
    optionsModule,
    optionsPositioningModule,
    optionsCalculatorModule,
    optionsScenarioModule,
    volSurfaceModule,
    realizedVolModule,
    ivHistoryModule,
  ],
});

const browserOwnershipPlugin = composeBuiltinPlugin({
  ...ownershipPluginMeta,
  description: "Holders, 13F funds, insider trades, and short interest and volume.",
  // The public 13F fallback goes through the same host proxy as other plugins.
  hosts: ["forms13f.com"],
  modules: [
    holdersModule,
    thirteenFModule,
    // Form 4s come through Gloom Cloud, behind a sign-in wall.
    insiderModule,
    // Daily volume shares open this pane.
    shortInterestModule,
    shortVolumeModule,
  ],
});

const browserFilingsPlugin = composeBuiltinPlugin({
  ...filingsPluginMeta,
  // Filings come through Gloom Cloud, behind a sign-in wall.
  modules: [secModule, riskFactorsModule, filingEventsModule, catalystsModule, mnaModule],
});

const browserNewsPlugin = composeBuiltinPlugin({
  ...newsPluginMeta,
  modules: [tickerNewsModule, browserNewsWireModule],
});

// Market Overview's successors with the modules it had on the web: all of
// them but top movers.
const browserGlobalMarketsPlugin = composeBuiltinPlugin({
  ...globalMarketsPluginMeta,
  modules: [worldIndicesModule, worldVenueMapModule, sectorsModule, fxMatrixModule, relativeRotationModule],
});

const browserScreenersPlugin = composeBuiltinPlugin({
  ...screenersPluginMeta,
  description: "Equity screener, session highs and lows, and unusual options flow.",
  modules: [equityScreenerModule, scannerModule],
});

const browserFuturesCommoditiesPlugin = composeBuiltinPlugin({
  ...futuresCommoditiesPluginMeta,
  modules: [
    commoditiesEnergyModule,
    ...[futuresModule, futuresCurveModule, cotModule, doeModule].map(runtimeOnly),
    { module: runtimeOnly(commodityBalancesModule), stateId: "commodity-balances" },
    { module: runtimeOnly(jodiModule), stateId: "jodi" },
  ],
});

const browserCryptoPlugin = composeBuiltinPlugin({
  ...cryptoPluginMeta,
  modules: [cryptoBoardModule, cryptoEtfFlowsModule, perpsModule],
});

const browserAltDataPlugin = composeBuiltinPlugin({
  ...altDataPluginMeta,
  modules: [
    ...[attentionModule, gpuModule, powerModule].map((module) => ({ module, stateId: "market-overview" })),
    supplyChainModule,
    exposureModule,
    awardsModule,
    companyAttentionModule,
    // Hiring data is a Gloom Cloud Pro dataset.
    jobsModule,
    socialMentionsModule,
  ],
});

const browserQuantPlugin = composeBuiltinPlugin({
  ...quantPluginMeta,
  modules: [{ module: correlationModule, stateId: "market-overview" }, backtestModule, seasonalityModule, macroDayModule],
});

// The same panes as on the terminal.
const browserRatesMacroPlugin = composeBuiltinPlugin({
  ...ratesMacroPluginMeta,
  modules: [
    macroSharedResourcesModule,
    economicCalendarModule,
    econStatisticsModule,
    cpiModule,
    yieldCurveModule,
    ratePathModule,
    moneyMarketsModule,
    centralBankRatesModule,
    volatilityModule,
    marketValuationModule,
  ],
});

const browserCreditPlugin = composeBuiltinPlugin({
  ...creditPluginMeta,
  modules: [
    fixedIncomeModule,
    cdsModule,
    creditBoardsModule,
    creditConditionsModule,
    treasuryAuctionsModule,
    bondCalculatorModule,
    traceBondsModule,
    treasuryDailyModule,
    primaryDealersModule,
    { module: creditDocumentsModule, stateId: "ticker-research" },
    { module: debtMaturitiesModule, stateId: "ticker-research" },
  ],
});
browserCreditPlugin.hosts = [...FIXED_INCOME_HOSTS];

// The calendar keeps Macro's state namespace, as on the desktop and terminal.
// Calls and the ripple keep the Ticker Research namespace they used on the web.
const browserEarningsPlugin = composeBuiltinPlugin({
  ...earningsPluginMeta,
  description: "Earnings calendar, call transcripts, and the earnings ripple through customers and suppliers.",
  modules: [
    earningsModule,
    { module: earningsCallsModule, stateId: "ticker-research" },
    { module: earningsRippleModule, stateId: "ticker-research" },
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
  browserTickerCorePlugin,
  browserOptionsVolatilityPlugin,
  browserOwnershipPlugin,
  browserFilingsPlugin,
  browserApplicationPlugin,
  browserNewsPlugin,
  browserGlobalMarketsPlugin,
  browserScreenersPlugin,
  browserFuturesCommoditiesPlugin,
  browserCryptoPlugin,
  browserAltDataPlugin,
  browserQuantPlugin,
  marketHeatmapPlugin,
  marketHaltsPlugin,
  fearGreedPlugin,
  membersPlugin,
  ipoCalendarPlugin,
  clinicalTrialsPlugin,
  commentLettersPlugin,
  openFdaPlugin,
  browserRatesMacroPlugin,
  browserCreditPlugin,
  browserEarningsPlugin,
  alertsPlugin,
  researchSearchPlugin,
];

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
