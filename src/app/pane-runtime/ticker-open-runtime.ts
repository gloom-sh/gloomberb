import { useCallback, type Dispatch } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import {
  addPaneFloating,
  addPaneToLayout,
  getDockedPaneIds,
  isPaneInLayout,
  isPaneDocked,
  removePane,
} from "../../layout/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import { PluginOffError, notifyPluginOff } from "../../plugins/plugin-off";
import { findFixedTickerPaneForSymbol } from "../../layout/ticker-navigation";
import { gridDockTarget } from "./layout-placement";
import type { AppAction, AppState } from "../../state/app/context";
import { findPaneInstance, TICKER_RESEARCH_PANE_ID, normalizePaneId } from "../../types/config";
import type {
  LayoutConfig,
  PaneBinding,
  PaneInstanceConfig,
} from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { PaneDef, PinTickerOptions } from "../../types/plugin";
import type { BrokerContractRef } from "../../types/instrument";
import {
  resolveTickerOpenTarget,
  tickerOpenFailureMessage,
  type TickerOpenTarget,
} from "../../tickers/open-target";
import {
  findExactTickerSearchMatch,
  normalizeTickerInput,
  savedTickerForQuery,
  upsertTickerFromSearchResult,
} from "../../tickers/search";
import { offerTickerListings, publishTickerOpenTarget as publishOpenTarget } from "./ticker-open-target";
import { parsePublicTickerKey, publicTickerKey } from "../../utils/exchanges";
import { attentionActionForPane, captureAttentionAction } from "../../telemetry/attention-counts";
import { tickerHasListingSuffix } from "../../sources/listing-symbols";
import { instrumentFromTicker } from "../../market-data/request-types";
import { tickerInstrumentLabel } from "../../tickers/instrument-label";
import { markTickerPaneOpening } from "../../state/opening-ticker-panes";
import { stableStringify } from "../../utils/hash";

type LayoutHistoryEntry = AppState["layoutHistory"][number];

interface UseAppTickerOpenRuntimeOptions {
  /** `trackTicker: false` keeps a pane still looking its ticker up out of the recent tickers. */
  activatePane: (paneId: string, options?: { trackTicker?: boolean }) => void;
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
  /** The layouts this window has been filling from empty, which a new pane docks into as a grid (gridDockTarget). */
  gridLayouts?: Set<string>;
  persistLayout: (layout: LayoutConfig, options?: { pushHistory?: boolean; focusedPaneId?: string | null }) => void;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
  tickerRepository: AppTickerRepositoryPort;
}

/** A research pane opened ahead of the lookup that finds its ticker (`openPaneAhead`). */
interface PaneAhead {
  instanceId: string;
  /** The key it is bound to until the lookup settles it. */
  symbol: string;
  /** The pane focused before it opened, which focus goes back to when nothing opens. */
  sourcePaneId: string | null;
  /** The layout it opened in, its undo history before the open, and that history as the open left it. */
  layoutIndex: number;
  historyBefore: LayoutHistoryEntry;
  historyOpened: LayoutHistoryEntry | undefined;
  stopOpening: () => void;
}

/** The binding a resolved target opens with, and its broker contract (`null` for the public listing). */
function targetPaneBinding(target: TickerOpenTarget, options?: PinTickerOptions): {
  binding: PaneBinding;
  instrument: BrokerContractRef | null | undefined;
} {
  const instrument = options?.instrument !== undefined ? options.instrument
    : target.instrument !== undefined ? target.instrument : instrumentFromTicker(target.ticker)?.instrument ?? undefined;
  const listing = options?.listing ?? target.listing;
  return {
    binding: { kind: "fixed", symbol: target.symbol, ...(instrument !== undefined ? { instrument } : {}), ...(listing ? { listing } : {}) },
    instrument,
  };
}

/**
 * The pane of `paneType` already showing the target in `layout`, which an
 * open brings forward instead of adding another, and whether its binding
 * stays as it is.
 */
