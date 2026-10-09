import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { errorMessage } from "../../../utils/errors";
import { exchangeRateMetadata } from "../../../utils/exchange-rate-snapshot";
import { fxLegReferenceRate, fxLegs, fxLegTargets, liveFxLegEntry, type FxLeg } from "./live-legs";

/** One USD leg as the board reads it: the rate it draws and where that rate came from. */
export interface FxLegReading {
  leg: FxLeg;
  /** USD per unit, from the pair quote or else the snapshot rate. */
  entry: QueryEntry<number> | null;
  /**
   * USD per unit at the pair's previous close, only when the rate is the pair
   * quote's: a snapshot rate has no previous close to read against.
   */
  reference: number | null;
  /** How far a snapshot rate is held back, when its source says. */
  delayMinutes: number | null;
}

export interface FxBoardLoad {
  legs: Map<string, FxLegReading>;
  errors: string[];
}

interface SnapshotReading {
  entry: QueryEntry<number>;
  delayMinutes: number | null;
}

/** A snapshot rate dated and checked the way the shared FX cache dates and checks it. */
async function loadSnapshot(provider: DataProvider, currency: string): Promise<SnapshotReading> {
  const fetchedAt = Date.now();
  const snapshot = await provider.getExchangeRateSnapshot?.(currency);
  const value = snapshot ?? await provider.getExchangeRate(currency);
  const rate = typeof value === "number" ? value : value.rate;
  const metadata = exchangeRateMetadata(value, currency, Date.now(), fetchedAt);
  const delay = snapshot?.delayMinutes;
  return {
    entry: {
      phase: "ready", data: rate, lastGoodData: rate, source: null,
      fetchedAt: metadata.fetchedAt ?? fetchedAt, asOf: metadata.asOf,
      staleAt: metadata.staleAt ?? null, error: null, attempts: [],
    },
    delayMinutes: typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : null,
  };
}

async function loadLegQuotes(provider: DataProvider, legs: readonly FxLeg[], forceRefresh: boolean): Promise<Map<string, Quote>> {
  const quotes = new Map<string, Quote>();
  if (provider.getQuotesBatch) {
    const results = await provider.getQuotesBatch(fxLegTargets(legs, null), { forceRefresh }).catch(() => []);
    for (const result of results) if (result.quote) quotes.set(result.target.symbol, result.quote);
    return quotes;
  }
  await Promise.all(legs.map(async (leg) => {
    const quote = await provider.getQuote(leg.symbol, "").catch(() => null);
    if (quote) quotes.set(leg.symbol, quote);
  }));
  return quotes;
}

const quoteEntry = (quote: Quote | undefined): QueryEntry<Quote> | undefined => quote ? {
  phase: "ready", data: quote, lastGoodData: quote, source: null, fetchedAt: quote.receivedAt ?? null,
  staleAt: null, error: null, attempts: [],
} : undefined;

/**
 * The board's USD legs, read the way the pane reads them: each leg's snapshot
 * rate, replaced by its pair quote when that quote is current and at least as
 * new. Only a pair quote brings the previous close a cross's move is read
 * against. A leg with neither has no rate, never parity.
 */
export async function loadFxBoard(
  currencies: readonly string[],
  provider: DataProvider,
  options: { forceRefresh?: boolean } = {},
): Promise<FxBoardLoad> {
  const legs = fxLegs(currencies);
  const errors: string[] = [];
  const [snapshots, quotes] = await Promise.all([
    Promise.all(legs.map((leg) => loadSnapshot(provider, leg.currency).catch((error: unknown) => {
      errors.push(`${leg.currency}: ${errorMessage(error)}`);
      return null;
    }))),
    loadLegQuotes(provider, legs, options.forceRefresh === true),
  ]);
  const readings = new Map<string, FxLegReading>();
  legs.forEach((leg, index) => {
    const quote = quoteEntry(quotes.get(leg.symbol));
    const snapshot = snapshots[index] ?? null;
    const live = liveFxLegEntry(leg, quote, snapshot?.entry);
    readings.set(leg.currency, {
      leg,
      entry: live ?? snapshot?.entry ?? null,
      reference: live ? fxLegReferenceRate(leg, quote) : null,
      delayMinutes: live ? null : snapshot?.delayMinutes ?? null,
    });
  });
  return { legs: readings, errors };
}
