import { startTransition, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PaneFooterScope, usePaneMenuItems } from "../../../components";
import { usePaneAppConfig, usePaneStateValue } from "../../../state/app/context";
import { usePluginBrokerActions } from "../../runtime";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useNativeRenderer, useUiCapabilities, type BoxRenderable } from "../../../ui";
import { capturePointerDrag } from "../../../ui/pointer-drag";
import { useShortcut } from "../../../react/input";
import { useDialogState } from "../../../ui/dialog";
import { ResearchTradingProvider, type ResearchTradeProjection } from "../shared/research-trading";
import type { BrokerOrder } from "../../../types/trading";
import { TickerOrdersSection } from "./overview-orders";
import { createTradeIntent } from "./command";
import { BrokerTradeTab } from "./pane";

const TRADE_TAB = "broker-trade";
/** Cells one press of `<` or `>` moves the divider, as in a pane sidebar. */
const RESIZE_STEP = 4;

/** Default, narrowest and widest ticket beside the chart; null when the pane is too narrow to share. */
function tradeDockWidths(width: number, native: boolean, cellWidth = 8): { initial: number; min: number; max: number } | null {
  if (width < (native ? 900 / cellWidth : 100)) return null;
  const initial = native ? 336 / cellWidth : 34;
  const min = native ? 280 / cellWidth : 30;
  // The chart keeps at least half the pane.
  return { initial, min, max: Math.max(min, Math.floor(width / 2)) };
}

interface DividerPointerEvent { x?: number; preciseX?: number; preventDefault?(): void; stopPropagation?(): void }

/**
 * Trade is the chart with the ticket beside it; Chart is the chart alone and
 * Overview never carries the ticket. b or s on either opens Trade. Below the
 * width where both fit, Trade is the ticket alone and the Chart tab is the
 * other half. The ticket stays mounted across tabs once opened, so a draft
 * survives a look at another tab.
 */
