import type { MarketDataRequestContext } from "../../types/data-provider";
import type { PricePoint, Quote } from "../../types/financials";
import { abortable, settleWithin, withDeadline } from "../../utils/async-deadline";
import { canonicalExchange } from "../../utils/exchanges";
import { logFailure } from "../../utils/log-failure";
import { dailyBarDate } from "../../utils/price-history";
import { classifyInstrumentType } from "../../tickers/instrument-kind";
import { changeBasisSessionDate, isChangeBasisDatedWithoutCloses, quoteChangeBasis } from "./change-basis";

/** History closes come as float32 (30.93000030517578) where the quote says 30.93: one close. */
const SAME_CLOSE_RELATIVE = 1e-5;
/**
 * An index's previous close and its daily close of that day closer than this,
 * as a share of the close, are one close told twice (a feed that rounds to a
 * decimal): a hundredth of a percent, the precision a day change is shown to.
 */
const SAME_INDEX_CLOSE_RELATIVE = 1e-4;
/**
 * How long a reading that named no day stands before the closes are read
 * again: a history a session behind catches up, a failed read is retried.
 */
const UNDATED_RETRY_MS = 10 * 60_000;
/** Readings kept at once; the oldest goes first. */
const MAX_READINGS = 2_000;
/** Daily histories read at once. */
const MAX_READS_IN_FLIGHT = 6;
/** How long one read may take before its slot goes to the next: a hung read must not stall the rest. */
const READ_DEADLINE_MS = 10_000;

/** The listing a quote was asked for, as its daily closes are read: its context names a broker's contract. */
export interface DatedCloseListing {
  symbol: string;
  exchange: string;
  context?: MarketDataRequestContext;
}

/** A listing's recent daily closes (a month is enough). */
export type ReadDailyCloses = (listing: DatedCloseListing) => Promise<readonly Pick<PricePoint, "date" | "close">[]>;

export interface PreviousCloseDatesOptions {
  /** Called with the latest copy of a quote, dated, when a read lands that names its day. */
  onDated?: (listing: DatedCloseListing, quote: Quote) => void;
  now?: () => number;
  maxReadsInFlight?: number;
  readDeadlineMs?: number;
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
  // An index's dated close is checked against its daily close of that day as well (indexCloseOn).
  if (datedIndexClose(quote)) return datedReadingKey(quote, listing);
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
 * The day of the latest daily close before the move's session, when that
 * close is the quote's previous close; null otherwise, so a gap in the
 * history never names the wrong day.
 */
function latestCloseBefore(points: readonly Pick<PricePoint, "date" | "close">[], quote: Quote): string | null {
  const sessionDate = changeBasisSessionDate(quote)!;
  const exchange = quote.listingExchangeName ?? quote.exchangeName ?? "";
  const before = points
    .map((point) => ({ time: new Date(point.date).getTime(), close: point.close }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.close))
    .map((point) => ({ date: dailyBarDate(point.time, exchange), close: point.close }))
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
function indexCloseOn(points: readonly Pick<PricePoint, "date" | "close">[], quote: Quote, date: string): { date: string | null; close?: number } {
  const exchange = quote.listingExchangeName ?? quote.exchangeName ?? "";
  const bar = points
    .map((point) => ({ time: new Date(point.date).getTime(), close: point.close }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.close) && point.close > 0)
    .findLast((point) => dailyBarDate(point.time, exchange) === date);
  if (!bar) return { date: null };
  const previousClose = quote.previousClose!;
  return Math.abs(previousClose - bar.close) <= bar.close * SAME_INDEX_CLOSE_RELATIVE ? { date } : { date, close: bar.close };
}

function readingOf(points: readonly Pick<PricePoint, "date" | "close">[], quote: Quote): { date: string | null; close?: number } {
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
 * reads run at once, each for at most ten seconds.
 */
export class PreviousCloseDates {
  private readonly readings = new Map<string, Reading>();
  private readonly pending = new Map<string, Promise<Pick<Reading, "date" | "close">>>();
  /** The latest copy of each quote a read is pending for, which the read dates when it lands. */
  private readonly latestCopies = new Map<string, { quote: Quote; listing: DatedCloseListing }>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private readonly now: () => number;
  private readonly maxReadsInFlight: number;
  private readonly readDeadlineMs: number;

  constructor(private readonly readCloses: ReadDailyCloses, private readonly options: PreviousCloseDatesOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxReadsInFlight = options.maxReadsInFlight ?? MAX_READS_IN_FLIGHT;
    this.readDeadlineMs = options.readDeadlineMs ?? READ_DEADLINE_MS;
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
   */
  async settle(
    entries: ReadonlyArray<{ quote: Quote; listing: DatedCloseListing }>,
    { waitMs, signal }: { waitMs: number; signal?: AbortSignal },
  ): Promise<void> {
    if (signal?.aborted) return;
    const reads: Promise<unknown>[] = [];
    for (const { quote, listing } of entries) {
      const key = readingKey(quote, listing, this.now());
      if (key && !this.stands(this.readings.get(key))) reads.push(this.start(key, quote, listing));
    }
    if (reads.length) await settleWithin(abortable(Promise.all(reads), signal, "Stopped waiting for daily closes"), waitMs);
  }

  /** Whether a reading answers without another read: a day it named, or no day named lately. */
  private stands(reading: Reading | undefined): boolean {
    return !!reading && (!!reading.date || this.now() - reading.at < UNDATED_RETRY_MS);
  }

  private start(key: string, quote: Quote, listing: DatedCloseListing): Promise<Pick<Reading, "date" | "close">> {
    this.latestCopies.set(key, { quote, listing });
    return this.pending.get(key) ?? this.read(key, quote, listing);
  }

  private read(key: string, quote: Quote, listing: DatedCloseListing): Promise<Pick<Reading, "date" | "close">> {
    const read = this.inSlot(() => withDeadline(Promise.resolve().then(() => this.readCloses(listing)), this.readDeadlineMs, "Reading daily closes timed out"))
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

  private async inSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.maxReadsInFlight) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      // A finished read hands its slot to the next one waiting.
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