function findTargetPane(
  state: AppState,
  layout: LayoutConfig,
  paneType: string,
  target: TickerOpenTarget,
  instrument: BrokerContractRef | null | undefined,
  options?: PinTickerOptions,
  typed?: string,
): { existing: PaneInstanceConfig | null; keepBinding: boolean } {
  if (options?.forceNewPane) return { existing: null, keepBinding: false };
  const symbol = target.symbol;
  let existing = findFixedTickerPaneForSymbol(layout, paneType, symbol, instrument);
  // A pane bound to the key as typed (the web terminal's first pane for ?ticker=7203:TSE) is the one the
  // resolved listing (7203:JPX) settles.
  const typedKey = typed?.trim().toUpperCase();
  if (!existing && typedKey && typedKey !== symbol) {
    existing = findFixedTickerPaneForSymbol(layout, paneType, typedKey, instrument);
  }
  // Without a broker route, the public listing and an unnamed route are the same security: a link that names
  // neither still finds the DES the command bar opened on the public listing, and leaves its binding as it is.
  let keepBinding = false;
  if (!existing && !instrument && !target.ticker.metadata.broker_contracts?.length) {
    existing = findFixedTickerPaneForSymbol(layout, paneType, symbol, instrument === null ? undefined : null);
    keepBinding = !!existing && instrument === undefined;
  }
  if (!existing && !instrument && (parsePublicTickerKey(symbol).exchange || tickerHasListingSuffix(symbol))) {
    existing = layout.instances.find((instance) => {
      if (instance.paneId !== paneType || instance.binding?.kind !== "fixed" || instance.binding.instrument || !isPaneInLayout(layout, instance.instanceId)) return false;
      const ticker = state.tickers.get(instance.binding.symbol);
      return !!ticker?.metadata.exchange && !!findExactTickerSearchMatch([
        { label: instance.binding.symbol, right: ticker.metadata.exchange },
      ], symbol);
    }) ?? null;
  }
  return { existing, keepBinding };
}

/** Whether a pane opened ahead is still in the layout on its key: not closed, nor pointed at another ticker. */
function isPaneAheadInPlace(layout: LayoutConfig, ahead: PaneAhead): boolean {
  const instance = findPaneInstance(layout, ahead.instanceId);
  return !!instance && isPaneInLayout(layout, ahead.instanceId)
    && instance.binding?.kind === "fixed" && instance.binding.symbol === ahead.symbol;
}

