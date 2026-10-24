import type { ScreenDefinition, ScreenMetric, ScreenRow } from "../../../api-client/equity-screener";
import { getExtendedSessionDisplay, type ExtendedSession, type ExtendedSessionDisplay } from "../../../market-data/market/status";
import { quoteTradingDay } from "../../../market-data/quotes/day-range";
import { getRegularSessionQuoteDisplay } from "../../../market-data/quotes/screener-live-quotes";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";
import { isFiniteNumber } from "../../../utils/guards";

/**
 * A screen row with its quote laid over it: price, change, volume and market
 * cap are the regular session's, and a pre-market, after-hours or overnight
 * print rides beside them in `extended`, measured from that session's close.
 */
export type LiveScreenRow = ScreenRow & { extended?: ExtendedSessionDisplay };

function metricTime(metric: ScreenMetric | undefined): number | null {
  const stamp = metric?.observedAt ?? metric?.asOf ?? null;
  if (!stamp) return null;
  const time = Date.parse(stamp);
  return Number.isFinite(time) ? time : null;
}

function screenRowQuoteKey(row: Pick<ScreenRow, "symbol" | "exchange">): string {
  return buildQuoteKey({ symbol: row.symbol, exchange: row.exchange });
}

function liveMetric(metric: ScreenMetric, value: number, asOf: string, observedAt: string): ScreenMetric {
  return { ...metric, value, asOf, observedAt, state: "available" };
}

/**
 * Price, day change, volume and market cap from a quote, over a snapshot row,
 * as `quote` headlines them: the live quote while the regular session trades,
 * then the completed session's close and its move (getRegularSessionQuoteDisplay,
 * as the boards read it), weekend and overnight included, so an extended print
 * never moves them. That print is the row's `extended`. Market cap scales with
 * the price so it keeps the snapshot's share basis. Membership, sort order and
 * percentiles stay the snapshot's, which ranks by the close too, so rows
 * neither reshuffle nor vanish between snapshots. A quote in another currency
 * unit (GBp against GBP), a stale one, or one older than the snapshot (a
 * live quote observed before it, a quote of an earlier day than the
 * snapshot's price) leaves the row alone.
 */
function overlayLiveScreenRow(row: ScreenRow, quote: Quote | null | undefined): LiveScreenRow {
  if (!quote || quote.stale === true || !isFiniteNumber(quote.price) || quote.price <= 0 || !isFiniteNumber(quote.lastUpdated)) return row;
  const quoteCurrency = quote.currency?.trim();
  if (quoteCurrency && row.currency && quoteCurrency !== row.currency) return row;
  const snapshotPrice = row.metrics.price;
  const headline = getRegularSessionQuoteDisplay(quote);
  if (!headline || !isFiniteNumber(headline.price) || headline.price <= 0) return row;
  if (headline.completed) {
    // The snapshot dates a session's price by that session (a pre-market
    // print by the day it trades in); a quote of an earlier day is older.
    const snapshotSession = snapshotPrice.asOf && /^\d{4}-\d{2}-\d{2}$/.test(snapshotPrice.asOf) ? snapshotPrice.asOf : null;
    const quoteDay = quoteTradingDay(quote) ?? headline.closedSession;
    if (quoteDay && snapshotSession && quoteDay < snapshotSession) return row;
  } else {
    const snapshotAt = metricTime(snapshotPrice);
    if (snapshotAt != null && quote.lastUpdated < snapshotAt) return row;
  }
  const print = getExtendedSessionDisplay(quote);
  const extended = print && isFiniteNumber(print.price) && print.price > 0 ? print : null;
  if (!extended && snapshotPrice.value === headline.price && row.metrics.changePercent.value === headline.changePercent) return row;

  const observedAt = new Date(quote.lastUpdated).toISOString();
  // A close is dated by its session, as the snapshot dates one.
  const asOf = headline.completed ? headline.closedSession ?? observedAt : observedAt;
  const metrics = { ...row.metrics, price: liveMetric(snapshotPrice, headline.price, asOf, observedAt) };
  if (isFiniteNumber(headline.changePercent)) {
    metrics.changePercent = liveMetric(metrics.changePercent, headline.changePercent, asOf, observedAt);
  }
  // Outside the session the quote's volume may be the next pre-market's; the snapshot's is the close's session's.
  if (!headline.completed && isFiniteNumber(quote.volume) && quote.volume >= 0) {
    metrics.volume = liveMetric(metrics.volume, quote.volume, asOf, observedAt);
  }
  const cap = metrics.marketCap;
  if (isFiniteNumber(cap.value) && isFiniteNumber(snapshotPrice.value) && snapshotPrice.value > 0) {
    metrics.marketCap = liveMetric(cap, cap.value * (headline.price / snapshotPrice.value), asOf, observedAt);
  }
  return { ...row, metrics, ...(extended ? { extended } : {}) };
}

