import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../../../../api-client";
import { loadPurchaseDateCostFx, purchaseDatesToRead, type PurchaseDateCostFx } from "../../../../portfolio/cost-fx";
import type { TickerRecord } from "../../../../types/ticker";

/** A past close does not change; a date that could not be read is tried again this often. */
const REFRESH_MS = 30 * 60_000;
const NO_RATES: PurchaseDateCostFx = new Map();

/**
 * The FX closes of the purchase dates of the portfolio's dated lots, as
 * `portfolio show` reads them, so their cost converts at the rate of the day
 * they were bought into `into`, the currency the pane values the portfolio
 * in. Read again only when the dated lots or the currency change. Nothing is
 * read for a portfolio with no such lot.
 */
export function usePurchaseDateCostFx(
  tickers: readonly TickerRecord[],
  { enabled, portfolioId, into }: { enabled: boolean; portfolioId: string; into: string },
): PurchaseDateCostFx {
  const key = useMemo(() => enabled ? [...purchaseDatesToRead(tickers, into, portfolioId).keys()].sort().join(",") : "", [enabled, into, portfolioId, tickers]);
  const tickersRef = useRef(tickers);
  tickersRef.current = tickers;
  // Rates are by currency and date, so those read before a lot was added still hold while the new date is read.
  const scope = `${into}|${portfolioId}`;
  const [state, setState] = useState<{ scope: string; rates: PurchaseDateCostFx }>({ scope: "", rates: NO_RATES });
  const [refresh, setRefresh] = useState(0);
  const complete = !!key && state.scope === scope && key.split(",").every((date) => state.rates.has(date));

  useEffect(() => {
    if (!key || complete) return;
    const timer = setInterval(() => setRefresh((count) => count + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [complete, key]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void loadPurchaseDateCostFx(tickersRef.current, { into, history: apiClient, portfolioId }).then((rates) => {
      if (!cancelled) setState({ scope: `${into}|${portfolioId}`, rates });
    });
    return () => { cancelled = true; };
  }, [into, key, portfolioId, refresh]);

  return key && state.scope === scope ? state.rates : NO_RATES;
}
