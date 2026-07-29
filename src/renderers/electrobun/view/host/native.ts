import type { ContextMenuItem } from "../../../../types/context-menu";
import { editableTextContextMenuItems } from "../../../../ui/context-menu";
import { backendRequest, onContextMenuSelect } from "../backend-rpc";
import {
  DesktopContextMenuActionScope,
  createContextMenuRequestId,
  prepareDesktopContextMenu,
} from "../context-menu";

export const NATIVE_CONTEXT_MENU_SUPPORTED = !/\blinux\b/i.test(window.navigator.platform || window.navigator.userAgent || "");

const CONTEXT_MENU_ACTION_TTL_MS = 120_000;
const contextMenuActionScope = new DesktopContextMenuActionScope(
  onContextMenuSelect,
  CONTEXT_MENU_ACTION_TTL_MS,
);

export function startElectrobunWindowDrag(): void {
  window.__electrobunInternalBridge?.postMessage(JSON.stringify([
    JSON.stringify({
      type: "message",
      id: "startWindowMove",
      payload: { id: window.__electrobunWindowId },
    }),
  ]));
}

export async function showDesktopContextMenu(items: ContextMenuItem[]): Promise<boolean> {
  if (!NATIVE_CONTEXT_MENU_SUPPORTED) return false;
  contextMenuActionScope.clear();
  const requestId = createContextMenuRequestId();
  const prepared = prepareDesktopContextMenu(items, requestId);
  if (prepared.menu.length === 0) return false;

  contextMenuActionScope.bind(requestId, prepared.actions);

  try {
    await backendRequest("host.showContextMenu", { menu: prepared.menu });
    return true;
  } catch {
    contextMenuActionScope.clearRequest(requestId);
    return false;
  }
}

export function showEditableTextContextMenu(): Promise<boolean> {
  return showDesktopContextMenu(editableTextContextMenuItems());
}
