import { creditDocumentsModule } from "./credit-documents";
import { attentionModule } from "./attention";
import { companyAttentionModule } from "./company-attention";
import { catalystsModule } from "./catalysts";
import { companyKpisModule } from "./company-kpis";
import { powerModule } from "./power";
import { perpsModule } from "./perps";
import { exposureModule } from "./exposure";
import { supplyChainModule } from "./supply-chain";
import { awardsModule } from "./awards";
import { cryptoBoardModule } from "./crypto-board";
import { portfolioAnalyticsModule } from "./analytics";
import { brokerManagerModule } from "./broker-manager";
import { changelogModule } from "./changelog";
import { connectionsModule } from "./connections";
import { pluginMarketplaceModule } from "./plugin-marketplace";
import { relativeRotationModule } from "./relative-rotation";
import { equityScreenerModule } from "./equity-screener";
import { correlationModule } from "./correlation";
import { cdsModule } from "./cds";
import { creditBoardsModule } from "./credit-boards";
import { creditConditionsModule } from "./credit-conditions";
import { marketValuationModule } from "./market-valuation";
import { economicCalendarModule } from "./econ";
import { cpiModule } from "./cpi";
import { econStatisticsModule } from "./econ-statistics";
import { earningsModule } from "./earnings";
import { earningsCallsModule } from "./earnings-calls";
import { futuresModule } from "./futures";
import { futuresCurveModule } from "./futures-curve";
import { cotModule } from "./cot";
import { doeModule } from "./doe";
import { gpuModule } from "./gpu";
import { fxMatrixModule } from "./fx-matrix";
import { helpModule } from "./help";
import { positionSizerModule } from "./kelly-sizer";
import { layoutManagerModule } from "./layout-manager";
import { marketMoversModule } from "./market-movers";
import { volatilityModule } from "./volatility";
import { composeBuiltinPlugin, type PluginModule } from "./plugin-module";
import { portfolioListModule } from "./portfolio-list";
import { scannerModule } from "./scanner";
import { sectorsModule } from "./sectors";
import { treasuryAuctionsModule } from "./treasury-auctions";
import { worldIndicesModule } from "./world-indices";
import { worldVenueMapModule } from "./world-venue-map";
import { bondCalculatorModule } from "./bond-calculator";
import { yieldCurveModule } from "./yield-curve";
import { centralBankRatesModule } from "./central-bank-rates";
import { moneyMarketsModule } from "./money-markets";
import { ratePathModule } from "./rate-path";
import { debtMaturitiesModule } from "./debt-maturities";
import { revenueBreakdownModule } from "./revenue-breakdown";
import { mnaModule } from "./mna";
import { shortVolumeModule } from "./short-volume";
import { socialMentionsModule } from "./social-mentions";
import { timeSalesModule } from "./time-sales";
import { estimateRevisionsModule } from "./estimate-revisions";
import { chartComposerModule } from "./chart-composer";
import { congressResearchModule } from "./congress-trades";
import { dividendYieldModule } from "./dividend-yield";
import { executivesModule } from "./executives";
import { filingEventsModule } from "./filing-events";
import { holdersModule } from "./holders";
import { insiderModule } from "./insider";
import { jobsModule } from "./jobs";
import { optionsModule } from "./options";
import { optionsPositioningModule } from "./options-positioning";
import { optionsScenarioModule } from "./options-scenario";
import { optionsCalculatorModule } from "./options-calculator";
import { volSurfaceModule } from "./vol-surface";
import { realizedVolModule } from "./realized-vol";
import { seasonalityModule } from "./seasonality";
import { earningsRippleModule } from "./earnings-ripple";
import { reverseDcfModule } from "./reverse-dcf";
import { peBandModule } from "./pe-band";
import { macroDayModule } from "./macro-day";
import { ivHistoryModule } from "./iv-history";
import { backtestModule } from "./backtest";
import { researchModule } from "./research";
import { riskFactorsModule } from "./risk-factors";
import { secModule } from "./sec";
import { shortInterestModule } from "./short-interest";
import { thirteenFModule } from "./thirteenf";
import { tickerDetailModule } from "./ticker-detail";
import { macroSharedResourcesModule } from "./macro-resources";
import {
  altDataPluginMeta,
  applicationPluginMeta,
  creditPluginMeta,
  cryptoPluginMeta,
  earningsPluginMeta,
  futuresCommoditiesPluginMeta,
  globalMarketsPluginMeta,
  portfolioPluginMeta,
  filingsPluginMeta,
  optionsVolatilityPluginMeta,
  ownershipPluginMeta,
  quantPluginMeta,
  ratesMacroPluginMeta,
  screenersPluginMeta,
  tickerCorePluginMeta,
} from "./builtin-plugin-meta";