export function ResearchTradeWorkspace({ width, height, focused, symbol, tabId, selectTab, onCapture, locked = false, children }: {
  width: number; height: number; focused: boolean; symbol: string; tabId: string;
  selectTab(id: string): void; onCapture(captured: boolean): void;
  /** A pane pinned to one tab (no strip) opens the ticket over that tab instead of switching. */
  locked?: boolean;
  /** Renders a research tab: the selected one, or Chart beside the ticket. */
  children(width: number, focused: boolean, shownTabId?: string): ReactNode;
}) {
  const c = useThemeColors();
  const { nativePaneChrome, cellWidthPx = 8 } = useUiCapabilities();
  const nativeRenderer = useNativeRenderer();
  const widths = tradeDockWidths(width, !!nativePaneChrome, cellWidthPx);
  const [savedWidth, setSavedWidth] = usePaneStateValue<number | null>("brokerTradePanelWidth", null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const panelWidth = widths ? Math.min(widths.max, Math.max(widths.min, dragWidth ?? savedWidth ?? widths.initial)) : null;
  const [intent, setIntent] = usePaneStateValue<string | null>("brokerTradeIntent", null);
  const [mounted, setMounted] = useState(false);
  const [lockedOpen, setLockedOpen] = useState(false);
  const [panelFocused, setPanelFocused] = useState(true);
  const dialogOpen = useDialogState((state) => state.isOpen);
  const [projection, publish] = useState<ResearchTradeProjection>({ levels: [] });
  // A text field in the ticket owns typed keys; otherwise keys the ticket does
  // not use (zoom, pan, cursor) still reach the chart beside it.
  const [ticketCaptured, setTicketCaptured] = useState(false);
  const captureTicket = useCallback((captured: boolean) => { setTicketCaptured(captured); onCapture(captured); }, [onCapture]);
  const config = usePaneAppConfig();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const available = config.brokerInstances.some((profile) => profile.enabled !== false && !!getBrokerAdapter(profile.brokerType)?.placeOrder);
  const docked = panelWidth !== null;
  const visible = tabId === TRADE_TAB || locked && lockedOpen;
  // Layout effect: the tab switches before the mounted ticket's effect takes the intent.
  useLayoutEffect(() => {
    if (visible || intent) { setMounted(true); setPanelFocused(true); }
    if (intent && !visible) { if (locked) setLockedOpen(true); else selectTab(TRADE_TAB); }
  }, [intent, visible, locked, selectTab]);
  const openTicket = useCallback((side: "BUY" | "SELL") => {
    if (projection.busy) return;
    setIntent(createTradeIntent({ action: side })); setMounted(true); setPanelFocused(true);
    if (locked) setLockedOpen(true); else selectTab(TRADE_TAB);
  }, [projection.busy, locked, selectTab, setIntent]);
  // Overview's order opens Trade with that order in the ticket, as the drawer's edit button does.
  const modifyOrder = useCallback((order: BrokerOrder) => {
    if (projection.busy) return;
    setIntent(createTradeIntent({ action: order.action, modify: order })); setMounted(true); setPanelFocused(true);
    if (locked) setLockedOpen(true); else selectTab(TRADE_TAB);
  }, [projection.busy, locked, selectTab, setIntent]);
  const orders = useCallback((ordersWidth: number) => <TickerOrdersSection width={ordersWidth} onModify={modifyOrder} />, [modifyOrder]);
  const close = useCallback(() => {
    captureTicket(false); setLockedOpen(false);
    if (tabId === TRADE_TAB) selectTab("chart");
  }, [captureTicket, selectTab, tabId]);
  const split = visible && docked;
  const ticketFocused = split && panelFocused;
  const context = useMemo(() => ({ ...projection, symbol, available, docked, visible, ticketFocused, open: openTicket, close, publish, ...(available ? { orders } : {}) }), [projection, symbol, available, docked, visible, ticketFocused, openTicket, close, orders]);
  useShortcut((event) => {
    if (event.name !== "f6" || event.repeat) return;
    event.preventDefault(); event.stopPropagation(); captureTicket(false); setPanelFocused((value) => !value);
  }, { enabled: focused && split && !dialogOpen, allowEditable: true, phase: "before", scope: "research:trade-focus" });
  useShortcut((event) => {
    if (event.name !== "escape" || event.defaultPrevented || event.targetEditable) return;
    event.preventDefault(); event.stopPropagation(); close();
  }, { enabled: focused && split && !panelFocused && !dialogOpen, phase: "after", scope: "research:trade-close" });

  // The divider between chart and ticket drags, and < > move it from the keyboard.
  const dividerRef = useRef<BoxRenderable>(null);
  const dragOrigin = useRef<{ pointerX: number; width: number } | null>(null);
  const [dividerActive, setDividerActive] = useState(false);
  const clampWidth = (next: number) => widths ? Math.min(widths.max, Math.max(widths.min, next)) : next;
  const dragTo = (event?: DividerPointerEvent) => {
    const origin = dragOrigin.current;
    if (!origin) return null;
    event?.preventDefault?.(); event?.stopPropagation?.();
    const pointerX = event?.preciseX ?? event?.x ?? origin.pointerX;
    // Dragging left widens the ticket on the right.
    const next = clampWidth(origin.width - (pointerX - origin.pointerX));
    return nativePaneChrome ? next : Math.round(next);
  };
  const dividerHandlers = split ? {
    onMouseDown: (event?: DividerPointerEvent) => {
      event?.preventDefault?.(); event?.stopPropagation?.();
      dragOrigin.current = { pointerX: event?.preciseX ?? event?.x ?? 0, width: panelWidth! };
      setDividerActive(true);
      capturePointerDrag(nativeRenderer, dividerRef.current);
    },
    onMouseDrag: (event?: DividerPointerEvent) => {
      const next = dragTo(event);
      if (next !== null) startTransition(() => setDragWidth(next));
    },
    onMouseDragEnd: (event?: DividerPointerEvent) => {
      const next = dragTo(event);
      const origin = dragOrigin.current;
      dragOrigin.current = null;
      setDividerActive(false);
      setDragWidth(null);
      // A click that never moved keeps the width as it was.
      if (next !== null && next !== origin?.width) setSavedWidth(next);
    },
    onMouseOver: () => setDividerActive(true),
    onMouseOut: () => { if (!dragOrigin.current) setDividerActive(false); },
  } : {};
  const stepWidth = useCallback((delta: number) => {
    if (!widths || panelWidth === null) return;
    const next = Math.min(widths.max, Math.max(widths.min, panelWidth + delta));
    if (next !== panelWidth) setSavedWidth(next);
  }, [widths?.min, widths?.max, panelWidth, setSavedWidth]);
  useShortcut((event) => {
    if (event.defaultPrevented || event.targetEditable || event.ctrl || event.meta || event.alt || event.super) return;
    if (event.name !== "<" && event.name !== ">") return;
    event.preventDefault(); event.stopPropagation(); stepWidth(event.name === "<" ? RESIZE_STEP : -RESIZE_STEP);
  }, { enabled: focused && split && !dialogOpen, phase: "before", scope: "research:trade-resize" });
  usePaneMenuItems("research:trade-focus", () => focused && split ? [
    { id: "trade-focus", accelerator: "F6", label: panelFocused ? "Focus chart" : "Focus ticket", onSelect: () => setPanelFocused((value) => !value) },
    { id: "trade-widen", accelerator: "<", label: "Widen trade panel", enabled: panelWidth! < widths!.max, onSelect: () => stepWidth(RESIZE_STEP) },
    { id: "trade-narrow", accelerator: ">", label: "Narrow trade panel", enabled: panelWidth! > widths!.min, onSelect: () => stepWidth(-RESIZE_STEP) },
  ] : null, [focused, split, panelFocused, panelWidth, widths?.min, widths?.max, stepWidth]);

  const chartWidth = split ? width - panelWidth! : width;
  const contentWidth = (split ? panelWidth! : width) - (split ? nativePaneChrome ? 1 / cellWidthPx : 1 : 0);
  const dividerColor = dividerActive ? c.borderFocused : c.border;
  return <ResearchTradingProvider value={context}>
    <Box flexDirection="row" width={width} height={height} overflow="hidden">
      <Box visible={!visible || split} width={chartWidth} height={height} flexDirection="column" overflow="hidden" onMouseDown={() => setPanelFocused(false)}>
        <PaneFooterScope active={!visible || !panelFocused}>{children(chartWidth, focused && (!visible || !panelFocused || split && !ticketCaptured), split && !locked ? "chart" : undefined)}</PaneFooterScope>
      </Box>
      {mounted ? <Box visible={visible} position="relative" onMouseDown={() => setPanelFocused(true)} width={split ? panelWidth! : width} height={height} flexShrink={0} flexDirection="row">
        {split && !nativePaneChrome ? <Box ref={dividerRef} width={1} height={height} flexDirection="column" flexShrink={0} {...dividerHandlers}>
          {Array.from({ length: height }, (_, index) => <Text key={index} fg={dividerColor} selectable={false}>│</Text>)}
        </Box> : null}
        {split && nativePaneChrome ? <>
          <Box position="absolute" top={0} left={0} width={1} height={height} style={{ width: 1, height: "100%", backgroundColor: dividerColor, pointerEvents: "none" }} />
          {/* A 1px line is too thin to grab, so the handle straddles it. */}
          <Box ref={dividerRef} position="absolute" top={0} left={0} width={1} height={height} title="Resize trade panel (< >)" {...dividerHandlers}
            style={{ width: 7, left: -3, height: "100%", zIndex: 3, cursor: "col-resize" }} />
        </> : null}
        <Box flexDirection="column" width={contentWidth} height={height} flexGrow={1}>
          <PaneFooterScope active={visible && panelFocused}>
            <BrokerTradeTab width={contentWidth} height={height} focused={focused && visible && panelFocused} onCapture={captureTicket} docked={split} onClose={close} />
          </PaneFooterScope>
        </Box>
      </Box> : null}
    </Box>
  </ResearchTradingProvider>;
}
