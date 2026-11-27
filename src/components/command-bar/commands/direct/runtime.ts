import { useCallback, type MutableRefObject } from "react";
import type { PluginRegistry } from "../../../../plugins/registry";
import type { PinTickerOptions } from "../../../../types/plugin";
import { useAppGetState } from "../../../../state/app/context";
import { normalizeTickerInput } from "../../../../tickers/search";
import { useRendererHost } from "../../../../ui";
import type { Command } from "../registry";
import { SECURITY_DESCRIPTION_SEARCH, type CollectionCommandId } from "../../helpers";
import { runDirectCommandAction } from "./index";
import type { OpenInlineConfirm } from "../../routing/confirm";
import type { CommandBarEnvironment } from "../../surface/environment";
import { resolveTickerInput, type SharedWorkflowDeps } from "../../workflow/ops";
import type { CommandBarRoute } from "../../workflow/types";

interface UseCommandBarDirectCommandRuntimeOptions {
  env: CommandBarEnvironment;
  buildSharedWorkflowDeps: () => SharedWorkflowDeps;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  executeCollectionCommand: (
    commandId: CollectionCommandId,
    rawInput?: string,
    explicitTargetId?: string | null,
  ) => Promise<void>;
  focusTicker: (symbol: string, options?: PinTickerOptions) => void;
  notify: (body: string, options?: { type?: "info" | "success" | "error" }) => void;
  onCheckForUpdates?: () => void | Promise<void>;
  /** Settings' Run Setup Again; absent where setup cannot run. */
  onRunSetupAgain?: () => Promise<void>;
  openBuiltInWorkflow: (actionId: string) => void;
  openInlineConfirm: OpenInlineConfirm;
  openModeRoute: (screen: "ticker-search" | "layout", initialQuery?: string, payload?: Record<string, unknown>) => void;
  openPaneSettings: (paneId: string | null) => void;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  quitApp: () => void;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
  setRootQuery: (query: string) => void;
}

export function useCommandBarDirectCommandRuntime({
  env,
  buildSharedWorkflowDeps,
  closeAll,
  executeCollectionCommand,
  focusTicker,
  notify,
  onCheckForUpdates,
  onRunSetupAgain,
  openBuiltInWorkflow,
  openInlineConfirm,
  openModeRoute,
  openPaneSettings,
  pluginRegistry,
  pushRoute,
  quitApp,
  rootThemeBaseIdRef,
  setRootQuery,
}: UseCommandBarDirectCommandRuntimeOptions) {
  const { activeCollectionId, activeTickerSymbol, dispatch, persistConfig, themePickerRef } = env;
  // A confirm it opens (Reset All Data) runs after the bar closed.
  const getState = useAppGetState();
  const rendererHost = useRendererHost();
  const runSecurityDescriptionShortcut = useCallback(async (query?: string, options?: { forceNewPane?: boolean }) => {
    const trimmed = query?.trim() || "";
    if (!trimmed) {
      const inferred = normalizeTickerInput(activeTickerSymbol, query);
      if (inferred) {
        focusTicker(inferred, options);
        closeAll({ revertThemePreview: false });
        return;
      }
      openModeRoute("ticker-search", "", SECURITY_DESCRIPTION_SEARCH);
      return;
    }

    const resolvedTicker = await resolveTickerInput(
      trimmed,
      activeTickerSymbol,
      activeCollectionId,
      buildSharedWorkflowDeps(),
      { preserveListingKey: true },
    );
    if (resolvedTicker) {
      focusTicker(resolvedTicker.symbol, {
        ...options,
        instrument: resolvedTicker.instrument,
        listing: resolvedTicker.listing,
      });
      closeAll({ revertThemePreview: false });
      return;
    }
    openModeRoute("ticker-search", trimmed, SECURITY_DESCRIPTION_SEARCH);
  }, [
    activeCollectionId,
    activeTickerSymbol,
    buildSharedWorkflowDeps,
    closeAll,
    focusTicker,
    openModeRoute,
  ]);

  const runDirectCommand = useCallback((command: Command, arg: string) => {
    runDirectCommandAction({
      activeCollectionId,
      activeTickerSymbol,
      arg,
      cancelThemePreview: () => themePickerRef.current?.cancelPreview(),
      closeAll,
      command,
      controlWindow: (action) => {
        void rendererHost.controlWindow?.(action);
      },
      dispatch,
      executeCollectionCommand,
      getState,
      notify,
      onCheckForUpdates,
      onRunSetupAgain,
      openBuiltInWorkflow,
      openInlineConfirm,
      openModeRoute,
      openPaneSettings,
      persistConfig,
      pluginRegistry,
      pushRoute,
      quitApp,
      runSecurityDescriptionShortcut,
      setRootQuery,
      setRootThemeBaseId: (themeId) => {
        rootThemeBaseIdRef.current = themeId;
      },
    });
  }, [
    activeCollectionId,
    activeTickerSymbol,
    closeAll,
    dispatch,
    executeCollectionCommand,
    getState,
    notify,
    onCheckForUpdates,
    onRunSetupAgain,
    openBuiltInWorkflow,
    openInlineConfirm,
    openModeRoute,
    openPaneSettings,
    persistConfig,
    pluginRegistry,
    pushRoute,
    quitApp,
    rendererHost,
    rootThemeBaseIdRef,
    runSecurityDescriptionShortcut,
    setRootQuery,
    themePickerRef,
  ]);

  return {
    runDirectCommand,
    runSecurityDescriptionShortcut,
  };
}
