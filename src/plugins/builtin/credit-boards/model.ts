import type {
  CdxBoardIndex,
  CreditBoardPoint,
  CreditIndexQuote,
  SovrBoardSovereign,
} from "../../../api-client/credit-boards";
import { spanAxisFormatter, formatBpAxis } from "../../../components/chart-table/axis";
import { historyStatistics } from "../../../components/chart/curve/model";
import type { MarketBoardRow } from "../../../components/market-board";
import type { PricePoint } from "../../../types/financials";

export const CDX_PANE_ID = "cdx-board";
export const SOVR_PANE_ID = "sovr-board";

const YEAR_DAYS = 365;
/** A level older than this is not the current market. */
const STALE_DAYS = 5;

/** The history the board draws, as dated closes. */
function pointHistory(points: readonly CreditBoardPoint[]): PricePoint[] {
  return points.map((point) => ({ date: new Date(`${point.date}T00:00:00Z`), close: point.level }));
}

/** Spreads in bp with a decimal; prices as quoted, to the cent. */
export function formatLevel(quote: CreditIndexQuote, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return quote === "spread" ? `${value.toFixed(1)}bp` : value.toFixed(2);
}

/** A move in the quote's unit: `+1.2bp`, or `-0.13` points of price. */
export function formatMove(quote: CreditIndexQuote, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const digits = quote === "spread" ? 1 : 2;
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded === 0 ? (0).toFixed(digits) : rounded.toFixed(digits)}${quote === "spread" ? "bp" : ""}`;
}

/**
 * A move as the board shows it, so a change that prints as 0.0 is not
 * coloured by the digits it hides.
 */
function shown(quote: CreditIndexQuote, value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(quote === "spread" ? 1 : 2));
}

/** Wider spreads and lower prices are the adverse direction. */
function adverseMove(quote: CreditIndexQuote): "up" | "down" {
  return quote === "spread" ? "up" : "down";
}

const formatPriceAxis = spanAxisFormatter((value, digits) => value.toFixed(digits));

export function axisFormatter(quote: CreditIndexQuote) {
  return quote === "spread" ? formatBpAxis : formatPriceAxis;
}

interface YearStatistics {
  percentile: number | null;
  low: number | null;
  high: number | null;
}

/** Where the latest level sits in its own year: midrank, with the range. */
function yearStatistics(points: readonly CreditBoardPoint[], level: number | null, date: string | null): YearStatistics {
  if (level == null || !date) return { percentile: null, low: null, high: null };
  const year = historyStatistics(points.map((point) => ({ date: point.date, value: point.level })), level,
    { asOf: date, windowDays: YEAR_DAYS });
  return { percentile: year.count >= 2 ? year.percentile : null, low: year.min, high: year.max };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function stale(date: string | null, asOf: string | null): boolean {
  if (!date || !asOf) return false;
  return daysBetween(date, asOf.slice(0, 10)) > STALE_DAYS;
}

/** `2031-12-20` as `Dec 2031`, how the contract is named on a desk. */
export function formatContract(maturity: string | null): string {
  if (!maturity) return "--";
  const date = new Date(`${maturity}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? maturity
    : date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export interface CdxRow extends MarketBoardRow {
  index: CdxBoardIndex;
  year: YearStatistics;
  /** The 1W move as shown. */
  week: number | null;
}

export function cdxRows(indexes: readonly CdxBoardIndex[], asOf: string | null): CdxRow[] {
  return indexes.map((index) => {
    const year = yearStatistics(index.points, index.level, index.date);
    return {
      id: index.id,
      label: index.name,
      value: index.level,
      valueText: formatLevel(index.quote, index.level),
      change: shown(index.quote, index.change1D),
      changeText: formatMove(index.quote, index.change1D),
      percentile: year.percentile,
      asOf: index.date,
      history: pointHistory(index.points),
      status: index.level == null ? "unavailable" : stale(index.date, asOf) ? "stale" : "available",
      adverseMove: adverseMove(index.quote),
      index,
      year,
      week: shown(index.quote, index.change1W),
    };
  });
}

