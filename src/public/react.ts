/**
 * Public React runtime surface for external plugins (`gloomberb/react`).
 *
 * These hooks are the renderer-neutral way for plugin panes to reach app
 * services. Plugin render code must use them instead of importing OpenTUI,
 * Electrobun, or DOM APIs directly — the renderer decides how each one is
 * fulfilled, which is what lets the same plugin run in the terminal, on the
 * desktop, and (for web-capable plugins) in the browser.
 *
 * Compatibility commitment: see the note in `./utils.ts`.
 */

export {
  deletePluginPaneStateValue,
  getPluginPaneStateValue,
  setPluginPaneStateValue,
  useCapabilityInvoker,
  useAssetData,
  useConnectionHealth,
  useDebouncedPluginPaneState,
  useMarketData,
  usePluginAppActions,
  usePluginBrokerActions,
  usePluginConfigState,
  usePluginPaneActions,
  usePluginPaneState,
  usePluginState,
  usePluginTickerActions,
  usePrunePluginPaneState,
  useSetPluginConfigStates,
} from "../plugins/runtime";
export type { PluginRuntimeAccess } from "../plugins/runtime";

export { useInlineTickerOpener, useInlineTickers } from "../state/hooks/inline-tickers";

// Any feed plugin needs to remember which items have been read, persisted and
// capped. Substack and the news wire both use this; a third-party feed plugin
// would otherwise reimplement it or copy it and drift.
export {
  DEFAULT_MAX_READ_IDS,
  markPersistedReadId,
  normalizePersistedReadIdState,
  usePersistedReadIds,
} from "../plugins/builtin/shared/read-state";
export type { PersistedReadIdAdapter } from "../plugins/builtin/shared/read-state";
export type { InlineTickerCatalogEntry, UseInlineTickersOptions } from "../state/hooks/inline-tickers";

export {
  AppContext,
  PaneInstanceProvider,
  useAppConfig,
  useAppDispatch,
  useAppSelector,
  useBrokerAccounts,
  useInputCapture,
  usePaneCollection,
  usePaneInstanceId,
  usePaneSettingValue,
  usePaneStateValue,
  usePaneTitle,
  usePaneTicker,
  usePaneTickerIdentity,
  useTickers,
} from "./pane-hooks";
export type { PaneTickerIdentity } from "./pane-hooks";

// Keyboard handling for plugin panes; the renderer decides how events arrive.
export { useShortcut } from "../react/input";

// The size of the surface the app is drawing into. A pane that pages or
// virtualizes its own rows needs it, and it has to come from the renderer:
// terminal cells, desktop pixels, and a browser tab are all different.
export { useViewport } from "../react/input";

// The pane's own instance record, for a pane whose template seeds `params`
// (a CLI launch or a shortcut argument) and has to read them back on mount.
export { usePaneInstance } from "../state/app/context";

// Which ticker a pane is on, resolved the way the host resolves it: the pane's
// own selection when it has one, the shared selection otherwise. A pane that
// reads app state directly (rather than through `usePaneTicker`) needs it, and
// the action type to dispatch back into the store.
export { resolveTickerForPane } from "../state/app/context";
export type { AppAction } from "../state/app/context";

// Turning a row in a plugin's own table into the app's ticker selection, with
// the host's rules for opening a new pane or reusing the current one.
export { useTickerSourceActivate } from "../plugins/builtin/shared/ticker-source";

// Financials and FX for a list of tickers, from the same query store the
// built-in tables read, so a plugin table shows the values the rest of the app
// already fetched instead of fetching them again. `useTickerFinancialsMap` is
// passive: it observes the store and opens no stream, so its prices move only
// while some other pane streams the same symbols.
export { useFxRatesMap, useTickerFinancialsMap } from "../market-data/hooks";

// The same reads that also stream the quotes, for a pane that shows a price or
// something computed from it. Identical symbols share one subscription with
// every other pane; a covered pane's quotes drop to the off-screen cadence and
// a hidden app pauses them. Pass `visible: false` for values that are only
// aggregated (totals, weights) rather than shown per row.
export { useLiveTickerFinancials, useLiveTickerFinancialsMap } from "../state/hooks/live-ticker-financials";
export type { LiveQuoteStreamOptions } from "../state/hooks/live-ticker-financials";

// Loading one thing asynchronously into a pane: data, loading, error, reload.
// Every data pane needs this, and a plugin that hand-rolls it drifts from the
// host's cancellation and stale-response handling.
export { useAsyncResource } from "../react/async-resource";

// Periodic refresh tied to pane visibility, and the "updated 2m ago" label
// that goes with it, so plugin panes refresh on the same cadence as built-ins
// and stop while they cannot be seen. `AGE_TICK_MS` is that cadence, for
// a pane that re-renders its own age column on the same clock.
export { AGE_TICK_MS, useAutoRefresh, useUpdatedAgo } from "../plugins/builtin/shared/auto-refresh";
export type { AutoRefreshOptions } from "../plugins/builtin/shared/auto-refresh";

// Whether market data should flow: `usePaneVisible()` is true while the app
// can be seen and the pane is not covered by other windows; `useAppVisible()`
// is the app half alone. Gate streams, polls and clocks on these, not on pane
// focus: a user watches quotes in one pane while typing in another.
export { useAppVisible, usePaneVisible } from "../state/app/activity";

// The class behind `useConnectionHealth()`. A value export so a plugin test
// can construct one to exercise its own connection-status registration.
export { ConnectionHealthRegistry } from "../core/connection-health";
