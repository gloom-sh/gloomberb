import { intradayBarText } from "../../../market-data/quotes/intraday-bar";
import type { Quote, QuoteIntradayBar } from "../../../types/financials";
import { isFxMarketOpen } from "../../../utils/fx-market-hours";
import { quoteFreshnessFields } from "./report-freshness";

/** The venue FX pairs trade on, so a report can place the FX market. */
const FX_VENUE = "CCY";

/**
 * One rate in the fields a report reads to date it: when it was observed,
 * whether it is live or delayed (and by how much), whether it is stale, and
 * where its market stands. The FX matrix publishes these for `fn FXC` and
 * `shot FXC`, and `fx` states its pair by them; the matrix does not show them.
 */
export type FxRateObservation = {
  currency: string;
  /** ISO time of the observation; absent when the rate carries none. */
  quoteTime?: string;
  dataSource?: "live" | "delayed";
  delayMinutes?: number;
  stale: boolean;
  sessionExchange: string;
  marketState: NonNullable<Quote["marketState"]>;
};

/**
 * What a loaded exchange rate says about its timing: a query entry, or a
 * cached value (with its `refreshError` as `error`).
 */
export interface FxRateTiming {
  asOf?: number;
  staleAt?: number | null;
  error?: unknown;
  /** How far the snapshot runs behind the market, as the data service states it; 0 is real-time. */
  delayMinutes?: number;
  /** The pair's bar the rate is the close of, when the data service took one over a print that had stopped behind it. */
  intradayBar?: QuoteIntradayBar;
  /** Why a stale rate stands, as the data service states it. */
  staleReason?: string;
}

/**
 * What the loaded USD rates behind a pair say of themselves, one line per
 * rate (`BRL/USD: ...`): the bar a rate is the close of, and, for a stale
 * rate, why it stands (its bars had nothing newer, or did not load). A rate
 * whose own refresh failed is stale for that reason, so it states none.
 */
export function fxRateNotes(legs: ReadonlyMap<string, FxRateTiming>, now = Date.now()): string[] {
  return [...legs].flatMap(([currency, timing]) => {
    if (currency === "USD") return [];
    const stale = timing.staleAt != null && timing.staleAt <= now;
    return [
      ...timing.intradayBar ? [`${currency}/USD: ${intradayBarText(timing.intradayBar)}`] : [],
      ...stale && timing.error == null && timing.staleReason ? [`${currency}/USD: ${timing.staleReason}`] : [],
    ];
  });
}

function isoTime(time: number | undefined | null): string | undefined {
  return time != null && Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * The observation behind each rate, except USD (the base, observed nowhere)
 * and a currency with no usable rate (drawn as a dash).
 *
 * A rate read from a live pair quote (`legQuote`) says what that quote says:
 * live or delayed, by how much, and its market state. Any other rate is the
 * loaded snapshot: a snapshot refreshed on a schedule, dated by the
 * snapshot's own observation time and held back by the delay the data service
 * states for it (live when that is 0, delayed without a length for an entry
 * that states none), and placed on the FX week, which runs Sunday 17:00 to
 * Friday 17:00 New York time. A rate is stale when its entry says so (a
 * failed refresh, or its own schedule), as the pane's footer counts.
 */
export function fxRateObservations(
  currencies: readonly string[],
  rates: ReadonlyMap<string, number>,
  read: (currency: string) => { entry?: FxRateTiming | null; legQuote?: Quote | null },
  now = Date.now(),
): FxRateObservation[] {
  return [...new Set(currencies)].flatMap((currency) => {
    if (currency === "USD") return [];
    const rate = rates.get(currency);
    if (rate == null || !Number.isFinite(rate) || rate <= 0) return [];
    const { entry, legQuote } = read(currency);
    const fields = legQuote ? quoteFreshnessFields(legQuote, now) : null;
    const entryStale = entry?.error != null || (entry?.staleAt != null && entry.staleAt <= now);
    const quoteTime = isoTime(entry?.asOf ?? legQuote?.lastUpdated);
    const delayMinutes = fields ? fields.delayMinutes : entry?.delayMinutes;
    return [{
      currency,
      ...(quoteTime ? { quoteTime } : {}),
      dataSource: fields?.dataSource ?? (!fields && entry?.delayMinutes === 0 ? "live" : "delayed"),
      ...(delayMinutes ? { delayMinutes } : {}),
      stale: entryStale || fields?.stale === true,
      sessionExchange: fields?.sessionExchange ?? FX_VENUE,
      marketState: fields?.marketState ?? (isFxMarketOpen(now) ? "REGULAR" : "CLOSED"),
    }];
  });
}

/**
 * The one observation a pair is when it is crossed from its legs' rates: as
 * old as its oldest dated leg, as held back as its most delayed leg (live only
 * when every leg is), and stale when any leg is. Null when no leg is observed.
 */
export function fxPairObservation(legs: readonly FxRateObservation[]): FxRateObservation | null {
  const first = legs[0];
  if (!first) return null;
  // ISO instants in UTC sort as the times they are.
  const oldest = legs.flatMap((leg) => leg.quoteTime ?? []).sort()[0];
  const delay = Math.max(0, ...legs.map((leg) => leg.delayMinutes ?? 0));
  return {
    currency: first.currency,
    ...(oldest ? { quoteTime: oldest } : {}),
    dataSource: legs.every((leg) => leg.dataSource === "live") ? "live" : "delayed",
    ...(delay > 0 ? { delayMinutes: delay } : {}),
    stale: legs.some((leg) => leg.stale),
    sessionExchange: first.sessionExchange,
    marketState: first.marketState,
  };
}
