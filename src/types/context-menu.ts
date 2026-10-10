import type { TickerFinancials } from "./financials";
import type { TickerRecord } from "./ticker";

type ContextMenuRole =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "pasteAndMatchStyle"
  | "delete"
  | "selectAll";

interface ContextMenuItemBase {
  id?: string;
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  hidden?: boolean;
  accelerator?: string;
  tooltip?: string;
}

export interface ContextMenuActionItem extends ContextMenuItemBase {
  type?: "normal";
  id: string;
  label: string;
  onSelect?: () => void | Promise<void>;
  submenu?: ContextMenuItem[];
}

export interface ContextMenuRoleItem extends ContextMenuItemBase {
  type: "role";
  role: ContextMenuRole;
  submenu?: never;
  onSelect?: never;
}

export interface ContextMenuDividerItem {
  type: "divider";
  id?: string;
}

export type ContextMenuItem =
  | ContextMenuActionItem
  | ContextMenuRoleItem
  | ContextMenuDividerItem;

export type ContextMenuContext =
  | { kind: "app" }
  | {
    kind: "pane";
    paneId: string;
    paneType: string;
    title: string;
    floating: boolean;
  }
  | {
    kind: "ticker";
    symbol: string;
    ticker: TickerRecord;
    financials: TickerFinancials | null;
  }
  | {
    kind: "link";
    url: string;
    label?: string;
  }
  | {
    kind: "editable-text";
    value?: string;
    selectedText?: string;
  }
  | {
    kind: "selected-text";
    text: string;
  }
  | {
    kind: "layout";
    layoutIndex: number;
    layoutName: string;
    active: boolean;
  }
  | {
    /** A person's name or @mention in the chat. */
    kind: "chat-user";
    userId: string;
    username: string | null;
  };

export function hasRunnableContextMenuItem(items: readonly ContextMenuItem[]): boolean {
  return items.some((item) => {
    if (item.type === "divider" || item.hidden === true || item.enabled === false) return false;
    if (item.type === "role") return true;
    return item.submenu?.length ? hasRunnableContextMenuItem(item.submenu) : true;
  });
}

export function contextMenuDivider(id?: string): ContextMenuDividerItem {
  return id ? { type: "divider", id } : { type: "divider" };
}
