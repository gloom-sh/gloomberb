import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { t, tf } from "../i18n";
import { getSharedRegistry, type PluginRegistry } from "../plugins/registry";
import type { TickerFinancials } from "../types/financials";
import { TICKER_RESEARCH_PANE_ID } from "../types/config";
import type { TickerRecord } from "../types/ticker";
import {
  contextMenuDivider,
  hasRunnableContextMenuItem,
  type ContextMenuContext,
  type ContextMenuItem,
} from "../types/context-menu";
import { useRendererHost, useUiCapabilities } from "./host";

interface ContextMenuEventLike {
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

interface RightClickSelectionGesture {
  selectedBefore: string;
  startedAt: number;
}

interface ContextMenuController {
  showContextMenu(
    context: ContextMenuContext,
    items: ContextMenuItem[],
    event?: ContextMenuEventLike,
  ): Promise<boolean>;
}

const ContextMenuControllerContext = createContext<ContextMenuController | null>(null);
const noopContextMenuController: ContextMenuController = {
  showContextMenu: async () => false,
};
const EDITABLE_SELECTOR = "input, textarea, [contenteditable='true']";
const MENU_SURFACE_SELECTOR = [
  "[data-gloom-context-menu-surface='true']",
  "[data-gloom-role='pane-header']",
  "[data-gloom-role='pane-float-toggle']",
  "[data-gloom-role='pane-action']",
  "[data-gloom-role='pane-close']",
  "[data-gloom-role='status-bar']",
  "[data-gloom-role='tab-button']",
].join(", ");

function isDivider(item: ContextMenuItem): boolean {
  return item.type === "divider";
}

export function compactContextMenuItems(items: ContextMenuItem[]): ContextMenuItem[] {
  const result: ContextMenuItem[] = [];
  for (const item of items) {
    if (item.hidden === true) continue;
    if (isDivider(item)) {
      if (result.length === 0 || isDivider(result[result.length - 1]!)) continue;
      result.push(item);
      continue;
    }
    const nextItem = item.type === "normal" || item.type == null
      ? {
        ...item,
        submenu: item.submenu ? compactContextMenuItems(item.submenu) : undefined,
      }
      : item;
    if (nextItem.type !== "role" && nextItem.submenu && !hasRunnableContextMenuItem(nextItem.submenu)) {
      result.push({ ...nextItem, enabled: false, submenu: nextItem.submenu });
      continue;
    }
    result.push(nextItem);
  }

  while (result.length > 0 && isDivider(result[result.length - 1]!)) {
    result.pop();
  }
  return result;
}

function withSafeActions(
  items: ContextMenuItem[],
  onError: (error: unknown) => void,
): ContextMenuItem[] {
  return items.map((item) => {
    if (item.type === "divider" || item.type === "role") return item;
    return {
      ...item,
      submenu: item.submenu ? withSafeActions(item.submenu, onError) : undefined,
      onSelect: item.onSelect
        ? () => {
          try {
            const result = item.onSelect?.();
            if (result instanceof Promise) {
              void result.catch(onError);
            }
          } catch (error) {
            onError(error);
          }
        }
        : undefined,
    };
  });
}

function selectedTextTickerSymbol(text: string): string | null {
  const normalized = text.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(normalized) ? normalized : null;
}

function elementTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null;
}

function selectionText(): string {
  return window.getSelection()?.toString().trim() ?? "";
}

function clearBrowserSelection(): void {
  window.getSelection()?.removeAllRanges();
}

function selectedTextMenuItems(text: string, registry: PluginRegistry | null, copyText: (text: string) => Promise<void>): ContextMenuItem[] {
  const symbol = selectedTextTickerSymbol(text);
  const ticker = symbol ? registry?.getTickerFn(symbol) ?? null : null;
  const items: ContextMenuItem[] = [
    { type: "role", role: "copy", label: "Copy" },
  ];
  if (ticker && symbol) {
    items.push(
      contextMenuDivider("selected-text:ticker-divider"),
      {
        id: "selected-text:open-ticker",
        label: "Open Ticker Research",
        onSelect: () => registry?.navigateTicker(symbol),
      },
      {
        id: "selected-text:copy-symbol",
        label: "Copy Symbol",
        onSelect: () => { void copyText(symbol); },
      },
    );
  }
  return items;
}

export function editableTextContextMenuItems(): ContextMenuItem[] {
  return [
    { type: "role", role: "undo" },
    { type: "role", role: "redo" },
    contextMenuDivider("edit:history"),
    { type: "role", role: "cut" },
    { type: "role", role: "copy" },
    { type: "role", role: "paste" },
    contextMenuDivider("edit:selection"),
    { type: "role", role: "selectAll" },
  ];
}

