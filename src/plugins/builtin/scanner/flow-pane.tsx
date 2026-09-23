import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type ScannerFlowEvent } from "../../../api-client";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  useTableLoadMore,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { useAppSelector, usePaneSettingValue, usePaneStateValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { formatCompact, formatNumber } from "../../../utils/format";
import { usePluginTickerActions } from "../../runtime";
import { ScannerDeniedState } from "./denied";
import { useFlowFeed, useScannerStatusFooter } from "./feed";
import { useFlowHistory } from "./flow-history";
import {
  DEFAULT_FLOW_FILTERS,
  FLOW_FILTER_OPTIONS,
  filterFlowEvents,
  flowEmptyState,
  flowHistoryQuery,
  flowRowsSpanDays,
  keepFlowPrints,
  mergeFlowRows,
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

function buildColumns(width: number, dated: boolean): DataTableColumn[] {
  // EXP is right aligned and SIDE is left aligned, so EXP needs an extra cell or
  // the two header labels read as one "EXP SIDE" word. Prints from earlier days
  // carry their date ("09/22 15:04"), so the time column widens for them.
  const fixed = { time: dated ? 11 : 8, ticker: 7, type: 8, strike: 8, exp: 7, side: 5, size: 7, prem: 7, volOi: 6 };
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

// Stable table adapters so memoized rows survive feed ticks.
const eventKey = (event: ScannerFlowEvent) => event.id;
const renderRow = (
  event: ScannerFlowEvent,
  column: DataTableColumn,
  _index: number,
  rowState: { selected: boolean },
) => renderCell(event, column, rowState);

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
  const { pinTicker } = usePluginTickerActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Publish the selection on this pane, not the portfolio: moving the
  // portfolio's cursor scrolled it to a ticker the user never picked there.
  const [, setCursorSymbol] = usePaneStateValue<string | null>("cursorSymbol", null);

  const [minPremium, setMinPremium] = usePaneSettingValue<FlowMinPremium>("minPremium", DEFAULT_FLOW_FILTERS.minPremium);
  const [side, setSide] = usePaneSettingValue<FlowSide>("side", DEFAULT_FLOW_FILTERS.side);
  const [kind, setKind] = usePaneSettingValue<FlowKind>("kind", DEFAULT_FLOW_FILTERS.kind);
  const [volOi, setVolOi] = usePaneSettingValue<FlowVolOi>("volOi", DEFAULT_FLOW_FILTERS.volOi);
  const [expiry, setExpiry] = usePaneSettingValue<FlowExpiry>("expiry", DEFAULT_FLOW_FILTERS.expiry);
  const [universe, setUniverse] = usePaneSettingValue<FlowUniverse>("universe", DEFAULT_FLOW_FILTERS.universe);

  const trackedSymbols = useAppSelector((state) => state.tickers);
  const watchlist = useMemo(
    () => new Set([...trackedSymbols.keys()].map((symbol) => symbol.toUpperCase())),
    [trackedSymbols],
  );

  const filters = useMemo<FlowFilters>(
    () => ({ minPremium, side, kind, volOi, expiry, universe }),
    [expiry, kind, minPremium, side, universe, volOi],
  );
  // The shared tape holds only its latest prints; the pane keeps every one it
  // has received, and recorded pages continue below the oldest of them.
  // Folded in during render, not after it, so the first recorded page is
  // already asked for below the live prints it arrived with.
  const keptRef = useRef<readonly ScannerFlowEvent[]>([]);
  const kept = useMemo(() => {
    keptRef.current = keepFlowPrints(keptRef.current, feed.payload?.events);
    return keptRef.current;
  }, [feed.payload?.events]);
  const liveRows = useMemo(
    () => filterFlowEvents(kept, filters, watchlist),
    [filters, kept, watchlist],
  );

  const historyQuery = useMemo(() => flowHistoryQuery(filters, watchlist), [filters, watchlist]);
  const oldestKept = kept.at(-1);
  const oldestLive = useMemo(
    () => (oldestKept ? { at: oldestKept.at, id: oldestKept.id } : null),
    [oldestKept?.at, oldestKept?.id],
  );
  const history = useFlowHistory(historyQuery, oldestLive, !!feed.payload && !feed.denied);
  const events = useMemo(() => mergeFlowRows(liveRows, history.events), [history.events, liveRows]);

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const canLoadOlder = history.hasMore && !history.loading && !history.error && !!feed.payload && !feed.denied;
  const onBodyScrollActivity = useTableLoadMore(scrollRef, canLoadOlder, history.loadMore);
  // A strict filter or a quiet tape should still fill the pane, including
  // before the open, when every row is recorded.
  const bodyRows = Math.max(1, height - 3);
  useEffect(() => {
    if (canLoadOlder && events.length < bodyRows) history.loadMore();
  }, [bodyRows, canLoadOlder, events.length, history.loadMore]);

  const emptyState = useMemo(
    () => flowEmptyState(kept.length, liveRows.length, feed.payload?.status),
    [feed.payload?.status, kept.length, liveRows.length],
  );

  const historyFooter = useMemo<PaneFooterSegment | null>(() => {
    if (history.error) {
      return { id: "flow-history", parts: [{ text: "older prints unavailable · r retry", tone: "warning" }] };
    }
    if (history.loading) return { id: "flow-history", parts: [{ text: "loading older prints", tone: "muted" }] };
    return null;
  }, [history.error, history.loading]);
  useScannerStatusFooter("flow", feed, focused, historyFooter);

  const dated = useMemo(() => flowRowsSpanDays(events), [events]);
  const columns = useMemo(() => buildColumns(width, dated), [dated, width]);

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name !== "r" || !history.error) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    history.retry();
    return true;
  }, [history.error, history.retry]);

  const handleSelect = useCallback((event: ScannerFlowEvent) => {
    setSelectedId(event.id);
    setCursorSymbol(event.underlying);
  }, [setCursorSymbol]);

  if (feed.denied) {
    return <ScannerDeniedState reason={feed.deniedReason} />;
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar
        width={width}
        filters={[
          { id: "premium", label: "Prem", value: minPremium, defaultValue: DEFAULT_FLOW_FILTERS.minPremium,
            options: FLOW_FILTER_OPTIONS.minPremium, onChange: setMinPremium },
          { id: "side", label: "Side", value: side, defaultValue: DEFAULT_FLOW_FILTERS.side,
            options: FLOW_FILTER_OPTIONS.side, onChange: setSide },
          { id: "kind", label: "Kind", value: kind, defaultValue: DEFAULT_FLOW_FILTERS.kind,
            options: FLOW_FILTER_OPTIONS.kind, onChange: setKind },
          { id: "voloi", label: "V/OI", value: volOi, defaultValue: DEFAULT_FLOW_FILTERS.volOi,
            options: FLOW_FILTER_OPTIONS.volOi, onChange: setVolOi },
          { id: "expiry", label: "Exp", value: expiry, defaultValue: DEFAULT_FLOW_FILTERS.expiry,
            options: FLOW_FILTER_OPTIONS.expiry, onChange: setExpiry },
          { id: "universe", label: "Univ", value: universe, defaultValue: DEFAULT_FLOW_FILTERS.universe,
            options: FLOW_FILTER_OPTIONS.universe, onChange: setUniverse },
        ]}
      />
      <DataTableView<ScannerFlowEvent>
        focused={focused}
        selection={{
          kind: "id",
          selectedId,
          getId: (event) => event.id,
          onChange: (_id, event) => handleSelect(event),
        }}
        rootWidth={width}
        rootHeight={Math.max(2, height - 1)}
        columns={columns}
        items={events}
        sortColumnId={null}
        sortDirection="desc"
        onHeaderClick={() => {}}
        getItemKey={eventKey}
        onActivate={(event) => pinTicker(event.underlying, { floating: true, paneType: TICKER_RESEARCH_PANE_ID })}
        renderCell={renderRow}
        emptyContent={
          !feed.payload
            ? <PaneStatusBody loading loadingLabel="Waiting for the scanner..." />
            : events.length === 0 && history.loading
              ? <PaneStatusBody loading loadingLabel="Loading recorded prints..." />
              : undefined
        }
        emptyStateTitle={emptyState.title}
        emptyStateHint={emptyState.hint}
        onRootKeyDown={handleRootKeyDown}
        onBodyScrollActivity={onBodyScrollActivity}
        scrollRef={scrollRef}
      />
    </Box>
  );
}

export default FlowPane;
