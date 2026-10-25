import { useEffect, useMemo } from "react";
import { getSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { formatMarketPrice, quoteFormatOptions, withCurrencyMinorDigits } from "../../../../market-data/market/format";
import { buildQuoteKey, instrumentFromQuoteTarget, resolveEntryData } from "../../../../market-data/selectors";
import type { PortfolioFuturesTerms } from "../../../../portfolio/futures-positions";
import { useLiveQuoteEntries } from "../../../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import { logFailure } from "../../../../utils/log-failure";

/** Front references share one snapshot and stream per contract, independent of each row's own price. */
export function useFuturesFrontNotes(
  terms: ReadonlyMap<string, PortfolioFuturesTerms>,
  { enabled, liveStreaming }: { enabled: boolean; liveStreaming: boolean },
): ReadonlyMap<string, string> {
  const symbolsKey = useMemo(() => enabled
    ? [...new Set([...terms.values()].flatMap((value) => value.front?.contractSymbol ?? []))].sort().join("\u001f") : "", [enabled, terms]);
  const targets = useMemo<QuoteSubscriptionTarget[]>(() => symbolsKey ? symbolsKey.split("\u001f").map((symbol) => ({
    symbol, exchange: "", route: "provider", surface: "watchlist", visible: true,
  })) : [], [symbolsKey]);
  const instruments = useMemo(() => targets.map(instrumentFromQuoteTarget), [targets]);
  const coordinator = getSharedMarketDataCoordinator();
  const { entries } = useLiveQuoteEntries(targets, { liveStreaming });
  useEffect(() => {
    // Polling primes its own batch immediately; a stream needs one snapshot while connecting.
    if (!liveStreaming || !coordinator || !instruments.length) return;
    void coordinator.loadQuotesBatch(instruments).catch(logFailure("portfolio-futures", "Read front contract quotes failed"));
  }, [coordinator, instruments, liveStreaming]);
  return useMemo(() => {
    const notes = new Map<string, string>();
    if (!enabled) return notes;
    for (const [symbol, value] of terms) {
      if (!value.front) continue;
      const quote = resolveEntryData(entries.get(buildQuoteKey({ symbol: value.front.contractSymbol, exchange: "" })));
      if (!quote || !Number.isFinite(quote.price)) continue;
      const options = withCurrencyMinorDigits(quoteFormatOptions(quote, "FUTURE"), quote.currency);
      notes.set(symbol, `front ${value.front.contract} ${formatMarketPrice(quote.price, options)}`);
    }
    return notes;
  }, [enabled, entries, terms]);
}
