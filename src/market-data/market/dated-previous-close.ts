import type { MarketDataRequestContext } from "../../types/data-provider";
import type { PricePoint, Quote } from "../../types/financials";
import { abortable, settleWithin, withDeadline } from "../../utils/async-deadline";
import { canonicalExchange } from "../../utils/exchanges";
import { logFailure } from "../../utils/log-failure";
import { dailyBarDate } from "../../utils/price-history";
import { classifyInstrumentType } from "../../tickers/instrument-kind";
import { calendarVenue, changeBasisSessionDate, isChangeBasisDatedWithoutCloses, quoteChangeBasis } from "./change-basis";
import { regularSessionCloseOn } from "./freshness";
import { cleanFloat32Price } from "../../utils/float32-price";

/** History closes come as float32 (30.93000030517578) where the quote says 30.93: one close. */
const SAME_CLOSE_RELATIVE = 1e-5;
/**
 * An index's previous close and its daily close of that day closer than this,
 * as a share of the close, are one close told twice (a feed that rounds to a
 * decimal): a hundredth of a percent, the precision a day change is shown to.
 */
const SAME_INDEX_CLOSE_RELATIVE = 1e-4;
/**
 * How long a reading that named no day, corrected an index's close, or found
 * no official close yet for a closed B3 session stands before the closes are
 * read again: a history a session behind catches up, a failed read is
 * retried, a correction is checked again.
 */
const UNDATED_RETRY_MS = 10 * 60_000;
/** Readings kept at once; the oldest goes first. */
const MAX_READINGS = 2_000;
/** Daily histories read at once. */
const MAX_READS_IN_FLIGHT = 6;
/**
 * Index checks read at once, in a pool of their own: a board of the world's
 * indices (`fn WEI`) checks two dozen at the same time, each one small read.
 */
const MAX_INDEX_READS_IN_FLIGHT = 32;
/**
 * The longest a caller waits for an index check. Gloom Cloud measures an
 * index's move from its previous session's bar already: this check stands
 * behind it, so it must never make a board of indices slow.
 */
const INDEX_CHECK_WAIT_MS = 300;
/** How long one read may take before its slot goes to the next: a hung read must not stall the rest. */
const READ_DEADLINE_MS = 10_000;

/** The listing a quote was asked for, as its daily closes are read: its context names a broker's contract. */
export interface DatedCloseListing {
  symbol: string;
  exchange: string;
  context?: MarketDataRequestContext;
}

/** A listing's recent daily closes (a month is enough), with the flags that say a bar had not closed yet. */
export type ReadDailyCloses = (listing: DatedCloseListing) => Promise<readonly DailyClose[]>;
type DailyClose = Pick<PricePoint, "date" | "close" | "partial" | "unsettled"> & Partial<Pick<PricePoint, "open" | "high" | "low">> & { volume?: number };

export interface PreviousCloseDatesOptions {
  /** Called with the latest copy of a quote, dated, when a read lands that names its day. */
  onDated?: (listing: DatedCloseListing, quote: Quote) => void;
  now?: () => number;
  maxReadsInFlight?: number;
  readDeadlineMs?: number;
  /** The longest `settle` waits for index checks (INDEX_CHECK_WAIT_MS). */
  indexWaitMs?: number;
}

type ReadingFields = Pick<Reading, "date" | "close" | "sessionClose" | "awaitsSessionClose" | "untraded" | "session">;

interface Reading {
  date: string | null;
  /**
   * The listing's daily close on `date`, when the quote's own previous close
   * disagrees with it: an index's, whose move is then measured from it.
   */
  close?: number;
  /** The official close of the quote's own session, from its daily bar, where the quote ends on a later print (B3). */
  sessionClose?: number;
  /** A closed quote on such a venue whose session's bar was not in the history yet: read again until it lands. */
  awaitsSessionClose?: boolean;
  /**
   * A thin listing that did not trade in the session its venue's calendar
   * puts before the move's, whose earlier closes do not hold its previous
   * close either (ThinPreviousTrade): no day can be named for it.
   */
  untraded?: boolean;
  /**
   * A quote its source left behind its listing's daily bars (laggingSession):
   * the later session whose close is its price, that bar's range, and the
   * day the listing last traded when nothing traded in it.
   */
  session?: LaggingSession;
  at: number;
}

interface LaggingSession {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  nominal?: { lastTraded: string | null };
}

