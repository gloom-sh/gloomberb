import {
  dockFloatingPaneAtCurrentRect,
  floatAtRect,
  getDockedPaneIds,
  getLeafRect,
  removePane,
} from "../../../plugins/pane-manager";
import { findPaneInstance } from "../../../types/config";
import type { ResultItem } from "../list/model";
import type { LayoutItemsContext } from "./types";
import { WINDOW_MODE_COMMAND_OPTIONS } from "./window-mode";

export function buildFocusedPaneLayoutItems({
  closeAll,
  confirmDangerousActions,
  currentLayout,
  duplicatePane,
  focusedPaneId,
  openInlineConfirm,
  persistLayoutChange,
  pluginRegistry,
  pushRoute,
}: LayoutItemsContext): ResultItem[] {
  const focusedPane = focusedPaneId ? findPaneInstance(currentLayout, focusedPaneId) : null;
  const focusedPaneDef = focusedPane ? pluginRegistry.panes.get(focusedPane.paneId) : null;

  if (!focusedPane || !focusedPaneDef) {
    return [{
      id: "layout-no-focused-pane",
      label: "No focused pane",
      detail: "Focus a pane to show pane-specific layout actions",
      category: "Focused Pane",
      kind: "info",
      action: () => {},
    }];
  }

  const dockedPaneIds = getDockedPaneIds(currentLayout);
  const focusedFloating = currentLayout.floating.find((entry) => entry.instanceId === focusedPane.instanceId);

  return [
    {
      id: "layout-toggle-mode",
      label: focusedFloating ? "Dock Pane" : "Float Pane",
      detail: focusedFloating ? "Return the focused window to the layout" : "Detach the focused pane into a floating window",
      category: "Focused Pane",
      kind: "action",
      action: () => {
        const { width, height } = pluginRegistry.getTermSizeFn();
        const bounds = { x: 0, y: 0, width, height };
        const tiledRect = focusedFloating
          ? null
          : getLeafRect(currentLayout, focusedPane.instanceId, bounds);
        const nextLayout = focusedFloating
          ? dockFloatingPaneAtCurrentRect(currentLayout, focusedPane.instanceId, bounds)
          : tiledRect
            ? floatAtRect(currentLayout, focusedPane.instanceId, tiledRect)
            : currentLayout;
        persistLayoutChange(nextLayout);
        closeAll({ revertThemePreview: false });
      },
    },
    ...WINDOW_MODE_COMMAND_OPTIONS.map((option) => ({
      id: `layout-window-mode:${option.mode}`,
      label: option.label,
      detail: option.detail,
      category: "Focused Pane",
      kind: "action" as const,
      right: option.query,
      action: () => {
        closeAll({ revertThemePreview: false });
        pluginRegistry.openWindowMode(focusedPane.instanceId, option.mode);
      },
    })),
    {
      id: "layout-swap",
      label: "Swap With…",
      detail: dockedPaneIds.length + currentLayout.floating.length > 1
        ? "Choose another pane to swap positions"
        : "Need at least two panes",
      category: "Focused Pane",
      kind: "action",
      disabled: dockedPaneIds.length + currentLayout.floating.length <= 1,
      action: () => {
        const pickerOptions = [
          ...dockedPaneIds,
          ...currentLayout.floating.map((entry) => entry.instanceId),
        ]
          .filter((paneId) => paneId !== focusedPane.instanceId)
          .map((paneId) => {
            const instance = findPaneInstance(currentLayout, paneId)!;
            const isFloating = currentLayout.floating.some((entry) => entry.instanceId === paneId);
            return {
              id: paneId,
              label: instance.title || pluginRegistry.panes.get(instance.paneId)?.name || instance.paneId,
              detail: isFloating ? "Floating window" : "Docked pane",
              description: isFloating ? "Floating window" : "Docked pane",
            };
          });
        if (pickerOptions.length === 0) return;
        pushRoute({
          kind: "picker",
          pickerId: "layout-swap",
          title: "Swap With…",
          query: "",
          selectedIdx: 0,
          hoveredIdx: null,
          options: pickerOptions,
          payload: { sourcePaneId: focusedPane.instanceId },
        });
      },
    },
    {
      id: "layout-duplicate",
      label: "Duplicate Pane",
      detail: "Create another instance next to the focused pane",
      category: "Focused Pane",
      kind: "action",
      action: () => {
        duplicatePane(focusedPane.instanceId);
        closeAll({ revertThemePreview: false });
      },
    },
    {
      id: "layout-close-pane",
      label: "Close Pane",
      detail: "Remove the focused pane from the layout",
      category: "Focused Pane",
      kind: "action",
      action: confirmDangerousActions
        ? () => {
          openInlineConfirm({
            confirmId: "layout-close-pane",
            title: "Close Pane",
            body: [`Close "${focusedPane.title || focusedPaneDef.name || focusedPane.instanceId}"?`],
            confirmLabel: "Close Pane",
            cancelLabel: "Back",
            tone: "danger",
            onConfirm: () => {
              persistLayoutChange(removePane(currentLayout, focusedPane.instanceId));
            },
          });
        }
        : () => {
          persistLayoutChange(removePane(currentLayout, focusedPane.instanceId));
          closeAll({ revertThemePreview: false });
        },
    },
  ];
}