export const applicationPlugin = composeBuiltinPlugin({
  ...applicationPluginMeta,
  modules: [layoutManagerModule, pluginMarketplaceModule, helpModule, changelogModule, connectionsModule],
});

export const portfolioPlugin = composeBuiltinPlugin({
  ...portfolioPluginMeta,
  modules: [portfolioListModule, portfolioAnalyticsModule, positionSizerModule],
});

// Ticker Research's modules are drawn in the renderer: the desktop backend
// process runs none of them, and keeps only the identity of the plugins that
// hold nothing else.
const rendererOnly = (module: PluginModule) => ({ module, rendererOnly: true });
const tickerResearchModule = (module: PluginModule) => ({ module, stateId: "ticker-research", rendererOnly: true });

export const tickerCorePlugin = composeBuiltinPlugin({
  ...tickerCorePluginMeta,
  modules: [
    tickerDetailModule,
    chartComposerModule,
    researchModule,
    estimateRevisionsModule,
    companyKpisModule,
    revenueBreakdownModule,
    dividendYieldModule,
    reverseDcfModule,
    peBandModule,
    executivesModule,
    timeSalesModule,
  ].map(rendererOnly),
});

export const optionsVolatilityPlugin = composeBuiltinPlugin({
  ...optionsVolatilityPluginMeta,
  modules: [
    optionsModule,
    optionsPositioningModule,
    optionsCalculatorModule,
    optionsScenarioModule,
    volSurfaceModule,
    realizedVolModule,
    ivHistoryModule,
  ].map(rendererOnly),
});

export const ownershipPlugin = composeBuiltinPlugin({
  ...ownershipPluginMeta,
  description: "Holders, 13F funds, insider trades, short interest and volume, and congressional trades.",
  modules: [
    holdersModule,
    thirteenFModule,
    insiderModule,
    shortInterestModule,
    shortVolumeModule,
    // The Congress research tab; the CONG pane is Gloom Cloud's.
    congressResearchModule,
  ].map(rendererOnly),
});

export const filingsPlugin = composeBuiltinPlugin({
  ...filingsPluginMeta,
  modules: [secModule, riskFactorsModule, filingEventsModule, catalystsModule, mnaModule].map(rendererOnly),
});

export const brokerPlugin = composeBuiltinPlugin({
  id: "broker",
  name: "Broker",
  version: "1.0.0",
  description: "Broker profiles, account sync, and connection status.",
  toggleable: true,
  modules: [brokerManagerModule],
});

export const globalMarketsPlugin = composeBuiltinPlugin({
  ...globalMarketsPluginMeta,
  modules: [worldIndicesModule, worldVenueMapModule, sectorsModule, fxMatrixModule, relativeRotationModule],
});

export const screenersPlugin = composeBuiltinPlugin({
  ...screenersPluginMeta,
  description: "Equity screener, top movers, session highs and lows, and unusual options flow.",
  modules: [equityScreenerModule, marketMoversModule, scannerModule],
});

export const futuresCommoditiesPlugin = composeBuiltinPlugin({
  ...futuresCommoditiesPluginMeta,
  modules: [futuresModule, futuresCurveModule, cotModule, doeModule],
});

export const cryptoPlugin = composeBuiltinPlugin({
  ...cryptoPluginMeta,
  modules: [cryptoBoardModule, perpsModule],
});

export const altDataPlugin = composeBuiltinPlugin({
  ...altDataPluginMeta,
  modules: [
    ...[attentionModule, gpuModule, powerModule].map((module) => ({ module, stateId: "market-overview" })),
    ...[supplyChainModule, exposureModule, awardsModule, companyAttentionModule, jobsModule, socialMentionsModule].map(rendererOnly),
  ],
});

export const quantPlugin = composeBuiltinPlugin({
  ...quantPluginMeta,
  modules: [
    { module: correlationModule, stateId: "market-overview" },
    ...[backtestModule, seasonalityModule, macroDayModule].map(rendererOnly),
  ],
});

export const ratesMacroPlugin = composeBuiltinPlugin({
  ...ratesMacroPluginMeta,
  modules: [
    // The FRED cache the other panes and the chart composer read too. Every
    // plugin is set up whether or not it is switched on, so it stays attached.
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

export const creditPlugin = composeBuiltinPlugin({
  ...creditPluginMeta,
  modules: [
    cdsModule,
    creditBoardsModule,
    creditConditionsModule,
    treasuryAuctionsModule,
    bondCalculatorModule,
    tickerResearchModule(creditDocumentsModule),
    tickerResearchModule(debtMaturitiesModule),
  ],
});

export const earningsPlugin = composeBuiltinPlugin({
  ...earningsPluginMeta,
  description: "Earnings calendar with surprises and implied moves, call transcripts, and the earnings ripple through customers and suppliers.",
  modules: [earningsModule, earningsCallsModule, tickerResearchModule(earningsRippleModule)],
});