/**
 * Venues whose quoted previous close is the exchange's official close, not
 * the last trade its daily bar closes on, with how far apart the two can be:
 * the BMV's closing auction gave WALMEX 53.57 on Thu 5 Nov 2026 beside a
 * 53.68 last trade. The bar of the trading weekday right before the move's
 * session still dates it, when the two are that close.
 */
const OFFICIAL_PREVIOUS_CLOSE_VENUES: ReadonlyMap<string, number> = new Map([["BMV", 0.01]]);

/**
 * Venues whose closed quote can end on a print after the closing call while
 * the daily bar is the official close, as history and the portfolio read it:
 * B3's PETR4 quoted R$45.36 on Fri 6 Nov 2026 beside a R$45.30 close.
 */
export const DAILY_BAR_CLOSE_VENUES: ReadonlySet<string> = new Set(["B3"]);

/**
 * A session volume below which a share or fund on a venue whose calendar
 * dates its moves may not have traded in the session before: its daily closes
 * are read to find its previous trade (thinPreviousTrade). B95 on SGX traded
 * 3,661 units on Fri 6 Nov 2026 and last before that on 22 Oct, while the
 * calendar put its move "vs Thu 5 Nov".
 */
const THIN_SESSION_VOLUME = 50_000;

/** A close this far from the quote's price is another unit's or another listing's, never the session's. */
const MAX_SESSION_CLOSE_MOVE = 0.25;

/** One listing whatever spelling of its exchange a request used. */
export function datedCloseListingKey(listing: DatedCloseListing): string {
  return `${listing.symbol.trim().toUpperCase()}|${canonicalExchange(listing.exchange)}`;
}

function sameClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * SAME_CLOSE_RELATIVE;
}

/**
 * What dates a quote's previous close by its listing's daily closes, or
 * checks an index's dated one against them: the listing, the session the
 * move is dated to and the close itself. Null for any other quote something
 * else dates (its venue's calendar, a coin's UTC day, a future's terms, a
 * close the source dated), one with no move from a previous close, and an
 * option, whose chain would read a history per contract. The instrument type
 * and the venue's calendar are checked first, since this runs on every tick.
 */
function readingKey(quote: Quote | null | undefined, listing: DatedCloseListing, now: number): string | null {
  if (!quote || classifyInstrumentType(quote.instrumentType) === "option") return null;
  // A stale share or fund may stand at a price its venue set in a later session than its source dated (laggingSession).
  if (laggingQuote(quote)) return `${datedCloseListingKey(listing)}|${changeBasisSessionDate(quote)}|${quote.price}|${quote.previousClose}|lagging`;
  // An index's dated close is checked against its daily close of that day as well (indexCloseOn), but for a Cboe
  // index's, which Gloom Cloud checks against Cboe's own closes.
  if (datedIndexClose(quote)) return calendarVenue(quote) === "CBOE" ? null : datedReadingKey(quote, listing);
  if (isChangeBasisDatedWithoutCloses(quote, now)) return thinListingCalendarDate(quote) ? `${datedReadingKey(quote, listing)}|thin` : null;
  if (quoteChangeBasis(quote)?.kind !== "previous close") return null;
  return datedReadingKey(quote, listing);
}

/**
 * The session a venue's calendar puts before a thin listing's move, for a
 * share or fund whose completed session traded under THIN_SESSION_VOLUME:
 * such a listing may not have traded in it, which only its daily closes say.
 * Null for any other quote, so a board of busy listings reads no history.
 */
function thinListingCalendarDate(quote: Quote): string | null {
  const kind = classifyInstrumentType(quote.instrumentType);
  if (kind !== "equity" && kind !== "fund") return null;
  if (quote.marketState === "REGULAR" || quote.previousCloseDate) return null;
  if (!(typeof quote.volume === "number" && quote.volume >= 0 && quote.volume < THIN_SESSION_VOLUME)) return null;
  const basis = quoteChangeBasis(quote);
  return basis?.kind === "close" && basis.venue ? basis.date : null;
}

/**
 * A share or fund whose source marked its quote stale, outside a regular
 * session: its venue may have set nominal prices in the sessions since (HKEX
 * does for a counter nothing traded on), which its daily bars carry while the
 * quote keeps the day of its last print. 9042.HK, the USD counter of a
 * bitcoin fund, read on Sun 8 Nov 2026: Fri 6 Nov's nominal 1.172 against
 * Thu 5 Nov's 1.244, dated Wed 4 Nov by its last print.
 */
