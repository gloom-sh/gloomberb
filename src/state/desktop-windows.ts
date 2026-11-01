import { t, tf } from "../i18n";
import type { DesktopWindowInfo, DesktopWindowsBridge, DesktopWindowTarget } from "../types/desktop-window";

/**
 * The desktop app's full windows, as the window this runs in sees them: set
 * once at startup by the desktop view, absent in the terminal, the browser
 * and a popped-out pane's window. Menus and the command bar read it when
 * they open.
 */
let desktopWindows: DesktopWindowsBridge | null = null;

export function setDesktopWindows(bridge: DesktopWindowsBridge | null): void {
  desktopWindows = bridge;
}

export function getDesktopWindows(): DesktopWindowsBridge | null {
  return desktopWindows;
}

function windowLabel(info: DesktopWindowInfo): string {
  return info.number <= 1 ? t("Main Window") : tf("Window {number}", { number: String(info.number) });
}

/** A place a tab or pane of this window can go. Labels are ready to show. */
export interface WindowMoveTarget {
  key: string;
  label: string;
  /** The tab the other window shows, to tell windows apart. */
  detail?: string;
  target: DesktopWindowTarget;
}

/** Each other window, then a new one; empty where there is only one window and nothing can go. */
export function windowMoveTargets(
  bridge: DesktopWindowsBridge,
  options: { newWindow?: boolean; prefix?: "pane" | "layout" } = {},
): WindowMoveTarget[] {
  const layout = options.prefix === "layout";
  const others = bridge.list().filter((info) => info.id !== bridge.windowId);
  const targets: WindowMoveTarget[] = others.map((info) => ({
    key: info.id,
    label: tf(layout ? "Move Layout to {window}" : "Move to {window}", { window: windowLabel(info) }),
    ...(info.activeLayoutName ? { detail: info.activeLayoutName } : {}),
    target: { windowId: info.id },
  }));
  if (options.newWindow !== false) {
    targets.push({
      key: "new",
      label: layout ? "Move Layout to New Window" : "Move to New Window",
      target: { newWindow: true },
    });
  }
  return targets;
}

/**
 * Where one of this window's tabs can go: the main window keeps its last
 * tab, and a window's only tab gains nothing from a new window of its own.
 */
export function layoutMoveTargets(bridge: DesktopWindowsBridge, tabCount: number): WindowMoveTarget[] {
  if (tabCount <= 1 && bridge.windowId === "main") return [];
  return windowMoveTargets(bridge, { prefix: "layout", newWindow: tabCount > 1 });
}
