import type { ContextMenuActionItem, ContextMenuItem, ContextMenuRoleItem } from "../../../types/context-menu";
import { ELECTROBUN_CONTEXT_MENU_ACTION, type DesktopContextMenuItem } from "../shared/protocol";

export interface PreparedDesktopContextMenu {
  menu: DesktopContextMenuItem[];
  actions: Map<string, () => void | Promise<void>>;
}

export interface DesktopContextMenuSelectMessage {
  requestId: string;
  itemId: string;
}

type ContextMenuSelectSubscribe = (
  requestId: string,
  listener: (message: DesktopContextMenuSelectMessage) => void,
) => () => void;

type ContextMenuTimeout = ReturnType<typeof globalThis.setTimeout>;
type ScheduleTimeout = (callback: () => void, delayMs: number) => ContextMenuTimeout;
type ClearScheduledTimeout = (timeout: ContextMenuTimeout) => void;

function scheduleContextMenuTimeout(callback: () => void, delayMs: number): ContextMenuTimeout {
  return globalThis.setTimeout(callback, delayMs);
}

function clearContextMenuTimeout(timeout: ContextMenuTimeout): void {
  globalThis.clearTimeout(timeout);
}

function actionIdFor(path: readonly number[], item: ContextMenuActionItem): string {
  return item.id || path.join(".");
}

function nativeActionFor(requestId: string, itemId: string): string {
  return `${ELECTROBUN_CONTEXT_MENU_ACTION}:${encodeURIComponent(requestId)}:${encodeURIComponent(itemId)}`;
}

function roleItemToDesktop(item: ContextMenuRoleItem): DesktopContextMenuItem {
  return {
    type: "normal",
    label: item.label,
    role: item.role,
    enabled: item.enabled,
    checked: item.checked,
    hidden: item.hidden,
    tooltip: item.tooltip,
    accelerator: item.accelerator,
  };
}

function prepareItems(
  items: readonly ContextMenuItem[],
  requestId: string,
  path: number[],
  actions: Map<string, () => void | Promise<void>>,
): DesktopContextMenuItem[] {
  return items.map((item, index): DesktopContextMenuItem => {
    if (item.type === "divider") return { type: "divider" };
    if (item.type === "role") return roleItemToDesktop(item);

    const itemPath = [...path, index];
    const itemId = actionIdFor(itemPath, item);
    if (item.onSelect) {
      actions.set(itemId, item.onSelect);
    }

    return {
      type: "normal",
      label: item.label,
      tooltip: item.tooltip,
      enabled: item.enabled,
      checked: item.checked,
      hidden: item.hidden,
      accelerator: item.accelerator,
      action: item.onSelect ? nativeActionFor(requestId, itemId) : undefined,
      data: item.onSelect ? { requestId, itemId } : undefined,
      submenu: item.submenu ? prepareItems(item.submenu, requestId, itemPath, actions) : undefined,
    };
  });
}

export function prepareDesktopContextMenu(
  items: readonly ContextMenuItem[],
  requestId: string,
): PreparedDesktopContextMenu {
  const actions = new Map<string, () => void | Promise<void>>();
  return {
    menu: prepareItems(items, requestId, [], actions),
    actions,
  };
}

export function createContextMenuRequestId(): string {
  return `ctx:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export class DesktopContextMenuActionScope {
  private active:
    | {
      requestId: string;
      actions: Map<string, () => void | Promise<void>>;
      dispose: () => void;
      timeout: ContextMenuTimeout;
    }
    | null = null;

  constructor(
    private readonly subscribe: ContextMenuSelectSubscribe,
    private readonly ttlMs: number,
    private readonly scheduleTimeout: ScheduleTimeout = scheduleContextMenuTimeout,
    private readonly clearScheduledTimeout: ClearScheduledTimeout = clearContextMenuTimeout,
  ) {}

  clear(): void {
    if (!this.active) return;
    this.active.dispose();
    this.clearScheduledTimeout(this.active.timeout);
    this.active = null;
  }

  clearRequest(requestId: string): void {
    if (this.active?.requestId === requestId) {
      this.clear();
    }
  }

  bind(requestId: string, actions: Map<string, () => void | Promise<void>>): void {
    this.clear();
    if (actions.size === 0) return;

    const dispose = this.subscribe(requestId, (message) => {
      const action = this.active?.actions.get(message.itemId);
      this.clear();
      if (!action) return;
      void action();
    });
    const timeout = this.scheduleTimeout(() => {
      this.clearRequest(requestId);
    }, this.ttlMs);
    this.active = {
      requestId,
      actions,
      dispose,
      timeout,
    };
  }
}
