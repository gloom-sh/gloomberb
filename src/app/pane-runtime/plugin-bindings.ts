import type { Dispatch } from "react";
import {
  applyPaneSettingFieldValue as applyPaneSettingFieldValueShared,
  createPaneTemplateOrThrow,
} from "../../components/command-bar/workflow/ops";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { openFormModal } from "../../components/form-modal";
import { t } from "../../i18n";
import { openBrokerAddFlow } from "../../plugins/builtin/broker-manager/add-request";
import { getPanelFocusTarget } from "../../core/state/app/layout";
import { getVisiblePaneCycleOrder } from "../../components/layout/pane/cycle-order";
import {
  collectDisabledPaneIds,
  resolveShellVisibleLayout,
  restoreShellHiddenPanes,
} from "../../components/layout/shell/visible-layout";
import { applyPluginToggles } from "../../plugins/ownership";
import { setLayoutManagerDispatch } from "../../plugins/builtin/layout-manager";
import { setMarketplaceHost } from "../../plugins/builtin/plugin-marketplace/store";
import type { InstalledPlugin } from "../../plugins/builtin/plugin-marketplace/model";
import {
  listExternalPlugins,
  removeExternalPlugin,
  setExternalPlugins,
  upsertExternalPlugin,
} from "../../plugins/external-runtime";
import { getPluginHealth } from "../../plugins/health";
import type { LoadedExternalPlugin } from "../../plugins/loader";
import { materializeMarketplaceLayout } from "../../shares/portable-layout";
import {
  isPaneInLayout,
  removePane,
} from "../../layout/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import { PluginOffError, notifyPluginOff } from "../../plugins/plugin-off";
import { reportCrash } from "../../telemetry/crash-reports";
import { recordFunctionOpen, usageFunctionForPane } from "../../telemetry/usage-counts";
import { captureAttentionAction } from "../../telemetry/attention-counts";
import { publicTickerKey } from "../../utils/exchanges";
import {
  resolveTickerNavigationReplacementPane,
  shouldFocusTickerNavigationTarget,
} from "../../layout/ticker-navigation";
import {
  resolveTickerForPane,
  type AppAction,
  type AppState,
} from "../../state/app/context";
import type {
  LayoutConfig,
  PaneInstanceConfig,
} from "../../types/config";
import { findPaneInstance, TICKER_RESEARCH_PANE_ID } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type {
  PaneDef,
  PaneSettingField,
  PaneTemplateCreateOptions,
  PaneTemplateInstanceConfig,
  PinTickerOptions,
} from "../../types/plugin";
import type { TickerOpenTarget } from "../../tickers/open-target";
import { instrumentFromTicker } from "../../market-data/request-types";
import { tickerInstrumentLabel } from "../../tickers/instrument-label";
import { isDialogOpen } from "../../ui/dialog-stack";
import { stableStringify } from "../../utils/hash";

// Registry callbacks are rebound on renders. Request ownership must survive
// that rebinding, while separate source panes retain independent navigation.
const tickerNavigationRequests = new WeakMap<PluginRegistry, Map<string | null, symbol>>();

interface BindAppPanePluginRegistryOptions {
  activatePane: (paneId: string) => void;
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
  openPaneSettings: (paneId?: string, options?: { fieldKey?: string }) => Promise<void>;
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
  resolveOpenTickerTarget: (
    rawSymbol: string,
    publicOnly?: boolean,
    canPresentFeedback?: () => boolean,
  ) => Promise<TickerOpenTarget | null>;
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
  // Switching plugins never edits the layout: the shell hides a switched-off
  // plugin's panes where they are and shows them again when it comes back.
  // Only focus moves, off a pane that just went hidden.
  const setPluginsEnabled = (changes: Readonly<Record<string, boolean>>) => {
    const current = stateRef.current;
    // Setting a state, not flipping it, so a second "Turn on" from an older
    // toast cannot switch the plugin back off.
    const disabledPlugins = applyPluginToggles(current.config.disabledPlugins ?? [], changes);
    if (!disabledPlugins) return;
    const focused = current.focusedPaneId ? findPaneInstance(current.config.layout, current.focusedPaneId) : undefined;
    const focusHidden = !!focused && collectDisabledPaneIds(pluginRegistry, disabledPlugins).has(focused.paneId);
    dispatch(focusHidden
      ? {
        type: "SET_DISABLED_PLUGINS",
        disabledPlugins,
        focusedPaneId: getVisiblePaneCycleOrder(current.config.layout, pluginRegistry, disabledPlugins)[0] ?? null,
      }
      : { type: "SET_DISABLED_PLUGINS", disabledPlugins });
    const nextConfig = { ...current.config, disabledPlugins };
    persistConfig(nextConfig);
    pluginRegistry.events.emit("config:changed", { config: nextConfig });
  };
  const setPluginEnabled = (pluginId: string, enabled: boolean) => setPluginsEnabled({ [pluginId]: enabled });

