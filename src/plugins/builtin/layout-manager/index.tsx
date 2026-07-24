import { findPaneInstance, type LayoutConfig } from "../../../types/config";
import type { AppNotificationRequest, GloomPluginContext } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import type { AppAction } from "../../../state/app/context";
import { notifyGridlockComplete } from "../../gridlock-notification";
import {
  dockFloatingPaneAtCurrentRect,
  floatAtRect,
  getDockedPaneIds,
  getLeafRect,
  gridlockAllPanes,
  isPaneInLayout,
  isPaneDocked,
  removePane,
  swapPanes,
} from "../../pane-manager";

let dispatchRef: ((action: AppAction) => void) | null = null;
let getStateRef: (() => { layout: LayoutConfig; termWidth: number; termHeight: number; focusedPaneId: string | null }) | null = null;

export function setLayoutManagerDispatch(
  dispatch: (action: AppAction) => void,
  getState: () => { layout: LayoutConfig; termWidth: number; termHeight: number; focusedPaneId: string | null },
) {
  dispatchRef = dispatch;
  getStateRef = getState;
}

function clearLayoutManagerDispatch() {
  dispatchRef = null;
  getStateRef = null;
}

function persistLayout(_ctx: Pick<GloomPluginContext, "getConfig">, layout: LayoutConfig) {
  if (!dispatchRef) return;
  dispatchRef({ type: "PUSH_LAYOUT_HISTORY" });
  dispatchRef({ type: "UPDATE_LAYOUT", layout });
}

function getFocusedPane(layout: LayoutConfig, focusedPaneId: string | null) {
  return focusedPaneId ? findPaneInstance(layout, focusedPaneId) ?? null : null;
}

