import {
  gridlockAllPanes,
  removeFloatingPanes,
} from "../../../plugins/pane-manager";
import {
  DEFAULT_LAYOUT,
  cloneLayout,
  type SavedLayout,
} from "../../../types/config";
import { groupIdFor } from "../../layout/status-bar-groups";
import type { ResultItem } from "../list/model";
import type { LayoutItemsContext } from "./types";

/**
 * The saved layouts drawn in the same run of status bar tabs as `index`, in tab
 * order. The bar groups tabs by owner (personal, then each team), so moving a
 * tab only ever trades places inside its own group.
 */
function layoutTabGroupIndexes(layouts: readonly SavedLayout[], index: number): number[] {
  const layout = layouts[index];
  if (!layout) return [];
  const groupId = groupIdFor(layout);
  return layouts.flatMap((entry, entryIndex) => (groupIdFor(entry) === groupId ? [entryIndex] : []));
}

export function buildCurrentLayoutItems({
  closeAll,
  confirmDangerousActions,
  currentLayout,
  dispatch,
  notifyGridlockRevert,
  openBuiltInWorkflow,
  openInlineConfirm,
  persistLayoutChange,
  pluginRegistry,
  state,
}: LayoutItemsContext): ResultItem[] {
  const layoutHistory = state.layoutHistory[state.config.activeLayoutIndex];
  const floatingPaneCount = currentLayout.floating.length;
  const floatingPaneLabel = floatingPaneCount === 1 ? "floating pane" : "floating panes";
  const activeLayoutIndex = state.config.activeLayoutIndex;
  const tabGroup = layoutTabGroupIndexes(state.config.layouts, activeLayoutIndex);
  const tabPosition = tabGroup.indexOf(activeLayoutIndex);
  // The bar stays open so Enter can move the tab again; the position on the
  // right is the feedback when the status bar is hidden.
  const moveLayoutTab = (direction: -1 | 1): ResultItem => {
    const toIndex = tabPosition < 0 ? undefined : tabGroup[tabPosition + direction];
    const side = direction < 0 ? "left" : "right";
    return {
      id: `layout-move-${side}`,
      label: direction < 0 ? "Move Layout Left" : "Move Layout Right",
      detail: toIndex === undefined
        ? direction < 0 ? "Already the first layout tab" : "Already the last layout tab"
        : `Trade places with the layout tab to the ${side}`,
      category: "Current Layout",
      kind: "action",
      right: tabPosition < 0 ? undefined : `${tabPosition + 1}/${tabGroup.length}`,
      disabled: toIndex === undefined,
      action: () => {
        if (toIndex === undefined) return;
        dispatch({ type: "REORDER_LAYOUT", fromIndex: activeLayoutIndex, toIndex });
      },
    };
  };

  return [
    {
      id: "layout-undo",
      label: "Undo Layout Change",
      detail: (layoutHistory?.past.length ?? 0) > 0 ? "Restore the previous layout state" : "No previous layout state",
      category: "Current Layout",
      kind: "action",
      disabled: (layoutHistory?.past.length ?? 0) === 0,
      action: () => {
        if ((layoutHistory?.past.length ?? 0) === 0) return;
        dispatch({ type: "UNDO_LAYOUT" });
        closeAll({ revertThemePreview: false });
      },
    },
    {
      id: "layout-redo",
      label: "Redo Layout Change",
      detail: (layoutHistory?.future.length ?? 0) > 0 ? "Reapply the next layout state" : "No later layout state",
      category: "Current Layout",
      kind: "action",
      disabled: (layoutHistory?.future.length ?? 0) === 0,
      action: () => {
        if ((layoutHistory?.future.length ?? 0) === 0) return;
        dispatch({ type: "REDO_LAYOUT" });
        closeAll({ revertThemePreview: false });
      },
    },
    {
      id: "layout-reset",
      label: "Reset Current Layout",
      detail: "Restore the default two-pane layout",
      category: "Current Layout",
      kind: "action",
      action: confirmDangerousActions
        ? () => {
          openInlineConfirm({
            confirmId: "layout-reset",
            title: "Reset Current Layout",
            body: ["Reset the current layout to the default two-pane arrangement?"],
            confirmLabel: "Reset Layout",
            cancelLabel: "Back",
            tone: "danger",
            onConfirm: () => {
              persistLayoutChange(cloneLayout(DEFAULT_LAYOUT));
            },
          });
        }
        : () => {
          persistLayoutChange(cloneLayout(DEFAULT_LAYOUT));
          closeAll({ revertThemePreview: false });
        },
    },
    {
      id: "layout-gridlock",
      label: "Tidy Windows",
      detail: currentLayout.floating.length > 0
        ? "Infer a tiled layout from the current window positions"
        : "Retile all panes from their current arrangement",
      category: "Current Layout",
      kind: "action",
      action: () => {
        const { width, height } = pluginRegistry.getTermSizeFn();
        persistLayoutChange(gridlockAllPanes(
          currentLayout,
          { x: 0, y: 0, width, height },
          pluginRegistry.panes,
        ));
        notifyGridlockRevert();
        closeAll({ revertThemePreview: false });
      },
    },
    {
      id: "layout-close-all-floating",
      label: "Close All Floating Panes",
      detail: floatingPaneCount > 0
        ? `Remove ${floatingPaneCount} ${floatingPaneLabel} from the current layout`
        : "No floating panes in the current layout",
      category: "Current Layout",
      kind: "action",
      disabled: floatingPaneCount === 0,
      action: confirmDangerousActions
        ? () => {
          if (floatingPaneCount === 0) return;
          openInlineConfirm({
            confirmId: "layout-close-all-floating",
            title: "Close All Floating Panes",
            body: [`Close ${floatingPaneCount} ${floatingPaneLabel}?`],
            confirmLabel: "Close Floating Panes",
            cancelLabel: "Back",
            tone: "danger",
            onConfirm: () => {
              persistLayoutChange(removeFloatingPanes(currentLayout));
            },
          });
        }
        : () => {
          if (floatingPaneCount === 0) return;
          persistLayoutChange(removeFloatingPanes(currentLayout));
          closeAll({ revertThemePreview: false });
        },
    },
    {
      id: "layout-rename",
      label: "Rename Layout",
      detail: "Change the current saved layout name",
      category: "Current Layout",
      kind: "action",
      action: () => openBuiltInWorkflow("rename-layout"),
    },
    moveLayoutTab(-1),
    moveLayoutTab(1),
    {
      id: "layout-duplicate-layout",
      label: "Duplicate Layout",
      detail: "Create a copy of the current layout",
      category: "Current Layout",
      kind: "action",
      action: () => {
        dispatch({ type: "DUPLICATE_LAYOUT", index: state.config.activeLayoutIndex });
        closeAll({ revertThemePreview: false });
      },
    },
    {
      id: "layout-new",
      label: "New Layout",
      detail: "Create a fresh saved layout",
      category: "Current Layout",
      kind: "action",
      action: () => openBuiltInWorkflow("new-layout"),
    },
  ];
}
