import type { HeadlessPaneDefinition, HeadlessPaneOptionDef } from "../../../types/headless";
import { isSubMinuteInterval, subMinuteDataMessage } from "../../../cli/known-gaps";
import { CHART_BAR_SIZE_PRESETS, parseChartBarSize } from "../../../time-series/resolution";
import { FINANCIAL_PERIOD_OPTION, FINANCIAL_PERIOD_COUNT_OPTION, HISTORY_RANGE_VALUES, RETURN_RANGE_VALUES } from "../shared/headless-options";
import { DATE_OPTION_EXAMPLES } from "../../../utils/calendar-date";

type PaneSchema = Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">;

/**
 * GF opens on quarterly bars, as its catalog entry says and as the template
 * builds them in the app; a default left at annual would override that for
 * every `fn`, `shot` and agent read. Annual is `--period annual`.
 */
const FUNDAMENTAL_PERIOD_OPTION: HeadlessPaneOptionDef = { ...FINANCIAL_PERIOD_OPTION, defaultValue: "quarterly" };

const BAR_SIZES = CHART_BAR_SIZE_PRESETS.map((value) => ({ value }));

const BAR_SIZE_DESCRIPTION = "Bar size: any count of minutes, hours, days, weeks or months; one the source does not serve is built from its shorter bars";

/**
 * A typed bar size as the chart stores it. A listed one matches in any case,
 * so `1M` stays one minute; any other is read by `parseChartBarSize`.
 */
function normalizeBarSize(value: string, auto: boolean): string {
  const listed = (auto ? ["auto"] : []).concat(BAR_SIZES.map((entry) => entry.value)).find((entry) => entry === value.trim().toLowerCase());
  if (listed) return listed;
  const parsed = parseChartBarSize(value);
  if (parsed) return parsed;
  const count = /^\s*(\d+)\s*M\s*$/.exec(value)?.[1];
  throw new Error(count
    ? `Invalid --chart-resolution value "${value}". Write ${count}m for ${count} minutes or ${count}mo for ${count} months.`
    : `Invalid --chart-resolution value "${value}". Use ${auto ? "auto, or " : ""}a count and a unit: 10m, 4h, 2d, 1wk, 3mo (up to a day of minutes or hours, a year of days or weeks, 12 months).`);
}

