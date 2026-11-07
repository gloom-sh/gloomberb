import type { Dispatch } from "react";
import type { PluginRegistry } from "../plugins/registry";
import { apiClient } from "../api-client";
import type { AppAction, AppState } from "../state/app/context";
import type { PaneRuntimeState } from "../core/state/app/state";
import { setPaneSettings } from "../pane-settings";
import { findPaneInstance, type LayoutConfig } from "../types/config";
import { getBasePaneDisplayTitle } from "../components/layout/pane/title";
import { commandBarResultsFromNodes, commandBarSnapshot } from "./command-bar";
import { formNodes, formSnapshot } from "./form";
import type { RemoteUiRegistry } from "./semantic-tree";
import { REMOTE_AGENT_HELP, remoteControlSchema } from "./schema";
import type { RemoteIncludedState, RemoteStateInclude, RemoteUiNodeSnapshot } from "./types";
import {
  activeLayoutRev,
  normalizeIncludes,
  paneSnapshot,
  paneSummary,
  type PatchTarget,
} from "./controller-utils";
import { finiteOrNull } from "../utils/guards";

/**
 * Deprecated: the app no longer tracks a left or right panel. The key stays
 * with a fixed value so older clients that read it keep working.
 */
const DEPRECATED_ACTIVE_PANEL = "left";

interface RemoteResourceContext {
  dispatch: Dispatch<AppAction>;
  getState: () => AppState;
  pluginRegistry: PluginRegistry;
  uiRegistry: RemoteUiRegistry | null;
  /** Whether a dialog (a form, a confirm, pane settings) is open now. */
  isDialogOpen: () => boolean;
}

/**
 * Broker accounts as last imported, with the figures an agent needs to answer
 * questions about cash, margin and the day, and where each figure came from.
 */
function brokerAccountsResource(state: AppState) {
  return state.config.brokerInstances.map((instance) => ({
    brokerInstanceId: instance.id,
    brokerType: instance.brokerType,
    label: instance.label,
    connectionMode: instance.connectionMode ?? null,
    enabled: instance.enabled !== false,
    portfolioIds: state.config.portfolios
      .filter((portfolio) => portfolio.brokerInstanceId === instance.id)
      .map((portfolio) => portfolio.id),
    accounts: (state.brokerAccounts[instance.id] ?? []).map((account) => {
      const netLiquidation = finiteOrNull(account.netLiquidation);
      const grossPositionValue = finiteOrNull(account.grossPositionValue);
      const totalCashValue = finiteOrNull(account.totalCashValue);
      return {
        ...account,
        updatedAt: account.updatedAt ? new Date(account.updatedAt).toISOString() : null,
        dailyPnlAsOf: account.dailyPnlAsOf ? new Date(account.dailyPnlAsOf).toISOString() : null,
        /** Borrowed cash, in the account currency, when net cash is negative. */
        marginLoan: totalCashValue != null && totalCashValue < 0 ? -totalCashValue : 0,
        leverage: netLiquidation && grossPositionValue != null ? grossPositionValue / netLiquidation : null,
        /** "broker": the broker's own day P&L. "quotes": none reported; the app estimates it from quotes. */
        dailyPnlBasis: finiteOrNull(account.dailyPnl) != null ? "broker" : "quotes",
      };
    }),
  }));
}

/**
 * What the default snapshot leaves out for its size, and where to read it:
 * an agent reads the schema and the guide once, not with every look.
 */
const SNAPSHOT_REFERENCES = {
  schema: "Every resource and operation with its input: { type: 'schema' } (gloom remote schema). Read it once.",
  help: "Recipes and caveats: app://remote/help (gloom remote help).",
  ui: "ui lists the labelled controls; ui://tree lists every node, unlabelled click areas too.",
  paneState: "What a pane loaded and where it is (panes[].runtimeState, config.layouts[].paneState): app://pane-state/{paneId}, app://panes, app://config.",
  full: "app://snapshot/full has all of it inline.",
};

/** The config without what each saved layout's panes loaded: app://config keeps it. */
function configSummary(config: AppState["config"]): AppState["config"] {
  return { ...config, layouts: config.layouts.map(({ paneState: _paneState, ...layout }) => layout) };
}

