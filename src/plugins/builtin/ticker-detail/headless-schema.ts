import type { HeadlessPaneDefinition } from "../../../types/headless";
import { FINANCIAL_PERIOD_OPTION, HISTORY_RANGE_VALUES } from "../shared/headless-options";

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

export const paneSchemas = {
  "financial-analysis-pane": {
    argument: { kind: "ticker" },
    options: [
      FINANCIAL_PERIOD_OPTION,
      {
        key: "statement",
        description: "Statement to display.",
        type: "enum",
        aliases: ["tab", "financialStatement"],
        values: [
          { value: "income", aliases: ["income statement", "is"] },
          { value: "balance", aliases: ["balance sheet", "bs"] },
          { value: "cashflow", aliases: ["cash flow", "cash flow statement", "cf", "cashflows"] },
        ],
        defaultValue: "income",
      },
    ],
    discovery: {
      id: "financial-statements",
      aliases: ["financials", "financial statement", "income statement", "balance sheet", "cash flow statement"],
      limitations: ["One company per invocation; use GF for cross-company metric comparisons."],
      screenshotReadiness: "ready",
    },
  },
  "quote-monitor-pane": {
    argument: { kind: "tickers" },
    options: [],
    discovery: {
      id: "quote-comparison",
      aliases: ["quotes", "stock prices", "market snapshot", "price comparison"],
      screenshotReadiness: "ready",
    },
  },
  "historical-prices-pane": {
    argument: { kind: "ticker" },
    options: [
      {
        key: "range",
        description: "Price-history window.",
        type: "enum",
        aliases: ["rangePreset"],
        values: HISTORY_RANGE_VALUES,
        defaultValue: "ALL",
        pluginState: { pluginId: "ticker-research" },
      },
    ],
    discovery: {
      id: "historical-prices",
      aliases: ["historical prices", "price history", "ohlcv", "daily prices"],
      screenshotReadiness: "partial",
    },
  },
} satisfies Record<string, PaneSchema>;
