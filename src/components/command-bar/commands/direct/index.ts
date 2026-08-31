import type { Dispatch } from "react";
import {
  applyLanguagePreference,
  LANGUAGE_DISPLAY_NAMES,
  resolveLanguageCommandPreference,
  t,
} from "../../../../i18n";
import { exportConfig, importConfig, resetAllData } from "../../../../data/config/store";
import type { PluginRegistry } from "../../../../plugins/registry";
import {
  applyTheme,
  clearTransientThemePreview,
} from "../../../../theme/colors";
import { clampFontSize, MIN_FONT_SIZE_PX } from "../../../../theme/font-scale";
import type { AppAction, AppState } from "../../../../state/app/context";
import { isManualPortfolio } from "../../../../plugins/builtin/portfolio-list/mutations";
import { CHART_RENDERER_PREFERENCES } from "../../../chart/core/types";
import type { Command } from "../registry";
import type { OpenInlineConfirm } from "../../routing/confirm";
import {
  isRouteCommandId,
  routeCommandIdToScreen,
} from "../../helpers";
import { parseWindowModeCommandArg } from "../../layout-items";
import type { CollectionCommandId } from "../collection";
import type { CommandBarRoute } from "../../workflow/types";

type NotifyFn = (body: string, options?: { type?: "info" | "success" | "error" }) => void;

function getDefaultConfigBackupPath(): string {
  const home = typeof process !== "undefined" ? process.env.HOME : undefined;
  return `${home || "~"}/gloomberb-config-backup.json`;
}