export const layoutManagerModule: PluginModule = {
  setup(ctx) {
    const notify = (body: string, options?: Omit<AppNotificationRequest, "body">) => {
      ctx.notify({ body, ...options });
    };

    ctx.registerCommand({
      id: "float-pane",
      label: "Float Pane",
      description: "Detach a docked pane into a floating window",
      keywords: ["float", "detach", "undock", "window", "pane"],
      category: "config",
      execute: async () => {
        if (!getStateRef) return;

        const { layout, termWidth, termHeight, focusedPaneId } = getStateRef();
        const focusedPane = getFocusedPane(layout, focusedPaneId);
        if (!focusedPane || !isPaneDocked(layout, focusedPane.instanceId)) {
          notify("Focus a docked pane to float it", { type: "info" });
          return;
        }

        const rect = getLeafRect(
          layout,
          focusedPane.instanceId,
          { x: 0, y: 0, width: termWidth, height: termHeight },
        );
        if (!rect) return;
        const nextLayout = floatAtRect(layout, focusedPane.instanceId, rect);
        persistLayout(ctx, nextLayout);
        dispatchRef?.({ type: "FOCUS_PANE", paneId: focusedPane.instanceId });
      },
    });

    ctx.registerCommand({
      id: "dock-pane",
      label: "Dock Pane",
      description: "Dock a floating pane back into the layout",
      keywords: ["dock", "attach", "pin", "pane"],
      category: "config",
      execute: async () => {
        if (!getStateRef) return;

        const { layout, termWidth, termHeight, focusedPaneId } = getStateRef();
        const focusedPane = getFocusedPane(layout, focusedPaneId);
        if (!focusedPane || !layout.floating.some((entry) => entry.instanceId === focusedPane.instanceId)) {
          notify("Focus a floating pane to dock it", { type: "info" });
          return;
        }

        const nextLayout = dockFloatingPaneAtCurrentRect(
          layout,
          focusedPane.instanceId,
          { x: 0, y: 0, width: termWidth, height: termHeight },
        );
        persistLayout(ctx, nextLayout);
        dispatchRef?.({ type: "FOCUS_PANE", paneId: focusedPane.instanceId });
      },
    });

    ctx.registerCommand({
      id: "gridlock-all",
      label: "Gridlock All Windows",
      description: "Arrange all visible panes into a tiled grid",
      keywords: ["grid", "gridlock", "tile", "arrange", "windows", "layout"],
      shortcut: "GL",
      category: "config",
      execute: async () => {
        if (!getStateRef) return;
        const { layout, termWidth, termHeight } = getStateRef();
        persistLayout(ctx, gridlockAllPanes(
          layout,
          { x: 0, y: 0, width: termWidth, height: termHeight },
          ctx.getPaneDef,
        ));
        notifyGridlockComplete(ctx.notify, () => {
          dispatchRef?.({ type: "UNDO_LAYOUT" });
        });
      },
    });

    ctx.registerCommand({
      id: "remove-pane",
      label: "Remove Pane",
      description: "Remove a pane from the layout",
      keywords: ["remove", "pane", "close", "hide", "panel"],
      category: "config",
      execute: async () => {
        if (!getStateRef) return;
        const { layout, focusedPaneId } = getStateRef();
        const focusedPane = getFocusedPane(layout, focusedPaneId);
        if (!focusedPane || !isPaneInLayout(layout, focusedPane.instanceId)) {
          notify("Focus a pane to remove it", { type: "info" });
          return;
        }
        persistLayout(ctx, removePane(layout, focusedPane.instanceId));
      },
    });

    ctx.registerCommand({
      id: "new-layout",
      label: "New Layout",
      description: "Create a new layout",
      keywords: ["new", "create", "add", "layout", "workspace"],
      category: "config",
      wizard: [{ key: "name", label: "Layout name", placeholder: "e.g. Trading, Research, Overview" }],
      execute: async (values) => {
        const name = values?.name?.trim();
        if (!name) {
          notify("Layout name is required", { type: "error" });
          return;
        }
        dispatchRef?.({ type: "NEW_LAYOUT", name });
        notify(`Layout "${name}" created`, { type: "success" });
      },
    });

    ctx.registerCommand({
      id: "delete-layout",
      label: "Delete Layout",
      description: "Delete the current layout preset",
      keywords: ["delete", "remove", "layout", "preset"],
      category: "config",
      confirm: () => {
        const config = ctx.getConfig();
        const layout = config.layouts[config.activeLayoutIndex];
        if (!layout) return null;
        return {
          title: "Delete Layout",
          body: [`Delete layout "${layout.name}"? This cannot be undone.`],
          confirmLabel: "Delete Layout",
          cancelLabel: "Back",
          tone: "danger",
        };
      },
      execute: async () => {
        const config = ctx.getConfig();
        if (config.layouts.length <= 1) {
          notify("Can't delete the only layout", { type: "error" });
          return;
        }
        const index = config.activeLayoutIndex;
        const name = config.layouts[index]!.name;
        dispatchRef?.({ type: "DELETE_LAYOUT", index });
        notify(`Layout "${name}" deleted`, { type: "success" });
      },
    });

    ctx.registerCommand({
      id: "rename-layout",
      label: "Rename Layout",
      description: "Rename the current layout preset",
      keywords: ["rename", "layout", "preset"],
      category: "config",
      wizard: [{ key: "name", label: "New name", placeholder: "Layout name" }],
      execute: async (values) => {
        const name = values?.name?.trim();
        if (!name) {
          notify("Name is required", { type: "error" });
          return;
        }
        dispatchRef?.({ type: "RENAME_LAYOUT", index: ctx.getConfig().activeLayoutIndex, name });
        notify(`Layout renamed to "${name}"`, { type: "success" });
      },
    });

    ctx.registerCommand({
      id: "duplicate-layout",
      label: "Duplicate Layout",
      description: "Create a copy of the current layout",
      keywords: ["duplicate", "copy", "clone", "layout"],
      category: "config",
      execute: async () => {
        dispatchRef?.({ type: "DUPLICATE_LAYOUT", index: ctx.getConfig().activeLayoutIndex });
        notify("Layout duplicated", { type: "success" });
      },
    });

    ctx.registerCommand({
      id: "swap-panes",
      label: "Swap Panes",
      description: "Swap two pane positions",
      keywords: ["swap", "switch", "pane", "panel"],
      category: "config",
      execute: async () => {
        if (!getStateRef) return;
        const { layout, focusedPaneId } = getStateRef();
        const focusedPane = getFocusedPane(layout, focusedPaneId);
        const dockedPaneIds = getDockedPaneIds(layout);
        if (dockedPaneIds.length < 2) {
          notify("Need at least 2 docked panes to swap", { type: "info" });
          return;
        }
        if (!focusedPane || !isPaneDocked(layout, focusedPane.instanceId)) {
          notify("Focus a docked pane to swap it", { type: "info" });
          return;
        }

        const others = dockedPaneIds.filter((instanceId) => instanceId !== focusedPane.instanceId);
        if (others.length === 1) {
          persistLayout(ctx, swapPanes(layout, focusedPane.instanceId, others[0]!));
          return;
        }

        ctx.openCommandBar("LAY ");
        notify("Choose a swap target from layout mode", { type: "info" });
      },
    });
  },

  dispose() {
    clearLayoutManagerDispatch();
  },
};
