import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
} from "react";
import type { PluginRegistry } from "../../../../plugins/registry";
import type {
  AppAction,
  AppState,
} from "../../../../state/app/context";
import { normalizeTickerInput } from "../../../../tickers/search";
import type { ThemePickerHandle } from "../../theme-picker";
import type { Command } from "../registry";
import type { CollectionCommandId } from "../collection";
import {
  runDirectCommandAction,
} from "./index";
import type { OpenInlineConfirm } from "../../routing/confirm";
import {
  resolveTickerInput,
  type SharedWorkflowDeps,
} from "../../workflow/ops";
import type { CommandBarRoute } from "../../workflow/types";

interface UseCommandBarDirectCommandRuntimeOptions {
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  buildSharedWorkflowDeps: () => SharedWorkflowDeps;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  dispatch: Dispatch<AppAction>;
  executeCollectionCommand: (
    commandId: CollectionCommandId,
    rawInput?: string,
    explicitTargetId?: string | null,
  ) => Promise<void>;
  focusTicker: (symbol: string) => void;
  notify: (body: string, options?: { type?: "info" | "success" | "error" }) => void;
  onCheckForUpdates?: () => void | Promise<void>;
  openBuiltInWorkflow: (actionId: string) => void;
  openInlineConfirm: OpenInlineConfirm;
  openModeRoute: (
    screen: "ticker-search" | "layout",
    initialQuery?: string,
    payload?: Record<string, unknown>,
  ) => void;
  openPaneSettingsRoute: (paneId: string) => void;
  persistConfig: (nextConfig: AppState["config"]) => void;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  quitApp: () => void;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
  setRootQuery: (query: string) => void;
  stateRef: MutableRefObject<AppState>;
  themePickerRef: MutableRefObject<ThemePickerHandle | null>;
}

export function useCommandBarDirectCommandRuntime({
  activeCollectionId,
  activeTickerSymbol,
  buildSharedWorkflowDeps,
  closeAll,
  dispatch,
  executeCollectionCommand,
  focusTicker,
  notify,
  onCheckForUpdates,
  openBuiltInWorkflow,
  openInlineConfirm,
  openModeRoute,
  openPaneSettingsRoute,
  persistConfig,
  pluginRegistry,
  pushRoute,
  quitApp,
  rootThemeBaseIdRef,
  setRootQuery,
  stateRef,
  themePickerRef,
}: UseCommandBarDirectCommandRuntimeOptions) {
  const runSecurityDescriptionShortcut = useCallback(async (query?: string) => {
    const trimmed = query?.trim() || "";
    if (!trimmed) {
      const inferred = normalizeTickerInput(activeTickerSymbol, query);
      if (inferred) {
        focusTicker(inferred);
        closeAll({ revertThemePreview: false });
        return;
      }
      openModeRoute("ticker-search", "");
      return;
    }

    const resolvedTicker = await resolveTickerInput(
      trimmed,
      activeTickerSymbol,
      activeCollectionId,
      buildSharedWorkflowDeps(),
    );
    if (resolvedTicker) {
      focusTicker(resolvedTicker.symbol);
      closeAll({ revertThemePreview: false });
      return;
    }
    openModeRoute("ticker-search", trimmed);
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
      dispatch,
      executeCollectionCommand,
      getState: () => stateRef.current,
      notify,
      onCheckForUpdates,
      openBuiltInWorkflow,
      openInlineConfirm,
      openModeRoute,
      openPaneSettingsRoute,
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
    notify,
    onCheckForUpdates,
    openBuiltInWorkflow,
    openInlineConfirm,
    openModeRoute,
    openPaneSettingsRoute,
    persistConfig,
    pluginRegistry,
    pushRoute,
    quitApp,
    rootThemeBaseIdRef,
    runSecurityDescriptionShortcut,
    setRootQuery,
    stateRef,
    themePickerRef,
  ]);

  return {
    runDirectCommand,
    runSecurityDescriptionShortcut,
  };
}
