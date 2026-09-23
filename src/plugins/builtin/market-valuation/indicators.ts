import { formatNumber } from "../../../utils/format";
import type { IndicatorDef, SeriesDef, ShillerField } from "./defs";

const DAY_MS = 24 * 60 * 60 * 1000;
const MILLIONS_TO_BILLIONS = 0.001;

/** Z.1 lands ~10 weeks after quarter end, then holds until the next quarter's release. */
const QUARTERLY_STALE_MS = 270 * DAY_MS;
/** Shiller republishes monthly; two missed months means something is wrong. */
const MONTHLY_STALE_MS = 75 * DAY_MS;
/** Shiller's dividend column trails his price column by about a quarter, on top of that cadence. */
const SHILLER_DIVIDEND_STALE_MS = MONTHLY_STALE_MS + 90 * DAY_MS;

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

function percentTenths(value: number): string {
  return `${formatNumber(value, 1)}%`;
}

function ratio(value: number): string {
  return formatNumber(value, 2);
}

/**
 * Dollar market value of US corporate equities from the Z.1 financial accounts:
 * nonfinancial corporate business plus domestic financial sectors, both quarterly
 * end-of-period liabilities in USD millions. FRED removed the Wilshire series in
 * 2024 and an index level is not a capitalization, so this is the numerator for
 * every market-cap ratio (see valuation-reference.md).
 */
const US_CORPORATE_EQUITIES: SeriesDef = {
  key: "Z1_CORPORATE_EQUITIES",
  scaleToBillions: MILLIONS_TO_BILLIONS,
  source: { kind: "fred-sum", seriesIds: ["NCBEILQ027S", "FBCELLQ027S"], limit: 400 },
};

const NOMINAL_GDP: SeriesDef = {
  key: "GDP",
  scaleToBillions: 1,
  source: { kind: "fred", seriesId: "GDP", limit: 340 },
};

const M2: SeriesDef = {
  key: "M2SL",
  scaleToBillions: 1,
  source: { kind: "fred", seriesId: "M2SL", limit: 900 },
};

function shillerSeries(key: string, field: ShillerField): SeriesDef {
  return { key, scaleToBillions: 1, source: { kind: "shiller", field } };
}

