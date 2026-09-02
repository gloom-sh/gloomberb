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
  usePaneTicker,
  useTickers,
} from "./pane-hooks";

// Keyboard handling for plugin panes; the renderer decides how events arrive.
export { useShortcut } from "../react/input";
