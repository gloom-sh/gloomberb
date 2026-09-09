import type { EarningsEvent, MarketDataRequestContext } from "../../types/data-provider";
import { shouldLogProviderError } from "../provider-errors";
import type { ProviderRouterCoreDeps } from "./route-types";

export class ProviderRouterSupplementalRoutes {
  constructor(private readonly deps: ProviderRouterCoreDeps) {}

  async getEarningsCalendar(
    symbols: string[],
    context?: MarketDataRequestContext,
  ): Promise<EarningsEvent[]> {
    const remaining = new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    );
    if (remaining.size === 0) return [];

    const eventsBySymbol = new Map<string, EarningsEvent>();
    let supported = false;
    let succeeded = false;
    let lastError: unknown = null;

    for (const provider of this.deps.providersInPriorityOrder()) {
      if (!provider.getEarningsCalendar || remaining.size === 0) continue;
      supported = true;
      try {
        const events = await provider.getEarningsCalendar([...remaining], context);
        succeeded = true;
        for (const event of events) {
          const symbol = event.symbol.trim().toUpperCase();
          if (!remaining.has(symbol)) continue;
          eventsBySymbol.set(symbol, event);
          remaining.delete(symbol);
        }
      } catch (error) {
        lastError = error;
        if (shouldLogProviderError(error)) {
          this.deps.logProviderError(`${provider.id} failed: ${error}`);
        }
      }
    }

    if (eventsBySymbol.size > 0 || succeeded) {
      return [...eventsBySymbol.values()]
        .sort((a, b) => a.earningsDate.getTime() - b.earningsDate.getTime());
    }
    if (lastError) throw lastError;
    if (!supported) throw new Error("No earnings calendar provider available");
    return [];
  }

}
