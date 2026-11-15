import { instrumentFromTicker, type InstrumentRef } from "../../market-data/request-types";
import { hasValidQuoteObservationTime, isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { savedCopyAt } from "../../data/saved-copies";
import type { AppConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { formatClockTime, formatShortDate } from "../../utils/datetime-format";
import { canonicalExchange } from "../../utils/exchanges";
import { instrumentIdentityKey } from "../../utils/instrument-identity";
import { isRecord } from "../../utils/guards";

/**
 * What moved in the user's own tickers since their last visit. A visit keeps
 * the last price it had of each listing in the user's portfolios and
 * watchlists; the next visit compares the price it has now with that one.
 * A move is only ever the difference between two prices of the same listing,
 * in the same currency and on the same basis, the newer printed after the
 * older; a listing with no such pair has no move, never a zero.
 */

/** Listings a visit keeps, portfolios first: one batch of quotes, and a small row in the state store. */
const MAX_TRACKED_LISTINGS = 50;
/** Less time away than this is the same visit (a restart, an update). */
export const MIN_AWAY_MS = 60 * 60_000;
/** The smallest move, in percent either way, the strip names. */
const MIN_MOVE_PERCENT = 1;
/** The most moves the strip names; a narrow window shows fewer. */
const MAX_STRIP_MOVES = 5;

/** One price of a listing, as a visit keeps it for the next one. */
export interface VisitObservation {
  /** The key the ticker is saved under (`TickerMetadata.ticker`). */
  symbol: string;
  price: number;
  currency: string;
  /** What the price counts: `per-unit`, `percent-of-par`, `points`, `thirty-seconds`, or a fund's `nav`. */
  basis: string;
  /** The listing's venue as the quote named it, canonical; empty when it named none. */
  venue: string;
  /** When the source printed the price (the quote's `lastUpdated`), epoch ms. */
  at: number;
  /** The quote came from the session a split took effect in, so a price from before it is on another share basis. */
  split?: true;
}

/** What a visit leaves for the next one. */
export interface VisitBaseline {
  /** The account the prices were seen under (`visitScope`): another account never reads them. */
  scope: string;
  /** The last moment the user was in the app with these prices. */
  seenAt: number;
  /** By listing (`instrumentIdentityKey`). */
  observations: Record<string, VisitObservation>;
}

export interface VisitMove {
  /** The listing (`instrumentIdentityKey`). */
  key: string;
  symbol: string;
  /** Percent from the last visit's price to the current one, when the recap was made. */
  percent: number;
  /** The last visit's price, which the move keeps being measured from. */
  before: VisitObservation;
}

/** The return recap: the moves since `seenAt`, biggest first. */
export interface VisitRecap {
  seenAt: number;
  moves: VisitMove[];
}

export interface TrackedListing {
  key: string;
  symbol: string;
  instrument: InstrumentRef;
}

/** Whose prices a visit keeps: the signed-in account, or this device signed out. */
export function visitScope(accountId: string | null | undefined): string {
  return accountId ? `account:${accountId}` : "local";
}

/** Option contracts move by tens of percent on a quiet day; the strip is about tickers. */
const OPTION_CATEGORIES = new Set(["OPT", "FOP"]);

/**
 * The listings in the user's own portfolios and watchlists, holdings first,
 * at most `limit`. Collections shared with a team (the server keeps their
 * rows) and portfolios imported from someone else's filing are not the
 * user's own and are left out, as is a ticker whose listing is ambiguous.
 */
export function trackedListings(
  config: Pick<AppConfig, "portfolios" | "watchlists">,
  tickers: ReadonlyMap<string, TickerRecord>,
  limit = MAX_TRACKED_LISTINGS,
): TrackedListing[] {
  const portfolios = new Set(config.portfolios.filter((entry) => !entry.teamId && !entry.importedFrom).map((entry) => entry.id));
  const watchlists = new Set(config.watchlists.filter((entry) => !entry.teamId).map((entry) => entry.id));
  const held: TrackedListing[] = [];
  const watched: TrackedListing[] = [];
  const seen = new Set<string>();
  for (const [symbol, ticker] of tickers) {
    const metadata = ticker.metadata;
    if (OPTION_CATEGORIES.has(metadata.assetCategory?.toUpperCase() ?? "")) continue;
    const inPortfolio = metadata.portfolios.some((id) => portfolios.has(id));
    const inWatchlist = metadata.watchlists.some((id) => watchlists.has(id));
    if (!inPortfolio && !inWatchlist) continue;
    const instrument = instrumentFromTicker(ticker, symbol);
    if (!instrument) continue;
    const key = instrumentIdentityKey(instrument);
    if (seen.has(key)) continue;
    seen.add(key);
    (inPortfolio ? held : watched).push({ key, symbol, instrument });
  }
  return [...held, ...watched].slice(0, Math.max(0, limit));
}

/**
 * A quote as a price the user can be said to have seen, or null when it is
 * not one: no positive price or currency, no valid print time, stale for its
 * market's current session, answered from a saved copy after a refresh
 * failed, a nominal price nothing traded at, or a line that stopped trading.
 */
export function observeQuote(symbol: string, quote: Quote | null | undefined, now: number): VisitObservation | null {
  if (!quote) return null;
  if (!Number.isFinite(quote.price) || quote.price <= 0) return null;
  if (typeof quote.currency !== "string" || !quote.currency.trim()) return null;
  if (!hasValidQuoteObservationTime(quote, now)) return null;
  if (quote.nominalPrice || quote.delisting || savedCopyAt(quote) != null) return null;
  if (isQuoteStaleForCurrentSession(quote, now)) return null;
  return {
    symbol,
    price: quote.price,
    currency: quote.currency.trim(),
    basis: quote.priceObservation === "nav" ? "nav" : quote.priceBasis ?? "per-unit",
    venue: canonicalExchange(quote.listingExchangeName || quote.exchangeName || ""),
    at: quote.lastUpdated,
    ...(quote.sessionSplit ? { split: true as const } : {}),
  };
}

/**
 * Share counts a split multiplies by: a price that moved by one of these
 * (or its inverse, a reverse split) cannot be told from a split, and a move
 * that is a split was never made.
 */
const SPLIT_FACTORS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100, 1.5];
const SPLIT_TOLERANCE = 0.01;

function looksLikeSplit(ratio: number): boolean {
  return SPLIT_FACTORS.some((factor) => (
    Math.abs(ratio * factor - 1) <= SPLIT_TOLERANCE || Math.abs(ratio / factor - 1) <= SPLIT_TOLERANCE
  ));
}

/**
 * Percent from `before` to `after`, or null when the two are not two prices
 * of one listing that can be compared: another ticker, currency, basis or
 * venue, a print no newer than the one before, either side in a split's
 * session, or a ratio a split would give.
 */
export function moveSince(before: VisitObservation, after: VisitObservation): number | null {
  if (before.symbol !== after.symbol || before.currency !== after.currency
    || before.basis !== after.basis || before.venue !== after.venue) return null;
  if (before.split || after.split) return null;
  if (!(after.at > before.at)) return null;
  if (!(before.price > 0) || !(after.price > 0)) return null;
  const ratio = after.price / before.price;
  if (!Number.isFinite(ratio) || looksLikeSplit(ratio)) return null;
  return (ratio - 1) * 100;
}

/**
 * The moves since `baseline` for the listings still tracked, from the
 * prices on hand now (`current`, by listing): the ones of at least
 * `minPercent` either way, biggest first, at most `limit`. Null when
 * there is no baseline, the user was away less than `minAwayMs`, or
 * nothing moved enough; the strip then does not show.
 */
export function recapSince(
  baseline: VisitBaseline | null,
  tracked: readonly TrackedListing[],
  current: ReadonlyMap<string, VisitObservation>,
  now: number,
  { minAwayMs = MIN_AWAY_MS, minPercent = MIN_MOVE_PERCENT, limit = MAX_STRIP_MOVES } = {},
): VisitRecap | null {
  if (!baseline || !(now - baseline.seenAt >= minAwayMs)) return null;
  const moves: VisitMove[] = [];
  for (const listing of tracked) {
    const before = baseline.observations[listing.key];
    const after = current.get(listing.key);
    if (!before || !after) continue;
    const percent = moveSince(before, after);
    if (percent == null || !(Math.abs(percent) >= minPercent)) continue;
    moves.push({ key: listing.key, symbol: listing.symbol, percent, before });
  }
  if (moves.length === 0) return null;
  moves.sort((left, right) => Math.abs(right.percent) - Math.abs(left.percent) || left.symbol.localeCompare(right.symbol));
  return { seenAt: baseline.seenAt, moves: moves.slice(0, Math.max(0, limit)) };
}

/**
 * A recap's move as of now, so a strip left up for hours keeps saying what
 * is true rather than a number from its first second: measured again from
 * the last visit's price to the quote on hand, or as it was when the recap
 * was made while no current price is on hand (a stale or missing quote).
 * Null once the quote on hand is a price the last one no longer compares
 * with (another currency, a split): the move is not shown at all.
 */
export function liveMovePercent(move: VisitMove, quote: Quote | null | undefined, now: number): number | null {
  const after = observeQuote(move.symbol, quote, now);
  return after ? moveSince(move.before, after) : move.percent;
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DAY_MS = 24 * 60 * 60_000;

function localDayStart(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * When the last visit was, as the strip dates its moves, in local time on
 * the 24-hour clock: `09:30` earlier today, `yesterday 16:05`, `Wed 16:05`
 * within the week, then the day (`4 Nov`, `4 Nov 2025` in another year).
 */
export function formatVisitTime(seenAt: number, now: number): string {
  const days = Math.round((localDayStart(now) - localDayStart(seenAt)) / DAY_MS);
  const clock = formatClockTime(seenAt);
  if (days <= 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  if (days < 7) return `${WEEKDAY.format(new Date(seenAt))} ${clock}`;
  const sameYear = new Date(seenAt).getFullYear() === new Date(now).getFullYear();
  return formatShortDate(seenAt, { year: sameYear ? false : "numeric" });
}

/** The most observations a stored baseline is read with, whatever it holds. */
const MAX_STORED_OBSERVATIONS = MAX_TRACKED_LISTINGS * 2;

function readObservation(value: unknown): VisitObservation | null {
  if (!isRecord(value)) return null;
  const { symbol, price, currency, basis, venue, at, split } = value;
  if (typeof symbol !== "string" || !symbol || typeof currency !== "string" || !currency
    || typeof basis !== "string" || !basis || typeof venue !== "string") return null;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  return { symbol, price, currency, basis, venue, at, ...(split === true ? { split: true as const } : {}) };
}

/** A stored baseline as this build reads it: null unless it is whole and belongs to `scope`. */
export function readVisitBaseline(value: unknown, scope: string): VisitBaseline | null {
  if (!isRecord(value) || value.scope !== scope || !isRecord(value.observations)) return null;
  const seenAt = value.seenAt;
  if (typeof seenAt !== "number" || !Number.isFinite(seenAt) || seenAt <= 0) return null;
  const observations: Record<string, VisitObservation> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value.observations)) {
    if (count >= MAX_STORED_OBSERVATIONS) break;
    const observation = readObservation(entry);
    if (!key || !observation) continue;
    observations[key] = observation;
    count += 1;
  }
  return { scope, seenAt, observations };
}