export function linkContextMenuItems({
  url,
  open,
  copy,
}: {
  url: string;
  open: (url: string) => void;
  copy: (text: string) => void;
}): ContextMenuItem[] {
  return [
    {
      id: "link:open",
      label: "Open Link",
      onSelect: () => open(url),
    },
    {
      id: "link:copy",
      label: "Copy Link",
      onSelect: () => copy(url),
    },
  ];
}

function appContextMenuItems(registry: Pick<PluginRegistry, "openCommandBar"> | null): ContextMenuItem[] {
  return [
    {
      id: "app:command-bar",
      label: "Command Bar",
      onSelect: () => registry?.openCommandBar(),
    },
    {
      id: "app:layout-actions",
      label: "Layout Actions...",
      onSelect: () => registry?.openCommandBar("LAY "),
    },
    contextMenuDivider("app:config-divider"),
    {
      id: "app:plugins",
      label: "Manage Plugins...",
      onSelect: () => registry?.openCommandBar("PL "),
    },
    {
      id: "app:theme",
      label: "Change Theme...",
      onSelect: () => registry?.openCommandBar("TH "),
    },
    {
      id: "app:updates",
      label: "Check for Updates",
      onSelect: () => registry?.openCommandBar("Check for Updates"),
    },
  ];
}

export function tickerContextMenuItems({
  ticker,
  financials,
  registry,
  openTicker,
  copyText,
}: {
  ticker: TickerRecord;
  financials: TickerFinancials | null;
  registry: PluginRegistry | null;
  openTicker?: (symbol: string) => void;
  copyText: (text: string) => Promise<void>;
}): ContextMenuItem[] {
  const symbol = ticker.metadata.ticker;
  const items: ContextMenuItem[] = [
    {
      id: "ticker:open",
      label: tf("Open {symbol} Ticker Research", { symbol }),
      onSelect: () => (openTicker ? openTicker(symbol) : registry?.navigateTicker(symbol)),
    },
    {
      id: "ticker:pin-floating",
      label: tf("Open {symbol} in New Floating Ticker Research", { symbol }),
      onSelect: () => registry?.pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID, forceNewPane: true }),
    },
    {
      id: "ticker:copy-symbol",
      label: "Copy Symbol",
      onSelect: () => { void copyText(symbol); },
    },
    contextMenuDivider("ticker:collection-divider"),
    {
      id: "ticker:add-watchlist",
      label: "Add to Watchlist...",
      onSelect: () => registry?.openCommandBar(`AW ${symbol}`),
    },
    {
      id: "ticker:add-portfolio",
      label: "Add to Portfolio...",
      onSelect: () => registry?.openCommandBar(`AP ${symbol}`),
    },
  ];

  if (ticker.metadata.watchlists.length > 0) {
    items.push({
      id: "ticker:remove-watchlist",
      label: "Remove from Watchlist...",
      onSelect: () => registry?.openCommandBar(`RW ${symbol}`),
    });
  }
  if (ticker.metadata.portfolios.length > 0) {
    items.push({
      id: "ticker:remove-portfolio",
      label: "Remove from Portfolio...",
      onSelect: () => registry?.openCommandBar(`RP ${symbol}`),
    });
  }

  const tickerActions = registry
    ? [...registry.tickerActions.values()].filter((action) => !action.filter || action.filter(ticker))
    : [];
  if (tickerActions.length > 0) {
    items.push(contextMenuDivider("ticker:actions-divider"));
    for (const action of tickerActions) {
      items.push({
        id: `ticker-action:${action.id}`,
        label: action.label,
        onSelect: () => { void action.execute(ticker, financials); },
      });
    }
  }

  return items;
}

function translateContextMenuItems(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.map((item) => {
    if (item.type === "divider" || item.type === "role") return item;
    return {
      ...item,
      label: t(item.label),
      submenu: item.submenu ? translateContextMenuItems(item.submenu) : item.submenu,
    };
  });
}

