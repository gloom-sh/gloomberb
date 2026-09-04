import { CHART_RESOLUTIONS } from "../../time-series/range";
import type {
  HeadlessPaneArgumentDef,
  HeadlessPaneDefinition,
  HeadlessPaneOptionDef,
  HeadlessPaneOptionType,
  HeadlessPaneOptionValue,
  PaneDef,
  PaneTemplateDef,
} from "../../types/plugin";

export type PaneFunctionReadiness = "ready" | "partial" | "unsupported";
export type PaneFunctionScreenshotReadiness = PaneFunctionReadiness | "live-dom";
export type PaneFunctionTickerCardinality = "none" | "one" | "one-or-more" | "two-or-more" | "one-or-two";
export type PaneFunctionOptionType = HeadlessPaneOptionType;
export type PaneFunctionOptionValue = HeadlessPaneOptionValue;
export type PaneFunctionOptionDef = HeadlessPaneOptionDef;
export type NormalizedPaneFunctionOptions = Record<string, string | number | boolean>;

export interface PaneFunctionCapability {
  id: string;
  botSafe: boolean;
  tickerCardinality: PaneFunctionTickerCardinality;
  aliases: string[];
  intents: string[];
  outputKind: string;
  reportReadiness: PaneFunctionReadiness;
  screenshotReadiness: PaneFunctionScreenshotReadiness;
  dataRequirements: string[];
  limitations: string[];
  options: PaneFunctionOptionDef[];
}

const PERIOD_OPTION: PaneFunctionOptionDef = {
  key: "period",
  description: "Financial reporting period.",
  type: "enum",
  aliases: ["financialPeriod"],
  values: [
    { value: "annual", aliases: ["a", "ann", "year", "yearly", "fy"] },
    { value: "quarterly", aliases: ["q", "qtr", "quarter"] },
  ],
  defaultValue: "annual",
};

const GRAPH_PERIOD_OPTION: PaneFunctionOptionDef = {
  ...PERIOD_OPTION,
};

const GRAPH_PERIOD_COUNT_OPTION: PaneFunctionOptionDef = {
  key: "periods",
  description: "Keep only the latest N annual or quarterly observations per ticker.",
  type: "integer",
  aliases: ["years", "limit"],
  minimum: 1,
  maximum: 40,
};

const RANGE_VALUES: PaneFunctionOptionValue[] = [
  { value: "1D", aliases: ["day", "daily"] },
  { value: "1W", aliases: ["week", "weekly"] },
  { value: "1M", aliases: ["month", "monthly"] },
  { value: "3M" },
  { value: "6M" },
  { value: "1Y", aliases: ["year"] },
  { value: "5Y", aliases: ["five-years", "five years"] },
  { value: "ALL", aliases: ["max", "maximum"] },
];

const FUNDAMENTAL_METRIC_VALUES: PaneFunctionOptionValue[] = [
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
];

const VALUATION_METRIC_VALUES: PaneFunctionOptionValue[] = [
  { value: "trailingPE", aliases: ["pe", "p/e", "trailing pe"] },
  { value: "forwardPE", aliases: ["forward pe", "forward p/e"] },
  { value: "pegRatio", aliases: ["peg", "peg ratio"] },
  { value: "priceSales", aliases: ["price sales", "price to sales", "p/s"] },
  { value: "evSales", aliases: ["ev sales", "ev/sales"] },
  { value: "evEbitda", aliases: ["ev ebitda", "ev/ebitda"] },
  { value: "priceFcf", aliases: ["price fcf", "price to free cash flow", "p/fcf"] },
];

