import type { PluginModule } from "../plugin-module";
import { INDICATORS, resolveIndicatorArg } from "./indicators";
import { MarketValuationPane } from "./pane";
import { buildValuationSettingsDef, indicatorOptions, VALUATION_DEFAULTS } from "./settings";

const MARKET_VALUATION_PANE_ID = "market-valuation";

const INDICATOR_KEYWORDS = INDICATORS.flatMap((indicator) => [
  indicator.id,
  ...indicator.shortLabel.toLowerCase().split(" "),
  ...indicator.label.toLowerCase().split(" "),
]);

export const marketValuationModule: PluginModule = {
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
    keywords: [
      "valuation",
      "market cap",
      "gdp",
      "wilshire",
      "macro",
      "bubble",
      "overvalued",
      "undervalued",
      ...INDICATOR_KEYWORDS,
    ],
    shortcut: {
      prefix: "VAL",
      argPlaceholder: "indicator",
      argKind: "text",
      argOptional: true,
    },
    wizard: [{
      key: "indicator",
      label: "Indicator",
      type: "select",
      defaultValue: VALUATION_DEFAULTS.indicator,
      options: indicatorOptions(),
    }],
    canCreate: () => true,
    createInstance: (_context, options) => {
      const indicator = resolveIndicatorArg(options?.arg ?? options?.values?.indicator);
      return {
        settings: { indicator: indicator?.id ?? VALUATION_DEFAULTS.indicator },
      };
    },
  }],
};
