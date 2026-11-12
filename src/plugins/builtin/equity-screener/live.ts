import type { ScreenDefinition, ScreenMetric, ScreenRow } from "../../../api-client/equity-screener";
import { getExtendedSessionDisplay, type ExtendedSession, type ExtendedSessionDisplay } from "../../../market-data/market/status";
import { quoteTradingDay } from "../../../market-data/quotes/day-range";
import { getRegularSessionQuoteDisplay } from "../../../market-data/quotes/screener-live-quotes";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { Quote } from "../../../types/financials";
import { isFiniteNumber } from "../../../utils/guards";
import { isValuationMultiple, screenRowId } from "./model";

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
 * Multiples of the price, which move with it as `valuation` reprices them:
 * the snapshot serves each over its row's price (its cap, for P/B), so over
 * the quote's price it is the snapshot's times the price's move.
 */
const PRICE_MULTIPLE_FIELDS = ["trailingPE", "forwardPE", "priceToBook"] as const;

/** The company's name as its quote gives it, so a row reads as `quote` does; the snapshot's without one. */
function quoteNamed(row: ScreenRow, quote: Quote): ScreenRow {
  const name = quote.name?.trim();
  return name && name !== row.name ? { ...row, name } : row;
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
function overlayLiveScreenRow(snapshotRow: ScreenRow, quote: Quote | null | undefined): LiveScreenRow {
  if (!quote) return snapshotRow;
  const row = quoteNamed(snapshotRow, quote);
  if (quote.stale === true || !isFiniteNumber(quote.price) || quote.price <= 0 || !isFiniteNumber(quote.lastUpdated)) return row;
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
  if (isFiniteNumber(snapshotPrice.value) && snapshotPrice.value > 0) {
    const move = headline.price / snapshotPrice.value;
    const cap = metrics.marketCap;
    if (isFiniteNumber(cap.value)) metrics.marketCap = liveMetric(cap, cap.value * move, asOf, observedAt);
    // Over the price the row shows, as `valuation` reprices them: one ticker, one P/E at one time. The
    // earnings or book under it keep the snapshot's date and state.
    for (const field of PRICE_MULTIPLE_FIELDS) {
      const metric = metrics[field];
      if (metric && isFiniteNumber(metric.value) && metric.value > 0 && move !== 1) metrics[field] = { ...metric, value: metric.value * move };
    }
  }
  return { ...row, metrics, ...(extended ? { extended } : {}) };
}

/** The last overlay per snapshot row, so a row whose quote did not move keeps its object. */
const liveRows = new WeakMap<ScreenRow, { quote: Quote | null; row: LiveScreenRow }>();

/** Where each quote key sits in a rows array: a screen's rows are replaced as a whole, so this is read once per array. */
const rowPositions = new WeakMap<readonly ScreenRow[], Map<string, number[]>>();

function positionsByQuoteKey(rows: readonly ScreenRow[]): Map<string, number[]> {
  let positions = rowPositions.get(rows);
  if (!positions) {
    positions = new Map();
    rows.forEach((row, index) => {
      const key = screenRowQuoteKey(row);
      const at = positions!.get(key);
      if (at) at.push(index);
      else positions!.set(key, [index]);
    });
    rowPositions.set(rows, positions);
  }
  return positions;
}

/**
 * The rows with their quotes laid over them. Only the rows a quote names are
 * touched, so a long list costs what its quotes do, and the same array comes
 * back while none of them moved a row (a tick for a row off the loaded pages,
 * or one that changes none of what the row shows).
 */
function overlayRows(
  rows: readonly ScreenRow[],
  quotes: Iterable<readonly [string, Quote | null | undefined]>,
): readonly LiveScreenRow[] {
  const positions = positionsByQuoteKey(rows);
  let next: LiveScreenRow[] | null = null;
  for (const [key, quote] of quotes) {
    if (quote === undefined) continue;
    for (const index of positions.get(key) ?? []) {
      const row = rows[index]!;
      let live: LiveScreenRow;
      const cached = liveRows.get(row);
      if (cached && cached.quote === quote) live = cached.row;
      else {
        live = overlayLiveScreenRow(row, quote);
        liveRows.set(row, { quote, row: live });
      }
      if (live !== (next ?? rows)[index]) (next ??= [...rows])[index] = live;
    }
  }
  return next ?? rows;
}

/** The pane's rows with the streamed quotes on screen laid over them. */
export function overlayLiveScreenRows(
  rows: readonly ScreenRow[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
): readonly LiveScreenRow[] {
  return overlayRows(rows, Array.from(entries, ([key, entry]) => [key, resolveEntryData(entry)] as const));
}

/** Rows with quotes keyed by screenRowQuoteKey laid over them, for a report. */
export function overlayScreenQuotes(rows: readonly ScreenRow[], quotes: ReadonlyMap<string, Quote>): readonly LiveScreenRow[] {
  return overlayRows(rows, quotes);
}

/** The fields a quote moves on a row (overlayLiveScreenRow). */
const LIVE_SORT_FIELDS: ReadonlySet<string> = new Set(["price", "changePercent", "volume", "marketCap", ...PRICE_MULTIPLE_FIELDS]);

/**
 * Rows in the screen's order by the figures they show. A sort on a field the
 * quotes move (price, change, volume, market cap, the P/Es and P/B) is redone on the overlaid
 * values, so the column reads monotone: GRAB's snapshot cap, two closes old,
 * kept it above MANH after its quote moved it below. Rows without a
 * value stay last, a multiple at zero or below just before them, and ties
 * keep the snapshot's order. Any other sort is the
 * snapshot's, which the overlay does not touch.
 */
export function sortLiveScreenRows<T extends ScreenRow>(rows: readonly T[], sort: ScreenDefinition["sort"]): T[] {
  if (!LIVE_SORT_FIELDS.has(sort.field)) return [...rows];
  const field = sort.field as "price" | "changePercent" | "volume" | "marketCap" | (typeof PRICE_MULTIPLE_FIELDS)[number];
  const sign = sort.direction === "desc" ? -1 : 1;
  // A multiple at zero or below follows the positive ones, either way, as the server ranks it; unknowns last.
  const lossesLast = isValuationMultiple(field);
  const band = (value: number | null | undefined) => !isFiniteNumber(value) ? 2 : lossesLast && value <= 0 ? 1 : 0;
  return rows
    .map((row, index) => ({ row, index, value: row.metrics[field]?.value }))
    .sort((a, b) => {
      const aBand = band(a.value), bBand = band(b.value);
      if (aBand !== bBand) return aBand - bBand;
      if (aBand < 2 && a.value !== b.value) return sign * (a.value! - b.value!);
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * Where each row sits in the screen's order by the figures it shows
 * (sortLiveScreenRows), by row id in that order. The pane takes it from
 * figures sampled every few seconds, so a tick reorders nothing: the rows it
 * moves are placed by it (placeLiveScreenRows), and the sort is not redone.
 */
export function liveScreenPlaces(rows: readonly ScreenRow[], sort: ScreenDefinition["sort"]): ReadonlyMap<string, number> {
  return new Map(sortLiveScreenRows(rows, sort).map((row, index) => [screenRowId(row), index]));
}

/** `rows` in the order of `places`; a row it does not know follows those it does, in the order it has. */
export function placeLiveScreenRows<T extends ScreenRow>(rows: readonly T[], places: ReadonlyMap<string, number>): T[] {
  const placed: Array<T | undefined> = [];
  const rest: T[] = [];
  for (const row of rows) {
    const place = places.get(screenRowId(row));
    if (place === undefined || placed[place] !== undefined) rest.push(row);
    else placed[place] = row;
  }
  const ordered: T[] = [];
  for (const row of placed) if (row !== undefined) ordered.push(row);
  return ordered.concat(rest);
}

/** The extended sessions some row has a print for, in the order their columns go. */
export function screenExtendedSessions(rows: readonly LiveScreenRow[]): ExtendedSession[] {
  return (["PRE", "POST", "OVERNIGHT"] as const).filter((session) => rows.some((row) => row.extended?.session === session));
}

/** A row's move in `session`'s print from the close in its price, when it has one. */
export function screenExtendedMove(row: LiveScreenRow, session: ExtendedSession): number | null {
  return row.extended?.session === session && isFiniteNumber(row.extended.changePercent) ? row.extended.changePercent : null;
}
