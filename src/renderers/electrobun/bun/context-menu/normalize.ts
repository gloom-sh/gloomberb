import { ELECTROBUN_CONTEXT_MENU_ACTION } from "../../shared/protocol";
import { contextMenuSelectionMessage } from "./click";
import { recordOrNull } from "../../../../utils/guards";

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeContextMenuItems(value: unknown, depth = 0): unknown[] {
  if (!Array.isArray(value) || depth > 4) return [];

  const items: unknown[] = [];
  for (const rawItem of value) {
    const item = recordOrNull(rawItem);
    if (!item) continue;
    if (item.type === "divider" || item.type === "separator") {
      items.push({ type: "divider" });
      continue;
    }

    const submenu = normalizeContextMenuItems(item.submenu, depth + 1);
    const role = normalizeText(item.role);
    const action = normalizeText(item.action);
    const data = recordOrNull(item.data);
    const customAction = contextMenuSelectionMessage({ action, data }, ELECTROBUN_CONTEXT_MENU_ACTION) !== null;

    if (!role && !customAction && submenu.length === 0 && !normalizeText(item.label)) continue;
    items.push({
      type: "normal",
      label: normalizeText(item.label),
      tooltip: normalizeText(item.tooltip),
      enabled: item.enabled === false ? false : true,
      checked: item.checked === true,
      hidden: item.hidden === true,
      accelerator: normalizeText(item.accelerator),
      ...(role ? { role } : {}),
      ...(customAction ? {
        action,
        ...(data ? { data } : {}),
      } : {}),
      ...(submenu.length > 0 ? { submenu } : {}),
    });
  }

  return items;
}

export function getContextMenuRequestId(items: unknown[]): string | null {
  for (const item of items) {
    const recordItem = recordOrNull(item);
    if (!recordItem) continue;
    const message = contextMenuSelectionMessage(recordItem, ELECTROBUN_CONTEXT_MENU_ACTION);
    if (message) {
      return message.requestId;
    }
    if (Array.isArray(recordItem.submenu)) {
      const submenuRequestId = getContextMenuRequestId(recordItem.submenu);
      if (submenuRequestId) return submenuRequestId;
    }
  }
  return null;
}
