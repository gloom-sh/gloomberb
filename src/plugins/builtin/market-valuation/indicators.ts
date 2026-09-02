import { formatNumber } from "../../../utils/format";
import type { IndicatorDef } from "./defs";

const DAY_MS = 24 * 60 * 60 * 1000;
const MILLIONS_TO_BILLIONS = 0.001;

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatRatio(value: number): string {
  return formatNumber(value, 2);
}

/**
 * US total market cap over nominal GDP. Wilshire 5000 full-cap is priced so one
 * index point is about $1B of market value, which is why it needs no rescaling.
 */
export const BUFFETT_INDICATOR: IndicatorDef = {
  id: "buffett",
  label: "Buffett Indicator",
  shortLabel: "Buffett",
  description: "US total market cap over nominal GDP.",
  numerator: {
    seriesId: "WILL5000PRFC",
    scaleToBillions: 1,
    request: { limit: 10000, sortOrder: "desc" },
    source: { kind: "yahoo-index", symbol: "^W5000" },
  },
  denominator: {
    seriesId: "GDP",
    scaleToBillions: 1,
    request: { limit: 340, sortOrder: "desc" },
    source: { kind: "fred" },
  },
  numeratorLabel: "Mkt cap",
  denominatorLabel: "GDP",
  ratioScale: 100,
  formatValue: formatPercent,
  zones: [
    { max: 75, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 90, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 115, id: "fair", label: "Fair Valued" },
    { max: 135, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: {
    max: 250,
    edges: [0, 75, 90, 115, 135, 250],
    ticks: [0, 75, 100, 135, 250],
  },
  reference: { value: 100, label: "parity" },
  chartGridStep: 150,
  staleAfterMs: 5 * DAY_MS,
  notes: [
    "Total US market value against one year of economic output. Warren Buffett called it probably the best single measure of where valuations stand at any given moment, in a December 2001 Fortune essay written with Carol Loomis.",
    "Rates, buybacks, and a larger listed share of the economy have all raised what fair looks like since 2001, so read the trend deviation alongside the absolute zone.",
  ],
  link: {
    url: "https://en.wikipedia.org/wiki/Buffett_indicator",
    label: "Buffett indicator, Wikipedia",
  },
};

/**
 * Tobin's Q: corporate equity market value over the replacement cost of net
 * assets. Both Z.1 legs report in millions, so both scale down to billions.
 */
export const TOBINS_Q: IndicatorDef = {
  id: "tobins-q",
  label: "Tobin's Q",
  shortLabel: "Tobin Q",
  description: "Corporate equity market value over replacement cost of net assets.",
  numerator: {
    seriesId: "NCBEILQ027S",
    scaleToBillions: MILLIONS_TO_BILLIONS,
    request: { limit: 400, sortOrder: "desc" },
    source: { kind: "fred" },
  },
  denominator: {
    seriesId: "TNWMVBSNNCB",
    scaleToBillions: MILLIONS_TO_BILLIONS,
    request: { limit: 400, sortOrder: "desc" },
    source: { kind: "fred" },
  },
  numeratorLabel: "Equities",
  denominatorLabel: "Net worth",
  ratioScale: 1,
  formatValue: formatRatio,
  // Bands anchored on the 1945-2026 distribution: p25 0.54, median 0.93, p75 1.34.
  zones: [
    { max: 0.55, id: "significantly-undervalued", label: "Significantly Undervalued" },
    { max: 0.8, id: "modestly-undervalued", label: "Modestly Undervalued" },
    { max: 1.1, id: "fair", label: "Fair Valued" },
    { max: 1.4, id: "modestly-overvalued", label: "Modestly Overvalued" },
    { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
  ],
  zoneScale: {
    max: 2,
    edges: [0, 0.55, 0.8, 1.1, 1.4, 2],
    ticks: [0, 0.55, 1, 1.4, 2],
  },
  reference: { value: 1, label: "replacement cost" },
  chartGridStep: 0.5,
  // The newest Z.1 print is legitimately old: one quarter of coverage, ~10 weeks to
  // publication, then another quarter before the next release. Q1 data stays current
  // until Q2 lands ~8.5 months after the Q1 observation date, so only flag past that.
  staleAfterMs: 270 * DAY_MS,
  notes: [
    "Equity market value against what it would cost to rebuild the assets behind it. Q above 1 means the market pays more than replacement cost.",
    "Built from the Fed's quarterly Z.1 financial accounts for nonfinancial corporate business, so it moves in quarterly steps and revises with each release.",
  ],
  link: {
    url: "https://en.wikipedia.org/wiki/Tobin%27s_q",
    label: "Tobin's q, Wikipedia",
  },
};

export const INDICATORS: readonly IndicatorDef[] = [BUFFETT_INDICATOR, TOBINS_Q];

export const DEFAULT_INDICATOR_ID = BUFFETT_INDICATOR.id;

export function findIndicator(id: string | null | undefined): IndicatorDef {
  const normalized = id?.trim().toLowerCase();
  return INDICATORS.find((entry) => entry.id === normalized) ?? BUFFETT_INDICATOR;
}

/** Resolves shortcut arguments like `VAL buffett` or `VAL q` onto an indicator. */
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
  ) ?? null;
}