export interface SovrRow extends MarketBoardRow {
  sovereign: SovrBoardSovereign;
  year: YearStatistics;
  currencyMove: number | null;
}

export function sovrRows(
  sovereigns: readonly SovrBoardSovereign[],
  asOf: string | null,
  moves: ReadonlyMap<string, number | null>,
): SovrRow[] {
  return sovereigns.map((sovereign) => {
    const year = yearStatistics(sovereign.points, sovereign.level, sovereign.date);
    return {
      id: sovereign.id,
      label: sovereign.name,
      value: sovereign.level,
      valueText: formatLevel("spread", sovereign.level),
      change: shown("spread", sovereign.change1M),
      changeText: formatMove("spread", sovereign.change1M),
      percentile: year.percentile,
      asOf: sovereign.date,
      history: pointHistory(sovereign.points),
      status: stale(sovereign.date, asOf) ? "stale" : "available",
      adverseMove: "up",
      sovereign,
      year,
      currencyMove: shown("spread", moves.get(sovereign.currency) ?? null),
    };
  });
}

/** `BRL -1.2%`; a dollar or dollar-pegged currency still shows its code. */
export function formatCurrencyMove(currency: string, movePercent: number | null): string {
  if (movePercent == null || !Number.isFinite(movePercent)) return `${currency} --`;
  const rounded = Number(movePercent.toFixed(1));
  const sign = rounded > 0 ? "+" : "";
  return `${currency} ${sign}${rounded === 0 ? "0.0" : rounded.toFixed(1)}%`;
}

/** Quoted as XXX/USD; every other currency is quoted per dollar. */
const USD_QUOTED = new Set(["EUR", "GBP", "AUD", "NZD"]);

/** The exchange-suffixed pair for a currency against the dollar, and whether its rate is dollars per unit. */
export function currencyPair(currency: string): { symbol: string; dollarsPerUnit: boolean } | null {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || code === "USD") return null;
  return USD_QUOTED.has(code)
    ? { symbol: `${code}USD=X`, dollarsPerUnit: true }
    : { symbol: `${code}=X`, dollarsPerUnit: false };
}

/** The same day a calendar month earlier, clamped to the month's end. */
function monthBefore(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const target = new Date(Date.UTC(year, month - 2, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * How much the currency gained against the dollar over the month to its
 * latest completed daily close, in percent: positive is a stronger local
 * currency. Each end is the median of three closes, so one stray print (the
 * pegged dinar alternates between 0.377 and 0.366 on the feed) makes no move,
 * and today's bar, still trading, is left out.
 */
export function currencyMoveFromHistory(
  history: readonly PricePoint[],
  dollarsPerUnit: boolean,
  today = new Date().toISOString().slice(0, 10),
): number | null {
  const byDate = new Map<string, number>();
  for (const point of history) {
    // Cached and headless histories carry the date as an ISO string.
    const time = new Date(point.date as Date | string).getTime();
    if (!Number.isFinite(point.close) || point.close <= 0 || Number.isNaN(time)) continue;
    const date = new Date(time).toISOString().slice(0, 10);
    if (date < today) byDate.set(date, point.close);
  }
  const closes = [...byDate].sort((a, b) => a[0].localeCompare(b[0]));
  const middle = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1]!;
  const latest = closes.slice(-3);
  if (latest.length < 3) return null;
  const base = monthBefore(latest.at(-1)![0]);
  const start = closes.filter(([date]) => date <= base).slice(-3);
  // A month-old close more than a week before the target date is no baseline.
  if (start.length < 3 || daysBetween(start.at(-1)![0], base) > 7) return null;
  const now = middle(latest.map(([, close]) => close));
  const then = middle(start.map(([, close]) => close));
  const ratio = dollarsPerUnit ? now / then : then / now;
  return (ratio - 1) * 100;
}