const CAPABILITIES: Record<string, PaneFunctionCapability> = {
  "chart-composer-pane": {
    id: "chart-composer",
    botSafe: true,
    tickerCardinality: "none",
    aliases: ["custom chart", "mixed series chart", "chart composer", "economic chart"],
    intents: ["chart arbitrary market fundamental valuation and economic series together"],
    outputKind: "chart-series",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["data required by each authored chart series"],
    limitations: ["FRED observations do not include historical vintage availability dates."],
    options: [
      {
        key: "rangePreset",
        description: "Chart history window.",
        type: "enum",
        aliases: ["range"],
        values: RANGE_VALUES,
      },
      {
        key: "chartResolution",
        description: "Market-price sampling resolution.",
        type: "enum",
        aliases: ["resolution"],
        values: CHART_RESOLUTIONS.map((value) => ({ value })),
      },
    ],
  },
  "financial-analysis-pane": {
    id: "financial-statements",
    botSafe: true,
    tickerCardinality: "one",
    aliases: ["financials", "financial statement", "income statement", "balance sheet", "cash flow statement"],
    intents: ["inspect company financial statements", "review income balance sheet or cash flow"],
    outputKind: "financial-statement",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["ticker financial statements"],
    limitations: ["One company per invocation; use GF for cross-company metric comparisons."],
    options: [
      PERIOD_OPTION,
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
  },
  "fundamental-graph-pane": {
    id: "fundamental-series",
    botSafe: true,
    tickerCardinality: "one-or-more",
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
    intents: ["compare company fundamentals over time", "compare cash flow revenue earnings margins assets debt or equity"],
    outputKind: "fundamental-series",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["ticker annual or quarterly financial statements"],
    limitations: ["One metric per invocation; run twice when both operating and free cash flow are requested."],
    options: [
      {
        key: "metric",
        description: "Fundamental metric to compare.",
        type: "enum",
        values: FUNDAMENTAL_METRIC_VALUES,
        defaultValue: "totalRevenue",
      },
      GRAPH_PERIOD_OPTION,
      GRAPH_PERIOD_COUNT_OPTION,
    ],
  },
  "valuation-graph-pane": {
    id: "valuation-series",
    botSafe: true,
    tickerCardinality: "one-or-more",
    aliases: ["valuation comparison", "multiple comparison", "pe comparison", "price to sales comparison", "ev ebitda"],
    intents: ["compare company valuation multiples over time"],
    outputKind: "valuation-series",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["ticker financial statements", "price history"],
    limitations: ["Historical multiples require usable prices and statement share counts."],
    options: [
      {
        key: "metric",
        description: "Valuation metric to compare.",
        type: "enum",
        values: VALUATION_METRIC_VALUES,
        defaultValue: "priceSales",
      },
      GRAPH_PERIOD_OPTION,
      GRAPH_PERIOD_COUNT_OPTION,
    ],
  },
  "comparison-chart-pane": {
    id: "price-comparison",
    botSafe: true,
    tickerCardinality: "two-or-more",
    aliases: ["stock comparison", "price performance comparison", "returns comparison", "compare stock prices"],
    intents: ["compare market price performance for multiple securities"],
    outputKind: "price-performance",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["price history"],
    limitations: ["Compares market prices or percentage returns, never company financial statements."],
    options: [
      {
        key: "rangePreset",
        description: "Price-history window.",
        type: "enum",
        aliases: ["range"],
        values: RANGE_VALUES,
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
        description: "Price sampling resolution.",
        type: "enum",
        aliases: ["resolution"],
        values: CHART_RESOLUTIONS.filter((value) => value !== "auto").map((value) => ({ value })),
        defaultValue: "1d",
      },
    ],
  },
  "correlation-pane": {
    id: "return-correlation",
    botSafe: true,
    tickerCardinality: "two-or-more",
    aliases: ["correlation", "return correlation", "correlation matrix", "pearson correlation"],
    intents: ["compare correlations between security returns"],
    outputKind: "correlation-matrix",
    reportReadiness: "ready",
    screenshotReadiness: "partial",
    dataRequirements: ["date-aligned price history"],
    limitations: ["Correlation is computed from daily returns with at least five shared observations."],
    options: [{
      key: "rangePreset",
      description: "Correlation history window.",
      type: "enum",
      aliases: ["range"],
      values: RANGE_VALUES.filter(({ value }) => !["1D", "1W", "ALL"].includes(value)),
      defaultValue: "1Y",
      settingKey: "rangePreset",
    }],
  },
  "relationship-graph-pane": {
    id: "security-relationship",
    botSafe: true,
    tickerCardinality: "one-or-two",
    aliases: ["relationship", "ratio", "beta", "regression", "rolling correlation"],
    intents: ["analyze ratio correlation and regression between two securities"],
    outputKind: "relationship-analysis",
    reportReadiness: "ready",
    screenshotReadiness: "partial",
    dataRequirements: ["date-aligned price history"],
    limitations: ["A single ticker is compared with SPY."],
    options: [
      {
        key: "range",
        description: "Relationship history window.",
        type: "enum",
        aliases: ["rangePreset"],
        values: RANGE_VALUES.filter(({ value }) => !["1D", "1W"].includes(value)),
        defaultValue: "1Y",
        pluginState: { pluginId: "market-overview" },
      },
      {
        key: "correlationWindow",
        description: "Rolling-correlation window in observations.",
        type: "integer",
        aliases: ["window"],
        defaultValue: 120,
        minimum: 5,
        maximum: 1000,
        pluginState: { pluginId: "market-overview" },
      },
    ],
  },
  "relative-valuation-pane": {
    id: "relative-valuation",
    botSafe: true,
    tickerCardinality: "one-or-more",
    aliases: ["relative valuation", "peer valuation", "valuation comps", "compare multiples"],
    intents: ["compare current valuation and operating metrics across peers"],
    outputKind: "relative-valuation",
    reportReadiness: "ready",
    screenshotReadiness: "partial",
    dataRequirements: ["ticker quote and fundamentals"],
    limitations: ["Uses current provider fundamentals rather than a historical series."],
    options: [],
  },
  "quote-monitor-pane": {
    id: "quote-comparison",
    botSafe: true,
    tickerCardinality: "one-or-more",
    aliases: ["quotes", "stock prices", "market snapshot", "price comparison"],
    intents: ["compare current quotes for one or more securities"],
    outputKind: "quote-comparison",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["current quotes"],
    limitations: [],
    options: [],
  },
  "historical-prices-pane": {
    id: "historical-prices",
    botSafe: true,
    tickerCardinality: "one",
    aliases: ["historical prices", "price history", "ohlcv", "daily prices"],
    intents: ["inspect historical open high low close and volume"],
    outputKind: "price-history",
    reportReadiness: "ready",
    screenshotReadiness: "partial",
    dataRequirements: ["price history"],
    limitations: [],
    options: [{
      key: "range",
      description: "Price-history window.",
      type: "enum",
      aliases: ["rangePreset"],
      values: RANGE_VALUES,
      defaultValue: "ALL",
      pluginState: { pluginId: "ticker-research" },
    }],
  },
  "graph-price-pane": {
    id: "price-chart",
    botSafe: true,
    tickerCardinality: "one",
    aliases: ["price chart", "stock chart", "historical chart"],
    intents: ["chart a security price over time"],
    outputKind: "price-history",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["price history"],
    limitations: [],
    options: [{
      key: "rangePreset",
      settingKey: "chartRangePreset",
      description: "Chart history window.",
      type: "enum",
      aliases: ["range"],
      values: RANGE_VALUES,
      defaultValue: "5Y",
    }],
  },
  "graph-intraday-price-pane": {
    id: "intraday-price-chart",
    botSafe: true,
    tickerCardinality: "one",
    aliases: ["intraday chart", "intraday price", "one day chart"],
    intents: ["chart intraday security prices"],
    outputKind: "price-history",
    reportReadiness: "ready",
    screenshotReadiness: "ready",
    dataRequirements: ["intraday price history"],
    limitations: ["Intraday availability and historical retention depend on the selected market-data provider."],
    options: [
      {
        key: "rangePreset",
        description: "Session window. 1D selects the latest session and 1W selects the latest five sessions.",
        type: "enum",
        aliases: ["range"],
        values: RANGE_VALUES.filter(({ value }) => value === "1D" || value === "1W"),
        defaultValue: "1D",
      },
      {
        key: "chartResolution",
        description: "Intraday sampling interval. Auto uses 1m for 1D and 5m for 1W.",
        type: "enum",
        aliases: ["resolution"],
        values: ["auto", "5m", "15m", "1h"].map((value) => ({ value })),
        defaultValue: "auto",
      },
      {
        key: "session",
        description: "Specific exchange-local session in YYYY-MM-DD form. Overrides the session window.",
        type: "string",
      },
    ],
  },
};

const UNSUPPORTED_CAPABILITY: PaneFunctionCapability = {
  id: "unverified-pane",
  botSafe: false,
  tickerCardinality: "none",
  aliases: [],
  intents: [],
  outputKind: "pane",
  reportReadiness: "unsupported",
  screenshotReadiness: "live-dom",
  dataRequirements: [],
  limitations: [
    "Reports are not verified for automation. Screenshots render live and derive evidence from visible DOM rows.",
  ],
  options: [],
};

function optionToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.-]+/g, "");
}

