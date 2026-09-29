import { brokerProfileRemovalConfirm } from "../../brokers/remove-profile";
import type { PluginRegistry } from "../../plugins/registry";
import { swapPanes } from "../../plugins/pane-manager";
import type { LayoutConfig } from "../../types/config";
import type { CommandBarCollectionWorkflowActions } from "./workflow/collection-actions";
import type { OpenInlineConfirm } from "./routing/confirm";
import { isCollectionCommand, type CollectionCommandId } from "./helpers";
import type { CommandBarPickerRoute } from "./workflow/types";

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
    case "disconnect-broker": {
      // The same confirm as the Brokers pane's, which says when the Gloom account's connection goes too.
      const instance = pluginRegistry.getConfigFn().brokerInstances.find((entry) => entry.id === option.id);
      if (!instance) return;
      openInlineConfirm(brokerProfileRemovalConfirm(instance, instance.label, async () => {
        await collectionWorkflowActions.disconnectBrokerInstance(option.id);
      }));
      return;
    }
    case "collection-target": {
      const commandId = String(route.payload?.commandId ?? "");
      const symbol = String(route.payload?.symbol ?? "");
      if (!isCollectionCommand(commandId)) return;
      void executeCollectionCommand(commandId, symbol, option.id);
      return;
    }
    default:
      return;
  }
}
