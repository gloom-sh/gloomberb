import { useCallback, type Dispatch } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import {
  addPaneFloating,
  addPaneToLayout,
  getDockedPaneIds,
  isPaneInLayout,
  isPaneDocked,
} from "../../layout/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import { PluginOffError, notifyPluginOff } from "../../plugins/plugin-off";
import { findFixedTickerPaneForSymbol } from "../../layout/ticker-navigation";
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
import { AmbiguousTickerError, findExactTickerSearchMatch } from "../../tickers/search";
import { isDialogOpen } from "../../ui/dialog-stack";
import { parsePublicTickerKey, publicTickerKey } from "../../utils/exchanges";
import { attentionActionForPane, captureAttentionAction } from "../../telemetry/attention-counts";
import { tickerHasListingSuffix } from "../../sources/listing-symbols";
import { instrumentFromTicker } from "../../market-data/request-types";
import { tickerInstrumentLabel } from "../../tickers/instrument-label";

interface UseAppTickerOpenRuntimeOptions {
  activatePane: (paneId: string) => void;
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
  const resolveOpenTickerTarget = useCallback(async (
    rawSymbol: string,
    publicOnly = false,
    canPresentFeedback: () => boolean = () => true,
  ): Promise<TickerOpenTarget | null> => {
    try {
      const target = await resolveTickerOpenTarget({
        query: rawSymbol, publicOnly,
        tickers: stateRef.current.tickers,
        dataProvider,
        tickerRepository,
      });
      if (!target && canPresentFeedback()) {
        pluginRegistry.notify({ body: `Could not open ${rawSymbol}.`, type: "error" });
      }
      return target;
    } catch (err) {
      if (!canPresentFeedback()) return null;
      // Ticker search offers the listings, unless a dialog would sit over the bar.
      if (err instanceof AmbiguousTickerError && !isDialogOpen()) {
        dispatch({ type: "SET_COMMAND_BAR", open: true, query: rawSymbol,
          launch: { kind: "ticker-search", query: rawSymbol } });
      }
      const message = err instanceof Error ? err.message : String(err);
      pluginRegistry.notify({ body: `Failed to open ${rawSymbol}: ${message}`, type: "error" });
      return null;
    }
  }, [dataProvider, dispatch, pluginRegistry, stateRef, tickerRepository]);

  const publishTickerOpenTarget = useCallback((target: TickerOpenTarget) => {
    const currentTicker = stateRef.current.tickers.get(target.symbol);
    if (currentTicker !== target.ticker) {
      dispatch({ type: "UPDATE_TICKER", ticker: target.ticker });
    }
    if (target.created) {
      pluginRegistry.events.emit("ticker:added", { symbol: target.symbol, ticker: target.ticker });
    }
  }, [dispatch, pluginRegistry.events, stateRef]);

  /**
   * A ticker opens in a pane of its plugin, which is added hidden while that
   * plugin is off, so the open is refused with an offer to turn it on.
   */
  const refuseWhileOwnerOff = useCallback((symbol: string, options: PinTickerOptions | undefined, reopen: () => void) => {
    const paneType = normalizePaneId(options?.paneType ?? TICKER_RESEARCH_PANE_ID);
    const owner = pluginRegistry.getDisabledPaneOwner(paneType, stateRef.current.config.disabledPlugins);
    if (!owner) return false;
    notifyPluginOff(pluginRegistry, new PluginOffError(owner, symbol), reopen);
    return true;
  }, [pluginRegistry, stateRef]);