function headlessTickerCardinality(argument: HeadlessPaneArgumentDef): PaneFunctionTickerCardinality {
  switch (argument.kind) {
    case "ticker":
      return "one";
    case "tickers":
    case "symbol-list":
      return (argument.minimum ?? 1) >= 2 ? "two-or-more" : "one-or-more";
    case "none":
    case "free-text":
      return "none";
    default: {
      const _exhaustive: never = argument.kind;
      return _exhaustive;
    }
  }
}

export function getHeadlessPaneDefinition(
  template: PaneTemplateDef | undefined,
  pane: PaneDef,
): HeadlessPaneDefinition | undefined {
  return template?.headless ?? pane.headless;
}

export function getPaneFunctionCapability(
  template: PaneTemplateDef | undefined,
  pane: PaneDef,
): PaneFunctionCapability {
  const existing = template ? CAPABILITIES[template.id] ?? UNSUPPORTED_CAPABILITY : UNSUPPORTED_CAPABILITY;
  const headless = getHeadlessPaneDefinition(template, pane);
  if (!headless) return existing;

  const hasExistingCapability = existing !== UNSUPPORTED_CAPABILITY;
  return {
    ...(hasExistingCapability ? existing : UNSUPPORTED_CAPABILITY),
    id: hasExistingCapability ? existing.id : template?.id ?? pane.id,
    botSafe: true,
    tickerCardinality: headlessTickerCardinality(headless.argument),
    outputKind: headless.shape,
    reportReadiness: "ready",
    options: [...headless.options],
    ...(hasExistingCapability ? {} : { limitations: [] }),
  };
}

