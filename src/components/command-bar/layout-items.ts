import type { PluginRegistry } from "../../plugins/registry";
import { getLayoutPreview } from "../../plugins/pane-manager";
import type { AppAction, AppState } from "../../state/app/context";
import type { LayoutConfig } from "../../types/config";
import { fuzzyFilter } from "../../utils/fuzzy-search";
import type { Dispatch } from "react";
import type { ResultItem } from "./list/model";
import type { CommandBarRoute } from "./workflow/types";
import { buildCurrentLayoutItems } from "./layout-items/current-layout";
import { buildFocusedPaneLayoutItems } from "./layout-items/focused-pane";
import type { CloseAll, LayoutItemsContext, OpenInlineConfirm } from "./layout-items/types";
import {
  buildWindowModeResultItems,
  parseWindowModeCommandArg,
} from "./layout-items/window-mode";

export {
  buildWindowModeResultItems,
  parseWindowModeCommandArg,
};

export function buildLayoutResultItems({
  closeAll,
  confirmDangerousActions,
  dispatch,
  duplicatePane,
  notifyGridlockRevert,
  openBuiltInWorkflow,
  openInlineConfirm,
  persistLayoutChange,
  pluginRegistry,
  pushRoute,
  query,
  state,
}: {
  closeAll: CloseAll;
  confirmDangerousActions?: boolean;
  dispatch: Dispatch<AppAction>;
  duplicatePane: (paneId: string) => void;
  notifyGridlockRevert: () => void;
  openBuiltInWorkflow: (actionId: string) => void;
  openInlineConfirm: OpenInlineConfirm;
  persistLayoutChange: (layout: LayoutConfig) => void;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  query: string;
  state: AppState;
}): ResultItem[] {
  const context: LayoutItemsContext = {
    closeAll,
    currentLayout: state.config.layout,
    dispatch,
    duplicatePane,
    focusedPaneId: state.focusedPaneId,
    notifyGridlockRevert,
    openBuiltInWorkflow,
    openInlineConfirm,
    persistLayoutChange,
    pluginRegistry,
    pushRoute,
    state,
    ...(confirmDangerousActions === undefined ? {} : { confirmDangerousActions }),
  };
  const layoutItems = [
    ...buildFocusedPaneLayoutItems(context),
    ...buildCurrentLayoutItems(context),
    ...buildSavedLayoutItems(context),
  ];

  return query
    ? fuzzyFilter(layoutItems, query, (item) => `${item.label} ${item.detail} ${item.right || ""}`)
    : layoutItems;
}

function buildSavedLayoutItems({
  closeAll,
  dispatch,
  state,
}: LayoutItemsContext): ResultItem[] {
  return state.config.layouts.map((savedLayout, index) => ({
    id: `layout-switch:${index}`,
    label: savedLayout.name,
    detail: index === state.config.activeLayoutIndex ? "Current layout" : "Switch to this saved layout",
    right: getLayoutPreview(savedLayout.layout),
    category: "Saved Layouts",
    kind: "action",
    current: index === state.config.activeLayoutIndex,
    action: () => {
      dispatch({ type: "SWITCH_LAYOUT", index });
      closeAll({ revertThemePreview: false });
    },
  }));
}
