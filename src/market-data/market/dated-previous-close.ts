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
 * What dates a quote's previous close by its listing's daily closes: the
 * listing, the session the move is dated to and the close itself. Null for a
 * quote something else dates (its venue's calendar, a coin's UTC day, a
 * future's terms, a close the source dated), one with no move from a previous
 * close, and an option, whose chain would read a history per contract. The
 * venue's calendar is checked first, since this runs on every tick.
 */
function readingKey(quote: Quote | null | undefined, listing: DatedCloseListing, now: number): string | null {
  if (!quote || isChangeBasisDatedWithoutCloses(quote, now) || classifyInstrumentType(quote.instrumentType) === "option") return null;
  if (quoteChangeBasis(quote)?.kind !== "previous close") return null;
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

function withDate<T extends Quote | null | undefined>(quote: T, date: string | null | undefined): T {
  return date && quote ? { ...quote, previousCloseDate: date } : quote;
}

/**
 * Dates the previous close a quote's move is from where the venue's calendar
 * cannot (LSE and Helsinki publish none the app carries), by the listing's
 * own daily closes, so every surface that reads quotes through the app's
 * quote router names the day (`quoteChangeBasis`). The closes are read once
 * per listing, session and close, and the answer is kept: a refresh, a tick
 * or a cached read of the same quote is dated without another read. A few
 * reads run at once, each for at most ten seconds.
 */
export class PreviousCloseDates {
  private readonly readings = new Map<string, Reading>();
  private readonly pending = new Map<string, Promise<string | null>>();
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
    return key ? withDate(quote, this.readings.get(key)?.date) : quote;
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
    return withDate(quote, reading?.date);
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
    const reads: Promise<string | null>[] = [];
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

  private start(key: string, quote: Quote, listing: DatedCloseListing): Promise<string | null> {
    this.latestCopies.set(key, { quote, listing });
    return this.pending.get(key) ?? this.read(key, quote, listing);
  }

  private read(key: string, quote: Quote, listing: DatedCloseListing): Promise<string | null> {
    const read = this.inSlot(() => withDeadline(Promise.resolve().then(() => this.readCloses(listing)), this.readDeadlineMs, "Reading daily closes timed out"))
      .then((points) => latestCloseBefore(points, quote))
      .catch(logFailure("market-data.dated-previous-close", "Read daily closes failed", null))
      .then((date) => {
        this.pending.delete(key);
        this.readings.delete(key);
        if (this.readings.size >= MAX_READINGS) this.readings.delete(this.readings.keys().next().value!);
        this.readings.set(key, { date, at: this.now() });
        const latest = this.latestCopies.get(key);
        this.latestCopies.delete(key);
        if (date && latest && this.options.onDated) {
          try {
            this.options.onDated(latest.listing, withDate(latest.quote, date));
          } catch (error) {
            logFailure("market-data.dated-previous-close", "Passing on a dated quote failed")(error);
          }
        }
        return date;
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