function resolveOptionDef(
  capability: PaneFunctionCapability,
  rawKey: string,
): PaneFunctionOptionDef | undefined {
  const token = optionToken(rawKey);
  return capability.options.find((option) => (
    optionToken(option.key) === token
    || option.aliases?.some((alias) => optionToken(alias) === token)
  ));
}

function normalizeEnumValue(option: PaneFunctionOptionDef, rawValue: string): string {
  const token = optionToken(rawValue);
  const match = option.values?.find((candidate) => (
    optionToken(candidate.value) === token
    || candidate.aliases?.some((alias) => optionToken(alias) === token)
  ));
  if (match) return match.value;
  throw new Error(
    `Invalid --${option.key} value "${rawValue}". Use one of: ${option.values?.map(({ value }) => value).join(", ") ?? ""}.`,
  );
}

function normalizeOptionValue(option: PaneFunctionOptionDef, rawValue: string | true): string | number | boolean {
  if (option.type === "boolean") {
    if (rawValue === true) return true;
    if (/^true$/i.test(rawValue)) return true;
    if (/^false$/i.test(rawValue)) return false;
    throw new Error(`Invalid --${option.key} value "${rawValue}". Use true or false.`);
  }
  if (rawValue === true) throw new Error(`--${option.key} requires a value.`);
  if (option.type === "enum") return normalizeEnumValue(option, rawValue);
  if (option.type === "integer") {
    const value = Number(rawValue);
    if (!Number.isInteger(value)) throw new Error(`--${option.key} must be an integer.`);
    if (option.minimum != null && value < option.minimum) {
      throw new Error(`--${option.key} must be at least ${option.minimum}.`);
    }
    if (option.maximum != null && value > option.maximum) {
      throw new Error(`--${option.key} must be at most ${option.maximum}.`);
    }
    return value;
  }
  return rawValue;
}

export function normalizeCapabilityOptions(
  capability: PaneFunctionCapability,
  options: Record<string, string | true>,
  settings: { strict?: boolean } = {},
): NormalizedPaneFunctionOptions {
  if (!capability.botSafe) {
    return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, value]));
  }

  const normalized: Record<string, string | number | boolean> = {};
  for (const option of capability.options) {
    if (option.defaultValue !== undefined) normalized[option.key] = option.defaultValue;
  }
  for (const [rawKey, rawValue] of Object.entries(options)) {
    const option = resolveOptionDef(capability, rawKey);
    if (!option) {
      if (settings.strict === false) {
        normalized[rawKey] = rawValue;
        continue;
      }
      const supported = capability.options.map(({ key }) => `--${key}`).join(", ");
      throw new Error(
        `${capability.id} does not support --${rawKey}.${supported ? ` Supported options: ${supported}.` : " It has no options."}`,
      );
    }
    normalized[option.key] = normalizeOptionValue(option, rawValue);
  }
  return normalized;
}

export function capabilityPaneSettings(
  capability: PaneFunctionCapability,
  options: NormalizedPaneFunctionOptions,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const option of capability.options) {
    if (option.pluginState) continue;
    const value = options[option.key];
    if (value !== undefined) settings[option.settingKey ?? option.key] = value;
  }
  return settings;
}

export function capabilityPluginState(
  capability: PaneFunctionCapability,
  options: NormalizedPaneFunctionOptions,
): Record<string, Record<string, unknown>> {
  const pluginState: Record<string, Record<string, unknown>> = {};
  for (const option of capability.options) {
    if (!option.pluginState) continue;
    const value = options[option.key];
    if (value === undefined) continue;
    const plugin = pluginState[option.pluginState.pluginId] ?? {};
    plugin[option.pluginState.key ?? option.key] = value;
    pluginState[option.pluginState.pluginId] = plugin;
  }
  return pluginState;
}

export function capabilityOptionSummary(capability: PaneFunctionCapability): string[] {
  return capability.options.map((option) => {
    const values = option.values?.map(({ value }) => value).join("|");
    const defaultValue = option.defaultValue !== undefined ? ` default=${String(option.defaultValue)}` : "";
    return `--${option.key}${values ? ` <${values}>` : ` <${option.type}>`}${defaultValue}`;
  });
}
