import type { Dispatch } from "react";
import {
  applyPaneSettingFieldValue as applyPaneSettingFieldValueShared,
  createPaneTemplateOrThrow,
} from "../../components/command-bar/workflow/ops";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { setLayoutManagerDispatch } from "../../plugins/builtin/layout-manager";
import { setMarketplaceHost } from "../../plugins/builtin/plugin-marketplace/store";
import type { InstalledPlugin } from "../../plugins/builtin/plugin-marketplace/model";
import type { LoadedExternalPlugin } from "../../plugins/loader";
import { materializeMarketplaceLayout } from "../../layout-marketplace/payload";
import {
  isPaneInLayout,
  removePane,
} from "../../plugins/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import {
  resolveTickerNavigationReplacementPane,
  shouldFocusTickerNavigationTarget,
} from "../../plugins/ticker-navigation";
import type {
  AppAction,
  AppState,
} from "../../state/app/context";
import type {
  LayoutConfig,
  PaneInstanceConfig,
} from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type {
  PaneDef,
  PaneSettingField,
  PaneTemplateCreateOptions,
  PaneTemplateInstanceConfig,
  PinTickerOptions,
} from "../../types/plugin";
import type { TickerOpenTarget } from "../../tickers/open-target";

interface BindAppPanePluginRegistryOptions {
  activatePane: (paneId: string, layout?: LayoutConfig) => void;
  buildPaneInstance: (paneType: string, options?: {
    title?: string;
    binding?: PaneInstanceConfig["binding"];
    params?: Record<string, string>;
    settings?: Record<string, unknown>;
    instanceId?: string;
  }) => PaneInstanceConfig | null;
  createPaneFromTemplate: (templateId: string, options?: PaneTemplateCreateOptions) => Promise<void>;
  dataProvider: DataProvider;
  detachedPaneId: string | null;
  dispatch: Dispatch<AppAction>;
  externalPlugins: readonly LoadedExternalPlugin[];
  focusVisiblePane: (paneId: string, layout?: LayoutConfig) => void;
  isDetachedWindow: boolean;
  openPaneSettings: (paneId?: string) => Promise<void>;
  openPinnedTicker: (rawSymbol: string, options?: PinTickerOptions) => Promise<void>;
  persistConfig: (nextConfig: AppState["config"]) => void;
  persistLayout: (layout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  placePaneInstance: (
    instance: PaneInstanceConfig,
    paneDef: PaneDef,
    options?: PaneTemplateInstanceConfig,
  ) => void;
  placePinnedTickerTarget: (target: TickerOpenTarget, options?: PinTickerOptions) => void;
  pluginRegistry: PluginRegistry;
  publishTickerOpenTarget: (target: TickerOpenTarget) => void;
  resolveOpenTickerTarget: (rawSymbol: string) => Promise<TickerOpenTarget | null>;
  resolvePaneTarget: (paneId: string, layout?: LayoutConfig) => string | null;
  selectTickerInPane: (symbol: string, preferredPaneId?: string | null) => void;
  showPane: (paneId: string) => void;
  state: AppState;
  stateRef: { current: AppState };
  switchTickerResearchTab: (tabId: string, preferredPaneId?: string | null) => void;
  tickerRepository: AppTickerRepositoryPort;
}

export function bindAppPanePluginRegistry({
  activatePane,
  buildPaneInstance,
  createPaneFromTemplate,
  dataProvider,
  detachedPaneId,
  dispatch,
  externalPlugins,
  focusVisiblePane,
  isDetachedWindow,
  openPaneSettings,
  openPinnedTicker,
  persistConfig,
  persistLayout,
  placePaneInstance,
  placePinnedTickerTarget,
  pluginRegistry,
  publishTickerOpenTarget,
  resolveOpenTickerTarget,
  resolvePaneTarget,
  selectTickerInPane,
  showPane,
  state,
  stateRef,
  switchTickerResearchTab,
  tickerRepository,
}: BindAppPanePluginRegistryOptions): void {
  pluginRegistry.selectTickerFn = (symbol, paneId) => selectTickerInPane(symbol, paneId);
  pluginRegistry.switchPanelFn = (panel) => {
    if (isDetachedWindow) return;
    dispatch({ type: "SET_ACTIVE_PANEL", panel });
  };
  pluginRegistry.switchTabFn = (tabId, paneId) => switchTickerResearchTab(tabId, paneId);
  pluginRegistry.openCommandBarFn = (query) => {
    if (isDetachedWindow) return;
    dispatch({ type: "SET_COMMAND_BAR", open: true, query });
  };
  pluginRegistry.openPluginCommandWorkflowFn = (commandId) => {
    if (isDetachedWindow) return;
    dispatch({
      type: "SET_COMMAND_BAR",
      open: true,
      query: "",
      launch: { kind: "plugin-command", commandId },
    });
  };
  pluginRegistry.getLayoutFn = () => stateRef.current.config.layout;
  pluginRegistry.updateLayoutFn = (layout) => {
    if (isDetachedWindow) return;
    persistLayout(layout);
  };
  pluginRegistry.openPaneSettingsFn = (paneId) => { void openPaneSettings(paneId); };
  pluginRegistry.showPaneFn = (paneId) => {
    if (isDetachedWindow) return;
    showPane(paneId);
  };
  pluginRegistry.createPaneFromTemplateAsyncFn = async (templateId, options) => {
    if (isDetachedWindow) return;
    await createPaneTemplateOrThrow(templateId, options, {
      dataProvider,
      tickerRepository,
      pluginRegistry,
      dispatch,
      getState: () => stateRef.current,
      buildPaneInstance,
      placePaneInstance,
    });
  };
  pluginRegistry.openPortablePaneShareAsyncFn = async (payload) => {
    if (isDetachedWindow) throw new Error("Open shared panes in the main window.");
    const materialized = materializeMarketplaceLayout(payload);
    const sharedPane = materialized.layout.instances[0];
    if (!sharedPane) throw new Error("This shared pane is invalid.");
    const paneDef = pluginRegistry.panes.get(sharedPane.paneId);
    const ownerId = pluginRegistry.getPanePluginId(sharedPane.paneId);
    if (!paneDef || (ownerId && stateRef.current.config.disabledPlugins.includes(ownerId))) {
      throw new Error("This shared pane is unavailable in this version of Gloomberb.");
    }
    const instance = buildPaneInstance(sharedPane.paneId, sharedPane);
    if (!instance) throw new Error("This shared pane could not be created.");
    dispatch({
      type: "REPLACE_PANE_STATE",
      paneId: instance.instanceId,
      state: materialized.paneState[instance.instanceId] ?? {},
    });
    placePaneInstance(instance, paneDef, { placement: "floating" });
  };
  pluginRegistry.createPaneFromTemplateFn = (templateId, options) => {
    if (isDetachedWindow) return;
    void createPaneFromTemplate(templateId, options);
  };
  pluginRegistry.applyPaneSettingValueFn = async (paneId, field: PaneSettingField, value) => {
    await applyPaneSettingFieldValueShared(paneId, field, value, {
      dataProvider,
      tickerRepository,
      pluginRegistry,
      dispatch,
      getState: () => stateRef.current,
      persistLayout,
    });
  };
  pluginRegistry.hidePaneFn = (paneId) => {
    if (isDetachedWindow) return;
    const instanceId = resolvePaneTarget(paneId);
    const layout = stateRef.current.config.layout;
    if (!instanceId || !isPaneInLayout(layout, instanceId)) return;
    persistLayout(removePane(layout, instanceId));
  };
  pluginRegistry.focusPaneFn = (paneId) => {
    if (isDetachedWindow) {
      if (paneId === detachedPaneId) {
        dispatch({ type: "FOCUS_PANE", paneId });
      }
      return;
    }
    const instanceId = resolvePaneTarget(paneId);
    if (!instanceId || !isPaneInLayout(stateRef.current.config.layout, instanceId)) {
      showPane(paneId);
      return;
    }

    focusVisiblePane(instanceId);
  };
  pluginRegistry.pinTickerFn = (symbol, options) => {
    if (isDetachedWindow) return;
    void openPinnedTicker(symbol, options);
  };
  pluginRegistry.navigateTickerFn = (rawSymbol, options) => {
    if (isDetachedWindow) return;
    const sourcePaneId = options?.sourcePaneId ?? stateRef.current.focusedPaneId;
    (async () => {
      try {
        const target = await resolveOpenTickerTarget(rawSymbol);
        if (!target) return;
        const symbol = target.symbol;

        const currentState = stateRef.current;
        const currentLayout = currentState.config.layout;
        const detailPane = resolveTickerNavigationReplacementPane(currentLayout, sourcePaneId);
        const focusIfStillOwned = (paneId: string, layout: LayoutConfig) => {
          if (!shouldFocusTickerNavigationTarget({
            sourcePaneId,
            currentFocusedPaneId: stateRef.current.focusedPaneId,
            targetPaneId: paneId,
          })) {
            return;
          }
          activatePane(paneId, layout);
        };

        if (detailPane) {
          publishTickerOpenTarget(target);
          const nextLayout = {
            ...currentLayout,
            instances: currentLayout.instances.map((instance) => (
              instance.instanceId === detailPane.instanceId
                ? { ...instance, title: symbol, binding: { kind: "fixed" as const, symbol } }
                : instance
            )),
          };
          persistLayout(nextLayout);
          focusIfStillOwned(detailPane.instanceId, nextLayout);
        } else if (shouldFocusTickerNavigationTarget({
          sourcePaneId,
          currentFocusedPaneId: stateRef.current.focusedPaneId,
          targetPaneId: null,
        })) {
          placePinnedTickerTarget(target, { floating: false });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pluginRegistry.notify({ body: `Failed to navigate to ${rawSymbol}: ${message}`, type: "error" });
      }
    })();
  };

  setLayoutManagerDispatch(dispatch, () => ({
    layout: state.config.layout,
    termWidth: pluginRegistry.getTermSizeFn().width,
    termHeight: pluginRegistry.getTermSizeFn().height,
    focusedPaneId: state.focusedPaneId,
  }));

  setMarketplaceHost({
    listInstalled: () => {
      const disabled = new Set(stateRef.current.config.disabledPlugins ?? []);
      const externalById = new Map(externalPlugins.map((entry) => [entry.plugin.id, entry]));
      const installed: InstalledPlugin[] = [];

      for (const plugin of pluginRegistry.allPlugins.values()) {
        const external = externalById.get(plugin.id);
        externalById.delete(plugin.id);
        installed.push({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          ...(plugin.description ? { description: plugin.description } : {}),
          toggleable: plugin.toggleable === true,
          enabled: !disabled.has(plugin.id),
          source: external ? "external" : "builtin",
        });
      }

      // Entries that never registered — a broken import, or a plugin this
      // renderer cannot run. They are invisible everywhere else, which is
      // exactly why the marketplace has to show them.
      for (const entry of externalById.values()) {
        installed.push({
          id: entry.plugin.id,
          name: entry.plugin.name,
          version: entry.plugin.version ?? "0.0.0",
          ...(entry.plugin.description ? { description: entry.plugin.description } : {}),
          toggleable: true,
          enabled: !disabled.has(entry.plugin.id),
          source: "external",
          ...(entry.unsupportedTarget ? { unsupportedTarget: entry.unsupportedTarget } : {}),
          ...(entry.error ? { loadError: entry.error } : {}),
        });
      }

      return installed;
    },
    setPluginEnabled: (pluginId, enabled) => {
      const current = stateRef.current.config;
      if (!enabled) {
        for (const paneId of pluginRegistry.getPluginPaneIds(pluginId)) pluginRegistry.hidePane(paneId);
      }
      dispatch({ type: "TOGGLE_PLUGIN", pluginId });
      const disabled = current.disabledPlugins ?? [];
      persistConfig({
        ...current,
        disabledPlugins: enabled
          ? disabled.filter((entry) => entry !== pluginId)
          : [...disabled, pluginId],
      });
    },
  });
}
