import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, PaneFooterScope, usePaneMenuItems } from "../../../components";
import { usePaneStateValue } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { useDialogState } from "../../../ui/dialog";
import { ResearchTradingProvider, type ResearchTradeProjection } from "../shared/research-trading";
import { createTradeIntent } from "./command";
import { BrokerTradeTab } from "./pane";

function tradeDockWidth(width: number, native: boolean, cellWidth = 8): number | null {
  return width >= (native ? 900 / cellWidth : 100) ? (native ? 336 / cellWidth : 34) : null;
}

/** One mounted ticket survives close, tab navigation and wide/narrow transitions. */
export function ResearchTradeWorkspace({ width, height, focused, symbol, tabId, selectTab, onCapture, children }: {
  width: number; height: number; focused: boolean; symbol: string; tabId: string;
  selectTab(id: string): void; onCapture(captured: boolean): void;
  children(width: number, focused: boolean): ReactNode;
}) {
  const c = useThemeColors();
  const { nativePaneChrome, cellWidthPx = 8 } = useUiCapabilities();
  const panelWidth = tradeDockWidth(width, !!nativePaneChrome, cellWidthPx);
  const [intent, setIntent] = usePaneStateValue<string | null>("brokerTradeIntent", null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [panelFocused, setPanelFocused] = useState(true);
  const dialogOpen = useDialogState((state) => state.isOpen);
  const [projection, publish] = useState<ResearchTradeProjection>({ levels: [] });
  const chartTab = tabId === "chart" || tabId === "overview";
  const docked = panelWidth !== null;
  const visible = tabId === "broker-trade" || open && chartTab;
  useEffect(() => {
    if (intent || tabId === "broker-trade") { setMounted(true); setOpen(true); setPanelFocused(true); }
    if (intent && !docked && tabId !== "broker-trade") selectTab("broker-trade");
    else if (tabId === "broker-trade" && docked) selectTab("chart");
  }, [intent, tabId, docked, selectTab]);
  useEffect(() => {
    if (open && chartTab && !docked) selectTab("broker-trade");
  }, [open, chartTab, docked, selectTab]);
  const openTicket = useCallback((side: "BUY" | "SELL") => {
    if (projection.busy) return;
    setIntent(createTradeIntent({ action: side })); setMounted(true); setOpen(true); setPanelFocused(true);
    if (!docked) selectTab("broker-trade");
    else if (!chartTab) selectTab("chart");
  }, [chartTab, docked, projection.busy, selectTab, setIntent]);
  const close = useCallback(() => {
    setOpen(false); onCapture(false);
    if (tabId === "broker-trade") selectTab("chart");
  }, [onCapture, selectTab, tabId]);
  const context = useMemo(() => ({ ...projection, symbol, docked, visible, open: openTicket, close, publish }), [projection, symbol, docked, visible, openTicket, close]);
  const split = visible && docked && chartTab;
  useShortcut((event) => {
    if (event.name !== "f6" || event.repeat) return;
    event.preventDefault(); event.stopPropagation(); onCapture(false); setPanelFocused((value) => !value);
  }, { enabled: focused && split && !dialogOpen, allowEditable: true, phase: "before", scope: "research:trade-focus" });
  useShortcut((event) => {
    if (event.name !== "escape" || event.defaultPrevented || event.targetEditable) return;
    event.preventDefault(); event.stopPropagation(); close();
  }, { enabled: focused && split && !panelFocused && !dialogOpen, phase: "after", scope: "research:trade-close" });
  usePaneMenuItems("research:trade-focus", () => focused && split ? [{ id: "trade-focus", accelerator: "F6", label: panelFocused ? "Focus chart" : "Focus ticket", onSelect: () => setPanelFocused((value) => !value) }] : null, [focused, split, panelFocused]);
  const contentWidth = (split ? panelWidth! : width) - (nativePaneChrome ? 1 / cellWidthPx : 1);
  return <ResearchTradingProvider value={context}>
    <Box flexDirection="row" width={width} height={height} overflow="hidden">
      <Box visible={tabId !== "broker-trade" && !(visible && !docked && chartTab)} width={split ? width - panelWidth! : width} height={height} flexDirection="column" overflow="hidden" onMouseDown={() => setPanelFocused(false)}>
        <PaneFooterScope active={!visible || !panelFocused}>{children(split ? width - panelWidth! : width, focused && (!visible || !panelFocused))}</PaneFooterScope>
      </Box>
      {mounted ? <Box visible={visible} onMouseDown={() => setPanelFocused(true)} width={split ? panelWidth! : width} height={height} flexShrink={0} flexDirection="column" border={nativePaneChrome ? undefined : ["left"]} borderColor={c.border}
        style={nativePaneChrome ? { borderLeft: `1px solid ${c.border}` } : undefined}>
        <PaneFooterScope active={visible && panelFocused}>
          <Box flexDirection="row" paddingX={1} justifyContent="space-between" height={nativePaneChrome ? 1.5 : 1} flexShrink={0}>
            {split ? <Text fg={c.textBright}>{symbol}</Text> : <Box flexGrow={1} />}<Button label="Close trade panel" displayLabel="Close" variant="plain" onPress={close} />
          </Box>
          <BrokerTradeTab width={contentWidth} height={height - (nativePaneChrome ? 1.5 : 1)} focused={focused && visible && panelFocused} onCapture={onCapture} docked={split} onClose={close} />
        </PaneFooterScope>
      </Box> : null}
    </Box>
  </ResearchTradingProvider>;
}
