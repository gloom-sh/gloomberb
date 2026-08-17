import { useCallback, useMemo, useState } from "react";
import { TextAttributes } from "../../../ui";
import {
  DataTableView,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { useAppSelector, usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { formatCompact, formatNumber } from "../../../utils/format";
import type { PaneProps } from "../../../types/plugin";
import type { ScannerFlowEvent } from "../../../api-client";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { usePluginPaneActions, usePluginTickerActions } from "../../runtime";
import { ScannerDeniedState } from "./denied";
import { useFlowFeed, useScannerStatusFooter } from "./feed";
import {
  DEFAULT_FLOW_FILTERS,
  filterFlowEvents,
  formatFlowExpiry,
  formatFlowPremium,
  formatFlowSide,
  formatFlowTime,
  formatFlowType,
  formatFlowVolOi,
  type FlowExpiry,
  type FlowFilters,
  type FlowKind,
  type FlowMinPremium,
  type FlowSide,
  type FlowUniverse,
  type FlowVolOi,
} from "./flow-model";

function buildColumns(width: number): DataTableColumn[] {
  const fixed = { time: 8, ticker: 7, type: 8, strike: 8, exp: 6, side: 5, size: 7, prem: 7, volOi: 6 };
  const total = Object.values(fixed).reduce((sum, value) => sum + value, 0);
  // Table chrome is one gap per column, two cells of padding, and the scrollbar.
  const slack = Math.max(0, width - total - 9 - 2 - 1);
  return [
    { id: "time", label: "TIME", width: fixed.time, align: "left" },
    { id: "ticker", label: "TICKER", width: fixed.ticker + Math.min(4, slack), align: "left" },
    { id: "type", label: "TYPE", width: fixed.type, align: "left" },
    { id: "strike", label: "STRIKE", width: fixed.strike, align: "right" },
    { id: "expiry", label: "EXP", width: fixed.exp, align: "right" },
    { id: "side", label: "SIDE", width: fixed.side, align: "left" },
    { id: "size", label: "SIZE", width: fixed.size, align: "right" },
    { id: "premium", label: "PREM", width: fixed.prem, align: "right" },
    { id: "volOi", label: "V/OI", width: fixed.volOi, align: "right" },
  ];
}

function renderCell(
  event: ScannerFlowEvent,
  column: DataTableColumn,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  const rightColor = event.right === "C" ? colors.positive : colors.negative;
  switch (column.id) {
    case "time":
      return { text: formatFlowTime(event.at), color: selectedColor ?? colors.textDim };
    case "ticker":
      return {
        text: event.underlying,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "type":
      return { text: formatFlowType(event), color: selectedColor ?? rightColor };
    case "strike":
      return { text: formatNumber(event.strike, event.strike % 1 === 0 ? 0 : 2), color: selectedColor };
    case "expiry":
      return { text: formatFlowExpiry(event.expiry), color: selectedColor ?? colors.textDim };
    case "side":
      return { text: formatFlowSide(event.side), color: selectedColor ?? colors.textDim };
    case "size":
      return { text: formatCompact(event.size), color: selectedColor };
    case "premium":
      return {
        text: formatFlowPremium(event.premium),
        color: selectedColor ?? rightColor,
        attributes: TextAttributes.BOLD,
      };
    default:
      return { text: formatFlowVolOi(event.volOi), color: selectedColor ?? colors.textDim };
  }
}

function FlowPane({ focused, width, height }: PaneProps) {
  const feed = useFlowFeed();
  const { selectTicker } = usePluginPaneActions();
  const { pinTicker } = usePluginTickerActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [minPremium] = usePaneSettingValue<FlowMinPremium>("minPremium", DEFAULT_FLOW_FILTERS.minPremium);
  const [side] = usePaneSettingValue<FlowSide>("side", DEFAULT_FLOW_FILTERS.side);
  const [kind] = usePaneSettingValue<FlowKind>("kind", DEFAULT_FLOW_FILTERS.kind);
  const [volOi] = usePaneSettingValue<FlowVolOi>("volOi", DEFAULT_FLOW_FILTERS.volOi);
  const [expiry] = usePaneSettingValue<FlowExpiry>("expiry", DEFAULT_FLOW_FILTERS.expiry);
  const [universe] = usePaneSettingValue<FlowUniverse>("universe", DEFAULT_FLOW_FILTERS.universe);

  const trackedSymbols = useAppSelector((state) => state.tickers);
  const watchlist = useMemo(
    () => new Set([...trackedSymbols.keys()].map((symbol) => symbol.toUpperCase())),
    [trackedSymbols],
  );

  const filters = useMemo<FlowFilters>(
    () => ({ minPremium, side, kind, volOi, expiry, universe }),
    [expiry, kind, minPremium, side, universe, volOi],
  );
  const events = useMemo(
    () => filterFlowEvents(feed.payload?.events, filters, watchlist),
    [feed.payload?.events, filters, watchlist],
  );

  useScannerStatusFooter("flow", feed);

  const columns = useMemo(() => buildColumns(width), [width]);

  const handleSelect = useCallback((event: ScannerFlowEvent) => {
    setSelectedId(event.id);
    selectTicker(event.underlying);
  }, [selectTicker]);

  if (feed.denied) {
    return <ScannerDeniedState reason={feed.deniedReason} />;
  }

  return (
    <DataTableView<ScannerFlowEvent>
      focused={focused}
      selection={{
        kind: "id",
        selectedId,
        getId: (event) => event.id,
        onChange: (_id, event) => handleSelect(event),
      }}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={events}
      sortColumnId={null}
      sortDirection="desc"
      onHeaderClick={() => {}}
      getItemKey={(event) => event.id}
      onActivate={(event) => pinTicker(event.underlying, { floating: true, paneType: TICKER_RESEARCH_PANE_ID })}
      renderCell={(event, column, _index, rowState) => renderCell(event, column, rowState)}
      emptyStateTitle={feed.payload ? "No prints match these filters." : "Waiting for the scanner..."}
      emptyStateHint={feed.payload ? "Loosen the premium, expiry, or universe filter." : undefined}
    />
  );
}

export default FlowPane;