/** The last overlay per snapshot row, so a row whose quote did not move keeps its object. */
const liveRows = new WeakMap<ScreenRow, { quote: Quote | null; row: LiveScreenRow }>();

function overlayRows(rows: readonly ScreenRow[], quoteOf: (key: string) => Quote | null | undefined): LiveScreenRow[] {
  return rows.map((row) => {
    const quote = quoteOf(screenRowQuoteKey(row));
    if (quote === undefined) return row;
    const cached = liveRows.get(row);
    if (cached && cached.quote === quote) return cached.row;
    const next = overlayLiveScreenRow(row, quote);
    liveRows.set(row, { quote, row: next });
    return next;
  });
}

/** The pane's rows with the streamed quotes on screen laid over them. */
export function overlayLiveScreenRows(
  rows: readonly ScreenRow[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): LiveScreenRow[] {
  return overlayRows(rows, (key) => {
    const entry = entries.get(key);
    return entry ? resolveEntryData(entry) : undefined;
  });
}

/** Rows with quotes keyed by screenRowQuoteKey laid over them, for a report. */
export function overlayScreenQuotes(rows: readonly ScreenRow[], quotes: ReadonlyMap<string, Quote>): LiveScreenRow[] {
  return overlayRows(rows, (key) => quotes.get(key));
}

/** The fields a quote moves on a row (overlayLiveScreenRow). */
const LIVE_SORT_FIELDS: ReadonlySet<string> = new Set(["price", "changePercent", "volume", "marketCap"]);

/**
 * Rows in the screen's order by the figures they show. A sort on a field the
 * quotes move (price, change, volume, market cap) is redone on the overlaid
 * values, so the column reads monotone: GRAB's snapshot cap, two closes old,
 * kept it above MANH after its quote moved it below. Rows without a
 * value stay last, and ties keep the snapshot's order. Any other sort is the
 * snapshot's, which the overlay does not touch.
 */
export function sortLiveScreenRows<T extends ScreenRow>(rows: readonly T[], sort: ScreenDefinition["sort"]): T[] {
  if (!LIVE_SORT_FIELDS.has(sort.field)) return [...rows];
  const field = sort.field as "price" | "changePercent" | "volume" | "marketCap";
  const sign = sort.direction === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: row.metrics[field]?.value }))
    .sort((a, b) => {
      const aKnown = isFiniteNumber(a.value), bKnown = isFiniteNumber(b.value);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && bKnown && a.value !== b.value) return sign * (a.value! - b.value!);
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/** The extended sessions some row has a print for, in the order their columns go. */
export function screenExtendedSessions(rows: readonly LiveScreenRow[]): ExtendedSession[] {
  return (["PRE", "POST", "OVERNIGHT"] as const).filter((session) => rows.some((row) => row.extended?.session === session));
}

/** A row's move in `session`'s print from the close in its price, when it has one. */
export function screenExtendedMove(row: LiveScreenRow, session: ExtendedSession): number | null {
  return row.extended?.session === session && isFiniteNumber(row.extended.changePercent) ? row.extended.changePercent : null;
}