function laggingQuote(quote: Quote): boolean {
  const kind = classifyInstrumentType(quote.instrumentType);
  if ((kind !== "equity" && kind !== "fund") || quote.stale !== true || quote.marketState === "REGULAR" || quote.delisting) return false;
  return quote.price > 0 && typeof quote.previousClose === "number" && quote.previousClose > 0 && !!changeBasisSessionDate(quote);
}

function datedReadingKey(quote: Quote, listing: DatedCloseListing): string | null {
  const previousClose = quote.previousClose;
  const sessionDate = changeBasisSessionDate(quote);
  if (previousClose == null || !Number.isFinite(previousClose) || !sessionDate) return null;
  // A session read while it traded has no close yet: once closed it is read again for its official close.
  const closed = DAILY_BAR_CLOSE_VENUES.has(calendarVenue(quote)) && quote.marketState === "CLOSED" ? "|closed" : "";
  return `${datedCloseListingKey(listing)}|${sessionDate}|${previousClose}${closed}`;
}

/**
 * The closed daily bars of a history, dated where the listing trades: by the
 * venue whose calendar its sessions follow (HKSE's bars by HKEX's zone, not
 * UTC). A bar whose period had not ended when it was served (`partial`), or a
 * future's session awaiting settlement, is no close: a copy kept from the
 * session before (a US holiday) must never stand for that session's close.
 */
function closedBars(points: readonly DailyClose[], quote: Quote): Array<{ date: string; close: number; point: DailyClose }> {
  const venue = calendarVenue(quote);
  return points.flatMap((point) => {
    const time = new Date(point.date).getTime();
    if (point.partial || point.unsettled || !Number.isFinite(time) || !Number.isFinite(point.close)) return [];
    return [{ date: dailyBarDate(time, venue), close: point.close, point }];
  });
}

const positiveBarPrice = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? cleanFloat32Price(value) : undefined;

/**
 * The session a lagging quote's price is from (laggingQuote): the listing's
 * latest daily bar, when it is later than the session the quote is dated to,
 * its close is the quote's price and the bar before it closed at the quote's
 * previous close. A bar with no volume is a nominal price, nothing having
 * traded: the reading then names the latest day the bars show a trade. Null
 * when the bars do not say so, and the quote stands as its source dated it.
 */
function laggingSession(points: readonly DailyClose[], quote: Quote): ReadingFields | null {
  const quoted = changeBasisSessionDate(quote);
  const bars = closedBars(points, quote).sort((left, right) => left.date.localeCompare(right.date));
  const last = bars.at(-1);
  const before = bars.at(-2);
  if (!quoted || !last || !before || last.date <= quoted) return null;
  if (!sameClose(last.close, quote.price) || !sameClose(before.close, quote.previousClose!)) return null;
  const traded = (bar: { point: DailyClose }) => typeof bar.point.volume === "number" && bar.point.volume > 0;
  if (last.point.volume === 0) {
    return { date: before.date, session: { date: last.date, volume: 0, nominal: { lastTraded: bars.findLast(traded)?.date ?? null } } };
  }
  const { open, high, low, volume } = last.point;
  return {
    date: before.date,
    session: {
      date: last.date,
      ...positiveBarPrice(open) != null ? { open: positiveBarPrice(open) } : {},
      ...positiveBarPrice(high) != null ? { high: positiveBarPrice(high) } : {},
      ...positiveBarPrice(low) != null ? { low: positiveBarPrice(low) } : {},
      ...typeof volume === "number" && Number.isFinite(volume) ? { volume } : {},
    },
  };
}

/**
 * The day of the latest daily close before the move's session, when that
 * close is the quote's previous close; null otherwise, so a gap in the
 * history never names the wrong day.
 */
function latestCloseBefore(points: readonly DailyClose[], quote: Quote): string | null {
  const sessionDate = changeBasisSessionDate(quote)!;
  const before = closedBars(points, quote)
    .filter((point) => point.date < sessionDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1);
  if (!before) return null;
  if (sameClose(before.close, quote.previousClose!)) return before.date;
  const apart = OFFICIAL_PREVIOUS_CLOSE_VENUES.get(calendarVenue(quote));
  return apart != null && before.date === weekdayBefore(sessionDate)
    && Math.abs(before.close - quote.previousClose!) <= before.close * apart ? before.date : null;
}

/** The weekday before a local `YYYY-MM-DD`: Friday for a Monday. */
function weekdayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  do day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

