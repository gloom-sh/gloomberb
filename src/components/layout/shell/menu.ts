import type { DesktopWindowBridge } from "../../../types/desktop-window";
import {
  dockFloatingPaneAtCurrentRect,
  floatAtRect,
  removePane,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../plugins/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutConfig } from "../../../types/config";
import { contextMenuDivider, type ContextMenuItem } from "../../../types/context-menu";
import {
  formatPlatformShortcutLabel,
  type ShortcutDisplayMode,
} from "../../../utils/shortcut-labels";
import { PANE_MANAGEMENT_ACCELERATORS } from "./shortcuts";
import { t } from "../../../i18n";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";

const MENU_MIN_WIDTH = 18;
const MENU_MAX_WIDTH = 44;

export const MENU_Z_INDEX = 10_000;

export function menuForPane(
  pane: ResolvedPane,
  rect: LayoutBounds,
  layout: LayoutConfig,
  width: number,
  contentHeight: number,
  pluginRegistry: PluginRegistry,
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean }) => void,
  focusPane: (paneId: string) => void,
  openPaneSettings: (paneId: string) => void,
  desktopWindowBridge?: DesktopWindowBridge,
  copyPaneScreenshot?: (paneId: string) => void | Promise<void>,
): ContextMenuItem[] {
  const baseActions: ContextMenuItem[] = [];
  if (pluginRegistry.hasPaneSettings(pane.instance.instanceId)) {
    baseActions.push({
      id: "settings",
      label: "Settings",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.settings,
      onSelect: () => openPaneSettings(pane.instance.instanceId),
    });
  }
  if (copyPaneScreenshot) {
    baseActions.push({
      id: "copy-screenshot",
      label: "Copy Screenshot",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.copyScreenshot,
      onSelect: () => copyPaneScreenshot(pane.instance.instanceId),
    });
  }

  if (pane.floating) {
    baseActions.push({
      id: "dock",
      label: "Dock Pane",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.toggleFloating,
      onSelect: () => {
        persistLayout(dockFloatingPaneAtCurrentRect(
          layout,
          pane.instance.instanceId,
          { x: 0, y: 0, width, height: contentHeight },
        ));
        focusPane(pane.instance.instanceId);
      },
    });
  } else {
    baseActions.push({
      id: "float",
      label: "Float Pane",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.toggleFloating,
      onSelect: () => {
        persistLayout(floatAtRect(layout, pane.instance.instanceId, rect));
        focusPane(pane.instance.instanceId);
      },
    });
  }

  if (desktopWindowBridge?.kind === "main" && desktopWindowBridge.popOutPane) {
    baseActions.push({
      id: "pop-out",
      label: "Pop Out",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.popOut,
      onSelect: () => {
        void desktopWindowBridge.popOutPane?.(pane.instance.instanceId);
      },
    });
  }

  baseActions.push({
    id: "close-pane",
    label: "Close Pane",
    accelerator: PANE_MANAGEMENT_ACCELERATORS.close,
    onSelect: () => persistLayout(removePane(layout, pane.instance.instanceId)),
  });

  baseActions.push(
    contextMenuDivider("pane:layout-divider"),
    {
      id: "window-move-mode",
      label: "Move Window...",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.windowMode,
      onSelect: () => pluginRegistry.openWindowMode(pane.instance.instanceId, "move"),
    },
    {
      id: "window-resize-mode",
      label: "Resize Window...",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.windowResizeMode,
      onSelect: () => pluginRegistry.openWindowMode(pane.instance.instanceId, "resize"),
    },
  );

  return baseActions;
}

export function menuItemsForFallback(
  items: ContextMenuItem[],
  shortcutDisplayMode: ShortcutDisplayMode,
): Array<{ id: string; label: string; accelerator?: string; action: () => void }> {
  return items.flatMap((item) => {
    if (item.type === "divider" || item.type === "role" || item.enabled === false || item.hidden === true) return [];
    if (!item.onSelect) return [];
    return [{
      id: item.id,
      label: item.label,
      accelerator: item.accelerator
        ? formatPlatformShortcutLabel(item.accelerator, undefined, shortcutDisplayMode)
        : undefined,
      action: () => { void item.onSelect?.(); },
    }];
  });
}

export function actionMenuWidth(
  items: Array<{ label: string; accelerator?: string }>,
  availableWidth: number,
): number {
  const requested = Math.max(
    MENU_MIN_WIDTH,
    ...items.map((item) => (
      displayWidth(t(item.label))
      + (item.accelerator ? displayWidth(item.accelerator) + 3 : 0)
      + 2
    )),
  );
  return Math.max(MENU_MIN_WIDTH, Math.min(MENU_MAX_WIDTH, availableWidth, requested));
}

export function truncateMenuText(text: string, width: number): string {
  return truncateToDisplayWidth(text, width);
}
