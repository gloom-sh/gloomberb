import { creditDocumentsModule } from "./credit-documents";
import { attentionModule } from "./attention";
import { companyAttentionModule } from "./company-attention";
import { catalystsModule } from "./catalysts";
import { companyKpisModule } from "./company-kpis";
import { supplyChainModule } from "./supply-chain";
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
import { composeBuiltinPlugin } from "./plugin-module";
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
import { reverseDcfModule } from "./reverse-dcf";
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
  applicationPluginMeta,
  macroPluginMeta,
  marketOverviewPluginMeta,
  portfolioPluginMeta,
  tickerResearchPluginMeta,
} from "./builtin-plugin-meta";

export const applicationPlugin = composeBuiltinPlugin({
  ...applicationPluginMeta,
  modules: [layoutManagerModule, pluginMarketplaceModule, helpModule, changelogModule, connectionsModule],
});

export const portfolioPlugin = composeBuiltinPlugin({
  ...portfolioPluginMeta,
  modules: [portfolioListModule, portfolioAnalyticsModule, positionSizerModule],
});

export const tickerResearchPlugin = composeBuiltinPlugin({
  ...tickerResearchPluginMeta,
  modules: [
    tickerDetailModule,
    chartComposerModule,
    congressResearchModule,
    optionsModule,
    optionsPositioningModule,
    optionsCalculatorModule,
    optionsScenarioModule,
    volSurfaceModule,
    realizedVolModule,
    seasonalityModule,
    reverseDcfModule,
    ivHistoryModule,
    backtestModule,
    estimateRevisionsModule,
    researchModule,
    shortVolumeModule,
    socialMentionsModule,
    debtMaturitiesModule,
    revenueBreakdownModule,
    supplyChainModule,
    creditDocumentsModule,
    companyAttentionModule,
    catalystsModule,
    companyKpisModule,
    mnaModule,
    dividendYieldModule,
    holdersModule,
    shortInterestModule,
    timeSalesModule,
    thirteenFModule,
    secModule,
    insiderModule,
    jobsModule,
    executivesModule,
    riskFactorsModule,
    filingEventsModule,
  ],
});

export const brokerPlugin = composeBuiltinPlugin({
  id: "broker",
  name: "Broker",
  version: "1.0.0",
  description: "Broker profiles, account sync, and connection status.",
  toggleable: true,
  modules: [brokerManagerModule],
});

export const marketOverviewPlugin = composeBuiltinPlugin({
  ...marketOverviewPluginMeta,
  description: "Global indices, movers, scanners, sectors, FX, futures, and correlations.",
  modules: [
    correlationModule,
    relativeRotationModule,
    equityScreenerModule,
    worldIndicesModule,
    worldVenueMapModule,
    marketMoversModule,
    scannerModule,
    sectorsModule,
    fxMatrixModule,
    futuresModule,
    futuresCurveModule,
    cotModule,
    doeModule,
    gpuModule,
    attentionModule,
    cryptoBoardModule,
  ],
});

export const macroPlugin = composeBuiltinPlugin({
  ...macroPluginMeta,
  description: "Economic calendar, rates, volatility, credit spreads, single-name, index and sovereign CDS, Treasury auctions, and earnings.",
  modules: [
    macroSharedResourcesModule,
    economicCalendarModule,
    econStatisticsModule,
    cpiModule,
    yieldCurveModule,
    ratePathModule,
    moneyMarketsModule,
    bondCalculatorModule,
    centralBankRatesModule,
    volatilityModule,
    creditConditionsModule,
    marketValuationModule,
    cdsModule,
    creditBoardsModule,
    treasuryAuctionsModule,
    earningsModule,
    earningsCallsModule,
  ],
});
