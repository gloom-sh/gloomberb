import type {
  CdxBoardIndex,
  CreditBoardPoint,
  CreditIndexQuote,
  CreditLevelKind,
  SovrBoardSovereign,
} from "../../../api-client/credit-boards";
import { spanAxisFormatter, formatBpAxis } from "../../../components/chart-table/axis";
import { historyStatistics } from "../../../components/chart/curve/model";
import type { MarketBoardRow } from "../../../components/market-board";
import type { PricePoint } from "../../../types/financials";
import type { HeadlessPaneColumn } from "../../../types/plugin";

const YEAR_DAYS = 365;
/** A level older than this is not the current market. */
const STALE_DAYS = 5;

/** The history the board draws, as dated closes. */
function pointHistory(points: readonly CreditBoardPoint[]): PricePoint[] {
  return points.map((point) => ({ date: new Date(`${point.date}T00:00:00Z`), close: point.level }));
}

/**
 * The units a quote's level and moves are in, as exports name them: a spread
 * and its moves in bp; HY and EM quote in price, and move in points of it.
 */
export function quoteUnits(quote: CreditIndexQuote): { level: "bp" | "price"; move: "bp" | "pts" } {
  return quote === "spread" ? { level: "bp", move: "bp" } : { level: "price", move: "pts" };
}

