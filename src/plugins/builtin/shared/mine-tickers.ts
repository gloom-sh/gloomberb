import { useMemo } from "react";
import { useAppSelector } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";

export function collectMineTickers(tickers: Iterable<TickerRecord>): ReadonlySet<string> {
  const symbols = new Set<string>();
  for (const { metadata } of tickers) {
    if (metadata.portfolios.length || metadata.watchlists.length) {
      symbols.add(metadata.ticker.trim().toUpperCase());
    }
  }
  return symbols;
}

/** Portfolio and watchlist membership from the same records the portfolio pane uses. */
export function useMineTickers(): ReadonlySet<string> {
  const tickers = useAppSelector((state) => state.tickers);
  return useMemo(() => collectMineTickers(tickers.values()), [tickers]);
}
