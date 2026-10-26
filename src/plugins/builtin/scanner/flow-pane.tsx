import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScannerFlowEvent, ScannerFlowSession } from "../../../api-client";
import {
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  scalarPoint,
  staticSeries,
  useChartTableSelection,
  usePaneTabs,
  useTableLoadMore,
  type ChartTableChart,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { fitChartTableColumns, formatCompactAxis } from "../../../components/chart-table";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { useAsyncResource, useAutoRefresh, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useAppSelector, usePaneSettingValue, usePaneStateValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { ResolvedSeries } from "../../../time-series/types";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { MISSING_VALUE, formatCompact, formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
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
  flowScopeSymbol,
  flowSessionSearch,
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
  type FlowScope,
  type FlowSide,
  type FlowUniverse,
  type FlowVolOi,
} from "./flow-model";
import {
  FLOW_SESSION_LIVE_REFRESH_MS,
  flowStrikeRows,
  flowTidePoints,
  flowTideRows,
  formatFlowSessionDate,
  formatSignedFlowPremium,
  formatStrikeExpiry,
  formatTideTime,
  loadFlowSession,
  sortFlowStrikes,
  type FlowStrikeRow,
  type FlowStrikeSort,
  type FlowTideRow,
} from "./flow-session";

type FlowTab = "prints" | "tide" | "strikes";

/** The tabs a pane offers: the strike breakdown is one name's. */
function flowTabs(symbol: string | null): Array<{ label: string; value: FlowTab }> {
  return [
    { label: "Prints", value: "prints" },
    { label: "Tide", value: "tide" },
    ...(symbol ? [{ label: "Strikes", value: "strikes" as const }] : []),
  ];
}

function buildColumns(width: number, dated: boolean, ticker: boolean): DataTableColumn[] {
  // Prints from earlier days carry their date ("09/22 15:04"), so the time
  // column widens for them. One name's pane names it in its title, not a column.
  const fixed = { time: dated ? 11 : 8, ticker: ticker ? 7 : 0, type: 8, strike: 8, exp: 6, side: 5, size: 7, prem: 7, volOi: 6 };
  const total = Object.values(fixed).reduce((sum, value) => sum + value, 0);
  // Table chrome is one gap per column, the table's extra gutter where
  // right-aligned EXP meets left-aligned SIDE, two cells of padding, and the scrollbar.
  const slack = Math.max(0, width - total - (ticker ? 9 : 8) - 1 - 2 - 1);
  return [
    { id: "time", label: "TIME", width: fixed.time, align: "left" },
    ...(ticker ? [{ id: "ticker", label: "TICKER", width: fixed.ticker + Math.min(4, slack), align: "left" as const }] : []),
    { id: "type", label: "TYPE", width: fixed.type + (ticker ? 0 : Math.min(4, slack)), align: "left" },
    { id: "strike", label: "STRIKE", width: fixed.strike, align: "right" },
    { id: "expiry", label: "EXP", width: fixed.exp, align: "right" },
    { id: "side", label: "SIDE", width: fixed.side, align: "left" },
    { id: "size", label: "SIZE", width: fixed.size, align: "right" },
    { id: "premium", label: "PREM", width: fixed.prem, align: "right" },
    { id: "volOi", label: "V/OI", width: fixed.volOi, align: "right" },
  ];
}

const TIDE_COLUMNS: DataTableColumn[] = [
  { id: "time", label: "TIME", width: 6, align: "left" },
  { id: "netCalls", label: "NET CALLS", width: 10, align: "right" },
  { id: "netPuts", label: "NET PUTS", width: 10, align: "right" },
  { id: "net", label: "NET PREM", width: 10, align: "right" },
  { id: "change", label: "CHG", width: 9, align: "right" },
];

const STRIKE_COLUMNS: Array<DataTableColumn & { id: FlowStrikeSort }> = [
  { id: "expiry", label: "EXP", width: 8, align: "left" },
  { id: "strike", label: "STRIKE", width: 8, align: "right" },
  { id: "callPremium", label: "CALLS", width: 8, align: "right" },
  { id: "callAsk", label: "C ASK", width: 8, align: "right" },
  { id: "callBid", label: "C BID", width: 8, align: "right" },
  { id: "putPremium", label: "PUTS", width: 8, align: "right" },
  { id: "putAsk", label: "P ASK", width: 8, align: "right" },
  { id: "putBid", label: "P BID", width: 8, align: "right" },
  { id: "net", label: "NET", width: 8, align: "right" },
];
/** The totals go before the side columns that make up the breakdown. */
const STRIKE_DROP_ORDER: FlowStrikeSort[] = ["putPremium", "callPremium"];

function sideColor(side: ScannerFlowEvent["side"]): string {
  if (side === "ask") return colors.positive;
  if (side === "bid") return colors.negative;
  return side === "mid" ? colors.text : colors.textDim;
}

function signedColor(value: number): string {
  return value > 0 ? colors.positive : value < 0 ? colors.negative : colors.textDim;
}

// Stable table adapters so memoized rows survive feed ticks.
const eventKey = (event: ScannerFlowEvent) => event.id;
const tideKey = (row: FlowTideRow) => String(row.at);
const tideDate = (row: FlowTideRow) => new Date(row.at);
const strikeKey = (row: FlowStrikeRow) => row.id;

function renderCell(
  event: ScannerFlowEvent,
  column: DataTableColumn,
): DataTableCell {
  const rightColor = event.right === "C" ? colors.positive : colors.negative;
  switch (column.id) {
    case "time":
      return { text: formatFlowTime(event.at), color: colors.textDim };
    case "ticker":
      return {
        text: event.underlying,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "type":
      return { text: formatFlowType(event), color: rightColor };
    case "strike":
      return { text: formatNumber(event.strike, event.strike % 1 === 0 ? 0 : 2) };
    case "expiry":
      return { text: formatFlowExpiry(event.expiry), color: colors.textDim };
    case "side":
      // Bought at the ask reads green, sold at the bid red, as on every tape; the word stays.
      return { text: formatFlowSide(event.side), color: sideColor(event.side) };
    case "size":
      return { text: formatCompact(event.size) };
    case "premium":
      return {
        text: formatFlowPremium(event.premium),
        color: rightColor,
        attributes: TextAttributes.BOLD,
      };
    default:
      return { text: formatFlowVolOi(event.volOi), color: colors.textDim };
  }
}

function renderTideCell(row: FlowTideRow, column: DataTableColumn): DataTableCell {
  if (column.id === "time") return { text: formatTideTime(row.at), value: new Date(row.at).toISOString(), color: colors.textDim };
  const value = row[column.id as "netCalls" | "netPuts" | "net" | "change"];
  return {
    text: formatSignedFlowPremium(value),
    value,
    color: signedColor(value),
    ...(column.id === "net" ? { attributes: TextAttributes.BOLD } : {}),
  };
}

function renderStrikeCell(row: FlowStrikeRow, column: DataTableColumn): DataTableCell {
  switch (column.id) {
    case "expiry":
      return { text: formatStrikeExpiry(row.expiry), value: row.expiry, color: colors.textDim };
    case "strike":
      return { text: formatNumber(row.strike, row.strike % 1 === 0 ? 0 : 2), value: row.strike, color: colors.textBright };
    case "net":
      return { text: formatSignedFlowPremium(row.net), value: row.net, color: signedColor(row.net), attributes: TextAttributes.BOLD };
    default: {
      const value = row[column.id as "callPremium" | "callAsk" | "callBid" | "putPremium" | "putAsk" | "putBid"];
      const call = column.id.startsWith("call");
      const total = column.id === "callPremium" || column.id === "putPremium";
      return {
        text: value > 0 ? formatFlowPremium(value) : MISSING_VALUE,
        value,
        color: value <= 0 ? colors.textDim : total ? (call ? colors.positive : colors.negative) : colors.text,
      };
    }
  }
}

/** Amounts on the tide's axis, in one unit for the whole axis: `$12M`, `-$4.5M`. */
function formatPremiumAxis(value: number, domain: CompositeAxisDomain): string {
  const text = formatCompactAxis(value, domain);
  if (text === "0") return "$0";
  return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`;
}

/** The tide's lines read in the user's own clock, as the TIME columns do. */
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function tideSeries(rows: readonly FlowTideRow[], bucketMs: number): ResolvedSeries[] {
  const points = flowTidePoints(rows, bucketMs);
  const line = (id: string, label: string, color: string, value: (point: (typeof points)[number]) => number): ResolvedSeries => ({
    ...staticSeries(points.map((point) => scalarPoint(new Date(point.at), value(point))), { id, label, color }),
    timeBasis: { kind: "market", timeZone: LOCAL_TIME_ZONE, cadenceMs: bucketMs },
    observationKind: "market",
  });
  // Named as the table's columns are; the net line is the tide itself.
  return [
    line("flow-net", "Net prem", colors.textBright, (point) => point.net),
    line("flow-net-calls", "Net calls", colors.positive, (point) => point.netCalls),
    line("flow-net-puts", "Net puts", colors.negative, (point) => point.netPuts),
  ];
}

function FlowPane({ focused, width, height }: PaneProps) {
  const feed = useFlowFeed();
  const { pinTicker } = usePluginTickerActions();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Publish the selection on this pane, not the portfolio: moving the
  // portfolio's cursor scrolled it to a ticker the user never picked there.
  const [, setCursorSymbol] = usePaneStateValue<string | null>("cursorSymbol", null);

  // `FLOW NVDA` is one name's flow; plain FLOW is the market.
  const [symbolSetting] = usePaneSettingValue<string>("symbol", "");
  const symbol = flowScopeSymbol(symbolSetting);
  const tabItems = useMemo(() => flowTabs(symbol), [symbol]);
  const [initialTab] = usePaneSettingValue<string>("tab", "prints");
  const [savedTab, setTab] = usePluginPaneState<string>("flow:tab", initialTab);
  const tab: FlowTab = tabItems.find((item) => item.value === savedTab)?.value ?? "prints";
  // Signed out or without Pro, every tab is the same wall.
  const { strip, rows: tabRows } = usePaneTabs(!feed.denied ? { tabs: tabItems, activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  const bodyHeight = Math.max(3, height - tabRows);

  const [minPremium, setMinPremium] = usePaneSettingValue<FlowMinPremium>("minPremium", DEFAULT_FLOW_FILTERS.minPremium);
  const [side, setSide] = usePaneSettingValue<FlowSide>("side", DEFAULT_FLOW_FILTERS.side);
  const [kind, setKind] = usePaneSettingValue<FlowKind>("kind", DEFAULT_FLOW_FILTERS.kind);
  const [volOi, setVolOi] = usePaneSettingValue<FlowVolOi>("volOi", DEFAULT_FLOW_FILTERS.volOi);
  const [expiry, setExpiry] = usePaneSettingValue<FlowExpiry>("expiry", DEFAULT_FLOW_FILTERS.expiry);
  const [universe, setUniverse] = usePaneSettingValue<FlowUniverse>("universe", DEFAULT_FLOW_FILTERS.universe);

  const trackedSymbols = useAppSelector((state) => state.tickers);
  const watchlist = useMemo(
    () => new Set([...trackedSymbols.keys()].map((entry) => entry.toUpperCase())),
    [trackedSymbols],
  );
  const scope = useMemo<FlowScope>(() => ({ symbol, watchlist }), [symbol, watchlist]);

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
    () => filterFlowEvents(kept, filters, scope),
    [filters, kept, scope],
  );

  const historyQuery = useMemo(() => flowHistoryQuery(filters, scope), [filters, scope]);
  const oldestKept = kept.at(-1);
  const oldestLive = useMemo(
    () => (oldestKept ? { at: oldestKept.at, id: oldestKept.id } : null),
    [oldestKept?.at, oldestKept?.id],
  );
  const history = useFlowHistory(historyQuery, oldestLive, !!feed.payload && !feed.denied);
  const events = useMemo(() => mergeFlowRows(liveRows, history.events), [history.events, liveRows]);

  // The session summary loads once its tab is first opened, and refreshes from then on.
  const [sessionOpened, setSessionOpened] = useState(tab !== "prints");
  useEffect(() => {
    if (tab !== "prints") setSessionOpened(true);
  }, [tab]);
  const sessionSearch = useMemo(() => flowSessionSearch(filters, scope), [filters, scope]);
  const sessionLoader = useCallback(() => loadFlowSession(sessionSearch), [sessionSearch]);
  const session = useAsyncResource<ScannerFlowSession>(
    sessionOpened && !!feed.payload && !feed.denied ? sessionLoader : null,
  );
  useAutoRefresh(session.updatedAt, () => void session.load(), {
    intervalMs: feed.payload?.status === "live" ? FLOW_SESSION_LIVE_REFRESH_MS : null,
  });

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const canLoadOlder = tab === "prints" && history.hasMore && !history.loading && !history.error && !!feed.payload && !feed.denied;
  const onBodyScrollActivity = useTableLoadMore(scrollRef, canLoadOlder, history.loadMore);
  // A strict filter or a quiet tape should still fill the pane, including
  // before the open, when every row is recorded.
  const bodyRows = Math.max(1, bodyHeight - 3);
  useEffect(() => {
    if (canLoadOlder && events.length < bodyRows) history.loadMore();
  }, [bodyRows, canLoadOlder, events.length, history.loadMore]);

  const emptyState = useMemo(
    () => flowEmptyState(kept.length, liveRows.length, feed.payload?.status, symbol),
    [feed.payload?.status, kept.length, liveRows.length, symbol],
  );

  const statusFooter = useMemo<PaneFooterSegment | null>(() => {
    if (tab !== "prints") {
      // A failed refresh keeps the last summary on screen and says so here.
      return session.error && session.data
        ? { id: "flow-session", parts: [{ text: "session totals not refreshed", tone: "warning" }] }
        : null;
    }
    if (history.error) {
      return { id: "flow-history", parts: [{ text: "older prints unavailable", tone: "warning" }] };
    }
    if (history.loading) return { id: "flow-history", parts: [{ text: "loading older prints", tone: "muted" }] };
    return null;
  }, [history.error, history.loading, session.data, session.error, tab]);
  useScannerStatusFooter("flow", feed, focused, statusFooter);

  const dated = useMemo(() => flowRowsSpanDays(events), [events]);
  const columns = useMemo(() => buildColumns(width, dated, !symbol), [dated, symbol, width]);

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (!isPlainKey(event, "r") || !history.error) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    history.retry();
    return true;
  }, [history.error, history.retry]);
  usePaneRefreshKey(() => void session.reload(), { focused, enabled: tab !== "prints" && !feed.denied });

  const handleSelect = useCallback((event: ScannerFlowEvent) => {
    setSelectedId(event.id);
    setCursorSymbol(event.underlying);
  }, [setCursorSymbol]);

  if (feed.denied) {
    return <ScannerDeniedState reason={feed.deniedReason} placement="flow-wall" width={width} height={height} />;
  }

  const queryBar = (
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
        // One name's pane is already narrower than any universe.
        ...(symbol ? [] : [{ id: "universe", label: "Univ", value: universe, defaultValue: DEFAULT_FLOW_FILTERS.universe,
          options: FLOW_FILTER_OPTIONS.universe, onChange: setUniverse }]),
      ]}
    />
  );

  let body: ReactNode;
  if (tab === "tide") {
    body = (
      <FlowTideView
        focused={focused} width={width} height={bodyHeight} query={queryBar}
        session={session.data} loading={session.loading} error={session.error}
        onRetry={session.reload}
      />
    );
  } else if (tab === "strikes" && symbol) {
    body = (
      <FlowStrikesView
        focused={focused} width={width} height={bodyHeight} query={queryBar} symbol={symbol}
        session={session.data} loading={session.loading} error={session.error}
        onRetry={session.reload}
        onOpenChain={(row) => createPaneFromTemplate("options-pane", { symbol, values: { expiration: row.expiry } })}
      />
    );
  } else {
    body = (
      <>
        {queryBar}
        <DataTableView<ScannerFlowEvent>
          focused={focused}
          selection={{
            kind: "id",
            selectedId,
            getId: (event) => event.id,
            onChange: (_id, event) => handleSelect(event),
          }}
          rootWidth={width}
          rootHeight={Math.max(2, bodyHeight - 1)}
          columns={columns}
          items={events}
          sortColumnId={null}
          sortDirection="desc"
          getItemKey={eventKey}
          onActivate={(event) => pinTicker(event.underlying, { floating: true, paneType: TICKER_RESEARCH_PANE_ID })}
          renderCell={renderCell}
          selectedTextOverridesCellColor
          emptyContent={
            !feed.payload
              ? <PaneStatusBody loading loadingLabel="Waiting for the scanner..." />
              : events.length === 0 && (history.loading || (!!symbol && history.hasMore && !history.error))
                ? <PaneStatusBody loading loadingLabel="Loading recorded prints..." />
                : undefined
          }
          emptyStateTitle={emptyState.title}
          emptyStateHint={emptyState.hint}
          onRootKeyDown={handleRootKeyDown}
          onBodyScrollActivity={onBodyScrollActivity}
          scrollRef={scrollRef}
        />
      </>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {strip}
      {body}
    </Box>
  );
}

interface SessionViewProps {
  focused: boolean;
  width: number;
  height: number;
  query: ReactNode;
  session: ScannerFlowSession | null;
  loading: boolean;
  error: string | null;
  onRetry: () => unknown;
}

/** Until the first summary answers, the body loads or says why it failed; after that a failed refresh is the footer's. */
function sessionStatus(props: SessionViewProps, subject: string) {
  return props.session ? undefined : { loading: props.loading, error: props.error, subject, retry: { onRetry: props.onRetry } };
}

/**
 * The net-premium tide through the session: call premium bought at the ask
 * less call premium sold at the bid, less the same for puts, bucket by
 * bucket. The chart draws the running totals; the table adds what each
 * bucket moved them by.
 */
function FlowTideView(props: SessionViewProps) {
  const { focused, width, height, query, session } = props;
  const rows = useMemo(() => flowTideRows(session), [session]);
  // Newest first, like the prints; buckets with no matching print carry nothing to read.
  const tableRows = useMemo(() => [...rows].reverse(), [rows]);
  const bucketMs = session?.bucketMs ?? 300_000;
  const [selected, setSelected] = usePluginPaneState<string | null>("flow:tide-bucket", null);
  const selectedId = tableRows.some((row) => tideKey(row) === selected) ? selected : tableRows[0] ? tideKey(tableRows[0]) : null;
  const link = useChartTableSelection({
    rows: tableRows, getId: tideKey, getDate: tideDate, selectedId, onSelect: setSelected, focused,
  });
  const series = useMemo(() => tideSeries(rows, bucketMs), [bucketMs, rows]);
  const sessionDate = formatFlowSessionDate(session?.session);
  // Two points are not a trend: under three buckets the table has the pane.
  const chart: ChartTableChart | null = rows.length >= 3 ? {
    series,
    formatValue: (value) => formatSignedFlowPremium(value),
    formatAxisValue: formatPremiumAxis,
    viewport: { start: new Date(rows[0]!.at), end: new Date(rows.at(-1)!.at + bucketMs) },
    ...(sessionDate ? { legendAccessory: <Text fg={colors.textMuted}>{sessionDate}</Text>, legendAccessoryWidth: sessionDate.length } : {}),
    remoteKind: "flow-tide",
    ...link,
  } : !session && props.loading ? { loading: true } : null;
  return (
    <DataTableView<FlowTideRow>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      columns={TIDE_COLUMNS}
      items={tableRows}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={tideKey}
      selection={{ kind: "id", selectedId, getId: tideKey, onChange: (id) => setSelected(id) }}
      onActivate={(row) => setSelected(tideKey(row))}
      renderCell={renderTideCell}
      selectedTextOverridesCellColor
      status={sessionStatus(props, "the session's net premium")}
      emptyStateTitle="No prints under these filters this session."
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={tableRows.length} tableColumns={TIDE_COLUMNS} query={query} chart={chart} />}
    />
  );
}

/** One name's session premium by expiry and strike, split by side. Enter opens the chain at that expiry. */
function FlowStrikesView(props: SessionViewProps & { symbol: string; onOpenChain: (row: FlowStrikeRow) => void }) {
  const { focused, width, height, query, session } = props;
  const [sort, setSort] = usePluginPaneState<{ column: FlowStrikeSort | null; direction: "asc" | "desc" }>(
    "flow:strike-sort", { column: null, direction: "desc" });
  const rows = useMemo(() => sortFlowStrikes(flowStrikeRows(session), sort.column, sort.direction), [session, sort]);
  const columns = useMemo(() => fitChartTableColumns(STRIKE_COLUMNS, width, STRIKE_DROP_ORDER), [width]);
  const [selected, setSelected] = usePluginPaneState<string | null>("flow:strike", null);
  const selectedId = rows.some((row) => row.id === selected) ? selected : rows[0]?.id ?? null;
  return (
    <>
      {query}
      <DataTableView<FlowStrikeRow, DataTableColumn & { id: FlowStrikeSort }>
        focused={focused}
        rootWidth={width}
        rootHeight={Math.max(2, height - 1)}
        columns={columns}
        items={rows}
        sortColumnId={sort.column}
        sortDirection={sort.direction}
        onHeaderClick={(column) => setSort((current) => ({
          column: column as FlowStrikeSort,
          direction: current.column === column && current.direction === "desc" ? "asc" : "desc",
        }))}
        getItemKey={strikeKey}
        selection={{ kind: "id", selectedId, getId: strikeKey, onChange: (id) => setSelected(id) }}
        onActivate={props.onOpenChain}
        renderCell={renderStrikeCell}
        selectedTextOverridesCellColor
        status={sessionStatus(props, `${props.symbol} strikes`)}
        emptyStateTitle={`No ${props.symbol} prints under these filters this session.`}
      />
    </>
  );
}

export default FlowPane;
