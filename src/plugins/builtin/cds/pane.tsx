import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChartTableHeader,
  DataTableStackView,
  DataTableView,
  EmptyState, formatBpAxis, PaneStatusBody, staticSeries,
  useChartTableSelection,
  usePaneMenuItems,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableKeyEvent,
  type PaneFooterSegment,
  type StatItem
} from "../../../components";
import type { CloudCdsHistoryPointPayload } from "../../../api-client";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { TextAttributes } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { cycleSortPreference, nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import {
  loadCdsActivity,
  loadCdsSpreadHistory,
  type CdsActivityLoader,
  type CdsSpreadHistoryLoader,
} from "./client";
import {
  DEFAULT_ISSUER_SORT,
  DEFAULT_TRADE_SORT,
  ISSUER_SORT_COLUMN_IDS,
  TRADE_SORT_COLUMN_IDS,
  buildIssuerColumns,
  buildTradeColumns,
  formatAsOf,
  formatBp,
  formatEventTime,
  formatMaturity,
  formatNotional,
  formatUpfront,
  resolveIssuerQuery,
  sortIssuers,
  sortTrades,
  spreadChartPoints,
  spreadFigures,
  summarizeIssuers,
  tradesForIssuer,
  type CdsIssuerSummary,
  type CdsTrade,
  type IssuerColumn,
  type IssuerColumnId,
  type IssuerSortPreference,
  type TradeColumn,
  type TradeColumnId,
  type TradeSortPreference,
} from "./model";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

function renderIssuerCell(
  row: CdsIssuerSummary,
  column: IssuerColumn,
  selected: boolean,
): DataTableCell {
  const selectedColor = selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "issuer":
      return {
        text: row.issuer,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "trades":
      return { text: String(row.trades), color: selectedColor ?? colors.text };
    case "last":
      return { text: formatEventTime(row.lastTradeAt), color: selectedColor ?? colors.textMuted };
    case "spread":
      return {
        text: formatBp(row.latestSpreadBp),
        color: selectedColor ?? (row.latestSpreadBp == null ? colors.textDim : colors.text),
      };
  }
}

// Table-shaped adapters live at module level so memoized rows keep their
// identity between pane renders.
const issuerKey = (row: CdsIssuerSummary) => row.key;
const tradeKey = (trade: CdsTrade) => trade.id;
const renderIssuerRow = (
  row: CdsIssuerSummary,
  column: IssuerColumn,
  _index: number,
  state: { selected: boolean },
) => renderIssuerCell(row, column, state.selected);
/**
 * Trades on another contract than the one the 5Y line follows are dimmed, so
 * the headline, the line and the bright rows describe the same instrument.
 */
function renderTradeCell(row: CdsTrade, column: TradeColumn, selected: boolean, lineMaturity: string | null): DataTableCell {
  const selectedColor = selected
    ? colors.selectedText
    : lineMaturity && row.maturity !== lineMaturity ? colors.textDim : undefined;
  switch (column.id) {
    case "time":
      return { text: formatEventTime(row.eventAt), color: selectedColor ?? colors.textMuted };
    case "maturity":
      return { text: formatMaturity(row.maturity), color: selectedColor ?? colors.text };
    case "notional":
      return { text: formatNotional(row), color: selectedColor ?? colors.textBright };
    case "currency":
      return { text: row.currency ?? "--", color: selectedColor ?? colors.textDim };
    case "coupon":
      return { text: formatBp(row.couponBp), color: selectedColor ?? colors.text };
    case "spread":
      return {
        text: formatBp(row.spreadBp),
        color: selectedColor ?? (row.spreadBp == null ? colors.textDim : colors.textBright),
      };
    case "upfront":
      return {
        text: formatUpfront(row),
        color: selectedColor ?? (row.upfront == null ? colors.textDim : colors.text),
      };
  }
}

function CdsTradeTable({
  trades,
  focused,
  width,
  height,
  sort,
  onSort,
  selectedId,
  onSelect,
  onKeyDown,
  before,
  lineMaturity = null,
}: {
  trades: CdsTrade[];
  focused: boolean;
  width: number;
  height?: number;
  sort: TradeSortPreference;
  onSort: (columnId: TradeColumnId) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onKeyDown: (event: DataTableKeyEvent) => boolean;
  before?: ReactNode;
  /** The contract the 5Y line follows today. */
  lineMaturity?: string | null;
}) {
  const columns = useMemo(() => buildTradeColumns(width), [width]);
  const renderTradeRow = useCallback((trade: CdsTrade, column: TradeColumn, _index: number, state: { selected: boolean }) => (
    renderTradeCell(trade, column, state.selected, lineMaturity)
  ), [lineMaturity]);
  return (
    <DataTableView<CdsTrade, TradeColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={before}
      selection={{
        kind: "id",
        selectedId,
        getId: (trade) => trade.id,
        onChange: (id) => onSelect(id),
      }}
      onRootKeyDown={onKeyDown}
      columns={columns}
      items={trades}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => onSort(columnId as TradeColumnId)}
      getItemKey={tradeKey}
      renderCell={renderTradeRow}
      emptyStateTitle="No reported trades."
    />
  );
}

