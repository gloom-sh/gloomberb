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
import { findExactTickerSearchMatch } from "../../tickers/search";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { tickerHasYahooSuffix } from "../../sources/yahoo-finance/symbols";

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
    let existing = options?.forceNewPane
      ? null
      : findFixedTickerPaneForSymbol(currentLayout, paneType, symbol);
    if (!options?.forceNewPane && !existing && (parsePublicTickerKey(symbol).exchange || tickerHasYahooSuffix(symbol))) {
      existing = currentLayout.instances.find((instance) => {
        if (instance.paneId !== paneType || instance.binding?.kind !== "fixed" || !isPaneInLayout(currentLayout, instance.instanceId)) return false;
        const ticker = currentState.tickers.get(instance.binding.symbol);
        return !!ticker?.metadata.exchange && !!findExactTickerSearchMatch([
          { label: instance.binding.symbol, right: ticker.metadata.exchange },
        ], symbol);
      }) ?? null;
    }
    if (existing) {
      // A reload can qualify a previously bare saved symbol. Reuse only the
      // verified same listing, retaining its pane identity and its followers.
      const previousSymbol = existing.binding?.kind === "fixed" ? existing.binding.symbol : null;
      let nextLayout = currentLayout;
      if (previousSymbol && previousSymbol !== symbol) {
        const existingId = existing.instanceId;
        nextLayout = { ...currentLayout, instances: currentLayout.instances.map((instance) => (
          instance.instanceId === existingId ? {
            ...instance,
            binding: { kind: "fixed" as const, symbol },
            title: !instance.title || instance.title === previousSymbol ? symbol : instance.title,
          } : instance
        )) };
        persistLayout(nextLayout);
      }
      if (paneType === TICKER_RESEARCH_PANE_ID && options?.tabId) {
        dispatch({ type: "UPDATE_PANE_STATE", paneId: existing.instanceId, patch: { activeTabId: options.tabId } });
      }
      focusVisiblePane(existing.instanceId, nextLayout);
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
    if (paneType === TICKER_RESEARCH_PANE_ID && options?.tabId) {
      dispatch({ type: "UPDATE_PANE_STATE", paneId: instance.instanceId, patch: { activeTabId: options.tabId } });
    }
    activatePane(instance.instanceId, nextLayout);
  }, [
    activatePane,
    buildPaneInstance,
    dispatch,
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
