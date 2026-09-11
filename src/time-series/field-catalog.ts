import type {
  SeriesStyle,
  SeriesTransform,
  TimeSeriesFieldDefinition,
} from "./types";

const MARKET_TRANSFORMS: SeriesTransform[] = ["raw", "percent", "index100", "yoy", "qoq", "log"];
const FUNDAMENTAL_TRANSFORMS: SeriesTransform[] = ["raw", "percent", "index100", "yoy", "qoq", "log"];
const RATIO_TRANSFORMS: SeriesTransform[] = ["raw", "percent", "index100", "yoy", "qoq"];
const FUNDAMENTAL_PRESENTATION = {
  defaultStyle: "columns",
  defaultInterpolation: "none",
} as const;

function field(
  definition: TimeSeriesFieldDefinition,
): Readonly<TimeSeriesFieldDefinition> {
  return Object.freeze({
    ...definition,
    styles: Object.freeze([...definition.styles]) as unknown as SeriesStyle[],
    transforms: Object.freeze([...definition.transforms]) as unknown as SeriesTransform[],
  });
}

const FIELDS = [
  field({
    id: "market.ohlcv",
    label: "Price (OHLCV)",
    shortLabel: "Price",
    sourceKind: "security",
    dataShape: "ohlcv",
    unit: "currency",
    unitGroup: "price",
    nativeFrequency: "daily",
    styles: ["candles", "ohlc", "hlc", "line", "area"],
    defaultStyle: "candles",
    transforms: MARKET_TRANSFORMS,
    defaultInterpolation: "none",
  }),
  ...(["open", "high", "low", "close"] as const).map((name) => field({
    id: `market.${name}`,
    label: name[0]!.toUpperCase() + name.slice(1),
    shortLabel: name[0]!.toUpperCase() + name.slice(1),
    sourceKind: "security" as const,
    dataShape: "scalar" as const,
    unit: "currency",
    unitGroup: "price",
    nativeFrequency: "daily" as const,
    styles: ["line", "area", "points"] as SeriesStyle[],
    defaultStyle: name === "close" ? "area" as const : "line" as const,
    transforms: MARKET_TRANSFORMS,
    defaultInterpolation: "none" as const,
  })),
  field({
    id: "market.volume",
    label: "Volume",
    shortLabel: "Volume",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "shares",
    unitGroup: "volume",
    nativeFrequency: "daily",
    styles: ["columns", "line", "area"],
    defaultStyle: "columns",
    transforms: ["raw", "percent", "index100", "yoy", "qoq", "log"],
    defaultInterpolation: "none",
  }),
  field({
    id: "fundamental.totalRevenue",
    label: "Revenue",
    shortLabel: "Revenue",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "currency",
    unitGroup: "currency-total",
    nativeFrequency: "quarterly",
    styles: ["step", "columns", "line", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  }),
  field({
    id: "fundamental.grossProfit",
    label: "Gross Profit",
    shortLabel: "Gross Profit",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "currency",
    unitGroup: "currency-total",
    nativeFrequency: "quarterly",
    styles: ["step", "columns", "line", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  }),
  field({
    id: "fundamental.grossMargin",
    label: "Gross Margin",
    shortLabel: "Gross Margin",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "%",
    unitGroup: "percent",
    nativeFrequency: "quarterly",
    styles: ["step", "line", "columns", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: RATIO_TRANSFORMS,
  }),
  field({
    id: "fundamental.operatingIncome",
    label: "Operating Income",
    shortLabel: "Operating Income",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "currency",
    unitGroup: "currency-total",
    nativeFrequency: "quarterly",
    styles: ["step", "columns", "line", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  }),
  field({
    id: "fundamental.operatingMargin",
    label: "Operating Margin",
    shortLabel: "Operating Margin",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "%",
    unitGroup: "percent",
    nativeFrequency: "quarterly",
    styles: ["step", "line", "columns", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: RATIO_TRANSFORMS,
  }),
  field({
    id: "fundamental.netIncome",
    label: "Net Income",
    shortLabel: "Net Income",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "currency",
    unitGroup: "currency-total",
    nativeFrequency: "quarterly",
    styles: ["step", "columns", "line", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  }),
  field({
    id: "fundamental.netMargin",
    label: "Net Margin",
    shortLabel: "Net Margin",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "%",
    unitGroup: "percent",
    nativeFrequency: "quarterly",
    styles: ["step", "line", "columns", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: RATIO_TRANSFORMS,
  }),
  field({
    id: "fundamental.operatingCashFlow",
    label: "Operating Cash Flow",
    shortLabel: "Operating CF",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "currency",
    unitGroup: "currency-total",
    nativeFrequency: "quarterly",
    styles: ["step", "columns", "line", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  }),
  field({
    id: "fundamental.freeCashFlow",
    label: "Free Cash Flow",
    shortLabel: "FCF",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "currency",
    unitGroup: "currency-total",
    nativeFrequency: "quarterly",
    styles: ["step", "columns", "line", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  }),
  field({
    id: "fundamental.freeCashFlowMargin",
    label: "Free Cash Flow Margin",
    shortLabel: "FCF Margin",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "%",
    unitGroup: "percent",
    nativeFrequency: "quarterly",
    styles: ["step", "line", "columns", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: RATIO_TRANSFORMS,
  }),
  ...([
    ["totalAssets", "Total Assets", "Assets"],
    ["totalDebt", "Total Debt", "Debt"],
    ["totalEquity", "Total Equity", "Equity"],
  ] as const).map(([id, label, shortLabel]) => field({
    id: `fundamental.${id}`,
    label,
    shortLabel,
    sourceKind: "security" as const,
    dataShape: "scalar" as const,
    unit: "currency",
    unitGroup: "currency-total",
    nativeFrequency: "quarterly" as const,
    styles: ["step", "columns", "line", "points"] as SeriesStyle[],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  })),
  field({
    id: "fundamental.eps",
    label: "Earnings Per Share",
    shortLabel: "EPS",
    sourceKind: "security",
    dataShape: "scalar",
    unit: "currency/share",
    unitGroup: "per-share",
    nativeFrequency: "quarterly",
    styles: ["step", "columns", "line", "points"],
    ...FUNDAMENTAL_PRESENTATION,
    transforms: FUNDAMENTAL_TRANSFORMS,
  }),
  ...([
    ["trailingPE", "Trailing P/E", "P/E"],
    ["forwardPE", "Forward P/E", "Forward P/E"],
    ["pegRatio", "PEG Ratio", "PEG"],
    ["priceSales", "Price / Sales", "P/S"],
    ["evSales", "EV / Sales", "EV/S"],
    ["evEbitda", "EV / EBITDA", "EV/EBITDA"],
    ["priceFcf", "Price / Free Cash Flow", "P/FCF"],
  ] as const).map(([id, label, shortLabel]) => field({
    id: `valuation.${id}`,
    label,
    shortLabel,
    sourceKind: "security" as const,
    dataShape: "scalar" as const,
    unit: "x",
    unitGroup: "multiple",
    nativeFrequency: "quarterly" as const,
    styles: ["step", "line", "columns", "points"] as SeriesStyle[],
    defaultStyle: "step" as const,
    transforms: RATIO_TRANSFORMS,
    defaultInterpolation: "step-after" as const,
  })),
] satisfies ReadonlyArray<Readonly<TimeSeriesFieldDefinition>>;

const FIELD_BY_ID = new Map(FIELDS.map((definition) => [definition.id, definition]));

const fieldAliases: Record<string, string> = {
  price: "market.ohlcv",
  ohlc: "market.ohlcv",
  ohlcv: "market.ohlcv",
  "market.price": "market.ohlcv",
  "price.ohlcv": "market.ohlcv",
  close: "market.close",
  "price.close": "market.close",
  "market.price.close": "market.close",
  open: "market.open",
  "price.open": "market.open",
  high: "market.high",
  "price.high": "market.high",
  low: "market.low",
  "price.low": "market.low",
  volume: "market.volume",
  revenue: "fundamental.totalRevenue",
  "fundamental.revenue": "fundamental.totalRevenue",
  "income.revenue": "fundamental.totalRevenue",
  pe: "valuation.trailingPE",
  "valuation.pe": "valuation.trailingPE",
};

for (const definition of FIELDS) {
  const suffix = definition.id.split(".").at(-1);
  if (suffix && !fieldAliases[suffix]) {
    fieldAliases[suffix] = definition.id;
  }
}

const FIELD_ALIASES: Readonly<Record<string, string>> = Object.freeze(fieldAliases);

export function canonicalTimeSeriesFieldId(id: string): string {
  const trimmed = id.trim();
  return FIELD_ALIASES[trimmed] ?? trimmed;
}

export function getTimeSeriesField(id: string): TimeSeriesFieldDefinition | undefined {
  return FIELD_BY_ID.get(canonicalTimeSeriesFieldId(id));
}

export function listTimeSeriesFields(): readonly TimeSeriesFieldDefinition[] {
  return FIELDS;
}

export function isMarketFieldId(id: string): boolean {
  return canonicalTimeSeriesFieldId(id).startsWith("market.");
}

export function isPriceOnlyMarketFieldId(id: string): boolean {
  const canonical = canonicalTimeSeriesFieldId(id);
  return canonical === "market.ohlcv"
    || canonical === "market.open"
    || canonical === "market.high"
    || canonical === "market.low"
    || canonical === "market.close"
    || canonical === "market.volume";
}

export function isFundamentalFieldId(id: string): boolean {
  const canonical = canonicalTimeSeriesFieldId(id);
  return canonical.startsWith("fundamental.") || canonical.startsWith("valuation.");
}
