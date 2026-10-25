import { logFailure } from "../../../utils/log-failure";
import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import { resolveEntryData } from "../../../market-data/selectors";
import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { quoteChangeBasis, type QuoteChangeBasis } from "../../../market-data/market/change-basis";
import { fxLegMoveReference, fxLegs, fxLegSavedAt, liveFxLegEntry, type FxLeg } from "./live-legs";

/** One USD leg as the board reads it: the rate it draws and where that rate came from. */
export interface FxLegReading {
  leg: FxLeg;
  /** USD per unit, from the pair quote or else the loaded rate; null when neither loaded. */
  entry: QueryEntry<number> | null;
  /** The pair quote, only when the rate is its own: it then says what the rate is (live or delayed, its session). */
  quote: Quote | null;
  /**
   * USD per unit at the pair quote's previous daily close, for the rate drawn
   * whether it is the quote's or a loaded rate of the same FX trading day
   * (fxLegMoveReference); null when the quote is stale or has none.
   */
  reference: number | null;
  /** The close `reference` is, as `quote` names it ("vs Wed 21 Oct close"). */
  changeBasis?: QuoteChangeBasis | null;
  /** Why the leg has no rate, when it has none. */
  error: string | null;
  /** When the copy the rate came from was saved, when refreshing it failed and that copy answered. */
  savedAt?: number;
}

/**
 * The board's USD legs, read once the way the pane reads them, through the
 * same market data coordinator over the same service: each leg's loaded rate
 * (`loadFxRate`, dated by the shared FX cache), replaced by its pair quote when
 * that quote is current and at least as new. The pair quote brings the
 * previous close a cross's move is read against, for either rate. A leg with
 * neither has no rate, never parity.
 */
export async function loadFxBoard(
  currencies: readonly string[],
  marketData: DataProvider,
  options: { forceRefresh?: boolean } = {},
): Promise<Map<string, FxLegReading>> {
  const coordinator = new MarketDataCoordinator(marketData);
  try {
    const legs = fxLegs(currencies);
    const forceRefresh = options.forceRefresh === true;
    const [rates, quotes] = await Promise.all([
      Promise.all(legs.map((leg) => coordinator.loadFxRate(leg.currency, { forceRefresh }))),
      // A pair quote only refines a loaded rate, so a failed batch leaves the loaded rates.
      coordinator.loadQuotesBatch(legs.map((leg) => ({ symbol: leg.symbol, exchange: "" })), { forceRefresh })
        .catch(logFailure("fx-matrix.client", "Load FX pair quotes failed", [] as QueryEntry<Quote>[])),
    ]);
    return new Map(legs.map((leg, index) => {
      const rate = rates[index]!;
      const quote = quotes[index];
      const live = liveFxLegEntry(leg, quote, rate);
      const entry = live ?? (resolveEntryData(rate) != null ? rate : null);
      const close = fxLegMoveReference(leg, quote, entry);
      // A pair quote or a loaded rate whose refresh failed is the copy saved before, not a current answer.
      const savedAt = fxLegSavedAt(live ? resolveEntryData(quote) : null, rate);
      return [leg.currency, {
        leg,
        entry,
        quote: live ? resolveEntryData(quote) : null,
        reference: close?.rate ?? null,
        changeBasis: close ? quoteChangeBasis(close.quote) : null,
        error: entry ? null : rate.error?.message ?? "No rate came back.",
        ...(savedAt != null ? { savedAt } : {}),
      }] as const;
    }));
  } finally {
    coordinator.destroy();
  }
}
