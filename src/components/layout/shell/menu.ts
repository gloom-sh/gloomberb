import type { DesktopWindowBridge } from "../../../types/desktop-window";
import {
  applyDrop,
  floatPane,
  removePane,
  type ResolvedPane,
} from "../../../plugins/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutConfig } from "../../../types/config";
import { isPaneLocked, setPaneLocked } from "../../../pane-settings";
import { contextMenuDivider, type ContextMenuItem } from "../../../types/context-menu";
import { paneHintTitle, type CombinedPaneFooter } from "../pane/footer/model";
import {
  formatPlatformShortcutLabel,
  type ShortcutDisplayMode,
} from "../../../utils/shortcut-labels";
import { PANE_MANAGEMENT_ACCELERATORS, type PaneManagementAccelerators } from "./shortcuts";
import { t } from "../../../i18n";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";

const MENU_MIN_WIDTH = 18;
const MENU_MAX_WIDTH = 44;

export const MENU_Z_INDEX = 10_000;

/** One row of the kit pane menu; a divider row is skipped by the keyboard. */
export interface PaneMenuEntry {
  id: string;
  label: string;
  accelerator?: string;
  checked?: boolean;
  divider?: boolean;
  action: () => void;
}

/** A pane's header toggle (the zap), repeated in its menu so the keyboard reaches it. */
export interface PaneMenuQuickSetting {
  key: string;
  label: string;
  active: boolean;
  toggle: () => void;
}

/**
 * The pane's own actions at the top of its menu: every footer hint with its
 * key, a footer shortcut such as `!`, then what the pane's kit controls add
 * (sort, filters, tabs). So the menu is the full list of what the keyboard can
 * do in this pane, even when a narrow footer cuts hints off.
 */
export function paneFooterMenuItems(footer: CombinedPaneFooter | undefined): ContextMenuItem[] {
  if (!footer) return [];
  const items: ContextMenuItem[] = [];
  for (const hint of footer.hints) {
    if (hint.disabled || !hint.onPress) continue;
    const onPress = hint.onPress;
    items.push({ id: `pane-hint:${hint.id}`, label: paneHintTitle(hint), accelerator: hint.key, onSelect: () => onPress() });
  }
  for (const segment of footer.info) {
    if (segment.disabled || !segment.onPress || !segment.shortcut) continue;
    items.push({
      id: `pane-segment:${segment.id}`,
      label: segment.label ?? segment.title ?? segment.parts.map((part) => part.text).join(" "),
      accelerator: segment.shortcut,
      onSelect: segment.onPress,
    });
  }
  // A kit item for a key the pane already lists (its own "/ search") would repeat it.
  const listedKeys = new Set(items.flatMap((item) => (item.type === "divider" || !item.accelerator ? [] : [item.accelerator])));
  const kitItems = footer.menu.filter((item) => item.type === "divider" || !item.accelerator || !listedKeys.has(item.accelerator));
  if (kitItems.some((item) => item.type !== "divider")) {
    if (items.length > 0) items.push(contextMenuDivider("pane:footer-menu-divider"));
    items.push(...kitItems);
  }
  return items;
}