export function runDirectCommandAction(options: {
  command: Command;
  arg: string;
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  dispatch: Dispatch<AppAction>;
  executeCollectionCommand: (commandId: CollectionCommandId, rawInput?: string) => void;
  getState: () => AppState;
  notify: NotifyFn;
  onCheckForUpdates?: () => void | Promise<void>;
  openBuiltInWorkflow: (actionId: string) => void;
  openInlineConfirm: OpenInlineConfirm;
  openModeRoute: (screen: "ticker-search" | "layout", initialQuery?: string) => void;
  openPaneSettingsRoute: (paneId: string) => void;
  pluginRegistry: PluginRegistry;
  persistConfig: (nextConfig: AppState["config"]) => void;
  pushRoute: (route: CommandBarRoute) => void;
  quitApp: () => void;
  runSecurityDescriptionShortcut: (query?: string) => void;
  setRootQuery: (query: string) => void;
  setRootThemeBaseId: (themeId: string | null) => void;
  cancelThemePreview: () => void;
}): void {
  const {
    activeCollectionId,
    activeTickerSymbol,
    arg,
    closeAll,
    command,
    dispatch,
    executeCollectionCommand,
    getState,
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
    setRootThemeBaseId,
    cancelThemePreview,
  } = options;
  const state = getState();

  switch (command.id) {
    case "help":
      closeAll({ revertThemePreview: false });
      pluginRegistry.showPane("help");
      return;
    case "layout-marketplace":
      closeAll({ revertThemePreview: false });
      pluginRegistry.showPane("layout-marketplace");
      return;
    case "pane-settings":
      if (state.focusedPaneId) openPaneSettingsRoute(state.focusedPaneId);
      return;
    case "window-mode":
      closeAll({ revertThemePreview: false });
      pluginRegistry.openWindowMode(state.focusedPaneId ?? undefined, parseWindowModeCommandArg(arg) ?? "move");
      return;
    case "add-broker-account":
    case "new-portfolio":
    case "new-watchlist":
    case "set-portfolio-position":
    case "disconnect-broker-account":
    case "delete-watchlist":
    case "delete-portfolio":
    case "reset-all-data":
      if (
        command.id === "add-broker-account"
        || command.id === "new-portfolio"
        || command.id === "new-watchlist"
        || command.id === "set-portfolio-position"
      ) {
        openBuiltInWorkflow(command.id);
        return;
      }
      if (command.id === "disconnect-broker-account") {
        const instances = state.config.brokerInstances.map((instance) => ({
          id: instance.id,
          label: instance.label,
          description: `${instance.brokerType.toUpperCase()} · ${instance.connectionMode || String(instance.config.connectionMode || "configured")}`,
        }));
        if (instances.length === 0) return;
        pushRoute({
          kind: "picker",
          pickerId: "disconnect-broker",
          title: "Disconnect Broker Account",
          query: "",
          selectedIdx: 0,
          hoveredIdx: null,
          options: instances.map((instance) => ({
            id: instance.id,
            label: instance.label,
            detail: instance.description,
            description: instance.description,
          })),
        });
        return;
      }
      if (command.id === "delete-watchlist") {
        const pickerOptions = state.config.watchlists.map((watchlist) => ({
          id: watchlist.id,
          label: watchlist.name,
          detail: `Delete watchlist "${watchlist.name}"`,
          description: `Delete watchlist "${watchlist.name}"`,
        }));
        if (pickerOptions.length === 0) return;
        pushRoute({
          kind: "picker",
          pickerId: "delete-watchlist",
          title: "Delete Watchlist",
          query: "",
          selectedIdx: 0,
          hoveredIdx: null,
          options: pickerOptions,
        });
        return;
      }
      if (command.id === "delete-portfolio") {
        const deletable = state.config.portfolios.filter(isManualPortfolio);
        const pickerOptions = deletable.map((portfolio) => ({
          id: portfolio.id,
          label: portfolio.name,
          detail: `Delete portfolio "${portfolio.name}"`,
          description: `Delete portfolio "${portfolio.name}"`,
        }));
        if (pickerOptions.length === 0) return;
        pushRoute({
          kind: "picker",
          pickerId: "delete-portfolio",
          title: "Delete Portfolio",
          query: "",
          selectedIdx: 0,
          hoveredIdx: null,
          options: pickerOptions,
        });
        return;
      }
      openInlineConfirm({
        confirmId: "reset-all-data",
        title: "Reset All Data",
        body: [
          "This will permanently delete all portfolios, tickers, notes, broker credentials, and settings.",
          "Gloomberb will quit and show the setup wizard on next launch.",
        ],
        confirmLabel: "Reset Everything",
        cancelLabel: "Back",
        tone: "danger",
        onConfirm: async () => {
          await resetAllData(getState().config.dataDir);
          quitApp();
        },
      });
      return;
    case "export-config": {
      const exportPath = getDefaultConfigBackupPath();
      void exportConfig(state.config, exportPath)
        .then(() => {
          notify(`Config exported to ${exportPath}`, { type: "success" });
          closeAll({ revertThemePreview: false });
        })
        .catch((error) => {
          notify(error instanceof Error ? error.message : "Export failed.", { type: "error" });
        });
      return;
    }
    case "import-config": {
      const importPath = getDefaultConfigBackupPath();
      void importConfig(state.config.dataDir, importPath)
        .then((imported) => {
          cancelThemePreview();
          clearTransientThemePreview();
          dispatch({ type: "SET_CONFIG", config: imported });
          applyTheme(imported.theme);
          dispatch({ type: "SET_THEME", theme: imported.theme });
          notify(`Imported config from ${importPath}.`, { type: "success" });
          closeAll({ revertThemePreview: false });
        })
        .catch((error) => {
          notify(error instanceof Error ? error.message : "Import failed.", { type: "error" });
        });
      return;
    }
    case "cycle-chart-renderer": {
      const current = state.config.chartPreferences.renderer;
      const index = CHART_RENDERER_PREFERENCES.indexOf(current);
      const next = CHART_RENDERER_PREFERENCES[(index + 1) % CHART_RENDERER_PREFERENCES.length] ?? "auto";
      const nextConfig = {
        ...state.config,
        chartPreferences: {
          ...state.config.chartPreferences,
          renderer: next,
        },
      };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      persistConfig(nextConfig);
      closeAll({ revertThemePreview: false });
      return;
    }
    case "language": {
      const current = state.config.language ?? "auto";
      const next = resolveLanguageCommandPreference(current, arg);
      if (!next) {
        notify(
          `${t("Unsupported language")}: ${arg.trim()}. LANG auto | en | es | zh-CN | zh-TW | ja | ko`,
          { type: "error" },
        );
        return;
      }
      const nextConfig = { ...state.config, language: next };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      persistConfig(nextConfig);
      applyLanguagePreference(next);
      const languageLabel = next === "auto" ? t(LANGUAGE_DISPLAY_NAMES.auto) : LANGUAGE_DISPLAY_NAMES[next];
      notify(`${t("Language")}: ${languageLabel}`, { type: "success" });
      closeAll({ revertThemePreview: false });
      return;
    }
    case "toggle-value-flashing": {
      const nextConfig = {
        ...state.config,
        valueFlashingEnabled: !state.config.valueFlashingEnabled,
      };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      persistConfig(nextConfig);
      closeAll({ revertThemePreview: false });
      return;
    }
    case "font-size-increase":
    case "font-size-decrease": {
      const delta = command.id === "font-size-increase" ? 1 : -1;
      const current = clampFontSize(state.config.fontSize);
      const next = clampFontSize(current + delta);
      if (next === current) {
        notify(`Font size already at ${next === MIN_FONT_SIZE_PX ? "minimum" : "maximum"} (${next}px)`, { type: "info" });
        closeAll({ revertThemePreview: false });
        return;
      }
      const nextConfig = { ...state.config, fontSize: next };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      persistConfig(nextConfig);
      notify(`Font size: ${next}px`, { type: "success" });
      closeAll({ revertThemePreview: false });
      return;
    }
    case "check-for-updates":
      void onCheckForUpdates?.();
      closeAll({ revertThemePreview: false });
      return;
    case "theme":
      setRootThemeBaseId(getState().config.theme);
      setRootQuery(arg ? `TH ${arg}` : "TH ");
      return;
    case "security-description":
      runSecurityDescriptionShortcut(arg);
      return;
    case "remove-watchlist":
    case "remove-portfolio":
    case "add-watchlist":
    case "add-portfolio":
      executeCollectionCommand(command.id, arg);
      return;
    default:
      if (isRouteCommandId(command.id)) {
        const screen = routeCommandIdToScreen(command.id);
        if (screen) openModeRoute(screen, arg);
        return;
      }
      command.execute?.(dispatch, { activeTicker: activeTickerSymbol, activeCollectionId });
      closeAll({ revertThemePreview: false });
  }
}
