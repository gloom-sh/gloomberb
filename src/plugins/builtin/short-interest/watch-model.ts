import { realizedVolatilityCadenceIssue } from "../../../market-data/realized-volatility";
import type { PricePoint } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { isKnownNonUsListing } from "../../../utils/sec";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import type { ShortInterestRecord } from "./types";

/** Short interest is published per settlement for each US listing, so a list fetches one symbol at a time. */
export const SHORT_WATCH_LIMIT = 60;
/**
 * A short is crowded at a tenth of the float, or at five days of volume to
 * cover once at least a twentieth of the float is short: days to cover alone
 * flags thinly traded large caps whose shorts are a sliver of the float. With
 * the float unknown, days to cover decides alone.
 */
const CROWDED_FLOAT_PERCENT = 10;
const CROWDED_DAYS_TO_COVER = 5;
const CROWDED_DAYS_MIN_FLOAT_PERCENT = 5;
/** The 1M base is the close a calendar month before the latest one, or the last close up to four days before (a weekend and a holiday). */
const RETURN_BASE_TOLERANCE_DAYS = 4;
const DAY_MS = 86_400_000;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const LISTED_TYPES = new Set(["", "STK", "EQUITY", "COMMONSTOCK", "ADR", "ETF", "FUND"]);

export type ShortWatchSetup = "crowded-rising" | "crowded";

export function setupLabel(setup: ShortWatchSetup | null): string {
  return setup === "crowded-rising" ? "Crowded, rising" : setup === "crowded" ? "Crowded" : "";
}

export interface ShortWatchRow {
  symbol: string;
  /** ISO date of the latest settlement. */
  settlementDate: string | null;
  sharesShort: number | null;
  /** Percent change in shares short since the settlement before. */
  changePercent: number | null;
  daysToCover: number | null;
  /** Shares short over the float, in percent. */
  percentFloat: number | null;
  /** Price change over a calendar month of daily closes, in percent. */
  return1M: number | null;
  /** ISO date of the close the return runs to. */
  closeDate: string | null;
  setup: ShortWatchSetup | null;
  error: string | null;
}