export const paneSchemas = {
  "chart-composer-pane": {
    argument: { kind: "free-text", optional: true },
    options: [
      {
        key: "rangePreset",
        description: "Chart history window.",
        type: "enum",
        aliases: ["range"],
        values: HISTORY_RANGE_VALUES,
      },
      {
        key: "chartResolution",
        description: BAR_SIZE_DESCRIPTION,
        type: "enum",
        aliases: ["resolution"],
        values: [{ value: "auto" }, ...BAR_SIZES],
        normalize: (value) => normalizeBarSize(value, true),
      },
    ],
    discovery: {
      id: "chart-composer",
      aliases: ["custom chart", "mixed series chart", "chart composer", "economic chart"],
      limitations: ["FRED observations do not include historical vintage availability dates."],
      screenshotReadiness: "ready",
    },
  },
  "graph-price-pane": {
    argument: { kind: "ticker" },
    options: [
      {
        key: "rangePreset",
        settingKey: "chartRangePreset",
        description: "Chart history window.",
        type: "enum",
        aliases: ["range"],
        values: HISTORY_RANGE_VALUES,
        defaultValue: "5Y",
      },
      {
        key: "extendedHours",
        description: "Include pre-market and after-hours bars on an intraday chart of a US listing.",
        type: "boolean",
        defaultValue: false,
      },
    ],
    discovery: {
      id: "price-chart",
      aliases: ["price chart", "stock chart", "historical chart"],
      screenshotReadiness: "ready",
    },
  },
  "graph-intraday-price-pane": {
    argument: { kind: "ticker" },
    options: [
      {
        key: "rangePreset",
        description: "Session window. 1D selects the latest session and 1W selects the latest five sessions.",
        type: "enum",
        aliases: ["range"],
        values: [{ value: "1D", aliases: ["day", "daily"] }, { value: "1W", aliases: ["week", "weekly"] }],
        defaultValue: "1D",
      },
      {
        key: "chartResolution",
        description: "Intraday sampling interval. Auto uses 1m for 1D and 5m for 1W.",
        type: "enum",
        aliases: ["resolution"],
        values: [{ value: "auto" }, { value: "1m" }, { value: "5m" }, { value: "15m" }, { value: "1h" }],
        defaultValue: "auto",
        invalidValueHint: (value, argument) => isSubMinuteInterval(value) ? subMinuteDataMessage(argument ?? undefined) : null,
      },
      {
        key: "session",
        description: `Specific exchange-local session, as ${DATE_OPTION_EXAMPLES}. Overrides the session window.`,
        type: "string",
      },
    ],
    discovery: {
      id: "intraday-price-chart",
      aliases: ["intraday chart", "intraday price", "one day chart"],
      limitations: ["Intraday availability and historical retention depend on the selected market-data provider."],
      screenshotReadiness: "ready",
    },
  },
  "comparison-chart-pane": {
    argument: { kind: "tickers", minimum: 2 },
    options: [
      {
        key: "rangePreset",
        description: "Price-history window. YTD runs from the prior year's last close.",
        type: "enum",
        aliases: ["range"],
        values: RETURN_RANGE_VALUES,
        defaultValue: "1Y",
      },
      {
        key: "axisMode",
        description: "Display raw price or normalized percentage performance.",
        type: "enum",
        values: [
          { value: "percent", aliases: ["return", "returns", "performance"] },
          { value: "price", aliases: ["prices"] },
        ],
        defaultValue: "percent",
      },
      {
        key: "chartResolution",
        description: BAR_SIZE_DESCRIPTION,
        type: "enum",
        aliases: ["resolution"],
        values: BAR_SIZES,
        defaultValue: "1d",
        normalize: (value) => normalizeBarSize(value, false),
      },
    ],
    discovery: {
      id: "price-comparison",
      aliases: ["stock comparison", "price performance comparison", "returns comparison", "compare stock prices"],
      limitations: ["Compares closing-price changes in each listing's currency over shared observation dates. Cash distributions and FX conversion are excluded; these are not reinvested total returns."],
      screenshotReadiness: "ready",
    },
  },
  "fundamental-graph-pane": {
    argument: { kind: "tickers" },
    options: [
      {
        key: "metric",
        description: "Fundamental metric to compare.",
        type: "enum",
        values: [
          { value: "totalRevenue", aliases: ["revenue", "sales"] },
          { value: "grossProfit", aliases: ["gross profit"] },
          { value: "grossMargin", aliases: ["gross margin"] },
          { value: "operatingIncome", aliases: ["operating income", "ebit"] },
          { value: "operatingMargin", aliases: ["operating margin"] },
          { value: "netIncome", aliases: ["net income", "profit", "earnings"] },
          { value: "netMargin", aliases: ["net margin", "profit margin"] },
          { value: "operatingCashFlow", aliases: ["operating cash flow", "cash flow", "ocf"] },
          { value: "freeCashFlow", aliases: ["free cash flow", "fcf"] },
          { value: "freeCashFlowMargin", aliases: ["free cash flow margin", "fcf margin"] },
          { value: "totalAssets", aliases: ["assets", "total assets"] },
          { value: "totalDebt", aliases: ["debt", "total debt"] },
          { value: "totalEquity", aliases: ["equity", "book value"] },
          { value: "eps", aliases: ["earnings per share"] },
        ],
        defaultValue: "totalRevenue",
      },
      FUNDAMENTAL_PERIOD_OPTION,
      FINANCIAL_PERIOD_COUNT_OPTION,
    ],
    discovery: {
      id: "fundamental-series",
      aliases: [
        "fundamental comparison",
        "financial metric comparison",
        "cash flow comparison",
        "revenue comparison",
        "earnings comparison",
        "operating cash flow",
        "free cash flow",
        "fcf",
        "ocf",
      ],
      limitations: ["One metric per invocation; run twice when both operating and free cash flow are requested."],
      screenshotReadiness: "ready",
    },
  },
  "valuation-graph-pane": {
    argument: { kind: "tickers" },
    options: [
      {
        key: "metric",
        description: "Valuation metric to compare.",
        type: "enum",
        values: [
          { value: "trailingPE", aliases: ["pe", "p/e", "trailing pe"] },
          { value: "forwardPE", aliases: ["forward pe", "forward p/e"] },
          { value: "pegRatio", aliases: ["peg", "peg ratio"] },
          { value: "priceSales", aliases: ["price sales", "price to sales", "p/s"] },
          { value: "evSales", aliases: ["ev sales", "ev/sales"] },
          { value: "evEbitda", aliases: ["ev ebitda", "ev/ebitda"] },
          { value: "priceFcf", aliases: ["price fcf", "price to free cash flow", "p/fcf"] },
        ],
        // The same metric the GE template opens with in the app.
        defaultValue: "trailingPE",
      },
      // Annual, as the GE template opens in the app.
      FINANCIAL_PERIOD_OPTION,
      FINANCIAL_PERIOD_COUNT_OPTION,
    ],
    discovery: {
      id: "valuation-series",
      aliases: [
        "valuation comparison",
        "multiple comparison",
        "pe comparison",
        "price to sales comparison",
        "ev ebitda",
      ],
      limitations: ["Historical multiples require usable prices and statement share counts."],
      screenshotReadiness: "ready",
    },
  },
} satisfies Record<string, PaneSchema>;
