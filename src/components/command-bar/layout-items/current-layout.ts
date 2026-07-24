import {
  applyLayoutPreset,
  gridlockAllPanes,
  removeFloatingPanes,
  type LayoutPresetId,
} from "../../../plugins/pane-manager";
import {
  DEFAULT_LAYOUT,
  cloneLayout,
} from "../../../types/config";
import type { ResultItem } from "../list/model";
import type { LayoutItemsContext } from "./types";

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
  const presetItems = ([
    ["single", "Single Column", "Stack all visible panes in one column"],
    ["2x2", "2x2 Grid", "Arrange visible panes in a two-column grid"],
    ["3x3", "3x3 Grid", "Arrange visible panes in a three-column grid"],
    ["left-main", "Left Main + Right Stack", "Make the first pane primary and stack the rest on the right"],
  ] satisfies Array<[LayoutPresetId, string, string]>).map(([preset, label, detail]) => ({
    id: `layout-preset:${preset}`,
    label,
    detail,
    category: "Layout Presets",
    kind: "action" as const,
    action: () => {
      const { width, height } = pluginRegistry.getTermSizeFn();
      persistLayoutChange(applyLayoutPreset(
        currentLayout,
        preset,
        { x: 0, y: 0, width, height },
        pluginRegistry.panes,
      ));
      closeAll({ revertThemePreview: false });
    },
  }));

  return [
    ...presetItems,
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
      label: "Gridlock All Windows",
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