export const BUFFETT_INDICATOR: IndicatorDef = {
  id: "buffett",
  label: "Buffett Indicator",
  shortLabel: "Buffett",
  description: "Z.1 corporate equities / nominal GDP (annual rate), %; quarterly.",
  input: {
    kind: "ratio",
    numerator: US_CORPORATE_EQUITIES,
    denominator: NOMINAL_GDP,
    levels: { numeratorLabel: "Mkt cap", denominatorLabel: "GDP" },
  },
  ratioScale: 100,
  formatValue: percent,
  axisUnit: "%",
  // The Z.1 universe runs well above an index-based reading (it values closely
  // held equity too), so the bands sit on its own 1947-2026 distribution:
  // p25 59%, median 85%, p75 139%, p90 194%.
  zones: [
    { max: 60, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 75, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 110, id: "fair", label: "Fair Valued" },
    { max: 140, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 350, edges: [0, 60, 75, 110, 140, 350], ticks: [0, 60, 100, 140, 350] },
  reference: { value: 100, label: "parity" },
  chartGridStep: 150,
  trendModel: "log",
  staleAfterMs: QUARTERLY_STALE_MS,
  link: {
    url: "https://en.wikipedia.org/wiki/Buffett_indicator",
    label: "Buffett indicator, Wikipedia",
  },
};

export const TOBINS_Q: IndicatorDef = {
  id: "tobins-q",
  label: "Tobin's Q",
  shortLabel: "Tobin Q",
  description: "Nonfinancial corporate equities / net worth; quarterly Z.1.",
  input: {
    kind: "ratio",
    numerator: {
      key: "NCBEILQ027S",
      scaleToBillions: MILLIONS_TO_BILLIONS,
      source: { kind: "fred", seriesId: "NCBEILQ027S", limit: 400 },
    },
    denominator: {
      key: "TNWMVBSNNCB",
      scaleToBillions: MILLIONS_TO_BILLIONS,
      source: { kind: "fred", seriesId: "TNWMVBSNNCB", limit: 400 },
    },
    levels: { numeratorLabel: "Equities", denominatorLabel: "Net worth" },
  },
  ratioScale: 1,
  formatValue: ratio,
  axisUnit: "",
  // Bands anchored on the 1945-2026 distribution: p25 0.54, median 0.93, p75 1.34.
  zones: [
    { max: 0.55, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 0.8, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 1.1, id: "fair", label: "Fair Valued" },
    { max: 1.4, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 2, edges: [0, 0.55, 0.8, 1.1, 1.4, 2], ticks: [0, 0.55, 1, 1.4, 2] },
  reference: { value: 1, label: "equities = net worth" },
  chartGridStep: 0.5,
  trendModel: "log",
  staleAfterMs: QUARTERLY_STALE_MS,
  link: { url: "https://en.wikipedia.org/wiki/Tobin%27s_q", label: "Tobin's q, Wikipedia" },
};

export const SHILLER_CAPE: IndicatorDef = {
  id: "shiller-cape",
  label: "Shiller CAPE",
  shortLabel: "CAPE",
  description: "Price / ten-year mean real earnings; Shiller monthly CAPE.",
  input: { kind: "direct", series: shillerSeries("SHILLER_CAPE", "cape") },
  ratioScale: 1,
  formatValue: (value) => formatNumber(value, 1),
  axisUnit: "",
  // Bands anchored on the 1881-2026 distribution: p25 12.0, median 16.6, p75 21.5.
  zones: [
    { max: 12, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 15, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 22, id: "fair", label: "Fair Valued" },
    { max: 30, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 45, edges: [0, 12, 15, 22, 30, 45], ticks: [0, 12, 22, 30, 45] },
  reference: { value: 16.6, label: "median" },
  chartGridStep: 10,
  trendModel: "log",
  staleAfterMs: MONTHLY_STALE_MS,
  link: {
    url: "https://en.wikipedia.org/wiki/Cyclically_adjusted_price-to-earnings_ratio",
    label: "CAPE ratio, Wikipedia",
  },
};

export const EXCESS_CAPE_YIELD: IndicatorDef = {
  id: "excess-cape-yield",
  label: "Excess CAPE Yield",
  shortLabel: "ERP (ECY)",
  description: "1/CAPE − real 10Y Treasury yield; Shiller monthly (%).",
  input: { kind: "direct", series: shillerSeries("SHILLER_ECY", "excessCapeYield") },
  // Shiller publishes it as a decimal fraction; show it as a percent.
  ratioScale: 100,
  formatValue: percentTenths,
  axisUnit: "%",
  // A high excess yield means stocks are paid well over bonds, so the bands run the
  // opposite way to a price ratio. Anchored on p25 1.5%, median 3.3%, p75 6.6%.
  zones: [
    { max: 1.5, id: "significantly-overvalued", label: "Significantly Overvalued" },
    { max: 2.5, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: 4.5, id: "fair", label: "Fair Valued" },
    { max: 6.5, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: null, id: "significantly-undervalued", label: "Significantly Undervalued" },
  ],
  zoneScale: { min: -3, max: 12, edges: [-3, 1.5, 2.5, 4.5, 6.5, 12], ticks: [-3, 1.5, 4.5, 6.5, 12] },
  reference: { value: 0, label: "no premium" },
  chartGridStep: 5,
  // The spread has been negative, so a log fit would silently drop those years.
  trendModel: "linear",
  staleAfterMs: MONTHLY_STALE_MS,
  link: {
    url: "https://en.wikipedia.org/wiki/Equity_premium_puzzle",
    label: "Equity risk premium, Wikipedia",
  },
};

export const SP500_DIVIDEND_YIELD: IndicatorDef = {
  id: "sp500-dividend-yield",
  label: "S&P 500 Dividend Yield",
  shortLabel: "Div yield",
  description: "Annual dividends / price; Shiller monthly series (%).",
  input: {
    kind: "ratio",
    numerator: shillerSeries("SHILLER_DIVIDEND", "dividend"),
    denominator: shillerSeries("SHILLER_PRICE", "price"),
  },
  ratioScale: 100,
  formatValue: percentTenths,
  axisUnit: "%",
  // Higher yield is cheaper, so the bands invert. Anchored on p25 3.0%, median 4.2%.
  zones: [
    { max: 2, id: "significantly-overvalued", label: "Significantly Overvalued" },
    { max: 3, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: 5, id: "fair", label: "Fair Valued" },
    { max: 6.5, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: null, id: "significantly-undervalued", label: "Significantly Undervalued" },
  ],
  zoneScale: { min: 0, max: 10, edges: [0, 2, 3, 5, 6.5, 10], ticks: [0, 2, 5, 6.5, 10] },
  reference: { value: 4.2, label: "median" },
  chartGridStep: 4,
  trendModel: "log",
  staleAfterMs: SHILLER_DIVIDEND_STALE_MS,
  link: { url: "https://en.wikipedia.org/wiki/Dividend_yield", label: "Dividend yield, Wikipedia" },
};

export const HOUSEHOLD_EQUITY_ALLOCATION: IndicatorDef = {
  id: "household-equity-allocation",
  label: "Investor Equity Allocation",
  shortLabel: "Equity alloc",
  description: "Household and nonprofit direct/indirect equities / financial assets, %.",
  input: {
    kind: "direct",
    series: {
      key: "BOGZ1FL153064486Q",
      scaleToBillions: 1,
      source: { kind: "fred", seriesId: "BOGZ1FL153064486Q", limit: 400 },
    },
  },
  // FRED publishes it as a percentage already, so it needs no rescaling.
  ratioScale: 1,
  formatValue: percentTenths,
  axisUnit: "%",
  // Bands anchored on the 1945-2026 distribution: p25 17.7%, median 24.3%, p75 30.0%.
  zones: [
    { max: 18, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 22, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 28, id: "fair", label: "Fair Valued" },
    { max: 34, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 50, edges: [0, 18, 22, 28, 34, 50], ticks: [0, 18, 28, 34, 50] },
  reference: { value: 24.3, label: "median" },
  chartGridStep: 10,
  trendModel: "log",
  staleAfterMs: QUARTERLY_STALE_MS,
  link: {
    url: "https://fred.stlouisfed.org/series/BOGZ1FL153064486Q",
    label: "Household equity share, FRED",
  },
};

export const MARKET_CAP_TO_M2: IndicatorDef = {
  id: "market-cap-m2",
  label: "Market Cap to M2",
  shortLabel: "Cap / M2",
  description: "Z.1 corporate equities / M2 money stock, %; quarterly.",
  input: {
    kind: "ratio",
    numerator: US_CORPORATE_EQUITIES,
    denominator: M2,
    levels: { numeratorLabel: "Mkt cap", denominatorLabel: "M2" },
  },
  ratioScale: 100,
  formatValue: percent,
  axisUnit: "%",
  // Bands anchored on the Z.1 numerator's 1989-2026 distribution: p25 205%,
  // median 255%, p75 293%. Earlier decades sit far lower and would put the
  // whole modern era in one band.
  zones: [
    { max: 200, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 230, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 270, id: "fair", label: "Fair Valued" },
    { max: 300, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 500, edges: [0, 200, 230, 270, 300, 500], ticks: [0, 200, 255, 300, 500] },
  reference: { value: 255, label: "median" },
  chartGridStep: 100,
  trendModel: "log",
  staleAfterMs: QUARTERLY_STALE_MS,
  link: { url: "https://fred.stlouisfed.org/series/M2SL", label: "M2 money stock, FRED" },
};

export const MARGIN_DEBT_TO_GDP: IndicatorDef = {
  id: "margin-debt-gdp",
  label: "Margin Debt to GDP",
  shortLabel: "Margin debt",
  description: "Margin loans and other customer receivables / nominal GDP (annual rate), %.",
  input: {
    kind: "ratio",
    numerator: {
      key: "BOGZ1FL663067003Q",
      scaleToBillions: MILLIONS_TO_BILLIONS,
      source: { kind: "fred", seriesId: "BOGZ1FL663067003Q", limit: 400 },
    },
    denominator: NOMINAL_GDP,
    levels: { numeratorLabel: "Margin debt", denominatorLabel: "GDP" },
  },
  ratioScale: 100,
  formatValue: percentTenths,
  axisUnit: "%",
  // Bands anchored on the 1945-2026 distribution: p25 0.71%, median 0.92%, p75 1.40%.
  zones: [
    { max: 0.7, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 0.9, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 1.4, id: "fair", label: "Fair Valued" },
    { max: 1.8, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 3, edges: [0, 0.7, 0.9, 1.4, 1.8, 3], ticks: [0, 0.9, 1.4, 1.8, 3] },
  reference: { value: 0.92, label: "median" },
  chartGridStep: 1,
  trendModel: "log",
  staleAfterMs: QUARTERLY_STALE_MS,
  link: {
    url: "https://fred.stlouisfed.org/series/BOGZ1FL663067003Q",
    label: "Margin account receivables, FRED",
  },
};

export const MARKET_CAP_TO_PROFITS: IndicatorDef = {
  id: "market-cap-profits",
  label: "Market Cap to Corporate Profits",
  shortLabel: "Cap / profits",
  description: "Z.1 corporate equities / corporate profits (IVA/CCAdj, annual rate); quarterly.",
  input: {
    kind: "ratio",
    numerator: US_CORPORATE_EQUITIES,
    denominator: {
      key: "CPROFIT",
      scaleToBillions: 1,
      source: { kind: "fred", seriesId: "CPROFIT", limit: 400 },
    },
    levels: { numeratorLabel: "Mkt cap", denominatorLabel: "Profits" },
  },
  ratioScale: 1,
  formatValue: (value) => formatNumber(value, 1),
  axisUnit: "",
  // Bands anchored on the Z.1 numerator's 1989-2026 distribution: p25 10.6,
  // median 13.1, p75 17.0.
  zones: [
    { max: 10.5, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 12, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 15, id: "fair", label: "Fair Valued" },
    { max: 17, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 25, edges: [0, 10.5, 12, 15, 17, 25], ticks: [0, 12, 15, 17, 25] },
  reference: { value: 13.1, label: "median" },
  chartGridStep: 5,
  trendModel: "log",
  staleAfterMs: QUARTERLY_STALE_MS,
  link: {
    url: "https://fred.stlouisfed.org/series/CPROFIT",
    label: "Corporate profits (IVA/CCAdj), FRED",
  },
};

export const INDICATORS: readonly IndicatorDef[] = [
  BUFFETT_INDICATOR,
  SHILLER_CAPE,
  EXCESS_CAPE_YIELD,
  TOBINS_Q,
  HOUSEHOLD_EQUITY_ALLOCATION,
  SP500_DIVIDEND_YIELD,
  MARGIN_DEBT_TO_GDP,
  MARKET_CAP_TO_PROFITS,
  MARKET_CAP_TO_M2,
];

export const DEFAULT_INDICATOR_ID = BUFFETT_INDICATOR.id;

export function findIndicator(id: string | null | undefined): IndicatorDef {
  const normalized = id?.trim().toLowerCase();
  return INDICATORS.find((entry) => entry.id === normalized) ?? BUFFETT_INDICATOR;
}

/** Resolves shortcut arguments like `VAL cape` or `VAL buffett` onto an indicator. */
export function resolveIndicatorArg(arg: string | null | undefined): IndicatorDef | null {
  const query = arg?.trim().toLowerCase();
  if (!query) return null;
  const direct = INDICATORS.find((entry) => entry.id === query);
  if (direct) return direct;
  return INDICATORS.find((entry) =>
    entry.shortLabel.toLowerCase() === query
    || entry.label.toLowerCase() === query
    || entry.id.startsWith(query)
    || entry.label.toLowerCase().startsWith(query)
    || entry.shortLabel.toLowerCase().startsWith(query)
  ) ?? null;
}
