import type { QueryEntry } from "../../../market-data/result-types";
import type { Quote } from "../../../types/financials";
import { isFxMarketOpen } from "../../../utils/fx-market-hours";
import { quoteFreshnessFields } from "../shared/report-freshness";

/** The venue FX pairs trade on, so a report can place the matrix's market. */
const FX_VENUE = "CCY";

/**
 * One rate the matrix draws, in the fields a report reads to date it: when it
 * was observed, whether it is live or delayed (and by how much), whether it is
 * stale, and where its market stands. The pane publishes these for `fn FXC`
 * and `shot FXC`; they are not shown in the pane.
 */
type FxRateObservation = {
  currency: string;
  /** ISO time of the observation; absent when the rate carries none. */
  quoteTime?: string;
  dataSource?: "live" | "delayed";
  delayMinutes?: number;
  stale: boolean;
  sessionExchange: string;
  marketState: NonNullable<Quote["marketState"]>;
};

function isoTime(time: number | undefined | null): string | undefined {
  return time != null && Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * The observation behind each rate the matrix shows, except USD (the base,
 * observed nowhere) and a currency with no usable rate (drawn as a dash).
 *
 * A rate read from a live pair quote (`legQuote`) says what that quote says:
 * live or delayed, by how much, and its market state. Any other rate is the
 * loaded snapshot: a snapshot refreshed on a schedule, so delayed, dated by
 * the snapshot's own observation time and placed on the FX week, which runs
 * Sunday 17:00 to Friday 17:00 New York time. A rate is stale when its entry
 * says so (a failed refresh, or its own schedule), as the pane's footer counts.
 */
export function fxRateObservations(
  currencies: readonly string[],
  rates: ReadonlyMap<string, number>,
  read: (currency: string) => { entry?: QueryEntry<number> | null; legQuote?: Quote | null },
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
    return [{
      currency,
      ...(quoteTime ? { quoteTime } : {}),
      dataSource: fields?.dataSource ?? "delayed",
      ...(fields?.delayMinutes ? { delayMinutes: fields.delayMinutes } : {}),
      stale: entryStale || fields?.stale === true,
      sessionExchange: fields?.sessionExchange ?? FX_VENUE,
      marketState: fields?.marketState ?? (isFxMarketOpen(now) ? "REGULAR" : "CLOSED"),
    }];
  });
}
