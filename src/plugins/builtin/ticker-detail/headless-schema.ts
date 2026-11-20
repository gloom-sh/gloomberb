import type { HeadlessPaneDefinition } from "../../../types/headless";
import { FINANCIAL_PERIOD_OPTION, HISTORY_RANGE_VALUES } from "../shared/headless-options";
import { historyIntervalsByRange } from "../../../cli/history-rows";
import { HISTORY_DEFAULT_RANGE } from "./data-panes/history-bars";
import { RETURN_INTERVAL_VALUES, RETURN_RANGES } from "./data-panes/returns-model";
import { PRICE_WINDOW_FROM_HELP, PRICE_WINDOW_TO_HELP } from "../../../utils/price-window";
import type { HeadlessPaneOptionDef, HeadlessPaneOptionValue } from "../../../types/headless";
import { QUOTE_MONITOR_MAX_TICKERS } from "../../../tickers/list";
import { STATEMENT_CURRENCY_OPTION } from "../shared/statement-currency";

/** The most tickers one FA report reads: each is a full statements load. */
const FINANCIAL_REPORT_MAX_TICKERS = 10;

/** `--from 2007 --to 2009`: the report's bars for those dates. The pane keeps its range, so a capture refuses them. */
const WINDOW_OPTIONS: HeadlessPaneOptionDef[] = [
  { key: "from", type: "string", placeholder: "year|date", description: PRICE_WINDOW_FROM_HELP, example: "--from 2007 --to 2009",
    shot: { reportOnly: "reads the report's bars for those dates" }, replaces: ["range"] },
  { key: "to", type: "string", placeholder: "year|date", description: PRICE_WINDOW_TO_HELP,
    shot: { reportOnly: "reads the report's bars for those dates" } },
];

/** The financials tab's statements and ratio tabs, as FA and DES's `--statement` name them. */
export const FINANCIAL_STATEMENT_VALUES: HeadlessPaneOptionValue[] = [
  { value: "income", aliases: ["income statement", "is"] },
  { value: "balance", aliases: ["balance sheet", "bs"] },
  { value: "cashflow", aliases: ["cash flow", "cash flow statement", "cf", "cashflows"] },
  { value: "profitability", aliases: ["ratios", "returns", "profit"] },
  { value: "leverage", aliases: ["coverage", "credit"] },
  { value: "liquidity" },
  { value: "efficiency", aliases: ["working capital"] },
  { value: "valuation", aliases: ["multiples"] },
];

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

export const paneSchemas = {
  "financial-analysis-pane": {
    // A ticker, or several in one long table; the pane, and so `shot`, shows one.
    argument: {
      kind: "tickers", maximum: FINANCIAL_REPORT_MAX_TICKERS, placeholder: "ticker",
      description: `Company ticker, or up to ${FINANCIAL_REPORT_MAX_TICKERS} in one long table (Ticker, Period, Period End, Metric, Value, Unit).`,
      examples: ["V MCO CPRT --statement profitability"],
    },
    options: [
      FINANCIAL_PERIOD_OPTION,
      { ...STATEMENT_CURRENCY_OPTION, shot: { reportOnly: "compares converted statement rows; GF charts converted figures" } },
      {
        key: "statement",
        description: "Statement or ratio tab to display.",
        type: "enum",
        aliases: ["tab", "financialStatement"],
        values: FINANCIAL_STATEMENT_VALUES,
        defaultValue: "income",
      },
      {
        key: "layout",
        description: "wide: one ticker's periods as columns, as the pane shows them. long: a row per ticker, fiscal period and metric, each with its period end and unit, for pasting several companies into one table. Default wide for one ticker, long for several.",
        type: "enum",
        values: [{ value: "wide" }, { value: "long", aliases: ["tidy", "rows"] }],
        example: "--layout long --csv",
        shot: { reportOnly: "lays the report's rows out a row per period and metric" },
      },
    ],
    discovery: {
      id: "financial-statements",
      aliases: ["financials", "financial statement", "income statement", "balance sheet", "cash flow statement", "financial ratios"],
      // What a memo asks for by name: `catalog roic` and `catalog "operating margin"` find FA, and `fn ROIC V` opens
      // the tab with it, as `fn runway VKTX` is the liquidity view, where cash + ST investments, burn and runway are.
      intents: [
        "ROIC (return on invested capital), ROE, ROA and gross, operating and net margins, with NOPAT and invested capital",
        "Capex, capex as a share of revenue, free cash flow and reinvestment rate by fiscal year",
      ],
      opens: [
        { words: ["runway", "cash runway", "burn", "cash burn", "months of cash"], argument: "", options: { statement: "liquidity" } },
        { words: ["roic", "return on invested capital", "nopat", "operating margin", "gross margin", "net margin", "margins"], argument: "",
          options: { statement: "profitability" } },
        { words: ["capex", "capital expenditure", "capital expenditures", "reinvestment rate"], argument: "", options: { statement: "cashflow" } },
      ],
      limitations: [
        "Several companies come as one long table, a row per figure; GF charts one metric across companies over more years.",
        "Excludes bank regulatory capital (CET1, risk-weighted assets) and REIT FFO/AFFO.",
      ],
      screenshotReadiness: "ready",
    },
  },
  "quote-monitor-pane": {
    argument: { kind: "tickers", maximum: QUOTE_MONITOR_MAX_TICKERS },
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
        description: "Bar size of each return; a range it does not reach uses the nearest longer bar the source keeps. Default: hourly to 1W, daily to 1Y, weekly for 5Y, monthly for ALL.",
        type: "enum",
        aliases: ["bar", "granularity", "resolution"],
        values: RETURN_INTERVAL_VALUES,
        pluginState: { pluginId: "ticker-research" },
      },
      {
        key: "view",
        description: "Rendered pane view: the table of returns, or a chart of a bar per interval. The report lists the rows either way.",
        type: "enum",
        values: [{ value: "table" }, { value: "chart", aliases: ["bars"] }],
        defaultValue: "table",
        pluginState: { pluginId: "ticker-research" },
      },
      ...WINDOW_OPTIONS,
    ],
    discovery: {
      id: "returns",
      aliases: ["returns", "interval returns", "cumulative return", "performance", "max drawdown"],
      // A capture is read from the rendered pane, as before the report existed:
      // the table's rows, or the bars the chart view drew.
      screenshotReadiness: "live-dom",
    },
  },
} satisfies Record<string, PaneSchema>;