  const placePinnedTickerTarget = useCallback((target: TickerOpenTarget, options?: PinTickerOptions) => {
    const paneType = normalizePaneId(options?.paneType ?? TICKER_RESEARCH_PANE_ID);
    const paneDef = pluginRegistry.panes.get(paneType);
    if (!paneDef) return;
    if (refuseWhileOwnerOff(target.symbol, options, () => placePinnedTickerTarget(target, options))) return;

    publishTickerOpenTarget(target);
    const symbol = target.symbol;
    const instrument = options?.instrument !== undefined ? options.instrument
      : target.instrument !== undefined ? target.instrument : instrumentFromTicker(target.ticker)?.instrument ?? undefined;
    const listing = options?.listing ?? target.listing;
    const binding = { kind: "fixed" as const, symbol, ...(instrument !== undefined ? { instrument } : {}), ...(listing ? { listing } : {}) };
    const currentState = stateRef.current;
    const currentLayout = currentState.config.layout;
    let existing = options?.forceNewPane
      ? null
      : findFixedTickerPaneForSymbol(currentLayout, paneType, symbol, instrument);
    if (!options?.forceNewPane && !existing && instrument === null && !target.ticker.metadata.broker_contracts?.length) {
      existing = findFixedTickerPaneForSymbol(currentLayout, paneType, symbol);
    }
    if (!options?.forceNewPane && !existing && !instrument && (parsePublicTickerKey(symbol).exchange || tickerHasListingSuffix(symbol))) {
      existing = currentLayout.instances.find((instance) => {
        if (instance.paneId !== paneType || instance.binding?.kind !== "fixed" || instance.binding.instrument || !isPaneInLayout(currentLayout, instance.instanceId)) return false;
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
      if (previousSymbol && (previousSymbol !== symbol || JSON.stringify(existing.binding) !== JSON.stringify(binding))) {
        const existingId = existing.instanceId;
        nextLayout = { ...currentLayout, instances: currentLayout.instances.map((instance) => (
          instance.instanceId === existingId ? {
            ...instance,
            binding,
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
      title: tickerInstrumentLabel(symbol, instrument),
      binding,
    });
    if (!instance) return;

    const { width, height } = pluginRegistry.getTermSize();
    const shouldFloat = options?.floating ?? true;
    const nextLayout = shouldFloat
      ? addPaneFloating(currentLayout, instance, width, height, paneDef)
      : addPaneToLayout(
        currentLayout,
        instance,
        {
          relativeTo: currentState.focusedPaneId && isPaneDocked(currentLayout, currentState.focusedPaneId)
            ? currentState.focusedPaneId
            : (getDockedPaneIds(currentLayout).at(-1) ?? instance.instanceId),
          position: "right",
        },
      );
    persistLayout(nextLayout);
    if (paneType === TICKER_RESEARCH_PANE_ID && options?.tabId) {
      dispatch({ type: "UPDATE_PANE_STATE", paneId: instance.instanceId, patch: { activeTabId: options.tabId } });
    }
    activatePane(instance.instanceId);
  }, [
    activatePane,
    buildPaneInstance,
    dispatch,
    focusVisiblePane,
    persistLayout,
    pluginRegistry,
    publishTickerOpenTarget,
    refuseWhileOwnerOff,
    stateRef,
  ]);

  const openPinnedTicker = useCallback(async (rawSymbol: string, options?: PinTickerOptions) => {
    // Before resolving, so a refused open adds no ticker either.
    if (refuseWhileOwnerOff(rawSymbol, options, () => { void openPinnedTicker(rawSymbol, options); })) return;
    const recordAttention = captureAttentionAction();
    const selectedTicker = options?.instrument !== undefined && (options.instrument || options.listing) ? await tickerRepository.loadTicker(rawSymbol) : null;
    const target = selectedTicker
      ? { symbol: selectedTicker.metadata.ticker, ticker: selectedTicker, created: false, instrument: options?.instrument, listing: options?.listing }
      : await resolveOpenTickerTarget(rawSymbol, options?.instrument === null);
    if (!target) return;
    placePinnedTickerTarget(target, options);
    const action = attentionActionForPane(options?.paneType ?? TICKER_RESEARCH_PANE_ID);
    if (action && pluginRegistry.panes.has(options?.paneType ?? TICKER_RESEARCH_PANE_ID)) {
      recordAttention(publicTickerKey(target.symbol, target.listing?.exchange ?? target.ticker.metadata.exchange), action);
    }
  }, [placePinnedTickerTarget, pluginRegistry, refuseWhileOwnerOff, resolveOpenTickerTarget, tickerRepository]);

  return {
    openPinnedTicker,
    placePinnedTickerTarget,
    publishTickerOpenTarget,
    resolveOpenTickerTarget,
  };
}
