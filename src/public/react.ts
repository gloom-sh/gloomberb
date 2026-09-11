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
  usePaneTitle,
  usePaneTicker,
  useTickers,
} from "./pane-hooks";

// Keyboard handling for plugin panes; the renderer decides how events arrive.
export { useShortcut } from "../react/input";

// Loading one thing asynchronously into a pane: data, loading, error, reload.
// Every data pane needs this, and a plugin that hand-rolls it drifts from the
// host's cancellation and stale-response handling.
export { useAsyncResource } from "../react/async-resource";

// Periodic refresh tied to app activity, and the "updated 2m ago" label that
// goes with it, so plugin panes refresh on the same cadence as built-ins and
// stop while the app is in the background.
export { useAutoRefresh, useUpdatedAgo } from "../plugins/builtin/shared/auto-refresh";

// The type behind `useConnectionHealth()`, for a plugin that passes it around.
export type { ConnectionHealthRegistry } from "../core/connection-health";