const NO_TRADES: CdsTrade[] = [];
const NO_POINTS: CloudCdsHistoryPointPayload[] = [];
/**
 * The 5Y line has one point per New York trade date, dated at UTC midnight, so
 * a trade's cursor is its New York day, not its time: an afternoon print would
 * otherwise snap to the next day's point.
 */
const tradeDate = (trade: CdsTrade) =>
  new Date(`${new Date(trade.eventAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" })}T00:00:00Z`);

/**
 * The issuer's figures, then its 5Y line over the trades, sized by the chart
 * table layout. The selected trade is the chart's cursor.
 */
function IssuerHeader({ issuer, points, trades, width, height, focused, loading, selectedId, onSelect }: {
  /** Left out in the stack detail, whose title already names the issuer. */
  issuer?: string;
  points: readonly CloudCdsHistoryPointPayload[];
  trades: readonly CdsTrade[];
  width: number;
  height: number;
  focused: boolean;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // The level, then whose spread it is: in a short pane the figures at the end
  // give way. While the history loads the level holds its place, so the trades
  // do not move when it lands.
  const [level, ...rest] = loading && !points.length
    ? [{ id: "spread", label: "5Y spread", value: "--" }]
    : spreadFigures(points);
  const figures: StatItem[] = [
    ...(level ? [level] : []),
    ...(issuer ? [{ id: "issuer", label: "Issuer", value: issuer }] : []),
    ...rest,
  ];
  const series = useMemo(() => [staticSeries(spreadChartPoints(points), {
    id: "cds-5y", label: "5Y spread", color: colors.positive, calendarSpaced: true,
  })], [points]);
  const link = useChartTableSelection({
    rows: trades, getId: tradeKey, getDate: tradeDate,
    selectedId: selectedId && trades.some((trade) => trade.id === selectedId) ? selectedId : trades[0]?.id ?? null,
    onSelect, focused,
  });
  return (
    <ChartTableHeader width={width} height={height} tableRows={trades.length} figures={figures}
      tableColumns={buildTradeColumns(width)}
      chart={points.length >= 2 || loading ? {
        series, formatValue: formatBp, formatAxisValue: formatBpAxis, remoteKind: "cds-spread-history", loading, ...link,
      } : null} />
  );
}

interface CdsPaneProps extends PaneProps {
  /** Injected by tests so the pane renders without the cloud backend. */
  loadActivity?: CdsActivityLoader;
  loadHistory?: CdsSpreadHistoryLoader;
}

export function CdsPane({
  paneId,
  focused,
  width,
  height,
  loadActivity = loadCdsActivity,
  loadHistory = loadCdsSpreadHistory,
}: CdsPaneProps) {
  const { symbol, ticker } = usePaneTickerIdentity();
  const issuerQuery = useMemo(() => resolveIssuerQuery(symbol, ticker), [symbol, ticker]);

  const [issuerSort, setIssuerSort] = useState<IssuerSortPreference>(DEFAULT_ISSUER_SORT);
  const [tradeSort, setTradeSort] = useState<TradeSortPreference>(DEFAULT_TRADE_SORT);
  // Selection and the open issuer live in pane state so a reload or a shared
  // layout comes back to the same row.
  const [selectedIssuerKey, setSelectedIssuerKey] = usePluginPaneState<string | null>("selectedIssuerKey", null);
  const [selectedTradeId, setSelectedTradeId] = usePluginPaneState<string | null>("selectedTradeId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState("detailOpen", false);
  // Held in a ref so an inline loader prop cannot turn every render into a fetch.
  const loadActivityRef = useRef(loadActivity);
  loadActivityRef.current = loadActivity;

  const request = useCallback(() => loadActivityRef.current(issuerQuery), [issuerQuery]);
  const { data: activity, status, error, updatedAt: fetchedAt, load } = useAsyncResource(request);
  useAutoRefresh(fetchedAt, load);

  const trades = activity?.trades ?? NO_TRADES;
  const issuers = useMemo(
    () => (issuerQuery ? [] : sortIssuers(summarizeIssuers(trades), issuerSort)),
    [issuerQuery, issuerSort, trades],
  );
  const visibleTrades = useMemo(() => sortTrades(
    issuerQuery ? trades : selectedIssuerKey ? tradesForIssuer(trades, selectedIssuerKey) : [],
    tradeSort,
  ), [issuerQuery, selectedIssuerKey, tradeSort, trades]);
  const selectedSummary = issuers.find((row) => row.key === selectedIssuerKey) ?? null;

  // The 5Y line follows the name the tape was queried for: the resolved company
  // for a bound ticker, the open row in the market-wide list.
  const historyIssuer = issuerQuery
    ? activity?.issuer ?? null
    : detailOpen && selectedSummary ? selectedSummary.issuer : null;
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;
  const historyRequest = useCallback(() => loadHistoryRef.current(historyIssuer!), [historyIssuer]);
  const history = useAsyncResource(historyIssuer ? historyRequest : null);
  useAutoRefresh(history.updatedAt, history.load);
  const spreadPoints = history.data?.points ?? NO_POINTS;
  // The band holds its rows while the first history loads, so the trades do not jump.
  const historyLoading = !!historyIssuer && history.loading && !history.data;
  const lineMaturity = spreadPoints.at(-1)?.maturity ?? null;
  // Without it a failed request reads as a name with no 5Y line.
  usePaneNoticeFooter({
    registrationId: `${paneId}:cds-history`,
    focused,
    notices: historyIssuer && history.error && !history.data ? ["5Y spread history unavailable."] : [],
  });

  useEffect(() => {
    if (issuerQuery) return;
    if (selectedIssuerKey && issuers.some((row) => row.key === selectedIssuerKey)) return;
    setSelectedIssuerKey(issuers[0]?.key ?? null);
    setDetailOpen(false);
  }, [issuerQuery, issuers, selectedIssuerKey]);

  const cycleTradeSort = useCallback((step: 1 | -1) => {
    setTradeSort((current) => {
      const next = cycleSortPreference<TradeColumnId>(TRADE_SORT_COLUMN_IDS, current, step);
      return { columnId: next.columnId ?? DEFAULT_TRADE_SORT.columnId, direction: next.direction };
    });
  }, []);
  const cycleIssuerSort = useCallback((step: 1 | -1) => {
    setIssuerSort((current) => {
      const next = cycleSortPreference<IssuerColumnId>(ISSUER_SORT_COLUMN_IDS, current, step);
      return { columnId: next.columnId ?? DEFAULT_ISSUER_SORT.columnId, direction: next.direction };
    });
  }, []);

  usePaneRefreshKey(() => {
    load();
    if (historyIssuer) history.load();
  }, { focused });

  const handleKey = useCallback((event: DataTableKeyEvent, cycle: (step: 1 | -1) => void): boolean => {
    if (isPlainKey(event, "]", "[")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycle(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, []);
  const handleIssuerKey = useCallback(
    (event: DataTableKeyEvent) => handleKey(event, cycleIssuerSort),
    [cycleIssuerSort, handleKey],
  );
  const handleTradeKey = useCallback(
    (event: DataTableKeyEvent) => handleKey(event, cycleTradeSort),
    [cycleTradeSort, handleKey],
  );
  // The pane menu names the sort keys for whichever table is in front.
  const tradesInFront = !!issuerQuery || (detailOpen && !!selectedSummary);
  const hasActivity = !!activity;
  usePaneMenuItems("cds:sort-keys", () => !hasActivity ? null : [
    { id: "sort-next", label: "Next Sort Column", accelerator: "]",
      onSelect: () => (tradesInFront ? cycleTradeSort : cycleIssuerSort)(1) },
    { id: "sort-previous", label: "Previous Sort Column", accelerator: "[",
      onSelect: () => (tradesInFront ? cycleTradeSort : cycleIssuerSort)(-1) },
  ], [cycleIssuerSort, cycleTradeSort, hasActivity, tradesInFront]);

  const asOfLabel = formatAsOf(activity?.asOf ?? null);
  const footerInfo = useMemo<PaneFooterSegment[]>(() => [
    ...(asOfLabel ? [{ id: "as-of", parts: [{ text: `as of ${asOfLabel}`, tone: "muted" as const }] }] : []),
    ...(activity ? [{ id: "delayed", parts: [{ text: "delayed", tone: "muted" as const }] }] : []),
  ], [activity, asOfLabel]);
  usePaneStatusFooter({
    registrationId: paneId,
    loading: status === "loading" || (!!historyIssuer && history.loading && !history.data),
    error,
    info: footerInfo,
  });

  if (status === "loading" && !activity) {
    return (
      <PaneStatusBody loading align="center" width={width} height={height} loadingLabel="Loading CDS activity..." />
    );
  }
  if (!activity) {
    // The reason lives in the footer, so the body never repeats it.
    return <EmptyState title="CDS activity unavailable." />;
  }

  if (issuerQuery) {
    // The pane title already carries the ticker, so the body leads with the
    // issuer name the backend was actually queried for, which is the expanded
    // company name once instrument search has resolved a bare symbol.
    const header = (
      <IssuerHeader issuer={activity.issuer ?? issuerQuery} points={spreadPoints} trades={visibleTrades}
        width={width} height={height} focused={focused} loading={historyLoading}
        selectedId={selectedTradeId} onSelect={setSelectedTradeId} />
    );
    return (
      <CdsTradeTable
        trades={visibleTrades}
        focused={focused}
        width={width}
        height={height}
        sort={tradeSort}
        onSort={(columnId) => setTradeSort((current) => nextHeaderSort(current, columnId, { resetTo: DEFAULT_TRADE_SORT }))}
        selectedId={selectedTradeId}
        onSelect={setSelectedTradeId}
        onKeyDown={handleTradeKey}
        before={header}
        lineMaturity={lineMaturity}
      />
    );
  }

  const issuerColumns = buildIssuerColumns();
  return (
    <DataTableStackView<CdsIssuerSummary, IssuerColumn>
      focused={focused}
      detailOpen={detailOpen && !!selectedSummary}
      onBack={() => setDetailOpen(false)}
      detailTitle={selectedSummary?.issuer}
      detailContent={selectedSummary ? (
        <CdsTradeTable
          trades={visibleTrades}
          focused={focused && detailOpen}
          width={width}
          before={spreadPoints.length || historyLoading ? (
            <IssuerHeader points={spreadPoints} trades={visibleTrades} width={width}
              height={Math.max(0, height - 1)} focused={focused && detailOpen} loading={historyLoading}
              selectedId={selectedTradeId} onSelect={setSelectedTradeId} />
          ) : undefined}
          sort={tradeSort}
          onSort={(columnId) => setTradeSort((current) => nextHeaderSort(current, columnId, { resetTo: DEFAULT_TRADE_SORT }))}
          selectedId={selectedTradeId}
          onSelect={setSelectedTradeId}
          onKeyDown={handleTradeKey}
          lineMaturity={lineMaturity}
        />
      ) : null}
      onDetailKeyDown={handleTradeKey}
      rootWidth={width}
      rootHeight={height}
      selection={{
        kind: "id",
        selectedId: selectedIssuerKey,
        getId: (row) => row.key,
        onChange: (id) => setSelectedIssuerKey(id),
      }}
      onActivate={(row) => {
        setSelectedIssuerKey(row.key);
        setSelectedTradeId(null);
        setDetailOpen(true);
      }}
      onRootKeyDown={handleIssuerKey}
      columns={issuerColumns}
      items={issuers}
      sortColumnId={issuerSort.columnId}
      sortDirection={issuerSort.direction}
      onHeaderClick={(columnId) => setIssuerSort((current) => (
        nextHeaderSort(current, columnId as IssuerColumnId, { resetTo: DEFAULT_ISSUER_SORT })
      ))}
      getItemKey={issuerKey}
      renderCell={renderIssuerRow}
      emptyStateTitle={error ? "CDS activity unavailable." : "No reported single-name CDS trades."}
    />
  );
}