export function useAppTickerOpenRuntime({
  activatePane,
  buildPaneInstance,
  dataProvider,
  dispatch,
  focusVisiblePane,
  gridLayouts,
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
        pluginRegistry.notify({ body: tickerOpenFailureMessage(rawSymbol), type: "error" });
      }
      return target;
    } catch (err) {
      if (!canPresentFeedback()) return null;
      offerTickerListings(err, rawSymbol, dispatch);
      const message = err instanceof Error ? err.message : String(err);
      pluginRegistry.notify({ body: `Failed to open ${rawSymbol}: ${message}`, type: "error" });
      return null;
    }
  }, [dataProvider, dispatch, pluginRegistry, stateRef, tickerRepository]);

  const publishTickerOpenTarget = useCallback((target: TickerOpenTarget) => {
    publishOpenTarget(target, { tickers: stateRef.current.tickers, dispatch, events: pluginRegistry.events });
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

  /**
   * Adds a new pane of `paneType` bound to `binding`, floating or docked as
   * asked, and focuses it. `opening` runs with its id before it is placed, for
   * a pane still looking its ticker up, which stays out of the recent tickers.
   */
  const addTickerPane = useCallback((
    paneType: string,
    paneDef: PaneDef,
    binding: PaneBinding,
    title: string,
    options?: PinTickerOptions,
    opening?: (instanceId: string) => void,
  ): string | null => {
    const instance = buildPaneInstance(paneType, { title, binding });
    if (!instance) return null;
    opening?.(instance.instanceId);

    const currentState = stateRef.current;
    const currentLayout = currentState.config.layout;
    const { width, height } = pluginRegistry.getTermSize();
    const shouldFloat = options?.floating ?? true;
    // A pane that would float docks into a layout being built as a grid, as any other pane does.
    const grid = shouldFloat && gridLayouts
      ? gridDockTarget(gridLayouts, currentState.config, instance.instanceId, { width, height }) : null;
    const nextLayout = grid ? addPaneToLayout(currentLayout, instance, grid) : shouldFloat
      ? addPaneFloating(currentLayout, instance, width, height, paneDef, { focusedPaneId: currentState.focusedPaneId })
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
      dispatch({ type: "UPDATE_PANE_STATE", paneId: instance.instanceId, patch: { ...options.tabState, activeTabId: options.tabId } });
    }
    activatePane(instance.instanceId, opening ? { trackTicker: false } : undefined);
    return instance.instanceId;
  }, [activatePane, buildPaneInstance, dispatch, gridLayouts, persistLayout, pluginRegistry, stateRef]);

  const placePinnedTickerTarget = useCallback((target: TickerOpenTarget, options?: PinTickerOptions, typed?: string) => {
    const paneType = normalizePaneId(options?.paneType ?? TICKER_RESEARCH_PANE_ID);
    const paneDef = pluginRegistry.panes.get(paneType);
    if (!paneDef) return;
    if (refuseWhileOwnerOff(target.symbol, options, () => placePinnedTickerTarget(target, options, typed))) return;

    publishTickerOpenTarget(target);
    const symbol = target.symbol;
    const { binding, instrument } = targetPaneBinding(target, options);
    const currentState = stateRef.current;
    const currentLayout = currentState.config.layout;
    const { existing, keepBinding } = findTargetPane(currentState, currentLayout, paneType, target, instrument, options, typed);
    if (existing) {
      // A reload can qualify a previously bare saved symbol. Reuse only the
      // verified same listing, retaining its pane identity and its followers.
      const previousSymbol = existing.binding?.kind === "fixed" ? existing.binding.symbol : null;
      let nextLayout = currentLayout;
      if (previousSymbol && (previousSymbol !== symbol || (!keepBinding && JSON.stringify(existing.binding) !== JSON.stringify(binding)))) {
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
        dispatch({ type: "UPDATE_PANE_STATE", paneId: existing.instanceId, patch: { ...options.tabState, activeTabId: options.tabId } });
      }
      focusVisiblePane(existing.instanceId, nextLayout);
      return;
    }

    addTickerPane(paneType, paneDef, binding, tickerInstrumentLabel(symbol, instrument), options);
  }, [
    addTickerPane,
    dispatch,
    focusVisiblePane,
    persistLayout,
    pluginRegistry,
    publishTickerOpenTarget,
    refuseWhileOwnerOff,
    stateRef,
  ]);

  /**
   * Opens the research pane of a ticker the app does not hold yet before the
   * network lookup that finds it (search and the listing's quote, seconds on
   * a slow connection), bound to the key as given and marked as opening; the
   * lookup settles it (`settlePaneAhead`). Null when the open waits for the
   * lookup instead: another pane type, a broker contract, a ticker the app
   * holds however the key spells it (it resolves here, at once), or a
   * research pane already on the key.
   */
  const openPaneAhead = useCallback((rawSymbol: string, options?: PinTickerOptions): PaneAhead | null => {
    const paneType = normalizePaneId(options?.paneType ?? TICKER_RESEARCH_PANE_ID);
    const paneDef = pluginRegistry.panes.get(paneType);
    const symbol = normalizeTickerInput(null, rawSymbol);
    if (paneType !== TICKER_RESEARCH_PANE_ID || !paneDef || !symbol || options?.instrument) return null;
    const state = stateRef.current;
    const layout = state.config.layout;
    if (savedTickerForQuery(rawSymbol, state.tickers)) return null;
    if (!options?.forceNewPane && layout.instances.some((instance) => instance.paneId === paneType
      && instance.binding?.kind === "fixed" && instance.binding.symbol === symbol && isPaneInLayout(layout, instance.instanceId))) return null;
    const binding: PaneBinding = {
      kind: "fixed",
      symbol,
      ...(options?.instrument !== undefined ? { instrument: options.instrument } : {}),
      ...(options?.listing ? { listing: options.listing } : {}),
    };
    const sourcePaneId = state.focusedPaneId;
    const layoutIndex = state.config.activeLayoutIndex;
    const historyBefore = state.layoutHistory[layoutIndex] ?? { past: [], future: [] };
    // Marked before it is placed, so its first frame already says it is loading.
    let stopOpening = () => {};
    const instanceId = addTickerPane(paneType, paneDef, binding, tickerInstrumentLabel(symbol, options?.instrument), options, (id) => {
      stopOpening = markTickerPaneOpening(id);
    });
    if (!instanceId) return null;
    const historyOpened = stateRef.current.layoutHistory[layoutIndex];
    return { instanceId, symbol, sourcePaneId, layoutIndex, historyBefore, historyOpened, stopOpening };
  }, [addTickerPane, pluginRegistry, stateRef]);

  /**
   * Settles a pane opened ahead once the lookup answers: it is bound to the
   * listing found, or gives way to a pane already showing that listing, or
   * closes when nothing opens (no listing, or a choice of listings the
   * command bar now offers), focus going back where it was. A pane closed or
   * pointed at another ticker meanwhile is left alone. The undo history and
   * the recent tickers end as if the open had waited for the lookup. True
   * when the open landed in a pane.
   */
  const settlePaneAhead = useCallback((
    ahead: PaneAhead,
    target: TickerOpenTarget | null,
    options: PinTickerOptions | undefined,
    typed: string,
  ): boolean => {
    if (target) publishTickerOpenTarget(target);
    const state = stateRef.current;
    const layout = state.config.layout;
    const inPlace = isPaneAheadInPlace(layout, ahead);
    const focusedHere = inPlace && state.focusedPaneId === ahead.instanceId;
    const without = removePane(layout, ahead.instanceId);
    const resolved = target ? targetPaneBinding(target, options) : null;
    const existing = inPlace && target && resolved
      ? findTargetPane(state, without, TICKER_RESEARCH_PANE_ID, target, resolved.instrument, options, typed).existing
      : null;
    const instance = findPaneInstance(layout, ahead.instanceId);
    const settled = target && resolved && !existing ? {
      binding: resolved.binding,
      title: inPlace && instance?.title && instance.title !== tickerInstrumentLabel(ahead.symbol, options?.instrument)
        ? instance.title
        : tickerInstrumentLabel(target.symbol, resolved.instrument),
    } : null;
    // The steps taken while it loaded hold it on its key. An open that came to nothing leaves
    // no step, and the history it found comes back whole when nothing was done since.
    const settleHistory = () => {
      if (stateRef.current.config.activeLayoutIndex !== ahead.layoutIndex) return;
      const untouched = !settled && state.layoutHistory[ahead.layoutIndex] === ahead.historyOpened;
      dispatch({
        type: "SETTLE_OPENING_PANE",
        settlement: { paneId: ahead.instanceId, symbol: ahead.symbol, settled, ...(untouched ? { before: ahead.historyBefore } : {}) },
      });
    };
    if (!inPlace || !instance) {
      settleHistory();
      return false;
    }
    if (!settled) {
      if (existing) {
        persistLayout(without, { pushHistory: false });
        if (options?.tabId) {
          dispatch({ type: "UPDATE_PANE_STATE", paneId: existing.instanceId, patch: { ...options.tabState, activeTabId: options.tabId } });
        }
        if (focusedHere) focusVisiblePane(existing.instanceId, without);
      } else {
        const backTo = ahead.sourcePaneId && isPaneInLayout(without, ahead.sourcePaneId) ? ahead.sourcePaneId : null;
        persistLayout(without, { pushHistory: false, ...(focusedHere ? { focusedPaneId: backTo } : {}) });
      }
      settleHistory();
      return !!existing;
    }
    if (settled.title !== instance.title || stableStringify(instance.binding) !== stableStringify(settled.binding)) {
      persistLayout({
        ...layout,
        instances: layout.instances.map((pane) => pane.instanceId === ahead.instanceId ? { ...pane, ...settled } : pane),
      }, { pushHistory: false });
    }
    settleHistory();
    // Focusing it left its key out of the recent tickers; the listing found goes in.
    if (focusedHere && target) dispatch({ type: "TRACK_TICKER", symbol: target.symbol });
    return true;
  }, [dispatch, focusVisiblePane, persistLayout, publishTickerOpenTarget, stateRef]);

  const openPinnedTicker = useCallback(async (rawSymbol: string, options?: PinTickerOptions) => {
    // Before resolving, so a refused open adds no ticker either.
    if (refuseWhileOwnerOff(rawSymbol, options, () => { void openPinnedTicker(rawSymbol, options); })) return;
    const recordAttention = captureAttentionAction();
    let selected = options?.instrument !== undefined && (options.instrument || options.listing)
      ? { ticker: await tickerRepository.loadTicker(rawSymbol), created: false } : null;
    // A listing the caller chose, such as one contract of an options chain,
    // opens as given: no search could name it better than its own chain.
    if (selected && !selected.ticker && options?.listing) {
      const { listing, instrument } = options;
      selected = await upsertTickerFromSearchResult(tickerRepository, {
        providerId: instrument?.brokerId ?? "", ...(instrument?.brokerInstanceId ? { brokerInstanceId: instrument.brokerInstanceId } : {}),
        symbol: rawSymbol, name: listing.name, exchange: listing.exchange, type: listing.type,
        ...(listing.currency ? { currency: listing.currency } : {}), ...(instrument ? { brokerContract: instrument } : {}),
      });
    }
    const selectedTicker = selected?.ticker;
    let target: TickerOpenTarget | null;
    let placed = true;
    if (selectedTicker) {
      target = { symbol: selectedTicker.metadata.ticker, ticker: selectedTicker, created: selected!.created, instrument: options?.instrument, listing: options?.listing };
      placePinnedTickerTarget(target, options, rawSymbol);
    } else {
      // The pane of a ticker found over the network shows now, not once the lookup answers.
      const ahead = openPaneAhead(rawSymbol, options);
      if (!ahead) {
        target = await resolveOpenTickerTarget(rawSymbol, options?.instrument === null);
        if (target) placePinnedTickerTarget(target, options, rawSymbol);
      } else {
        // Cleared once it settles, so no frame between says no ticker is selected.
        try {
          // A failure, or the choice of listings, is said only while the pane still waits: one closed was given up.
          target = await resolveOpenTickerTarget(rawSymbol, options?.instrument === null,
            () => isPaneAheadInPlace(stateRef.current.config.layout, ahead));
          placed = settlePaneAhead(ahead, target, options, rawSymbol);
        } finally {
          ahead.stopOpening();
        }
      }
    }
    if (!target || !placed) return;
    const action = attentionActionForPane(options?.paneType ?? TICKER_RESEARCH_PANE_ID);
    if (action && pluginRegistry.panes.has(options?.paneType ?? TICKER_RESEARCH_PANE_ID)) {
      recordAttention(publicTickerKey(target.symbol, target.listing?.exchange ?? target.ticker.metadata.exchange), action);
    }
  }, [openPaneAhead, placePinnedTickerTarget, pluginRegistry, refuseWhileOwnerOff, resolveOpenTickerTarget, settlePaneAhead, stateRef, tickerRepository]);

  return {
    openPinnedTicker,
    placePinnedTickerTarget,
    publishTickerOpenTarget,
    resolveOpenTickerTarget,
  };
}
