import type { HeadlessPaneDefinition } from "../../../types/headless";
import { FINANCIAL_PERIOD_OPTION, HISTORY_RANGE_VALUES } from "../shared/headless-options";
import { historyIntervalsByRange } from "../../../cli/history-rows";
import { HISTORY_DEFAULT_RANGE } from "./data-panes/history-bars";
import { RETURN_INTERVAL_VALUES, RETURN_RANGES } from "./data-panes/returns-model";
import { PRICE_WINDOW_FROM_HELP, PRICE_WINDOW_TO_HELP } from "../../../utils/price-window";
import type { HeadlessPaneOptionDef } from "../../../types/headless";

/** `--from 2007 --to 2009`: the report's bars for those dates. The pane keeps its range, so a capture refuses them. */
const WINDOW_OPTIONS: HeadlessPaneOptionDef[] = [
  { key: "from", type: "string", placeholder: "year|date", description: PRICE_WINDOW_FROM_HELP, example: "--from 2007 --to 2009",
    shot: { reportOnly: "reads the report's bars for those dates" } },
  { key: "to", type: "string", placeholder: "year|date", description: PRICE_WINDOW_TO_HELP,
    shot: { reportOnly: "reads the report's bars for those dates" } },
];

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

export const paneSchemas = {
  "financial-analysis-pane": {
    argument: { kind: "ticker" },
    options: [
      FINANCIAL_PERIOD_OPTION,
      {
        key: "statement",
        description: "Statement or ratio tab to display.",
        type: "enum",
        aliases: ["tab", "financialStatement"],
        values: [
          { value: "income", aliases: ["income statement", "is"] },
          { value: "balance", aliases: ["balance sheet", "bs"] },
          { value: "cashflow", aliases: ["cash flow", "cash flow statement", "cf", "cashflows"] },
          { value: "profitability", aliases: ["ratios", "returns", "profit"] },
          { value: "leverage", aliases: ["coverage", "credit"] },
          { value: "liquidity" },
          { value: "efficiency", aliases: ["working capital"] },
          { value: "valuation", aliases: ["multiples"] },
        ],
        defaultValue: "income",
      },
    ],
    discovery: {
      id: "financial-statements",
      aliases: ["financials", "financial statement", "income statement", "balance sheet", "cash flow statement", "financial ratios"],
      limitations: [
        "One company per invocation; use GF for cross-company metric comparisons.",
        "Excludes bank regulatory capital (CET1, risk-weighted assets) and REIT FFO/AFFO.",
      ],
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
        description: `Price-history window, which also sets the bar size: ${historyIntervalsByRange()}.`,
        type: "enum",
        aliases: ["rangePreset"],
        values: HISTORY_RANGE_VALUES,
        defaultValue: HISTORY_DEFAULT_RANGE,
        pluginState: { pluginId: "ticker-research" },
      },
      ...WINDOW_OPTIONS,
    ],
    discovery: {
      id: "historical-prices",
      aliases: ["historical prices", "price history", "ohlcv", "daily prices", "max drawdown"],
      screenshotReadiness: "partial",
    },
  },
  "returns-pane": {
    argument: { kind: "ticker" },
    options: [
      {
        key: "range",
        description: "Window the returns cover, ending now, or at the last session's close while the market is shut.",
        type: "enum",
        aliases: ["window", "period"],
        values: RETURN_RANGES.map((value) => ({ value })),
        defaultValue: "5D",
        pluginState: { pluginId: "ticker-research" },
      },
      {
        key: "interval",
        description: "Bar size of each return; a range it does not reach uses the nearest longer bar the source keeps.",
        type: "enum",
        aliases: ["bar", "granularity", "resolution"],
        values: RETURN_INTERVAL_VALUES,
        defaultValue: "1h",
        pluginState: { pluginId: "ticker-research" },
      },
      ...WINDOW_OPTIONS,
    ],
    discovery: {
      id: "returns",
      aliases: ["returns", "interval returns", "cumulative return", "performance", "max drawdown"],
      // A capture is read from the rendered table, as before the report existed.
      screenshotReadiness: "live-dom",
    },
  },
} satisfies Record<string, PaneSchema>;
