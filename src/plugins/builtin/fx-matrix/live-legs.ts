import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { isStreamCarryingQuote } from "../shared/use-quote-board";
import { fxPrintTradingDay, fxTradingDay, fxTradingDayAt } from "../../../utils/fx-market-hours";
import { delayedFeedLagMs } from "../../../market-data/market/freshness";
import { savedCopyAt } from "../../../data/saved-copies";

/** Currencies the market quotes as USD per unit; the rest quote as units per USD. */
const USD_QUOTED = new Set(["EUR", "GBP", "AUD", "NZD"]);

export interface FxLeg {
  currency: string;
  /** The pair as the market quotes it: EURUSD=X, or JPY=X for USD/JPY. */
  symbol: string;
  /** The pair quotes units per USD, so USD per unit is its inverse. */
  inverted: boolean;
}

/** One quoted pair per non-USD currency; every cross in the matrix derives from these legs. */
export function fxLegs(currencies: readonly string[]): FxLeg[] {
  return currencies.flatMap((currency) => {
    if (currency === "USD") return [];
    const inverted = !USD_QUOTED.has(currency);
    return [{ currency, symbol: inverted ? `${currency}=X` : `${currency}USD=X`, inverted }];
  });
}

export function fxLegTargets(legs: readonly FxLeg[], selectedCurrency: string | null): QuoteSubscriptionTarget[] {
  return legs.map((leg) => ({
    symbol: leg.symbol,
    exchange: "",
    surface: "screener",
    visible: true,
    selected: leg.currency === selectedCurrency,
    weight: leg.currency === selectedCurrency ? 100 : 70,
  }));
}

export function fxLegQuoteKey(leg: FxLeg): string {
  return buildQuoteKey({ symbol: leg.symbol, exchange: "" });
}

/**
 * The USD-per-unit rate a live pair quote implies, as an entry in the same
 * shape as the snapshot rates, so status and export read both alike. A quote
 * the connection marked stale, or older than the snapshot, gives way to it.
 */
export function liveFxLegEntry(
  leg: FxLeg,
  entry: QueryEntry<Quote> | undefined,
  snapshot: QueryEntry<number> | null | undefined,
): QueryEntry<number> | null {
  const quote = resolveEntryData(entry);
  if (!quote || quote.stale === true || !Number.isFinite(quote.price) || quote.price <= 0) return null;
  const observedAt = Number.isFinite(quote.lastUpdated) ? quote.lastUpdated : null;
  if (observedAt == null) return null;
  const snapshotAsOf = snapshot?.asOf ?? null;
  if (snapshotAsOf != null && Number.isFinite(snapshotAsOf) && observedAt < snapshotAsOf) return null;
  const rate = leg.inverted ? 1 / quote.price : quote.price;
  return {
    phase: "ready",
    data: rate,
    lastGoodData: rate,
    // What the data is, never where it came from.
    source: quote.dataSource === "live" || quote.dataSource === "delayed" ? quote.dataSource : null,
    fetchedAt: quote.receivedAt ?? observedAt,
    asOf: observedAt,
    staleAt: null,
    error: null,
    attempts: [],
  };
}

/**
 * When the rate a leg draws was saved, if it is a copy shown because its
 * refresh failed (offline, a hung or refused connection), or null for a
 * current one: the pair quote's own mark when `liveQuote` draws the leg, else
 * the loaded rate's last fetch once a refresh of it failed.
 */
export function fxLegSavedAt(liveQuote: Quote | null | undefined, rate: QueryEntry<number> | null | undefined): number | null {
  if (liveQuote) return savedCopyAt(liveQuote);
  return rate?.error && resolveEntryData(rate) != null && rate.fetchedAt != null ? rate.fetchedAt : null;
}

/**
 * The legs the feed is not carrying, whose snapshot rates a reload has to
 * stand in for. With streaming off the legs' own quote poll is the feed.
 */
