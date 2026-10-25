import type { PricePoint, Quote } from "../../types/financials";
import { settleWithin } from "../../utils/async-deadline";
import { canonicalExchange } from "../../utils/exchanges";
import { logFailure } from "../../utils/log-failure";
import { dailyBarDate } from "../../utils/price-history";
import { classifyInstrumentType } from "../../tickers/instrument-kind";
import { isFuturesInstrument } from "../futures-contract";
import { changeBasisSessionDate, quoteChangeBasis } from "./change-basis";

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

/** The listing a quote was asked for, as its daily closes are read. */
export interface DatedCloseListing {
  symbol: string;
  exchange: string;
}

/** A listing's recent daily closes (a month is enough). */
export type ReadDailyCloses = (listing: DatedCloseListing) => Promise<readonly Pick<PricePoint, "date" | "close">[]>;

interface Reading {
  date: string | null;
  at: number;
}

function sameClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * SAME_CLOSE_RELATIVE;
}

/**
 * What dates a quote's previous close by its listing's daily closes: the
 * listing, the session the move is dated to and the close itself. Null for a
 * quote whose basis is dated already (a venue calendar, a coin's UTC day, a
 * close the source dated) or that has no move from a previous close. A
 * future or an option, whose chain would read a history per contract, is
 * left as it is.
 */
function readingKey(quote: Quote | null | undefined, listing: DatedCloseListing): string | null {
  if (!quote || isFuturesInstrument(quote.symbol, quote.instrumentType) || classifyInstrumentType(quote.instrumentType) === "option") return null;
  if (quoteChangeBasis(quote)?.kind !== "previous close") return null;
  const previousClose = quote.previousClose;
  const sessionDate = changeBasisSessionDate(quote);
  if (previousClose == null || !Number.isFinite(previousClose) || !sessionDate) return null;
  return [listing.symbol.trim().toUpperCase(), canonicalExchange(listing.exchange), sessionDate, previousClose].join("|");
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
 * or a cached read of the same quote is dated without another read.
 */
export class PreviousCloseDates {
  private readonly readings = new Map<string, Reading>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly readCloses: ReadDailyCloses, private readonly now: () => number = () => Date.now()) {}

  /** The quote dated by what was already read for it; as it was when nothing was. Never reads. */
  known<T extends Quote | null | undefined>(quote: T, listing: DatedCloseListing): T {
    const key = readingKey(quote, listing);
    return key ? withDate(quote, this.readings.get(key)?.date) : quote;
  }

  /**
   * The quote dated by what was read already, starting the read when no
   * reading for it stands: for a tick, which cannot wait, so the ticks after
   * it are dated.
   */
  observe<T extends Quote | null | undefined>(quote: T, listing: DatedCloseListing): T {
    const key = readingKey(quote, listing);
    if (!key) return quote;
    const reading = this.readings.get(key);
    if (!this.stands(reading)) void (this.pending.get(key) ?? this.read(key, quote!, listing));
    return withDate(quote, reading?.date);
  }

  /**
   * The quote dated by its listing's daily closes, read unless a reading for
   * it stands. Waits at most `waitMs` for the read (to the end without): one
   * that lands later dates the quote's next copy.
   */
  async date<T extends Quote | null | undefined>(quote: T, listing: DatedCloseListing, waitMs?: number): Promise<T> {
    const key = readingKey(quote, listing);
    if (!key) return quote;
    const reading = this.readings.get(key);
    if (this.stands(reading)) return withDate(quote, reading!.date);
    const read = this.pending.get(key) ?? this.read(key, quote!, listing);
    return withDate(quote, waitMs == null ? await read : await settleWithin(read, waitMs));
  }

  /** Whether a reading answers without another read: a day it named, or no day named lately. */
  private stands(reading: Reading | undefined): boolean {
    return !!reading && (!!reading.date || this.now() - reading.at < UNDATED_RETRY_MS);
  }

  private read(key: string, quote: Quote, listing: DatedCloseListing): Promise<string | null> {
    const read = this.inSlot(() => this.readCloses(listing))
      .then((points) => latestCloseBefore(points, quote))
      .catch(logFailure("market-data.dated-previous-close", "Read daily closes failed", null))
      .then((date) => {
        this.pending.delete(key);
        this.readings.delete(key);
        if (this.readings.size >= MAX_READINGS) this.readings.delete(this.readings.keys().next().value!);
        this.readings.set(key, { date, at: this.now() });
        return date;
      });
    this.pending.set(key, read);
    return read;
  }

  private async inSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < MAX_READS_IN_FLIGHT) this.active += 1;
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
