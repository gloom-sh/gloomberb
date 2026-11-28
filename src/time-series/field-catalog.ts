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

const FUNDAMENTAL_STYLES: SeriesStyle[] = ["step", "columns", "line", "points"];
const RATIO_STYLES: SeriesStyle[] = ["step", "line", "columns", "points"];

function field(
  definition: TimeSeriesFieldDefinition,
): Readonly<TimeSeriesFieldDefinition> {
  return Object.freeze({
    ...definition,
    styles: Object.freeze([...definition.styles]) as unknown as SeriesStyle[],
    transforms: Object.freeze([...definition.transforms]) as unknown as SeriesTransform[],
  });
}

function fundamentalField(
  id: string,
  label: string,
  shortLabel = label,
  kind: "currency" | "percent" | "per-share" = "currency",
): Readonly<TimeSeriesFieldDefinition> {
  return field({
    id: `fundamental.${id}`,
    label,
    shortLabel,
    sourceKind: "security",
    dataShape: "scalar",
    unit: kind === "percent" ? "%" : kind === "per-share" ? "currency/share" : "currency",
    unitGroup: kind === "percent" ? "percent" : kind === "per-share" ? "per-share" : "currency-total",
    nativeFrequency: "quarterly",
    styles: kind === "percent" ? RATIO_STYLES : FUNDAMENTAL_STYLES,
    ...FUNDAMENTAL_PRESENTATION,
    transforms: kind === "percent" ? RATIO_TRANSFORMS : FUNDAMENTAL_TRANSFORMS,
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
    styles: ["candles", "hollow", "heikin-ashi", "ohlc", "hlc", "line", "area"],
    defaultStyle: "candles",
    transforms: MARKET_TRANSFORMS,
    defaultInterpolation: "none",
  }),
  ...(["open", "high", "low", "close"] as const).map((name) => {
    const label = name[0]!.toUpperCase() + name.slice(1);
    return field({
      id: `market.${name}`,
      label,
      shortLabel: label,
      sourceKind: "security",
      dataShape: "scalar",
      unit: "currency",
      unitGroup: "price",
      nativeFrequency: "daily",
      styles: ["line", "area", "points"],
      defaultStyle: name === "close" ? "area" : "line",
      transforms: MARKET_TRANSFORMS,
      defaultInterpolation: "none",
    });
  }),
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
    transforms: MARKET_TRANSFORMS,
    defaultInterpolation: "none",
  }),
  // EBITDA is operating income plus D&A (utils/ebitda.ts); both lines chart so a trailing EBITDA can be rebuilt.
  ...([
    ["totalRevenue", "Revenue"],
    ["grossProfit", "Gross Profit"],
    ["grossMargin", "Gross Margin", "Gross Margin", "percent"],
    ["operatingIncome", "Operating Income"],
    ["operatingMargin", "Operating Margin", "Operating Margin", "percent"],
    ["netIncome", "Net Income"],
    ["netMargin", "Net Margin", "Net Margin", "percent"],
    ["ebitda", "EBITDA"],
    ["depreciationAndAmortization", "Depreciation & Amortization", "D&A"],
    ["operatingCashFlow", "Operating Cash Flow", "Operating CF"],
    ["freeCashFlow", "Free Cash Flow", "FCF"],
    ["freeCashFlowMargin", "Free Cash Flow Margin", "FCF Margin", "percent"],
    ["totalAssets", "Total Assets", "Assets"],
    ["totalDebt", "Total Debt", "Debt"],
    ["totalEquity", "Total Equity", "Equity"],
    ["eps", "Earnings Per Share", "EPS", "per-share"],
  ] as const).map(([id, label, shortLabel, kind]) => fundamentalField(id, label, shortLabel, kind)),
  ...([
    ["trailingPE", "Trailing P/E", "P/E"],
    ["forwardPE", "Forward P/E", "Forward P/E"],
    ["realizedNtmPE", "Realized NTM P/E", "Realized P/E"],
    ["pegRatio", "PEG Ratio", "PEG"],
    ["priceSales", "Price / Sales", "P/S"],
    ["evSales", "EV / Sales", "EV/S"],
    ["evEbitda", "EV / EBITDA", "EV/EBITDA"],
    ["priceFcf", "Price / Free Cash Flow", "P/FCF"],
  ] as const).map(([id, label, shortLabel]) => field({
    id: `valuation.${id}`,
    label,
    shortLabel,
    sourceKind: "security",
    dataShape: "scalar",
    unit: "x",
    unitGroup: "multiple",
    nativeFrequency: "quarterly",
    styles: RATIO_STYLES,
    defaultStyle: "step",
    transforms: RATIO_TRANSFORMS,
    defaultInterpolation: "step-after",
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