  pluginRegistry.bindHost({
    setPluginEnabled,
    setPluginsEnabled,
    selectTicker: (symbol, paneId) => selectTickerInPane(symbol, paneId),
    switchPanel: (panel) => {
      if (isDetachedWindow) return;
      const paneId = getPanelFocusTarget(stateRef.current.config.layout, panel);
      if (paneId) dispatch({ type: "FOCUS_PANE", paneId });
    },
    switchTab: (tabId, paneId) => switchTickerResearchTab(tabId, paneId),
    // The bar would open over a dialog without its keys, so it waits for none to be open.
    openCommandBar: (query) => {
      if (isDetachedWindow || isDialogOpen()) return;
      dispatch({ type: "SET_COMMAND_BAR", open: true, query });
    },
    // Forms submit through the main window's state, so a detached window says where to go.
    openPluginCommandWorkflow: (commandId) => {
      if (isDetachedWindow) {
        pluginRegistry.notify({ body: t("Open this from the main window."), type: "info" });
        return;
      }
      const command = pluginRegistry.commands.get(commandId);
      if (!command?.wizard || command.wizard.length === 0) {
        // Nothing to fill in: the bar opens, as it always has for such a command.
        if (!isDialogOpen()) dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
        return;
      }
      openFormModal({ kind: "plugin-command", commandId });
    },
    openBuiltInWorkflow: (actionId) => {
      if (isDetachedWindow) {
        pluginRegistry.notify({ body: t("Open this from the main window."), type: "info" });
        return;
      }
      // Profiles are added in the Brokers pane, not in a form.
      if (actionId === "add-broker-account") {
        openBrokerAddFlow(pluginRegistry);
        return;
      }
      openFormModal({ kind: "builtin", actionId });
    },
    getLayout: () => stateRef.current.config.layout,
    updateLayout: (layout) => {
      if (isDetachedWindow) return;
      persistLayout(layout);
    },
    openPaneSettings: (paneId, options) => { void openPaneSettings(paneId, options); },
    showPane: (paneId) => {
      if (isDetachedWindow) return;
      showPane(paneId);
    },
    createPaneFromTemplateAsync: async (templateId, options) => {
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
    },
    openPortablePaneShareAsync: async (payload) => {
      if (isDetachedWindow) throw new Error("Open shared panes in the main window.");
      const materialized = materializeMarketplaceLayout(payload);
      const sharedPane = materialized.layout.instances[0];
      if (!sharedPane) throw new Error("This shared pane is invalid.");
      const paneDef = pluginRegistry.panes.get(sharedPane.paneId);
      if (!paneDef) throw new Error("This shared pane is unavailable in this version of Gloomberb.");
      const owner = pluginRegistry.getDisabledPaneOwner(sharedPane.paneId, stateRef.current.config.disabledPlugins);
      if (owner) throw new PluginOffError(owner, "this shared pane");
      const instance = buildPaneInstance(sharedPane.paneId, sharedPane);
      if (!instance) throw new Error("This shared pane could not be created.");
      dispatch({
        type: "REPLACE_PANE_STATE",
        paneId: instance.instanceId,
        state: materialized.paneState[instance.instanceId] ?? {},
      });
      placePaneInstance(instance, paneDef, { placement: "floating" });
    },
    createPaneFromTemplate: (templateId, options) => {
      if (isDetachedWindow) return;
      void createPaneFromTemplate(templateId, options);
    },
    applyPaneSettingValue: async (paneId, field: PaneSettingField, value) => {
      await applyPaneSettingFieldValueShared(paneId, field, value, {
        dataProvider,
        tickerRepository,
        pluginRegistry,
        dispatch,
        getState: () => stateRef.current,
        persistLayout,
      });
    },
    hidePane: (paneId) => {
      if (isDetachedWindow) return;
      const instanceId = resolvePaneTarget(paneId);
      const layout = stateRef.current.config.layout;
      if (!instanceId || !isPaneInLayout(layout, instanceId)) return;
      persistLayout(removePane(layout, instanceId));
    },
    focusPane: (paneId, layout) => {
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
      // In the layout but hidden with its plugin, as the research pane that
      // follows a list is while Ticker Research is off.
      const paneType = findPaneInstance(stateRef.current.config.layout, instanceId)?.paneId;
      const owner = paneType ? pluginRegistry.getDisabledPaneOwner(paneType, stateRef.current.config.disabledPlugins) : null;
      if (owner) {
        const what = resolveTickerForPane(stateRef.current, instanceId) ?? pluginRegistry.panes.get(paneType!)?.name ?? paneType!;
        notifyPluginOff(pluginRegistry, new PluginOffError(owner, what), () => pluginRegistry.focusPane(paneId, layout));
        return;
      }

      focusVisiblePane(instanceId, layout);
    },
    // Ticker links in panes and menus, and DES from the command bar, open the
    // research pane (or the pane asked for) through these two.
    pinTicker: (symbol, options) => {
      if (isDetachedWindow) return;
      recordFunctionOpen(usageFunctionForPane(pluginRegistry, options?.paneType ?? TICKER_RESEARCH_PANE_ID));
      void openPinnedTicker(symbol, options);
    },
    navigateTicker: (rawSymbol, options) => {
      if (isDetachedWindow) return;
      // Navigation lands in a research pane, which stays hidden while its plugin is off.
      const researchOwner = pluginRegistry.getDisabledPaneOwner(TICKER_RESEARCH_PANE_ID, stateRef.current.config.disabledPlugins);
      if (researchOwner) {
        notifyPluginOff(pluginRegistry, new PluginOffError(researchOwner, rawSymbol), () => pluginRegistry.navigateTicker(rawSymbol, options));
        return;
      }
      const recordAttention = captureAttentionAction();
      recordFunctionOpen(usageFunctionForPane(pluginRegistry, TICKER_RESEARCH_PANE_ID));
      const sourcePaneId = options?.sourcePaneId ?? stateRef.current.focusedPaneId;
      const requests = tickerNavigationRequests.get(pluginRegistry) ?? new Map<string | null, symbol>();
      tickerNavigationRequests.set(pluginRegistry, requests);
      const request = Symbol();
      requests.set(sourcePaneId, request);
      const ownsRequest = () => requests.get(sourcePaneId) === request;
      const originalPane = resolveTickerNavigationReplacementPane(stateRef.current.config.layout, sourcePaneId);
      const originalBinding = originalPane ? stableStringify(originalPane.binding) : null;
      const ownsDestination = () => {
        if (!ownsRequest()) return false;
        if (!originalPane) return true;
        const currentPane = resolveTickerNavigationReplacementPane(stateRef.current.config.layout, sourcePaneId);
        // Direct commands and pane closure also supersede a pending navigation.
        return !!currentPane && stableStringify(currentPane.binding) === originalBinding;
      };
      const canPresentFeedback = () => ownsDestination() && shouldFocusTickerNavigationTarget({
        sourcePaneId,
        currentFocusedPaneId: stateRef.current.focusedPaneId,
        targetPaneId: originalPane?.instanceId ?? null,
      });
      (async () => {
        try {
          const target = await resolveOpenTickerTarget(rawSymbol, false, canPresentFeedback);
          if (!target || !ownsDestination()) return;
          const symbol = target.symbol;

          const currentState = stateRef.current;
          const currentLayout = currentState.config.layout;
          const detailPane = resolveTickerNavigationReplacementPane(currentLayout, sourcePaneId);
          const focusIfStillOwned = (paneId: string) => {
            if (!shouldFocusTickerNavigationTarget({
              sourcePaneId,
              currentFocusedPaneId: stateRef.current.focusedPaneId,
              targetPaneId: paneId,
            })) {
              return;
            }
            activatePane(paneId);
          };

          if (detailPane) {
            publishTickerOpenTarget(target);
            const instrument = target.instrument !== undefined ? target.instrument
              : instrumentFromTicker(target.ticker)?.instrument ?? undefined;
            const binding = { kind: "fixed" as const, symbol,
              ...(instrument !== undefined ? { instrument } : {}),
              ...(target.listing ? { listing: target.listing } : {}),
            };
            const nextLayout = {
              ...currentLayout,
              instances: currentLayout.instances.map((instance) => (
                instance.instanceId === detailPane.instanceId
                  ? { ...instance, title: tickerInstrumentLabel(symbol, instrument), binding }
                  : instance
              )),
            };
            persistLayout(nextLayout);
            focusIfStillOwned(detailPane.instanceId);
            recordAttention(publicTickerKey(symbol, target.listing?.exchange ?? target.ticker.metadata.exchange), "des");
          } else if (shouldFocusTickerNavigationTarget({
            sourcePaneId,
            currentFocusedPaneId: stateRef.current.focusedPaneId,
            targetPaneId: null,
          })) {
            placePinnedTickerTarget(target, { floating: false });
            recordAttention(publicTickerKey(symbol, target.listing?.exchange ?? target.ticker.metadata.exchange), "des");
          }
        } catch (err) {
          if (!canPresentFeedback()) return;
          const message = err instanceof Error ? err.message : String(err);
          pluginRegistry.notify({ body: `Failed to navigate to ${rawSymbol}: ${message}`, type: "error" });
        } finally {
          if (ownsRequest()) requests.delete(sourcePaneId);
        }
      })();
    },
  });