/**
 * The official close of a closed quote's own session on a venue whose quote
 * can end on a later print (DAILY_BAR_CLOSE_VENUES): the session's finished
 * daily bar, when it differs from the quote's price; undefined when it does
 * not. `awaits` when the history has no finished bar of that session yet.
 */
function sessionCloseOf(points: readonly DailyClose[], quote: Quote): { close?: number; awaits?: true } {
  if (quote.marketState !== "CLOSED" || !DAILY_BAR_CLOSE_VENUES.has(calendarVenue(quote))) return {};
  if (typeof quote.regularClose === "number" && quote.regularClose > 0) return {};
  const sessionDate = changeBasisSessionDate(quote);
  if (!sessionDate) return {};
  const bar = closedBars(points, quote).findLast((point) => point.date === sessionDate && point.close > 0);
  if (!bar) return { awaits: true };
  if (!(quote.price > 0) || sameClose(bar.close, quote.price)) return {};
  const close = cleanFloat32Price(bar.close);
  return Math.abs(close / quote.price - 1) <= MAX_SESSION_CLOSE_MOVE ? { close } : {};
}

/**
 * The day an index quote's move is measured from, when something dates it
 * (its venue's calendar, the sessions its source sent): the day whose close
 * its previous close must be. Null for any other quote.
 */
function datedIndexClose(quote: Quote): string | null {
  if (classifyInstrumentType(quote.instrumentType) !== "index") return null;
  const basis = quoteChangeBasis(quote);
  return basis?.kind === "close" ? basis.date : null;
}

/**
 * An index's previous close is its previous session's
 * close: the listing's daily close on the day its move is dated from, when
 * the closes hold that day. On Fri 6 Nov 2026 a source's quote of the Hang
 * Seng said 23,919.5, Wed 4 Nov's close, "vs Thu 5 Nov close", while its daily
 * close of Thu 5 Nov, the one HP charts, was 24,796.98: +2.35% beside -1.27%.
 * The reading names the day either way, and the close when it disagrees.
 */
function indexCloseOn(points: readonly DailyClose[], quote: Quote, date: string): { date: string | null; close?: number } {
  const bar = closedBars(points, quote).findLast((point) => point.close > 0 && point.date === date);
  if (!bar) return { date: null };
  // Bars come as float32 (24796.98046875): the close is the decimal it is, as Gloom Cloud serves it.
  const close = cleanFloat32Price(bar.close);
  const previousClose = quote.previousClose!;
  return Math.abs(previousClose - close) <= close * SAME_INDEX_CLOSE_RELATIVE ? { date } : { date, close };
}

/**
 * A thin listing's previous trade, where it is earlier than the session its
 * venue's calendar puts before the move's: the day of its latest daily close
 * before the move's session that traded, when that close is its previous
 * close. When it traded in the calendar's session the calendar stands
 * (date null), and so it does when the calendar's session closed at the
 * previous close with nothing traded: the venue's nominal price of that day
 * (83042.HK's 8.315 on Thu 5 Nov 2026, its last trade on Wed 4 Nov at
 * 8.095). When its closes hold none of these, the day is unknown (`untraded`).
 */
function thinPreviousTrade(points: readonly DailyClose[], quote: Quote, calendarDate: string): ReadingFields {
  const sessionDate = changeBasisSessionDate(quote)!;
  const traded = new Set(points.filter((point) => point.volume == null || point.volume > 0).map((point) => point.date.valueOf()));
  const before = closedBars(points.filter((point) => traded.has(point.date.valueOf())), quote)
    .filter((point) => point.date < sessionDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1);
  if (!before || before.date >= calendarDate) return { date: null };
  if (sameClose(before.close, quote.previousClose!)) return { date: before.date };
  const nominal = closedBars(points, quote).findLast((point) => point.date === calendarDate);
  return nominal && sameClose(nominal.close, quote.previousClose!) ? { date: null } : { date: null, untraded: true };
}

function readingOf(points: readonly DailyClose[], quote: Quote): ReadingFields {
  const indexDate = datedIndexClose(quote);
  if (indexDate) return indexCloseOn(points, quote, indexDate);
  const lagging = laggingQuote(quote) ? laggingSession(points, quote) : null;
  if (lagging) return lagging;
  const calendarDate = thinListingCalendarDate(quote);
  if (calendarDate) return thinPreviousTrade(points, quote, calendarDate);
  const session = sessionCloseOf(points, quote);
  return {
    date: latestCloseBefore(points, quote),
    ...session.close != null ? { sessionClose: session.close } : {},
    ...session.awaits ? { awaitsSessionClose: true } : {},
  };
}

