import { useEffect, useMemo, useRef, useState } from "react";
import { useAssetData } from "../../../runtime";
import { isFuturesTicker, type PortfolioFuturesTerms } from "../../../../portfolio/futures-positions";
import { dailyFuturesHistory, loadPortfolioFuturesTerms } from "../../../../portfolio/futures-terms";
import type { TickerRecord } from "../../../../types/ticker";

/** Settlements land once a day and the terms change with a roll; the terms cache answers sooner reads. */
const REFRESH_MS = 30 * 60_000;

export interface PaneFuturesTerms {
  /** By symbol, for the futures the collection holds; empty until they are read. */
  terms: ReadonlyMap<string, PortfolioFuturesTerms>;
  /** Moves whenever `terms` does. */
  version: number;
}

const NO_TERMS: PaneFuturesTerms = { terms: new Map(), version: 0 };

/**
 * The contract size and settlement of each future in the collection, as
 * `portfolio show` reads them, so its rows value contracts and, at the close,
 * the settlement. The settlement before the latest, which the day's move at
 * the close measures from, is read from daily bars only while `settlement` is
 * asked for. Nothing is read for a collection without futures.
 */
export function usePortfolioFuturesTerms(
  tickers: readonly TickerRecord[],
  { enabled, settlement }: { enabled: boolean; settlement: boolean },
): PaneFuturesTerms {
  const dataProvider = useAssetData();
  const futures = useMemo(() => enabled ? tickers.filter(isFuturesTicker) : [], [enabled, tickers]);
  const key = useMemo(() => futures.map((ticker) => `${ticker.metadata.ticker}@${ticker.metadata.exchange}`).sort().join("|"), [futures]);
  const futuresRef = useRef(futures);
  futuresRef.current = futures;
  const [state, setState] = useState<PaneFuturesTerms & { key: string }>({ ...NO_TERMS, key: "" });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!key) return;
    const timer = setInterval(() => setRefresh((count) => count + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const requestKey = `${key}|${settlement}`;
    void loadPortfolioFuturesTerms(futuresRef.current, {
      settlement,
      sources: dataProvider ? { history: dailyFuturesHistory(dataProvider) } : {},
    }).then((terms) => {
      if (!cancelled) setState((previous) => ({ key: requestKey, terms, version: previous.version + 1 }));
    });
    return () => { cancelled = true; };
  }, [dataProvider, key, refresh, settlement]);

  return key ? state : NO_TERMS;
}
