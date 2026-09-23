import { useMemo } from "react";
import {
  hasAmbiguousTickerContracts,
  resolveInstrumentForPane,
  resolveListingForPane,
  tickerForInstrument,
} from "../../core/state/app/instrument";
import type { BrokerContractRef } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { resolveTickerForPane, useAppSelector, useOptionalPaneInstanceId } from "../app/context";

export interface PaneTickerIdentity {
  symbol: string | null;
  ticker: TickerRecord | null;
  /**
   * The broker contract the pane is bound to: `null` for a plain listing,
   * `undefined` while the symbol names several contracts and none is chosen.
   */
  contract: BrokerContractRef | null | undefined;
  error: string | undefined;
}

const NO_IDENTITY: PaneTickerIdentity = { symbol: null, ticker: null, contract: undefined, error: undefined };

/**
 * The pane's symbol and ticker without its financials. `usePaneTicker` also
 * observes the quote, snapshot and chart of the symbol and schedules a snapshot
 * load whenever the ticker changes, so a pane that only needs the symbol (news,
 * filings, insiders, estimates) would re-render on every quote tick of it. Use
 * this in those panes; keep `usePaneTicker` for panes that show the quote.
 */
export function usePaneTickerIdentity(paneId?: string): PaneTickerIdentity {
  const paneContextId = useOptionalPaneInstanceId();
  const needsFocusedPane = paneId == null && paneContextId == null;
  const focusedPaneId = useAppSelector((state) => (needsFocusedPane ? state.focusedPaneId : null));
  const scopedPaneId = paneId ?? paneContextId ?? focusedPaneId;
  const symbol = useAppSelector((state) => (
    scopedPaneId ? resolveTickerForPane(state, scopedPaneId) : null
  ));
  const savedTicker = useAppSelector((state) => (
    symbol ? state.tickers.get(symbol) ?? null : null
  ));
  const contract = useAppSelector((state) => (
    scopedPaneId ? resolveInstrumentForPane(state, scopedPaneId)?.instrument : undefined
  ));
  const listing = useAppSelector((state) => (scopedPaneId ? resolveListingForPane(state, scopedPaneId) : undefined));
  const ticker = useMemo(() => tickerForInstrument(savedTicker, contract, listing), [savedTicker, contract, listing]);

  return useMemo(() => {
    if (!scopedPaneId) return NO_IDENTITY;
    return {
      symbol,
      ticker,
      contract,
      error: contract === undefined && hasAmbiguousTickerContracts(savedTicker) ? "Choose a contract in search." : undefined,
    };
  }, [contract, savedTicker, scopedPaneId, symbol, ticker]);
}
