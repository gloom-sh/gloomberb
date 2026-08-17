import { portfolioAnalyticsModule } from "./analytics";
import { brokerManagerModule } from "./broker-manager";
import { changelogModule } from "./changelog";
import { correlationModule } from "./correlation";
import { economicCalendarModule } from "./econ";
import { earningsModule } from "./earnings";
import { fearGreedModule } from "./fear-greed";
import { fxMatrixModule } from "./fx-matrix";
import { helpModule } from "./help";
import { positionSizerModule } from "./kelly-sizer";
import { layoutManagerModule } from "./layout-manager";
import { marketHeatmapModule } from "./market-heatmap";
import { marketMoversModule } from "./market-movers";
import { tvModule } from "./tv";
import { composeBuiltinPlugin } from "./plugin-module";
import { portfolioListModule } from "./portfolio-list";
import { scannerModule } from "./scanner";
import { sectorsModule } from "./sectors";
import { worldIndicesModule } from "./world-indices";
import { yieldCurveModule } from "./yield-curve";

export const applicationPlugin = composeBuiltinPlugin({
  id: "application",
  name: "Application",
  version: "1.0.0",
  description: "Core layout, help, and release information.",
  modules: [layoutManagerModule, helpModule, changelogModule],
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
  description: "Global indices, movers, scanners, sectors, FX, sentiment, and correlations.",
  toggleable: true,
  modules: [
    correlationModule,
    worldIndicesModule,
    marketHeatmapModule,
    marketMoversModule,
    scannerModule,
    fearGreedModule,
    sectorsModule,
    fxMatrixModule,
  ],
});

export const macroPlugin = composeBuiltinPlugin({
  id: "macro",
  name: "Macro",
  version: "1.0.0",
  description: "Economic calendar, yield curve, earnings calendar, and live financial TV.",
  toggleable: true,
  modules: [economicCalendarModule, yieldCurveModule, earningsModule, tvModule],
});
