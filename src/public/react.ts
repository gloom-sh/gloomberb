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

// The size of the surface the app is drawing into. A pane that pages or
// virtualizes its own rows needs it, and it has to come from the renderer:
// terminal cells, desktop pixels, and a browser tab are all different.
export { useViewport } from "../react/input";

// The pane's own instance record, for a pane whose template seeds `params`
// (a CLI launch or a shortcut argument) and has to read them back on mount.
export { usePaneInstance } from "../state/app/context";

// Loading one thing asynchronously into a pane: data, loading, error, reload.
// Every data pane needs this, and a plugin that hand-rolls it drifts from the
// host's cancellation and stale-response handling.
export { useAsyncResource } from "../react/async-resource";

// Periodic refresh tied to app activity, and the "updated 2m ago" label that
// goes with it, so plugin panes refresh on the same cadence as built-ins and
// stop while the app is in the background.
export { useAutoRefresh, useUpdatedAgo } from "../plugins/builtin/shared/auto-refresh";

// The class behind `useConnectionHealth()`. A value export so a plugin test
// can construct one to exercise its own connection-status registration.
export { ConnectionHealthRegistry } from "../core/connection-health";
