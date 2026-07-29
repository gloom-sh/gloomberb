import { useCallback, type Dispatch } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import {
  addPaneFloating,
  addPaneToLayout,
  getDockedPaneIds,
  isPaneInLayout,
} from "../../plugins/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import { findFixedTickerPaneForSymbol } from "../../plugins/ticker-navigation";
import type { AppAction, AppState } from "../../state/app/context";
import { TICKER_RESEARCH_PANE_ID, normalizePaneId } from "../../types/config";
import type {
  LayoutConfig,
  PaneBinding,
  PaneInstanceConfig,
} from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { PinTickerOptions } from "../../types/plugin";
import {
  resolveTickerOpenTarget,
  type TickerOpenTarget,
} from "../../tickers/open-target";

interface UseAppTickerOpenRuntimeOptions {
  activatePane: (paneId: string, layout?: LayoutConfig) => void;
  buildPaneInstance: (paneType: string, options?: {
    title?: string;
    binding?: PaneBinding;
    params?: Record<string, string>;
    settings?: Record<string, unknown>;
    instanceId?: string;
  }) => PaneInstanceConfig | null;
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  focusVisiblePane: (paneId: string, layout?: LayoutConfig) => void;
  persistLayout: (layout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
  tickerRepository: AppTickerRepositoryPort;
}

export function useAppTickerOpenRuntime({
  activatePane,
  buildPaneInstance,
  dataProvider,
  dispatch,
  focusVisiblePane,
  persistLayout,
  pluginRegistry,
  stateRef,
  tickerRepository,
}: UseAppTickerOpenRuntimeOptions) {
  const resolveOpenTickerTarget = useCallback(async (rawSymbol: string): Promise<TickerOpenTarget | null> => {
    try {
      const target = await resolveTickerOpenTarget({
        query: rawSymbol,
        tickers: stateRef.current.tickers,
        dataProvider,
        tickerRepository,
      });
      if (!target) {
        pluginRegistry.notify({ body: `Could not open ${rawSymbol}.`, type: "error" });
      }
      return target;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pluginRegistry.notify({ body: `Failed to open ${rawSymbol}: ${message}`, type: "error" });
      return null;
    }
  }, [dataProvider, pluginRegistry, stateRef, tickerRepository]);

  const publishTickerOpenTarget = useCallback((target: TickerOpenTarget) => {
    const currentTicker = stateRef.current.tickers.get(target.symbol);
    if (currentTicker !== target.ticker) {
      dispatch({ type: "UPDATE_TICKER", ticker: target.ticker });
    }
    if (target.created) {
      pluginRegistry.events.emit("ticker:added", { symbol: target.symbol, ticker: target.ticker });
    }
  }, [dispatch, pluginRegistry.events, stateRef]);

  const placePinnedTickerTarget = useCallback((target: TickerOpenTarget, options?: PinTickerOptions) => {
    const paneType = normalizePaneId(options?.paneType ?? TICKER_RESEARCH_PANE_ID);
    const paneDef = pluginRegistry.panes.get(paneType);
    if (!paneDef) return;

    publishTickerOpenTarget(target);
    const symbol = target.symbol;
    const currentState = stateRef.current;
    const currentLayout = currentState.config.layout;
    const existing = options?.forceNewPane
      ? null
      : findFixedTickerPaneForSymbol(currentLayout, paneType, symbol);
    if (existing) {
      focusVisiblePane(existing.instanceId, currentLayout);
      return;
    }

    const instance = buildPaneInstance(paneType, {
      title: symbol,
      binding: { kind: "fixed", symbol },
    });
    if (!instance) return;

    const { width, height } = pluginRegistry.getTermSizeFn();
    const shouldFloat = options?.floating ?? true;
    const nextLayout = shouldFloat
      ? addPaneFloating(currentLayout, instance, width, height, paneDef)
      : addPaneToLayout(
        currentLayout,
        instance,
        {
          relativeTo: currentState.focusedPaneId && isPaneInLayout(currentLayout, currentState.focusedPaneId)
            ? currentState.focusedPaneId
            : (getDockedPaneIds(currentLayout).at(-1) ?? instance.instanceId),
          position: "right",
        },
      );
    persistLayout(nextLayout);
    activatePane(instance.instanceId, nextLayout);
  }, [
    activatePane,
    buildPaneInstance,
    focusVisiblePane,
    persistLayout,
    pluginRegistry,
    publishTickerOpenTarget,
    stateRef,
  ]);

  const openPinnedTicker = useCallback(async (rawSymbol: string, options?: PinTickerOptions) => {
    const target = await resolveOpenTickerTarget(rawSymbol);
    if (!target) return;
    placePinnedTickerTarget(target, options);
  }, [placePinnedTickerTarget, resolveOpenTickerTarget]);

  return {
    openPinnedTicker,
    placePinnedTickerTarget,
    publishTickerOpenTarget,
    resolveOpenTickerTarget,
  };
}
