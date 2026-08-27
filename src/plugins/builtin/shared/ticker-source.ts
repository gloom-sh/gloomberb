import { useCallback } from "react";
import { useAppStateRef, usePaneInstanceId } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { resolveTickerActivation } from "../../ticker-navigation";
import { usePluginAppActions, usePluginTickerActions } from "../../runtime";

/**
 * Shared Enter routing for panes that publish a cursor symbol: reuse the Ticker Research pane
 * already bound to this one instead of stacking another pane on top of it.
 */
export function useTickerSourceActivate(): (
  symbol: string,
  options?: { newPane?: boolean; floating?: boolean },
) => void {
  const paneId = usePaneInstanceId();
  const stateRef = useAppStateRef();
  const { pinTicker } = usePluginTickerActions();
  const { focusPane } = usePluginAppActions();

  return useCallback((symbol: string, options?: { newPane?: boolean; floating?: boolean }) => {
    const activation = resolveTickerActivation(stateRef.current.config.layout, paneId, options);
    if (activation.kind === "focus") {
      focusPane(activation.paneId);
      return;
    }
    pinTicker(symbol, {
      floating: options?.floating ?? true,
      forceNewPane: options?.newPane,
      paneType: TICKER_RESEARCH_PANE_ID,
    });
  }, [focusPane, paneId, pinTicker, stateRef]);
}