export function fxLegsBehind(
  legs: readonly FxLeg[],
  entries: ReadonlyMap<string, QueryEntry<Quote>>,
  feed: { liveStreaming: boolean; liveCurrencies: ReadonlySet<string>; startedAt: number; now: number },
): string[] {
  return legs.filter((leg) => {
    const entry = entries.get(fxLegQuoteKey(leg));
    if (!feed.liveStreaming) return !(feed.liveCurrencies.has(leg.currency) && (entry?.fetchedAt ?? 0) >= feed.startedAt);
    return !isStreamCarryingQuote(entry, feed.startedAt, feed.now);
  }).map((leg) => leg.currency);
}

/** USD per unit at the pair's previous close: a rate that holds still for the session. */
export function fxLegReferenceRate(leg: FxLeg, entry: QueryEntry<Quote> | undefined): number | null {
  const close = resolveEntryData(entry)?.previousClose;
  if (close == null || !Number.isFinite(close) || close <= 0) return null;
  return leg.inverted ? 1 / close : close;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The FX trading day a pair quote's move is of: the day its source dated
 * (`changeSessionDate`), else the day of its print, which turns at 17:00 New
 * York. Null for a stale quote, or an undated print made while the market was
 * shut, which is of no trading day.
 */
function fxLegMoveDay(quote: Quote | null | undefined): string | null {
  if (!quote || quote.stale === true || !Number.isFinite(quote.lastUpdated)) return null;
  if (quote.changeSessionDate && ISO_DATE.test(quote.changeSessionDate)) return quote.changeSessionDate;
  return fxPrintTradingDay(quote.lastUpdated);
}

/** How far behind the present a leg's quote is held: a delayed feed's lag, none for a live one. */
function legDelayMs(quote: Quote | null | undefined): number {
  return quote?.dataSource === "delayed" ? delayedFeedLagMs(quote.listingExchangeName || quote.exchangeName || "CCY") : 0;
}

/**
 * The one FX trading day a board's moves are read on, from the clock: the
 * day the market is on as the legs' feed shows it, `now` less the longest
 * delay among their quotes, or the Friday that closed the week while FX is
 * shut (fxTradingDayAt). A leg's quote is never trusted to set it, so a leg
 * dated ahead of the clock, or on a weekend, cannot move the board's close:
 * only its own move goes blank (fxLegMoveReference).
 */
export function fxBoardMoveDay(quotes: Iterable<QueryEntry<Quote> | undefined>, now = Date.now()): string | null {
  let delay = 0;
  for (const entry of quotes) delay = Math.max(delay, legDelayMs(resolveEntryData(entry)));
  return fxTradingDayAt(now - delay);
}

/**
 * What a leg's move is read against: its pair quote's previous daily close
 * (USD per unit), the close `quote` measures the pair from, whichever rate
 * the board draws. A loaded rate a minute newer than the quote moves from the
 * same close, so it reads against it too, as long as it is of the quote's FX
 * trading day. Null when the quote is stale or carries no previous close,
 * when the drawn rate is of a later trading day (or undated) than the quote,
 * or when the quote's move is not of the board's day (`boardDay`,
 * fxBoardMoveDay): a quote dated ahead of it or on a weekend, or a thin pair
 * that has not printed since the day turned, whose move is the day before's.
 */
export function fxLegMoveReference(
  leg: FxLeg,
  entry: QueryEntry<Quote> | undefined,
  drawn: Pick<QueryEntry<number>, "asOf"> | null | undefined,
  boardDay: string | null,
): { rate: number; quote: Quote } | null {
  const quote = resolveEntryData(entry);
  const rate = fxLegReferenceRate(leg, entry);
  if (!quote || quote.stale === true || rate == null || !Number.isFinite(quote.lastUpdated)) return null;
  if (boardDay == null || fxLegMoveDay(quote) !== boardDay) return null;
  const drawnAt = drawn?.asOf;
  if (drawnAt == null || !Number.isFinite(drawnAt) || fxTradingDay(drawnAt) !== fxTradingDay(quote.lastUpdated)) return null;
  return { rate, quote };
}