export function ContextMenuProvider({
  pluginRegistry,
  children,
}: {
  pluginRegistry?: PluginRegistry | null;
  children: ReactNode;
}) {
  const renderer = useRendererHost();
  const capabilities = useUiCapabilities();
  const rightClickSelectionRef = useRef<RightClickSelectionGesture | null>(null);
  const registry = pluginRegistry ?? getSharedRegistry() ?? null;
  const nativeSupported = capabilities.nativeContextMenu === true && typeof renderer.showContextMenu === "function";

  const handleActionError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    registry?.notify({ body: message || "Context menu action failed.", type: "error" });
  }, [registry]);

  const showContextMenu = useCallback<ContextMenuController["showContextMenu"]>(async (context, localItems, event) => {
    if (!nativeSupported || !renderer.showContextMenu) return false;

    const pluginItems = registry?.getContextMenuItems(context) ?? [];
    const items = compactContextMenuItems([
      ...localItems,
      ...(localItems.length > 0 && pluginItems.length > 0 ? [contextMenuDivider(`${context.kind}:plugin-divider`)] : []),
      ...pluginItems,
    ]);
    if (!hasRunnableContextMenuItem(items)) return false;

    event?.preventDefault?.();
    event?.stopPropagation?.();
    return renderer.showContextMenu(withSafeActions(translateContextMenuItems(items), handleActionError));
  }, [handleActionError, nativeSupported, registry, renderer]);

  useEffect(() => {
    if (!nativeSupported || typeof document === "undefined") return;
    const handleDocumentRightClickStart = (event: MouseEvent | PointerEvent) => {
      if (event.button !== 2) return;
      const target = elementTarget(event.target);
      if (target?.closest(EDITABLE_SELECTOR)) {
        rightClickSelectionRef.current = null;
        return;
      }

      const now = Date.now();
      if (!rightClickSelectionRef.current || now - rightClickSelectionRef.current.startedAt > 500) {
        rightClickSelectionRef.current = {
          selectedBefore: selectionText(),
          startedAt: now,
        };
      }
      event.preventDefault();
    };
    const handleDocumentSelectStart = (event: Event) => {
      if (!rightClickSelectionRef.current) return;
      const target = elementTarget(event.target);
      if (target?.closest(EDITABLE_SELECTOR)) return;
      event.preventDefault();
    };
    const handleDocumentContextMenu = (event: MouseEvent) => {
      const target = elementTarget(event.target);
      if (target?.closest(EDITABLE_SELECTOR)) return;
      const gesture = rightClickSelectionRef.current;
      let selected = selectionText();
      const browserCreatedSelection = !!gesture && !gesture.selectedBefore && !!selected;
      if (browserCreatedSelection) {
        clearBrowserSelection();
        selected = "";
      }
      globalThis.setTimeout(() => {
        if (rightClickSelectionRef.current === gesture) {
          rightClickSelectionRef.current = null;
        }
      }, 0);
      if (target?.closest(MENU_SURFACE_SELECTOR)) return;
      if (!selected) {
        void showContextMenu(
          { kind: "app" },
          appContextMenuItems(registry),
          event,
        );
        return;
      }
      void showContextMenu(
        { kind: "selected-text", text: selected },
        selectedTextMenuItems(selected, registry, renderer.copyText.bind(renderer)),
        event,
      );
    };
    document.addEventListener("pointerdown", handleDocumentRightClickStart, true);
    document.addEventListener("mousedown", handleDocumentRightClickStart, true);
    document.addEventListener("selectstart", handleDocumentSelectStart, true);
    document.addEventListener("contextmenu", handleDocumentContextMenu, true);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentRightClickStart, true);
      document.removeEventListener("mousedown", handleDocumentRightClickStart, true);
      document.removeEventListener("selectstart", handleDocumentSelectStart, true);
      document.removeEventListener("contextmenu", handleDocumentContextMenu, true);
    };
  }, [nativeSupported, registry, renderer, showContextMenu]);

  const value = useMemo(() => ({ showContextMenu }), [showContextMenu]);
  return (
    <ContextMenuControllerContext value={value}>
      {children}
    </ContextMenuControllerContext>
  );
}

export function useContextMenu(): ContextMenuController {
  const context = useContext(ContextMenuControllerContext);
  if (!context) {
    return noopContextMenuController;
  }
  return context;
}

export function useTickerContextMenu({
  ticker,
  financials,
  onOpen,
}: {
  ticker: TickerRecord | null | undefined;
  financials?: TickerFinancials | null;
  onOpen?: (symbol: string) => void;
}) {
  const { showContextMenu } = useContextMenu();
  const renderer = useRendererHost();
  const registry = getSharedRegistry() ?? null;
  return useCallback((event?: ContextMenuEventLike) => {
    if (!ticker) return Promise.resolve(false);
    return showContextMenu(
      {
        kind: "ticker",
        symbol: ticker.metadata.ticker,
        ticker,
        financials: financials ?? null,
      },
      tickerContextMenuItems({
        ticker,
        financials: financials ?? null,
        registry,
        openTicker: onOpen,
        copyText: renderer.copyText.bind(renderer),
      }),
      event,
    );
  }, [financials, onOpen, registry, renderer, showContextMenu, ticker]);
}