  // Layout commands (Tidy, Swap, Float, Close) act on what is on screen, as
  // the shell's own menus do, and leave a switched-off plugin's panes alone.
  const disabledPaneIds = () => collectDisabledPaneIds(pluginRegistry, stateRef.current.config.disabledPlugins);
  setLayoutManagerDispatch(dispatch, () => ({
    layout: resolveShellVisibleLayout(state.config.layout, disabledPaneIds(), pluginRegistry.panes),
    termWidth: pluginRegistry.getTermSize().width,
    termHeight: pluginRegistry.getTermSize().height,
    focusedPaneId: state.focusedPaneId,
  }), (edited) => restoreShellHiddenPanes(stateRef.current.config.layout, edited, disabledPaneIds(), pluginRegistry.panes));

  setExternalPlugins(externalPlugins);

  setMarketplaceHost({
    listInstalled: () => {
      const disabled = new Set(stateRef.current.config.disabledPlugins ?? []);
      const externalById = new Map(listExternalPlugins().map((entry) => [entry.plugin.id, entry]));
      const installed: InstalledPlugin[] = [];

      for (const plugin of pluginRegistry.allPlugins.values()) {
        const external = externalById.get(plugin.id);
        externalById.delete(plugin.id);
        const health = getPluginHealth(plugin.id);
        const hasSetup = !!plugin.configSchema && plugin.configSchema.length > 0;
        installed.push({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          ...(plugin.description ? { description: plugin.description } : {}),
          toggleable: plugin.toggleable === true,
          enabled: !disabled.has(plugin.id),
          source: external ? "external" : "builtin",
          ...(external?.directory ? { directory: external.directory, path: external.path } : {}),
          ...(external?.commit ? { commit: external.commit } : {}),
          ...(external?.linked ? { linked: true } : {}),
          hasSetup,
          needsSetup: hasSetup && !pluginRegistry.isPluginConfigured(plugin.id),
          errorCount: health.errorCount,
          ...(health.lastError ? { lastError: health.lastError.message } : {}),
          ...(external?.needsRestart ? { needsRestart: true } : {}),
        });
      }

      // Entries that never registered — a broken import, or a plugin this
      // renderer cannot run. They are invisible everywhere else, which is
      // exactly why the marketplace has to show them.
      for (const entry of externalById.values()) {
        installed.push({
          id: entry.plugin.id,
          name: entry.plugin.name,
          version: entry.plugin.version ?? "",
          ...(entry.plugin.description ? { description: entry.plugin.description } : {}),
          toggleable: true,
          enabled: !disabled.has(entry.plugin.id),
          source: "external",
          ...(entry.directory ? { directory: entry.directory, path: entry.path } : {}),
          ...(entry.commit ? { commit: entry.commit } : {}),
          ...(entry.linked ? { linked: true } : {}),
          ...(entry.unsupportedTarget ? { unsupportedTarget: entry.unsupportedTarget } : {}),
          ...(entry.error ? { loadError: entry.error } : {}),
          ...(entry.needsGloomberb ? { needsGloomberb: entry.needsGloomberb } : {}),
          ...(entry.needsRestart ? { needsRestart: true } : {}),
        });
      }

      return installed;
    },
    activate: async (entry) => {
      if (isDetachedWindow) throw new Error("Manage plugins from the main window.");
      const pluginId = entry.plugin.id;
      // New files under modules this process already imported: loading them
      // would mix old and new code, so what is running keeps running and the
      // row asks for a restart. The commit is the checkout's, now the new one.
      if (entry.needsRestart) {
        const running = listExternalPlugins().find((existing) => existing.directory === entry.directory);
        upsertExternalPlugin({ ...(running ?? entry), ...(entry.commit ? { commit: entry.commit } : {}), needsRestart: true });
        return;
      }
      if (entry.error || entry.unsupportedTarget) {
        upsertExternalPlugin(entry);
        return;
      }
      // An update replaces the running registration. If the old one will not
      // let go cleanly, the new code cannot be trusted to coexist with it, so
      // the row asks for a restart instead of half-loading.
      if (pluginRegistry.allPlugins.has(pluginId)) {
        try {
          pluginRegistry.unregister(pluginId);
        } catch (error) {
          upsertExternalPlugin({ ...entry, needsRestart: true });
          throw error;
        }
      }
      try {
        await pluginRegistry.register(entry.plugin);
        upsertExternalPlugin(entry);
      } catch (error) {
        upsertExternalPlugin({ ...entry, error: error instanceof Error ? error.message : String(error) });
        reportCrash(error, { kind: "plugin", plugin: pluginId });
        throw error;
      }
    },
    deactivate: async (pluginId, directory) => {
      if (isDetachedWindow) throw new Error("Manage plugins from the main window.");
      const paneIds = pluginRegistry.getPluginPaneIds(pluginId);
      for (const paneId of paneIds) pluginRegistry.hidePane(paneId);
      const current = stateRef.current.config;
      const layout = current.layout;
      const orphaned = new Set(layout.instances.filter((instance) => paneIds.includes(instance.paneId)).map((instance) => instance.instanceId));
      if (orphaned.size > 0) {
        let next: LayoutConfig = layout;
        for (const instanceId of orphaned) next = removePane(next, instanceId);
        persistLayout(next);
      }
      if (pluginRegistry.allPlugins.has(pluginId)) pluginRegistry.unregister(pluginId);
      removeExternalPlugin(pluginId, directory);
    },
    contributions: (pluginId) => {
      const panes = pluginRegistry.getPluginPaneIds(pluginId)
        .map((id) => ({ id, name: pluginRegistry.panes.get(id)?.name ?? id }));
      const templates = pluginRegistry.getPluginPaneTemplateIds(pluginId)
        .map((id) => {
          const template = pluginRegistry.paneTemplates.get(id);
          return { id, label: template?.label ?? id, ...(template?.shortcut?.prefix ? { prefix: template.shortcut.prefix } : {}) };
        });
      const commands = [...pluginRegistry.commands.entries()]
        .filter(([id]) => pluginRegistry.getCommandPluginId(id) === pluginId && !id.endsWith(":setup"))
        .map(([id, command]) => ({ id, label: command.label }));
      const capabilities = pluginRegistry.capabilities.manifests()
        .filter((manifest) => pluginRegistry.getCapabilityPluginId(manifest.id) === pluginId).length;
      const broker = [...pluginRegistry.brokers.keys()].some((type) => pluginRegistry.getBrokerPluginId(type) === pluginId);
      return { panes, templates, commands, capabilities, broker };
    },
    notify: (notification) => {
      pluginRegistry.notify(notification);
    },
    setPluginEnabled,
  });
}