function withDate<T extends Quote | null | undefined>(quote: T, date: string | null | undefined): T {
  return date && quote ? { ...quote, previousCloseDate: date } : quote;
}

/** The quote as a reading has it: dated, and for an index measured from that day's close when its own disagrees. */
function withReading<T extends Quote | null | undefined>(quote: T, reading: Pick<Reading, "date" | "close" | "sessionClose" | "untraded" | "session"> | undefined): T {
  if (!quote || !reading) return quote;
  if (reading.untraded) return { ...quote, previousCloseUndated: true };
  if (reading.session && reading.date) return withDate(withLaggingSession(quote, reading.session), reading.date);
  const closed = withSessionClose(quote, reading.sessionClose);
  return closed === quote ? withDatedReading(quote, reading) : withDatedReading(closed as T, reading);
}

/**
 * A lagging quote as its bars date it: the later session's, as of that
 * session's close, with that bar's range and volume. A nominal price has no
 * range: nothing traded. No longer stale, the bars being as new as the venue's
 * latest session.
 */
function withLaggingSession<T extends Quote>(quote: T, session: LaggingSession): T {
  const closedAt = regularSessionCloseOn(calendarVenue(quote), session.date);
  return {
    ...quote,
    changeSessionDate: session.date,
    stale: false,
    lastUpdated: closedAt ?? quote.lastUpdated,
    open: session.open,
    high: session.high,
    low: session.low,
    volume: session.volume,
    ...session.nominal ? { nominalPrice: session.nominal } : {},
  };
}

/** A closed quote that ended on a later print headlines its session's official close, as history and the portfolio read it. */
function withSessionClose<T extends Quote>(quote: T, close: number | undefined): T {
  const sessionDate = close != null && quote.marketState === "CLOSED" && !(typeof quote.regularClose === "number" && quote.regularClose > 0)
    ? changeBasisSessionDate(quote) : null;
  return sessionDate ? { ...quote, regularClose: close, regularCloseSessionDate: sessionDate } : quote;
}

function withDatedReading<T extends Quote | null | undefined>(quote: T, reading: Pick<Reading, "date" | "close"> | undefined): T {
  if (!quote || !reading?.date) return quote;
  if (reading.close == null) return withDate(quote, reading.date);
  const close = reading.close;
  const change = quote.price - close;
  // A completed session's move of the same day is measured from it too: getRegularSessionDisplay rebuilds it.
  const sameSession = quote.regularCloseSessionDate != null && quote.regularCloseSessionDate === quote.changeSessionDate;
  return {
    ...quote,
    previousClose: close,
    previousCloseDate: reading.date,
    change,
    changePercent: (change / close) * 100,
    ...(sameSession ? { regularChange: undefined, regularChangePercent: undefined } : {}),
  };
}

/**
 * Dates the previous close a quote's move is from where the venue's calendar
 * cannot (LSE and Helsinki publish none the app carries), by the listing's
 * own daily closes, so every surface that reads quotes through the app's
 * quote router names the day (`quoteChangeBasis`), and an index's move is
 * measured from its previous session's close (indexCloseOn). The closes are read once
 * per listing, session and close, and the answer is kept: a refresh, a tick
 * or a cached read of the same quote is dated without another read. A few
 * reads run at once, each for at most ten seconds; index checks run in a
 * wider pool of their own.
 */
export class PreviousCloseDates {
  private readonly readings = new Map<string, Reading>();
  private readonly pending = new Map<string, Promise<ReadingFields>>();
  /** The latest copy of each quote a read is pending for, which the read dates when it lands. */
  private readonly latestCopies = new Map<string, { quote: Quote; listing: DatedCloseListing }>();
  /** Dating reads and index checks queue apart, so neither waits behind the other. */
  private readonly pools: Record<"dating" | "index", { active: number; waiting: Array<() => void>; max: number }>;
  private readonly now: () => number;
  private readonly readDeadlineMs: number;
  private readonly indexWaitMs: number;

  constructor(private readonly readCloses: ReadDailyCloses, private readonly options: PreviousCloseDatesOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const max = options.maxReadsInFlight ?? MAX_READS_IN_FLIGHT;
    this.pools = {
      dating: { active: 0, waiting: [], max },
      index: { active: 0, waiting: [], max: Math.max(max, MAX_INDEX_READS_IN_FLIGHT) },
    };
    this.readDeadlineMs = options.readDeadlineMs ?? READ_DEADLINE_MS;
    this.indexWaitMs = options.indexWaitMs ?? INDEX_CHECK_WAIT_MS;
  }