/** A clickable box with no label: it says nothing an agent can act on by name. */
function isBareBox(node: { role: string; label?: string }): boolean {
  return node.role === "box" && !node.label;
}

export function createRemoteResources({
  dispatch,
  getState,
  pluginRegistry,
  uiRegistry,
  isDialogOpen,
}: RemoteResourceContext) {
  const getResource = (resource: string): unknown => {
    const state = getState();
    if (resource === "app://snapshot" || resource === "app://snapshot/full") {
      const uiNodes = uiRegistry?.snapshot() ?? [];
      const full = resource === "app://snapshot/full";
      return {
        rev: activeLayoutRev(state),
        app: {
          activePanel: DEPRECATED_ACTIVE_PANEL,
          focusedPaneId: state.focusedPaneId,
          previousFocusedPaneId: state.previousFocusedPaneId,
          statusBarVisible: state.statusBarVisible,
          commandBarOpen: state.commandBarOpen,
          commandBarQuery: state.commandBarQuery,
          initialized: state.initialized,
        },
        config: full ? state.config : configSummary(state.config),
        panes: state.config.layout.instances.map((pane) => (full ? paneSnapshot : paneSummary)(state, pane)),
        commandBar: commandBarSnapshot(state, uiNodes),
        form: formSnapshot(uiNodes, isDialogOpen()),
        ...full
          ? { ui: uiNodes, schema: remoteControlSchema(), help: REMOTE_AGENT_HELP }
          : { ui: uiNodes.filter((node) => !isBareBox(node)), references: SNAPSHOT_REFERENCES },
      };
    }
    if (resource === "app://config") return state.config;
    if (resource === "app://layout/current") return state.config.layout;
    if (resource === "app://layouts") return state.config.layouts;
    if (resource === "app://panes") return state.config.layout.instances.map((pane) => paneSnapshot(state, pane));
    if (resource === "app://pane-types") {
      return [...pluginRegistry.panes.values()].map((pane) => ({
        id: pane.id,
        name: pane.name,
        defaultPosition: pane.defaultPosition,
        defaultMode: pane.defaultMode,
        hasSettings: !!pane.settings,
      }));
    }
    if (resource === "app://pane-templates") {
      // An unlisted function (`listed: false`) is left out, as of every list.
      return [...pluginRegistry.paneTemplates.values()].filter((template) => template.listed !== false).map((template) => ({
        id: template.id,
        paneId: template.paneId,
        label: template.label,
        description: template.description,
        shortcut: template.shortcut,
      }));
    }
    if (resource.startsWith("app://pane-state/")) {
      const paneId = decodeURIComponent(resource.slice("app://pane-state/".length));
      return state.paneState[paneId] ?? {};
    }
    if (resource.startsWith("app://pane-settings/")) {
      const paneId = decodeURIComponent(resource.slice("app://pane-settings/".length));
      const descriptor = pluginRegistry.resolvePaneSettings(paneId);
      if (!descriptor) throw new Error(`Pane "${paneId}" does not expose settings.`);
      return {
        paneId: descriptor.paneId,
        settings: descriptor.context.settings,
        fields: descriptor.settingsDef.fields,
      };
    }
    if (resource === "app://commands") {
      return [...pluginRegistry.commands.values()].map((command) => ({
        id: command.id,
        label: command.label,
        description: command.description,
        shortcut: command.shortcut,
        hasWizard: !!command.wizard?.length,
      }));
    }
    if (resource === "app://command-bar") return commandBarSnapshot(state, uiRegistry?.snapshot() ?? []);
    if (resource === "app://command-bar/results") return commandBarResultsFromNodes(uiRegistry?.snapshot() ?? []);
    if (resource === "app://form") return formSnapshot(formNodes(uiRegistry), isDialogOpen());
    if (resource === "app://capabilities") return pluginRegistry.capabilities.manifests();
    if (resource === "app://auth") return apiClient.describeAuthState();
    if (resource === "app://accounts") return brokerAccountsResource(state);
    if (resource === "app://remote/help") return REMOTE_AGENT_HELP;
    if (resource === "ui://tree") return uiRegistry?.snapshot() ?? [];
    if (resource.startsWith("ui://node/")) {
      const nodeId = decodeURIComponent(resource.slice("ui://node/".length));
      const node = uiRegistry?.detail(nodeId);
      if (!node) throw new Error(`No UI node "${nodeId}" is on screen. Read ui://tree for the current ones.`);
      const pane = node.paneId ? findPaneInstance(state.config.layout, node.paneId) : undefined;
      const paneDef = pane ? pluginRegistry.panes.get(pane.paneId) : undefined;
      return pane && paneDef
        ? { ...node, paneTitle: getBasePaneDisplayTitle(state, pane, paneDef, pluginRegistry.panes) }
        : node;
    }
    throw new Error(`Unknown remote resource "${resource}".`);
  };

  const buildIncludedState = (include: RemoteStateInclude[] | undefined, defaults: RemoteStateInclude[] = []): RemoteIncludedState | undefined => {
    const included = normalizeIncludes(include, defaults);
    if (included.length === 0) return undefined;
    const state = getState();
    // The whole tree only for what lists from it; the form is read on its own.
    let tree: RemoteUiNodeSnapshot[] | undefined;
    const uiNodes = () => (tree ??= uiRegistry?.snapshot() ?? []);
    const result: RemoteIncludedState = {
      rev: activeLayoutRev(state),
      included,
    };
    if (included.includes("app")) {
      result.app = {
        activePanel: DEPRECATED_ACTIVE_PANEL,
        focusedPaneId: state.focusedPaneId,
        previousFocusedPaneId: state.previousFocusedPaneId,
        statusBarVisible: state.statusBarVisible,
        commandBarOpen: state.commandBarOpen,
        commandBarQuery: state.commandBarQuery,
        initialized: state.initialized,
        activeLayoutIndex: state.config.activeLayoutIndex,
        activeLayoutName: state.config.layouts[state.config.activeLayoutIndex]?.name ?? null,
      };
    }
    if (included.includes("layout")) result.layout = state.config.layout;
    if (included.includes("panes")) {
      result.panes = state.config.layout.instances.map((pane) => paneSummary(state, pane));
    }
    if (included.includes("commandBar") || included.includes("commandBar.results")) {
      const commandBar = commandBarSnapshot(state, uiNodes());
      result.commandBar = included.includes("commandBar")
        ? commandBar
        : { results: commandBar.results };
    }
    if (included.includes("form")) result.form = formSnapshot(formNodes(uiRegistry), isDialogOpen());
    if (included.includes("ui")) result.ui = uiNodes();
    if (included.includes("schema")) result.schema = remoteControlSchema();
    if (included.includes("help")) result.help = REMOTE_AGENT_HELP;
    return result;
  };

  const patchTarget = (resource: string): PatchTarget<unknown> => {
    const state = getState();
    if (resource === "app://config") {
      return {
        value: state.config,
        apply: (value) => dispatch({ type: "SET_CONFIG", config: value as AppState["config"] }),
      };
    }
    if (resource === "app://layout/current") {
      return {
        value: state.config.layout,
        apply: (value) => pluginRegistry.updateLayout(value as LayoutConfig),
      };
    }
    if (resource.startsWith("app://pane-state/")) {
      const paneId = decodeURIComponent(resource.slice("app://pane-state/".length));
      return {
        value: state.paneState[paneId] ?? {},
        apply: (value) => dispatch({ type: "REPLACE_PANE_STATE", paneId, state: value as PaneRuntimeState }),
      };
    }
    if (resource.startsWith("app://pane-settings/")) {
      const paneId = decodeURIComponent(resource.slice("app://pane-settings/".length));
      const descriptor = pluginRegistry.resolvePaneSettings(paneId);
      if (!descriptor) throw new Error(`Pane "${paneId}" does not expose settings.`);
      return {
        value: descriptor.context.settings,
        apply: (value) => {
          const nextLayout = setPaneSettings(getState().config.layout, descriptor.paneId, value as Record<string, unknown>);
          pluginRegistry.updateLayout(nextLayout);
        },
      };
    }
    throw new Error(`Remote resource "${resource}" is not patchable.`);
  };

  return {
    buildIncludedState,
    getResource,
    patchTarget,
  };
}