export interface ShortWatchInputs {
  symbol: string;
  records: readonly ShortInterestRecord[] | null;
  floatShares: number | null;
  history: readonly PricePoint[] | null;
  error?: string | null;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The latest close against the close one calendar month earlier: the last close
 * on or before that day, within four days of it, from daily bars only, so a gap in the history leaves the
 * return unknown rather than measuring a longer window.
 */
export function oneMonthReturn(history: readonly PricePoint[]): { percent: number; date: string } | null {
  // Weekly or intraday bars would measure from the wrong close.
  if (realizedVolatilityCadenceIssue(history)) return null;
  // Cached histories come back with ISO-string dates.
  const closes = history.map((point) => ({ close: point.close, date: new Date(point.date) }))
    .filter((point) => finite(point.close) && point.close > 0 && !Number.isNaN(point.date.getTime()))
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const last = closes.at(-1);
  if (!last) return null;
  const target = new Date(last.date);
  target.setUTCMonth(target.getUTCMonth() - 1);
  // 31 March less a month is 3 March; clamp to the month's last day.
  if (target.getUTCMonth() === last.date.getUTCMonth()) target.setUTCDate(0);
  const base = closes.filter((point) => point.date.getTime() <= target.getTime()).at(-1);
  if (!base || target.getTime() - base.date.getTime() > RETURN_BASE_TOLERANCE_DAYS * DAY_MS) return null;
  return { percent: (last.close / base.close - 1) * 100, date: isoDate(last.date) };
}

function shortWatchSetup(row: Pick<ShortWatchRow, "percentFloat" | "daysToCover" | "return1M">): ShortWatchSetup | null {
  const longToCover = row.daysToCover != null && row.daysToCover >= CROWDED_DAYS_TO_COVER;
  const crowded = row.percentFloat != null
    ? row.percentFloat >= CROWDED_FLOAT_PERCENT || (longToCover && row.percentFloat >= CROWDED_DAYS_MIN_FLOAT_PERCENT)
    : longToCover;
  if (!crowded) return null;
  return row.return1M != null && row.return1M > 0 ? "crowded-rising" : "crowded";
}

/**
 * One name's latest settlement, its change from the settlement before, its
 * shares short over the float, and its month's price move. A settlement that
 * carries its own percent of float keeps it; otherwise the float is the
 * snapshot's current float.
 */
export function buildShortWatchRow(inputs: ShortWatchInputs): ShortWatchRow {
  const records = [...(inputs.records ?? [])].sort((left, right) => left.settlementDate.getTime() - right.settlementDate.getTime());
  const latest = records.at(-1);
  const prior = records.at(-2);
  // A float smaller than the shares short is another class's float (BRK.B reports Berkshire's Class A), not a short over 100%.
  const percentFloat = latest
    ? latest.shortPercentFloat ?? (finite(inputs.floatShares) && inputs.floatShares >= latest.sharesShort && inputs.floatShares > 0
      ? latest.sharesShort / inputs.floatShares * 100 : null)
    : null;
  const move = inputs.history ? oneMonthReturn(inputs.history) : null;
  const row = {
    symbol: inputs.symbol,
    settlementDate: latest ? isoDate(latest.settlementDate) : null,
    sharesShort: latest?.sharesShort ?? null,
    changePercent: latest && prior && prior.sharesShort > 0 ? (latest.sharesShort / prior.sharesShort - 1) * 100 : null,
    daysToCover: latest?.shortRatio ?? null,
    percentFloat,
    return1M: move?.percent ?? null,
    closeDate: move?.date ?? null,
    error: inputs.error ?? (latest ? null : "No short interest reported"),
  };
  return { ...row, setup: shortWatchSetup(row) };
}

const SETUP_RANK: Record<ShortWatchSetup, number> = { "crowded-rising": 2, crowded: 1 };

/**
 * Crowded names that are rising first, then crowded names, then the rest; each
 * group from the most crowded down, and names without a settlement last.
 */
function compareShortWatchRank(left: ShortWatchRow, right: ShortWatchRow): number {
  return (right.settlementDate ? 1 : 0) - (left.settlementDate ? 1 : 0)
    || (right.setup ? SETUP_RANK[right.setup] : 0) - (left.setup ? SETUP_RANK[left.setup] : 0)
    // Percent of float measures crowding; days to cover orders the names whose float is unknown, after them.
    || (right.percentFloat != null ? 1 : 0) - (left.percentFloat != null ? 1 : 0)
    || compareSortValues(left.percentFloat ?? left.daysToCover, right.percentFloat ?? right.daysToCover, "desc")
    || left.symbol.localeCompare(right.symbol);
}

export type ShortWatchSortId = "setup" | "symbol" | "percentFloat" | "daysToCover" | "changePercent" | "return1M" | "sharesShort" | "settlementDate" | "closeDate";

export function sortShortWatchRows(rows: readonly ShortWatchRow[], columnId: ShortWatchSortId, direction: SortDirection): ShortWatchRow[] {
  if (columnId === "setup") {
    const ranked = [...rows].sort(compareShortWatchRank);
    return direction === "desc" ? ranked : ranked.reverse();
  }
  return [...rows].sort((left, right) => compareSortValues(left[columnId], right[columnId], direction)
    || compareShortWatchRank(left, right));
}

/** The one date every row shares, so it can sit in the footer instead of a column. */
export function sharedDate(rows: readonly ShortWatchRow[], key: "settlementDate" | "closeDate"): string | null {
  const dates = new Set(rows.map((row) => row[key]).filter((value): value is string => !!value));
  return dates.size === 1 ? [...dates][0]! : null;
}

export interface ShortWatchUniverse { symbols: string[]; notice: string | null }

/** US listings only: short interest settlements cover US-traded shares. */
function listed(ticker: Pick<TickerRecord, "metadata">): boolean {
  const category = (ticker.metadata.assetCategory ?? "").toUpperCase().replace(/[\s_-]/g, "");
  return LISTED_TYPES.has(category) && !isKnownNonUsListing(ticker as TickerRecord);
}

function cap(symbols: string[], skipped: string | null): ShortWatchUniverse {
  const unique = [...new Set(symbols)];
  return {
    symbols: unique.slice(0, SHORT_WATCH_LIMIT),
    notice: unique.length > SHORT_WATCH_LIMIT ? `Showing the first ${SHORT_WATCH_LIMIT} of ${unique.length} names.` : skipped,
  };
}

const plural = (count: number) => `${count} name${count === 1 ? "" : "s"}`;

/** Every name in the user's portfolios and watchlists. */
export function ownNamesUniverse(tickers: readonly Pick<TickerRecord, "metadata">[]): ShortWatchUniverse {
  const members = tickers.filter((ticker) => ticker.metadata.portfolios.length > 0 || ticker.metadata.watchlists.length > 0);
  const symbols = members.filter(listed).map((ticker) => ticker.metadata.ticker.toUpperCase()).filter((symbol) => SYMBOL.test(symbol));
  const skipped = members.length - symbols.length;
  return cap(symbols.sort(), skipped ? `${plural(skipped)} left out: short interest covers US-listed shares.` : null);
}

export function customUniverse(text: string): ShortWatchUniverse {
  const symbols = text.split(/[\s,]+/).map((value) => value.split(":")[0]!.toUpperCase()).filter(Boolean);
  const valid = symbols.filter((symbol) => SYMBOL.test(symbol));
  const skipped = symbols.length - valid.length;
  return cap(valid, skipped ? `${plural(skipped)} left out: not a US ticker symbol.` : null);
}
