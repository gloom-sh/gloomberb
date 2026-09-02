import { formatNumber } from "../../../utils/format";
import type { IndicatorDef, SeriesDef, ShillerField } from "./defs";

const DAY_MS = 24 * 60 * 60 * 1000;
const MILLIONS_TO_BILLIONS = 0.001;

/** Z.1 lands ~10 weeks after quarter end, then holds until the next quarter's release. */
const QUARTERLY_STALE_MS = 270 * DAY_MS;
/** Shiller republishes monthly; two missed months means something is wrong. */
const MONTHLY_STALE_MS = 75 * DAY_MS;
const DAILY_STALE_MS = 5 * DAY_MS;

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
 * Total US market value. FRED discontinued the WILL5000* family, so this comes
 * from the cloud's own price history rather than the econ proxy.
 */
const WILSHIRE_5000: SeriesDef = {
  key: "W5000",
  scaleToBillions: 1,
  source: {
    kind: "market-history",
    symbol: "^W5000",
    exchange: "INDEX",
    startDate: "1970-01-01",
  },
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
  description: "US total market cap over nominal GDP.",
  input: {
    kind: "ratio",
    numerator: WILSHIRE_5000,
    denominator: NOMINAL_GDP,
    levels: { numeratorLabel: "Mkt cap", denominatorLabel: "GDP" },
  },
  ratioScale: 100,
  formatValue: percent,
  axisUnit: "%",
  zones: [
    { max: 75, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 90, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 115, id: "fair", label: "Fair Valued" },
    { max: 135, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 250, edges: [0, 75, 90, 115, 135, 250], ticks: [0, 75, 100, 135, 250] },
  reference: { value: 100, label: "parity" },
  chartGridStep: 150,
  trendModel: "log",
  staleAfterMs: DAILY_STALE_MS,
  notes: [
    "Total US market value against one year of economic output. Warren Buffett called it probably the best single measure of where valuations stand at any given moment, in a December 2001 Fortune essay written with Carol Loomis.",
    "Rates, buybacks, and a larger listed share of the economy have all raised what fair looks like since 2001, so read the trend deviation alongside the absolute zone.",
  ],
  link: {
    url: "https://en.wikipedia.org/wiki/Buffett_indicator",
    label: "Buffett indicator, Wikipedia",
  },
};

export const TOBINS_Q: IndicatorDef = {
  id: "tobins-q",
  label: "Tobin's Q",
  shortLabel: "Tobin Q",
  description: "Corporate equity market value over replacement cost of net assets.",
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
  reference: { value: 1, label: "replacement cost" },
  chartGridStep: 0.5,
  trendModel: "log",
  staleAfterMs: QUARTERLY_STALE_MS,
  notes: [
    "Equity market value against what it would cost to rebuild the assets behind it. Q above 1 means the market pays more than replacement cost.",
    "Built from the Fed's quarterly Z.1 financial accounts for nonfinancial corporate business, so it moves in quarterly steps and revises with each release.",
  ],
  link: { url: "https://en.wikipedia.org/wiki/Tobin%27s_q", label: "Tobin's q, Wikipedia" },
};

export const SHILLER_CAPE: IndicatorDef = {
  id: "shiller-cape",
  label: "Shiller CAPE",
  shortLabel: "CAPE",
  description: "S&P 500 price over ten years of inflation-adjusted earnings.",
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
  notes: [
    "Price divided by the average of ten years of real earnings, which smooths away the profit cycle that makes a one-year P/E swing hardest exactly when it matters most.",
    "Robert Shiller's series runs back to 1881. It has spent decades above its own median without mean-reverting, so treat it as a long-horizon return signal rather than a timing tool.",
  ],
  link: {
    url: "https://en.wikipedia.org/wiki/Cyclically_adjusted_price-to-earnings_ratio",
    label: "CAPE ratio, Wikipedia",
  },
};

export const EXCESS_CAPE_YIELD: IndicatorDef = {
  id: "excess-cape-yield",
  label: "Excess CAPE Yield",
  shortLabel: "ERP (ECY)",
  description: "CAPE earnings yield over the real 10-year Treasury yield.",
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
  notes: [
    "What stocks yield over inflation-protected bonds: the CAPE earnings yield minus the real ten-year Treasury yield. It is the equity risk premium in the form Shiller publishes.",
    "Unlike a price ratio, higher is cheaper. It went negative before the 1929 and 2000 peaks, when bonds out-yielded stocks outright.",
  ],
  link: {
    url: "https://en.wikipedia.org/wiki/Equity_premium_puzzle",
    label: "Equity risk premium, Wikipedia",
  },
};

export const SP500_DIVIDEND_YIELD: IndicatorDef = {
  id: "sp500-dividend-yield",
  label: "S&P 500 Dividend Yield",
  shortLabel: "Div yield",
  description: "Index dividend over index price.",
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
  staleAfterMs: MONTHLY_STALE_MS,
  notes: [
    "What the index pays out against what it costs. Buybacks have moved a large share of shareholder return off this line since the 1980s, so the modern level is structurally lower than the pre-1990 record.",
    "Read it against its own recent decades rather than the full history for that reason.",
  ],
  link: { url: "https://en.wikipedia.org/wiki/Dividend_yield", label: "Dividend yield, Wikipedia" },
};

export const HOUSEHOLD_EQUITY_ALLOCATION: IndicatorDef = {
  id: "household-equity-allocation",
  label: "Investor Equity Allocation",
  shortLabel: "Equity alloc",
  description: "Share of household financial assets held in equities.",
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
  notes: [
    "How much of what households own sits in stocks. When investors are already all-in there is little cash left to bid prices higher, which is why this has tracked ten-year forward returns more closely than any price ratio.",
    "From the Fed's quarterly Z.1 accounts, counting equities held directly and through funds.",
  ],
  link: {
    url: "https://fred.stlouisfed.org/series/BOGZ1FL153064486Q",
    label: "Household equity share, FRED",
  },
};

export const MARKET_CAP_TO_M2: IndicatorDef = {
  id: "market-cap-m2",
  label: "Market Cap to M2",
  shortLabel: "Cap / M2",
  description: "US total market cap against the money supply.",
  input: {
    kind: "ratio",
    numerator: WILSHIRE_5000,
    denominator: M2,
    levels: { numeratorLabel: "Mkt cap", denominatorLabel: "M2" },
  },
  ratioScale: 100,
  formatValue: percent,
  axisUnit: "%",
  // Bands anchored on the 1989-2026 distribution: p25 142%, median 180%, p75 206%.
  zones: [
    { max: 130, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 160, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 210, id: "fair", label: "Fair Valued" },
    { max: 260, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 350, edges: [0, 130, 160, 210, 260, 350], ticks: [0, 130, 210, 260, 350] },
  reference: { value: 180, label: "median" },
  chartGridStep: 100,
  trendModel: "log",
  staleAfterMs: DAILY_STALE_MS,
  notes: [
    "Market value measured against the money supply rather than output, which is the liquidity-adjusted read on the same question the Buffett indicator asks.",
    "It falls when the Fed expands M2 faster than equities rise, so the 2020 surge shows up here as cheapening even while price ratios were climbing.",
  ],
  link: { url: "https://fred.stlouisfed.org/series/M2SL", label: "M2 money stock, FRED" },
};

export const MARGIN_DEBT_TO_GDP: IndicatorDef = {
  id: "margin-debt-gdp",
  label: "Margin Debt to GDP",
  shortLabel: "Margin debt",
  description: "Borrowing against securities, against the size of the economy.",
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
  notes: [
    "How much investors have borrowed against their holdings. Leverage is what turns a decline into forced selling, so it is froth rather than value, but it peaks where valuations do.",
    "Its two highest readings are the first quarter of 2000 and the third of 2008. From the Fed's Z.1 accounts, which reach further back than FINRA's own margin table.",
  ],
  link: {
    url: "https://fred.stlouisfed.org/series/BOGZ1FL663067003Q",
    label: "Margin account receivables, FRED",
  },
};

export const MARKET_CAP_TO_PROFITS: IndicatorDef = {
  id: "market-cap-profits",
  label: "Market Cap to Corporate Profits",
  shortLabel: "Cap / profits",
  description: "US total market cap over after-tax corporate profits.",
  input: {
    kind: "ratio",
    numerator: WILSHIRE_5000,
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
  // Bands anchored on the 1989-2026 distribution: p25 7.9, median 9.1, p75 12.3.
  zones: [
    { max: 8, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 9, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 12, id: "fair", label: "Fair Valued" },
    { max: 15, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: { min: 0, max: 20, edges: [0, 8, 9, 12, 15, 20], ticks: [0, 9, 12, 15, 20] },
  reference: { value: 9.1, label: "median" },
  chartGridStep: 5,
  trendModel: "log",
  staleAfterMs: DAILY_STALE_MS,
  notes: [
    "A price-to-earnings ratio for the whole economy rather than the index, using what every US corporation actually earned after tax.",
    "Profits are near a record share of GDP, so this asks whether the market is dear even against unusually good earnings. Its highest reading is March 2000.",
  ],
  link: {
    url: "https://fred.stlouisfed.org/series/CPROFIT",
    label: "Corporate profits after tax, FRED",
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