export function menuForPane(
  pane: ResolvedPane,
  layout: LayoutConfig,
  width: number,
  contentHeight: number,
  pluginRegistry: PluginRegistry,
  persistLayout: (nextLayout: LayoutConfig, options?: { pushHistory?: boolean }) => void,
  focusPane: (paneId: string) => void,
  openPaneSettings: (paneId: string) => void,
  desktopWindowBridge?: DesktopWindowBridge,
  copyPaneScreenshot?: (paneId: string) => void | Promise<void>,
  sharePane?: () => void | Promise<void>,
  linkItems: ContextMenuItem[] = [],
  exportPaneCsv?: (paneId: string) => void | Promise<void>,
  accelerators: PaneManagementAccelerators = PANE_MANAGEMENT_ACCELERATORS,
  quickSettings: PaneMenuQuickSetting[] = [],
  fullscreen?: { active: boolean; toggle: () => void },
  paneItems: ContextMenuItem[] = [],
): ContextMenuItem[] {
  const baseActions: ContextMenuItem[] = [...paneItems];
  if (baseActions.length > 0) baseActions.push(contextMenuDivider("pane:own-actions-divider"));
  for (const setting of quickSettings) {
    baseActions.push({
      id: `quick-setting:${setting.key}`,
      label: setting.label,
      checked: setting.active,
      onSelect: setting.toggle,
    });
  }
  if (quickSettings.length > 0) baseActions.push(contextMenuDivider("pane:quick-settings-divider"));
  if (pluginRegistry.hasPaneSettings(pane.instance.instanceId)) {
    baseActions.push({
      id: "settings",
      label: "Settings",
      accelerator: accelerators.settings,
      onSelect: () => openPaneSettings(pane.instance.instanceId),
    });
  }
  if (sharePane) {
    baseActions.push({
      id: "share-pane",
      label: "Share Pane",
      accelerator: accelerators.share,
      onSelect: sharePane,
    });
  }
  if (copyPaneScreenshot) {
    baseActions.push({
      id: "copy-screenshot",
      label: "Copy Screenshot",
      accelerator: accelerators.copyScreenshot,
      onSelect: () => copyPaneScreenshot(pane.instance.instanceId),
    });
  }
  if (exportPaneCsv) {
    baseActions.push({
      id: "export-csv",
      label: "Export CSV",
      accelerator: accelerators.exportCsv,
      onSelect: () => exportPaneCsv(pane.instance.instanceId),
    });
  }

  if (fullscreen) {
    baseActions.push({
      id: "toggle-fullscreen",
      label: fullscreen.active ? "Exit Fullscreen" : "Fullscreen",
      accelerator: accelerators.fullscreen,
      onSelect: fullscreen.toggle,
    });
  }

  if (pane.floating) {
    baseActions.push({
      id: "dock",
      label: "Dock Pane",
      accelerator: accelerators.toggleFloating,
      onSelect: () => {
        persistLayout(applyDrop(layout, pane.instance.instanceId, { kind: "frame", edge: "right" }));
        focusPane(pane.instance.instanceId);
      },
    });
  } else {
    baseActions.push({
      id: "float",
      label: "Float Pane",
      accelerator: accelerators.toggleFloating,
      onSelect: () => {
        persistLayout(floatPane(layout, pane.instance.instanceId, width, contentHeight, pane.def));
        focusPane(pane.instance.instanceId);
      },
    });
  }

  if (desktopWindowBridge?.kind === "main" && desktopWindowBridge.popOutPane) {
    baseActions.push({
      id: "pop-out",
      label: "Pop Out",
      accelerator: accelerators.popOut,
      onSelect: () => {
        void desktopWindowBridge.popOutPane?.(pane.instance.instanceId);
      },
    });
  }

  const locked = isPaneLocked(pane.instance);
  baseActions.push({
    id: "toggle-pane-lock",
    // The label carries the state: the terminal menu has no checkmark column.
    label: locked ? "Unlock Pane" : "Lock Pane",
    onSelect: () => persistLayout(setPaneLocked(layout, pane.instance.instanceId, !locked)),
  });

  baseActions.push({
    id: "close-pane",
    label: "Close Pane",
    accelerator: accelerators.close,
    onSelect: () => persistLayout(removePane(layout, pane.instance.instanceId)),
  });

  if (linkItems.length > 0) {
    baseActions.push(contextMenuDivider("pane:link-divider"), ...linkItems);
  }

  baseActions.push(
    contextMenuDivider("pane:layout-divider"),
    {
      id: "window-move-mode",
      label: "Move Window...",
      accelerator: accelerators.windowMode,
      onSelect: () => pluginRegistry.openWindowMode(pane.instance.instanceId, "move"),
    },
    {
      id: "window-resize-mode",
      label: "Resize Window...",
      accelerator: accelerators.windowResizeMode,
      onSelect: () => pluginRegistry.openWindowMode(pane.instance.instanceId, "resize"),
    },
  );

  return baseActions;
}

export function menuItemsForFallback(
  items: ContextMenuItem[],
  shortcutDisplayMode: ShortcutDisplayMode,
): PaneMenuEntry[] {
  return items.flatMap((item, index): PaneMenuEntry[] => {
    if (item.type === "divider") return [{ id: item.id ?? `divider:${index}`, label: "", divider: true, action: () => {} }];
    if (item.type === "role" || item.enabled === false || item.hidden === true) return [];
    if (!item.onSelect) return [];
    return [{
      id: item.id,
      label: item.label,
      checked: item.checked,
      accelerator: item.accelerator
        ? formatPlatformShortcutLabel(item.accelerator, undefined, shortcutDisplayMode)
        : undefined,
      action: () => { void item.onSelect?.(); },
    }];
  });
}

export function actionMenuWidth(
  items: Array<{ label: string; accelerator?: string; checked?: boolean; divider?: boolean }>,
  availableWidth: number,
): number {
  const requested = Math.max(
    MENU_MIN_WIDTH,
    ...items.map((item) => (
      (item.checked === undefined ? 0 : 4)
      + displayWidth(t(item.label))
      + (item.accelerator ? displayWidth(item.accelerator) + 3 : 0)
      + 2
    )),
  );
  return Math.max(MENU_MIN_WIDTH, Math.min(MENU_MAX_WIDTH, availableWidth, requested));
}

export function truncateMenuText(text: string, width: number): string {
  return truncateToDisplayWidth(text, width);
}