/** Today's trade date in New York, the date DTCC's index prints are dated by. */
const NEW_YORK_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function newYorkTradeDate(now: number): string {
  return NEW_YORK_DATE.format(new Date(now));
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Where an index's latest day stands, and its moves between complete days. */
export interface CdxDay {
  /** The latest day is today's New York trade date, still trading: its level and prints are so far. */
  partial: boolean;
  /** When the latest day's last print was executed, ISO UTC, when the server says. */
  lastPrintAt: string | null;
  /** The last complete day, which the moves run to. */
  changeDate: string | null;
  change1D: number | null;
  change1W: number | null;
  change1M: number | null;
}

/**
 * An index's latest day and the moves the board shows: always between
 * complete days, so a morning's few prints never make a 1D. A server that
 * says (`partial`) has already measured them that way, across a roll on one
 * contract. An older one dates them from the latest day; when that day is
 * today's New York trade date or later (Asia's prints) the moves are measured
 * again here from the complete days before it, on the same contract only
 * (none across a roll).
 */
export function cdxDay(index: CdxBoardIndex, now = Date.now()): CdxDay {
  const served = { change1D: index.change1D, change1W: index.change1W, change1M: index.change1M ?? null };
  if (typeof index.partial === "boolean") {
    return {
      partial: index.partial, lastPrintAt: index.lastPrintAt ?? null,
      changeDate: index.changeDate !== undefined ? index.changeDate : index.partial ? null : index.date, ...served,
    };
  }
  // Asia-session prints are dated the next local day, so from about 00:00 to 04:00 UTC (and from
  // Sunday evening in New York) the latest day can be New York's tomorrow: still trading too.
  if (!index.date || index.date < newYorkTradeDate(now)) return { partial: false, lastPrintAt: null, changeDate: index.date, ...served };
  const complete = index.points.filter((point) => point.date < index.date!);
  const anchor = complete.at(-1) ?? null;
  const move = (base: string, maxLagDays: number): number | null => {
    const baseline = complete.findLast((point) => point.date <= base);
    if (!anchor || !baseline || baseline.maturity !== anchor.maturity || daysBetween(baseline.date, base) > maxLagDays) return null;
    return Math.round((anchor.level - baseline.level) * 1e6) / 1e6;
  };
  return {
    partial: true,
    lastPrintAt: null,
    changeDate: anchor?.date ?? null,
    change1D: anchor ? move(addDays(anchor.date, -1), 5) : null,
    change1W: anchor ? move(addDays(anchor.date, -7), 5) : null,
    change1M: anchor ? move(monthBefore(anchor.date), 7) : null,
  };
}

/** `08:09`: a print's time of day in UTC. */
function utcClock(instant: string): string | null {
  const time = Date.parse(instant);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(11, 16) : null;
}

/**
 * How a level that is the day's settlement price, not its trades, is marked
 * beside its date.
 */
export const SETTLEMENT_TEXT = "settlement";

/**
 * A report's mark for the levels that are settlement prices: blank for a
 * level from the day's trades. Shown only when a row is one, and each row
 * then carries `kind`.
 */
export const levelKindColumn: HeadlessPaneColumn = {
  key: "kind", header: "Level",
  description: "Blank for a level from the day's trades. settlement for the day's end-of-day settlement price, which stands in "
    + "on a day without enough agreeing trades; its prints are 0.",
  format: (value) => value === "settlement" ? SETTLEMENT_TEXT : "",
};

/** `kind` on every row once one level is a settlement; nothing otherwise, so a report without one is unchanged. */
export function levelKinds<T>(items: readonly T[], kindOf: (item: T) => CreditLevelKind | null | undefined) {
  const shown = items.some((item) => kindOf(item) === "settlement");
  return {
    columns: shown ? [levelKindColumn] : [],
    row: (item: T) => shown ? { kind: kindOf(item) ?? "traded" } : {},
  };
}

/**
 * What a day still trading rests on: `so far, 38 prints, last 08:09 UTC`.
 * The print time is left out when the server does not say it.
 */
export function partialDayText(prints: number | null, lastPrintAt: string | null): string {
  const clock = lastPrintAt ? utcClock(lastPrintAt) : null;
  return ["so far", ...(prints == null ? [] : [`${prints} ${prints === 1 ? "print" : "prints"}`]),
    ...(clock ? [`last ${clock} UTC`] : [])].join(", ");
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

const boardKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * `IG`, `cdx hy`, `itraxx main`, `crossover`: an index by its code, its name or the name's last word. `fn CDX`
 * and the board's own selection (`CDX HY` opens on it) read the argument through this.
 */
export function findIndex<T extends { id: string; name: string }>(indexes: readonly T[], query: string): T | null {
  const wanted = boardKey(query) === "crossover" ? "xover" : boardKey(query);
  return indexes.find((index) => [index.id, index.name, index.name.split(" ").at(-1) ?? ""]
    .some((name) => boardKey(name) === wanted)) ?? null;
}

/** `Brazil`, `br`, `ivory coast`: a sovereign by its name or its country code, in any case. */
export function findSovereign<T extends { id: string; name: string }>(sovereigns: readonly T[], query: string): T | null {
  const wanted = boardKey(query);
  return wanted ? sovereigns.find((sovereign) => [sovereign.id, sovereign.name].some((name) => boardKey(name) === wanted)) ?? null : null;
}

export interface CdxRow extends MarketBoardRow {
  index: CdxBoardIndex;
  year: YearStatistics;
  /** The latest day's standing and the moves between complete days. */
  day: CdxDay;
  /** The 1W and 1M moves as shown. */
  week: number | null;
  month: number | null;
}

export function cdxRows(indexes: readonly CdxBoardIndex[], asOf: string | null, now = Date.now()): CdxRow[] {
  return indexes.map((index) => {
    const year = yearStatistics(index.points, index.level, index.date);
    const day = cdxDay(index, now);
    return {
      id: index.id,
      label: index.name,
      value: index.level,
      valueText: formatLevel(index.quote, index.level),
      change: shown(index.quote, day.change1D),
      changeText: formatMove(index.quote, day.change1D),
      percentile: year.percentile,
      asOf: index.date,
      history: pointHistory(index.points),
      status: index.level == null ? "unavailable" : stale(index.date, asOf) ? "stale" : day.partial ? "partial" : "available",
      adverseMove: adverseMove(index.quote),
      index,
      year,
      day,
      week: shown(index.quote, day.change1W),
      month: shown(index.quote, day.change1M),
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
      // The sovereign's flag, by its name, leads the row on the desktop.
      country: sovereign.name,
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