  /** The quote dated by what was already read for it; as it was when nothing was. Never reads. */
  known<T extends Quote | null | undefined>(quote: T, listing: DatedCloseListing): T {
    const key = readingKey(quote, listing, this.now());
    return key ? withReading(quote, this.readings.get(key)) : quote;
  }

  /**
   * The quote dated by what was already read for it, starting the read when
   * no reading for it stands. Never waits: the read dates the copies after
   * it, and `onDated` the latest one.
   */
  observe<T extends Quote | null | undefined>(quote: T, listing: DatedCloseListing): T {
    const key = readingKey(quote, listing, this.now());
    if (!key) return quote;
    const reading = this.readings.get(key);
    if (!this.stands(reading)) void this.start(key, quote!, listing);
    return withReading(quote, reading);
  }

  /**
   * Starts the reads these quotes need and waits for them, at most `waitMs`
   * in all and no longer than `signal` lets it; `known` then dates them.
   * Index checks run side by side and are waited for at most `indexWaitMs`.
   */
  async settle(
    entries: ReadonlyArray<{ quote: Quote; listing: DatedCloseListing }>,
    { waitMs, signal }: { waitMs: number; signal?: AbortSignal },
  ): Promise<void> {
    if (signal?.aborted) return;
    const reads: Promise<unknown>[] = [];
    const checks: Promise<unknown>[] = [];
    for (const { quote, listing } of entries) {
      const key = readingKey(quote, listing, this.now());
      if (key && !this.stands(this.readings.get(key))) (datedIndexClose(quote) ? checks : reads).push(this.start(key, quote, listing));
    }
    const within = (all: Promise<unknown>[], ms: number) => all.length
      ? settleWithin(abortable(Promise.all(all), signal, "Stopped waiting for daily closes"), ms) : null;
    await Promise.all([within(reads, waitMs), within(checks, Math.min(waitMs, this.indexWaitMs))]);
  }

  /**
   * Whether a reading answers without another read: a day it named that
   * agreed with the quote's close, or any other reading taken lately. A
   * correction (an index's close the quote disagreed with) is read again as
   * an undated one is, so a wrong close cannot stand for the session, and so
   * is a closed B3 quote's whose session's official close had not landed.
   */
  private stands(reading: Reading | undefined): boolean {
    return !!reading && ((!!reading.date && reading.close == null && !reading.awaitsSessionClose)
      || this.now() - reading.at < UNDATED_RETRY_MS);
  }

  private start(key: string, quote: Quote, listing: DatedCloseListing): Promise<ReadingFields> {
    this.latestCopies.set(key, { quote, listing });
    return this.pending.get(key) ?? this.read(key, quote, listing);
  }

  private read(key: string, quote: Quote, listing: DatedCloseListing): Promise<ReadingFields> {
    const read = this.inSlot(datedIndexClose(quote) ? "index" : "dating", () => withDeadline(Promise.resolve().then(() => this.readCloses(listing)), this.readDeadlineMs, "Reading daily closes timed out"))
      .then((points) => readingOf(points, quote))
      .catch(logFailure("market-data.dated-previous-close", "Read daily closes failed", { date: null } as ReadingFields))
      .then((reading) => {
        this.pending.delete(key);
        this.readings.delete(key);
        if (this.readings.size >= MAX_READINGS) this.readings.delete(this.readings.keys().next().value!);
        this.readings.set(key, { ...reading, at: this.now() });
        const latest = this.latestCopies.get(key);
        this.latestCopies.delete(key);
        if ((reading.date || reading.sessionClose != null || reading.untraded || reading.session) && latest && this.options.onDated) {
          try {
            this.options.onDated(latest.listing, withReading(latest.quote, reading));
          } catch (error) {
            logFailure("market-data.dated-previous-close", "Passing on a dated quote failed")(error);
          }
        }
        return reading;
      });
    this.pending.set(key, read);
    return read;
  }

  private async inSlot<T>(kind: "dating" | "index", work: () => Promise<T>): Promise<T> {
    const pool = this.pools[kind];
    if (pool.active < pool.max) pool.active += 1;
    else await new Promise<void>((resolve) => pool.waiting.push(resolve));
    try {
      return await work();
    } finally {
      // A finished read hands its slot to the next one waiting.
      const next = pool.waiting.shift();
      if (next) next();
      else pool.active -= 1;
    }
  }
}
