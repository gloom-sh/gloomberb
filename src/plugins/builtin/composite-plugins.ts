import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../data/fred-series";
import { portfolioAnalyticsModule } from "./analytics";
import { brokerManagerModule } from "./broker-manager";
import { changelogModule } from "./changelog";
import { connectionsModule } from "./connections";
import { pluginMarketplaceModule } from "./plugin-marketplace";
import { correlationModule } from "./correlation";
import { cdsModule } from "./cds";
import { creditConditionsModule } from "./credit-conditions";
import { marketValuationModule } from "./market-valuation";
import { economicCalendarModule } from "./econ";
import { earningsModule } from "./earnings";
import { earningsCallsModule } from "./earnings-calls";
import { ipoCalendarModule } from "./ipo-calendar";
import { fearGreedModule } from "./fear-greed";
import { futuresModule } from "./futures";
import { fxMatrixModule } from "./fx-matrix";
import { helpModule } from "./help";
import { positionSizerModule } from "./kelly-sizer";
import { layoutManagerModule } from "./layout-manager";
import { marketHaltsModule } from "./market-halts";
import { marketHeatmapModule } from "./market-heatmap";
import { marketMoversModule } from "./market-movers";
import { tvModule } from "./tv";
import { volatilityModule } from "./volatility";
import { composeBuiltinPlugin, type PluginModule } from "./plugin-module";
import { portfolioListModule } from "./portfolio-list";
import { scannerModule } from "./scanner";
import { sectorsModule } from "./sectors";
import { treasuryAuctionsModule } from "./treasury-auctions";
import { worldIndicesModule } from "./world-indices";
import { worldVenueMapModule } from "./world-venue-map";
import { yieldCurveModule } from "./yield-curve";
import {
  attachValuationPersistence,
  resetValuationPersistence,
} from "./market-valuation/cache";

const macroSharedResourcesModule = {
  setup(ctx) {
    attachFredSeriesPersistence(ctx.persistence);
    attachValuationPersistence(ctx.persistence);
  },
  dispose() {
    resetFredSeriesPersistence();
    resetValuationPersistence();
  },
} satisfies PluginModule;

export const applicationPlugin = composeBuiltinPlugin({
  id: "application",
  name: "Application",
  version: "1.0.0",
  description: "Core layout, help, and release information.",
  modules: [layoutManagerModule, pluginMarketplaceModule, helpModule, changelogModule, connectionsModule],
});

export const portfolioPlugin = composeBuiltinPlugin({
  id: "portfolio",
  name: "Portfolio",
  version: "1.0.0",
  description: "Portfolio and watchlist management, analytics, and position sizing.",
  toggleable: true,
  modules: [portfolioListModule, portfolioAnalyticsModule, positionSizerModule],
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
  id: "market-overview",
  name: "Market Overview",
  version: "1.0.0",
  description: "Global indices, movers, scanners, sectors, FX, futures, sentiment, and correlations.",
  toggleable: true,
  modules: [
    correlationModule,
    worldIndicesModule,
    worldVenueMapModule,
    marketHeatmapModule,
    marketMoversModule,
    marketHaltsModule,
    scannerModule,
    fearGreedModule,
    sectorsModule,
    fxMatrixModule,
    futuresModule,
  ],
});

export const macroPlugin = composeBuiltinPlugin({
  id: "macro",
  name: "Macro",
  version: "1.0.0",
  description: "Economic calendar, rates, volatility, credit spreads, single-name CDS, Treasury auctions, earnings, IPOs, and live financial TV.",
  toggleable: true,
  modules: [
    macroSharedResourcesModule,
    economicCalendarModule,
    yieldCurveModule,
    volatilityModule,
    creditConditionsModule,
    marketValuationModule,
    cdsModule,
    treasuryAuctionsModule,
    earningsModule,
    earningsCallsModule,
    ipoCalendarModule,
    tvModule,
  ],
});
