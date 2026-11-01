import { useCallback, type Dispatch } from "react";
import {
  createPaneInstance,
  findPaneInstance,
  findPrimaryPaneInstance,
  resolveFollowBindingInstance,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../../types/config";
import {
  addPaneFloating,
  addPaneToLayout,
} from "../../layout/pane-manager";
import { resolveTickerRetargetPane, retargetTickerPane } from "../../layout/ticker-retarget";
import type { PluginRegistry } from "../../plugins/registry";
import type { PinTickerOptions } from "../../types/plugin";
import { instrumentFromTicker } from "../../market-data/request-types";
import { resolveTickerForPane, type AppAction, type AppState } from "../../state/app/context";
import { recordFunctionOpen } from "../../telemetry/usage-counts";

/** Points the portfolio pane the focus follows (or the main one) at a collection. */
export function showCollectionInPortfolioPane(
  state: AppState,
  dispatch: Dispatch<AppAction>,
  collectionId: string,
): void {
  const targetPaneId = resolveFollowBindingInstance(
    state.config.layout,
    state.focusedPaneId,
    (instance) => instance.paneId === "portfolio-list",
  )?.instanceId
    ?? findPrimaryPaneInstance(state.config.layout, "portfolio-list")?.instanceId
    ?? null;
  if (!targetPaneId) return;
  dispatch({ type: "UPDATE_PANE_STATE", paneId: targetPaneId, patch: { collectionId } });
}

interface CommandBarPaneActionsOptions {
  dispatch: Dispatch<AppAction>;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
}

export function useCommandBarPaneActions({
  dispatch,
  pluginRegistry,
  stateRef,
}: CommandBarPaneActionsOptions) {
  const openFixedTickerPane = useCallback((symbol: string, options?: PinTickerOptions) => {
    pluginRegistry.pinTicker(symbol, {
      floating: true,
      paneType: TICKER_RESEARCH_PANE_ID,
      forceNewPane: options?.forceNewPane,
      instrument: options?.instrument,
      listing: options?.listing,
    });
  }, [pluginRegistry]);

  const persistLayoutChange = useCallback((nextLayout: LayoutConfig) => {
    pluginRegistry.updateLayout(nextLayout);
  }, [pluginRegistry]);

  /** Pins `target` on the ticker; the focus stays on the pane it was on. */
  const retargetPane = useCallback((target: PaneInstanceConfig, symbol: string, options?: PinTickerOptions) => {
    const currentState = stateRef.current;
    // Opening a research pane is counted in pinTicker; retargeting one here is DES too.
    if (target.paneId === TICKER_RESEARCH_PANE_ID) recordFunctionOpen({ shortcut: "DES", externalPluginId: null });
    const instrument = options?.instrument !== undefined
      ? options.instrument
      : instrumentFromTicker(currentState.tickers.get(symbol))?.instrument ?? undefined;
    persistLayoutChange(retargetTickerPane(currentState.config.layout, target, symbol, {
      instrument,
      listing: options?.listing,
      previous: resolveTickerForPane(currentState, target.instanceId),
      paneDef: pluginRegistry.panes.get(target.paneId),
    }));
    dispatch({ type: "FOCUS_PANE", paneId: currentState.focusedPaneId ?? target.instanceId });
  }, [dispatch, persistLayoutChange, pluginRegistry.panes, stateRef]);

  /**
   * DES and the command bar's ticker rows: a focused Ticker Research pane changes to the ticker,
   * and from any other pane a research pane opens on it.
   */
  const focusTicker = useCallback((symbol: string, options?: PinTickerOptions) => {
    const currentState = stateRef.current;
    const focusedPane = currentState.focusedPaneId
      ? findPaneInstance(currentState.config.layout, currentState.focusedPaneId)
      : null;
    if (!options?.forceNewPane && focusedPane?.paneId === TICKER_RESEARCH_PANE_ID) {
      retargetPane(focusedPane, symbol, options);
      return;
    }
    openFixedTickerPane(symbol, options);
  }, [openFixedTickerPane, retargetPane, stateRef]);

  /**
   * Ticker search's Enter (the backtick, or the ticker in a pane's header): the focused pane
   * changes to the ticker when it shows one, with the panes linked to it (the rule is
   * `resolveTickerRetargetPane`). From any other pane it does what DES does.
   */
  const changePaneTicker = useCallback((symbol: string, options?: PinTickerOptions) => {
    const currentState = stateRef.current;
    const target = options?.forceNewPane
      ? null
      : resolveTickerRetargetPane(currentState.config.layout, currentState.focusedPaneId, pluginRegistry.panes);
    if (target) retargetPane(target, symbol, options);
    else focusTicker(symbol, options);
  }, [focusTicker, pluginRegistry.panes, retargetPane, stateRef]);

  const duplicatePane = useCallback((paneId: string) => {
    const currentState = stateRef.current;
    const pane = findPaneInstance(currentState.config.layout, paneId);
    if (!pane) return;
    const paneDef = pluginRegistry.panes.get(pane.paneId);
    if (!paneDef) return;

    const duplicate = createPaneInstance(pane.paneId, {
      title: pane.title,
      binding: pane.binding,
      params: pane.params,
      settings: pane.settings,
    });

    const { width, height } = pluginRegistry.getTermSize();
    const nextLayout = currentState.config.layout.floating.some((entry) => entry.instanceId === paneId)
      ? addPaneFloating(currentState.config.layout, duplicate, width, height, paneDef, { focusedPaneId: paneId })
      : addPaneToLayout(currentState.config.layout, duplicate, { relativeTo: paneId, position: "right" });
    persistLayoutChange(nextLayout);
    dispatch({ type: "FOCUS_PANE", paneId: duplicate.instanceId });
  }, [dispatch, persistLayoutChange, pluginRegistry, stateRef]);

  return {
    changePaneTicker,
    duplicatePane,
    focusTicker,
    persistLayoutChange,
  };
}
