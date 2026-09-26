import type { Dispatch, SetStateAction } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import { swapPanes } from "../../plugins/pane-manager";
import type { LayoutConfig } from "../../types/config";
import type { PaneSettingField } from "../../types/plugin";
import type { CommandBarCollectionWorkflowActions } from "./workflow/collection-actions";
import type { OpenInlineConfirm } from "./routing/confirm";
import { isCollectionCommand, type CollectionCommandId } from "./helpers";
import type {
  CommandBarFieldValue,
  CommandBarPickerRoute,
  CommandBarRoute,
} from "./workflow/types";

export function activatePickerSelectionAction({
  closeAll,
  collectionWorkflowActions,
  executeCollectionCommand,
  layout,
  openInlineConfirm,
  persistLayoutChange,
  pluginRegistry,
  route,
  selectedId,
  setRouteStack,
  updateTopRoute,
  updateWorkflowValue,
}: {
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  collectionWorkflowActions: CommandBarCollectionWorkflowActions;
  executeCollectionCommand: (commandId: CollectionCommandId, rawInput?: string, explicitTargetId?: string | null) => Promise<void>;
  layout: LayoutConfig;
  openInlineConfirm: OpenInlineConfirm;
  persistLayoutChange: (nextLayout: LayoutConfig) => void;
  pluginRegistry: PluginRegistry;
  route: CommandBarPickerRoute;
  selectedId: string;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
}): void {
  const option = route.options.find((entry) => entry.id === selectedId);
  if (!option || option.disabled) return;

  switch (route.pickerId) {
    case "layout-swap": {
      const sourcePaneId = String(route.payload?.sourcePaneId ?? "");
      if (!sourcePaneId) return;
      persistLayoutChange(swapPanes(layout, sourcePaneId, option.id));
      closeAll({ revertThemePreview: false });
      return;
    }
    case "delete-watchlist":
      openInlineConfirm({
        confirmId: "delete-watchlist",
        title: "Delete Watchlist",
        body: [`Delete "${option.label}"? Tickers will not be deleted.`],
        confirmLabel: "Delete Watchlist",
        cancelLabel: "Back",
        tone: "danger",
        onConfirm: async () => {
          await collectionWorkflowActions.deleteWatchlist(option.id);
        },
      });
      return;
    case "delete-portfolio":
      openInlineConfirm({
        confirmId: "delete-portfolio",
        title: "Delete Portfolio",
        body: [`Delete "${option.label}"? Tickers will not be deleted.`],
        confirmLabel: "Delete Portfolio",
        cancelLabel: "Back",
        tone: "danger",
        onConfirm: async () => {
          await collectionWorkflowActions.deletePortfolio(option.id);
        },
      });
      return;
    case "disconnect-broker":
      openInlineConfirm({
        confirmId: "disconnect-broker",
        title: "Disconnect Broker Account",
        body: [`Remove "${option.label}" and all imported broker portfolios, positions, and contracts?`],
        confirmLabel: "Disconnect Broker",
        cancelLabel: "Back",
        tone: "danger",
        onConfirm: async () => {
          await collectionWorkflowActions.disconnectBrokerInstance(option.id);
        },
      });
      return;
    case "collection-target": {
      const commandId = String(route.payload?.commandId ?? "");
      const symbol = String(route.payload?.symbol ?? "");
      if (!isCollectionCommand(commandId)) return;
      void executeCollectionCommand(commandId, symbol, option.id);
      return;
    }
    case "field-select": {
      const parentKind = String(route.payload?.parentKind ?? "");
      if (parentKind === "workflow") {
        updateWorkflowValue(String(route.payload?.fieldId ?? ""), option.id);
        setRouteStack((current) => current.slice(0, -1));
        return;
      }
      if (parentKind === "pane-settings") {
        const paneId = String(route.payload?.paneId ?? "");
        const field = route.payload?.field as PaneSettingField | undefined;
        if (!paneId || !field) return;
        void pluginRegistry.applyPaneSettingValueFn(paneId, field, option.id)
          .then(() => {
            setRouteStack((current) => current.slice(0, -1));
          })
          .catch((error) => {
            updateTopRoute((route) => route.kind === "pane-settings"
              ? { ...route, error: error instanceof Error ? error.message : "Could not apply that setting." }
              : route);
          });
      }
      return;
    }
    default:
      return;
  }
}
