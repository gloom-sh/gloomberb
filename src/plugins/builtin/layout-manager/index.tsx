import { findPaneInstance, type LayoutConfig } from "../../../types/config";
import type { AppNotificationRequest, CommandResultDef, GloomPluginContext } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import type { AppAction } from "../../../state/app/context";
import { LayoutMarketplacePane } from "../../../layout-marketplace/pane";
import { apiClient } from "../../../api-client";
import { resolvePlanAccess } from "../../../api-client/plan-access";
import { getSharedRegistry } from "../../registry";
import {
  buildDesk,
  deskFunctions,
  DESKS,
  isDeskStock,
  pickDeskCompany,
  type Desk,
} from "../../../layout/desks";
import {
  dockPane,
  floatPane,
  getDockedPaneIds,
  isPaneInLayout,
  isPaneDocked,
  removePane,
  swapPanes,
  tidyWindows,
} from "../../../layout/pane-manager";

let dispatchRef: ((action: AppAction) => void) | null = null;
let getStateRef: (() => { layout: LayoutConfig; termWidth: number; termHeight: number; focusedPaneId: string | null }) | null = null;
let restoreHiddenRef: ((layout: LayoutConfig) => LayoutConfig) | null = null;

/**
 * `getState().layout` is the layout on screen. `restoreHidden` puts the panes
 * it leaves out back into an edit of it before the edit is saved.
 */
export function setLayoutManagerDispatch(
  dispatch: (action: AppAction) => void,
  getState: () => { layout: LayoutConfig; termWidth: number; termHeight: number; focusedPaneId: string | null },
  restoreHidden: (layout: LayoutConfig) => LayoutConfig,
) {
  dispatchRef = dispatch;
  getStateRef = getState;
  restoreHiddenRef = restoreHidden;
}

function clearLayoutManagerDispatch() {
  dispatchRef = null;
  getStateRef = null;
  restoreHiddenRef = null;
}

function persistLayout(layout: LayoutConfig) {
  if (!dispatchRef) return;
  dispatchRef({ type: "PUSH_LAYOUT_HISTORY" });
  dispatchRef({ type: "UPDATE_LAYOUT", layout: restoreHiddenRef ? restoreHiddenRef(layout) : layout });
}

function getFocusedPane(layout: LayoutConfig, focusedPaneId: string | null) {
  return focusedPaneId ? findPaneInstance(layout, focusedPaneId) ?? null : null;
}

/** Desks whose key, name or one of whose functions matches what follows DESK. */
function matchDesks(query: string): Desk[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...DESKS];
  return DESKS.filter((desk) => (
    desk.key.startsWith(needle)
    || desk.label.toLowerCase().includes(needle)
    || desk.name.toLowerCase().includes(needle)
    || deskFunctions(desk).some((fn) => fn.toLowerCase() === needle)
  ));
}

/**
 * Opens the desk as a new tab after the others. Its company is the focused
 * pane's stock, else the most recent stock the user looked at.
 */
async function addDesk(ctx: GloomPluginContext, desk: Desk): Promise<void> {
  const registry = getSharedRegistry();
  if (!registry || !dispatchRef || !getStateRef) return;
  const config = ctx.getConfig();
  const { layout, focusedPaneId } = getStateRef();
  const focused = getFocusedPane(layout, focusedPaneId);
  const company = pickDeskCompany(
    [focused?.binding?.kind === "fixed" ? focused.binding.symbol : null, ...config.recentTickers],
    (symbol) => isDeskStock(ctx.getTicker(symbol), ctx.getData(symbol)),
  );
  const saved = await buildDesk(desk, {
    catalog: registry,
    config,
    company,
    pro: resolvePlanAccess(apiClient.getCurrentUser()).hasProAccess,
  });
  if (!saved) return;
  dispatchRef({ type: "INSTALL_LAYOUT_COPY", name: saved.name, layout: saved.layout, paneState: saved.paneState });
}

function deskResults(ctx: GloomPluginContext, query: string): CommandResultDef[] {
  return matchDesks(query).map((desk) => ({
    id: desk.key,
    label: desk.label,
    detail: deskFunctions(desk).join(" · "),
    execute: () => addDesk(ctx, desk),
  }));
}

export const layoutManagerModule: PluginModule = {
  panes: [
    {
      id: "layout-marketplace",
      name: "Layouts",
      icon: "L",
      component: LayoutMarketplacePane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 118, height: 34 },
    },
  ],

  setup(ctx) {
    const notify = (body: string, options?: Omit<AppNotificationRequest, "body">) => {
      ctx.notify({ body, ...options });
    };

    ctx.registerCommand({
      id: "add-desk",
      label: "Add a Desk",
      description: "Add a ready-made desk for one kind of trading as a new layout tab",
      keywords: ["desk", "desks", "workspace", "starter", "equities", "stocks", "options", "volatility", "futures",
        "commodities", "rates", "credit", "fx", "macro", "active trading", "day trading"],
      category: "config",
      shortcut: "DESK",
      shortcutArg: { placeholder: "desk", kind: "text", parse: (arg) => ({ query: arg.trim() }) },
      buildResults: (arg) => deskResults(ctx, arg),
      execute: async (values) => {
        const query = values?.query ?? values?.shortcut ?? "";
        const [desk] = query.trim() ? matchDesks(query) : [];
        if (desk) await addDesk(ctx, desk);
        else ctx.openCommandBar("DESK ");
      },
    });

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

        const def = ctx.getPaneDef(focusedPane.paneId);
        const nextLayout = floatPane(layout, focusedPane.instanceId, termWidth, termHeight, def);
        persistLayout(nextLayout);
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

        const { layout, focusedPaneId } = getStateRef();
        const focusedPane = getFocusedPane(layout, focusedPaneId);
        if (!focusedPane || !layout.floating.some((entry) => entry.instanceId === focusedPane.instanceId)) {
          notify("Focus a floating pane to dock it", { type: "info" });
          return;
        }

        const nextLayout = dockPane(layout, focusedPane.instanceId);
        persistLayout(nextLayout);
        dispatchRef?.({ type: "FOCUS_PANE", paneId: focusedPane.instanceId });
      },
    });

    ctx.registerCommand({
      id: "gridlock-all",
      label: "Tidy Windows",
      description: "Arrange every window into one tiled layout",
      keywords: ["tidy", "snap", "grid", "gridlock", "tile", "arrange", "organize", "organise", "cleanup", "dock", "floating", "windows", "layout"],
      shortcut: "GL",
      category: "config",
      execute: async () => {
        if (!getStateRef) return;
        const { layout, termWidth, termHeight } = getStateRef();
        tidyWindows({
          layout,
          size: { width: termWidth, height: termHeight },
          paneTypes: ctx.getPaneDef,
          apply: persistLayout,
          notify: ctx.notify,
          onRevert: () => dispatchRef?.({ type: "UNDO_LAYOUT" }),
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
        persistLayout(removePane(layout, focusedPane.instanceId));
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
          persistLayout(swapPanes(layout, focusedPane.instanceId, others[0]!));
          return;
        }

        ctx.openCommandBar("LMA ");
        notify("Choose a swap target from layout mode", { type: "info" });
      },
    });
  },

  dispose() {
    clearLayoutManagerDispatch();
  },
};
