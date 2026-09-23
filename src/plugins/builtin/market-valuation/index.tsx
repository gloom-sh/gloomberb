import type { PluginModule } from "../plugin-module";
import { createValuationChartSeriesCapability } from "./chart-series";
import { INDICATORS, resolveIndicatorArg } from "./indicators";
import { marketValuationHeadless } from "./headless";
import { MarketValuationPane } from "./pane";
import { buildValuationSettingsDef, VALUATION_DEFAULTS } from "./settings";

export { marketValuationHeadless } from "./headless";

const MARKET_VALUATION_PANE_ID = "market-valuation";

const BASE_KEYWORDS = [
  "valuation",
  "market cap",
  "gdp",
  "wilshire",
  "macro",
  "bubble",
  "overvalued",
  "undervalued",
  "shiller",
  "tobin",
  "erp",
];

// Whole phrases: keywords double as CLI resolver tokens and catalog aliases,
// so split words would claim generic tokens such as "to", "q" and "/".
const KEYWORDS = [...new Set([
  ...BASE_KEYWORDS,
  ...INDICATORS.flatMap((indicator) => [
    indicator.id,
    indicator.shortLabel.toLowerCase(),
    indicator.label.toLowerCase(),
  ]),
])];

export const marketValuationModule: PluginModule = {
  // Exposes each ratio as a chartable series, so G can overlay them on anything else.
  capabilities: [createValuationChartSeriesCapability()],
  panes: [{
    id: MARKET_VALUATION_PANE_ID,
    name: "Market Valuation",
    icon: "V",
    component: MarketValuationPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 88, height: 34 },
    settings: buildValuationSettingsDef(),
  }],
  paneTemplates: [{
    id: "market-valuation-pane",
    paneId: MARKET_VALUATION_PANE_ID,
    label: "Market Valuation",
    description: "Whole-market valuation ratios against their own history, with zones and trend deviation.",
    keywords: KEYWORDS,
    shortcut: {
      prefix: "VAL",
      argPlaceholder: "indicator",
      argKind: "text",
      argOptional: true,
    },
    headless: marketValuationHeadless,
    // No wizard: VAL opens straight into the pane, where the summary rows swap
    // indicators with the cursor. The argument form stays for deep links.
    canCreate: () => true,
    createInstance: (_context, options) => {
      const indicator = resolveIndicatorArg(options?.arg);
      return {
        settings: { indicator: indicator?.id ?? VALUATION_DEFAULTS.indicator },
      };
    },
  }],
};
