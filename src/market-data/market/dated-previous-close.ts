import type { MarketDataRequestContext } from "../../types/data-provider";
import type { PricePoint, Quote } from "../../types/financials";
import { abortable, settleWithin, withDeadline } from "../../utils/async-deadline";
import { canonicalExchange } from "../../utils/exchanges";
import { logFailure } from "../../utils/log-failure";
import { dailyBarDate } from "../../utils/price-history";
import { classifyInstrumentType } from "../../tickers/instrument-kind";
import { calendarVenue, changeBasisSessionDate, isChangeBasisDatedWithoutCloses, quoteChangeBasis } from "./change-basis";
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
 * How long a reading that named no day, or corrected an index's close,
 * stands before the closes are read again: a history a session behind
 * catches up, a failed read is retried, a correction is checked again.
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
type DailyClose = Pick<PricePoint, "date" | "close" | "partial" | "unsettled">;

export interface PreviousCloseDatesOptions {
  /** Called with the latest copy of a quote, dated, when a read lands that names its day. */
  onDated?: (listing: DatedCloseListing, quote: Quote) => void;
  now?: () => number;
  maxReadsInFlight?: number;
  readDeadlineMs?: number;
  /** The longest `settle` waits for index checks (INDEX_CHECK_WAIT_MS). */
  indexWaitMs?: number;
}

interface Reading {
  date: string | null;
  /**
   * The listing's daily close on `date`, when the quote's own previous close
   * disagrees with it: an index's, whose move is then measured from it.
   */
  close?: number;
  at: number;
}

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
  // An index's dated close is checked against its daily close of that day as well (indexCloseOn), but for a Cboe
  // index's, which Gloom Cloud checks against Cboe's own closes.
  if (datedIndexClose(quote)) return calendarVenue(quote) === "CBOE" ? null : datedReadingKey(quote, listing);
  if (isChangeBasisDatedWithoutCloses(quote, now)) return null;
  if (quoteChangeBasis(quote)?.kind !== "previous close") return null;
  return datedReadingKey(quote, listing);
}

function datedReadingKey(quote: Quote, listing: DatedCloseListing): string | null {
  const previousClose = quote.previousClose;
  const sessionDate = changeBasisSessionDate(quote);
  if (previousClose == null || !Number.isFinite(previousClose) || !sessionDate) return null;
  return `${datedCloseListingKey(listing)}|${sessionDate}|${previousClose}`;
}

/**
 * The closed daily bars of a history, dated where the listing trades: by the
 * venue whose calendar its sessions follow (HKSE's bars by HKEX's zone, not
 * UTC). A bar whose period had not ended when it was served (`partial`), or a
 * future's session awaiting settlement, is no close: a copy kept from the
 * session before (a US holiday) must never stand for that session's close.
 */
function closedBars(points: readonly DailyClose[], quote: Quote): Array<{ date: string; close: number }> {
  const venue = calendarVenue(quote);
  return points.flatMap((point) => {
    const time = new Date(point.date).getTime();
    if (point.partial || point.unsettled || !Number.isFinite(time) || !Number.isFinite(point.close)) return [];
    return [{ date: dailyBarDate(time, venue), close: point.close }];
  });
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
  return before && sameClose(before.close, quote.previousClose!) ? before.date : null;
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

function readingOf(points: readonly DailyClose[], quote: Quote): { date: string | null; close?: number } {
  const indexDate = datedIndexClose(quote);
  return indexDate ? indexCloseOn(points, quote, indexDate) : { date: latestCloseBefore(points, quote) };
}

function withDate<T extends Quote | null | undefined>(quote: T, date: string | null | undefined): T {
  return date && quote ? { ...quote, previousCloseDate: date } : quote;
}

/** The quote as a reading has it: dated, and for an index measured from that day's close when its own disagrees. */
function withReading<T extends Quote | null | undefined>(quote: T, reading: Pick<Reading, "date" | "close"> | undefined): T {
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
  private readonly pending = new Map<string, Promise<Pick<Reading, "date" | "close">>>();
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
   * an undated one is, so a wrong close cannot stand for the session.
   */
  private stands(reading: Reading | undefined): boolean {
    return !!reading && ((!!reading.date && reading.close == null) || this.now() - reading.at < UNDATED_RETRY_MS);
  }

  private start(key: string, quote: Quote, listing: DatedCloseListing): Promise<Pick<Reading, "date" | "close">> {
    this.latestCopies.set(key, { quote, listing });
    return this.pending.get(key) ?? this.read(key, quote, listing);
  }

  private read(key: string, quote: Quote, listing: DatedCloseListing): Promise<Pick<Reading, "date" | "close">> {
    const read = this.inSlot(datedIndexClose(quote) ? "index" : "dating", () => withDeadline(Promise.resolve().then(() => this.readCloses(listing)), this.readDeadlineMs, "Reading daily closes timed out"))
      .then((points) => readingOf(points, quote))
      .catch(logFailure("market-data.dated-previous-close", "Read daily closes failed", { date: null }))
      .then((reading) => {
        this.pending.delete(key);
        this.readings.delete(key);
        if (this.readings.size >= MAX_READINGS) this.readings.delete(this.readings.keys().next().value!);
        this.readings.set(key, { ...reading, at: this.now() });
        const latest = this.latestCopies.get(key);
        this.latestCopies.delete(key);
        if (reading.date && latest && this.options.onDated) {
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
