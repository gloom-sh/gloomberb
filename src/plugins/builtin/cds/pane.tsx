import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChartTableHeader,
  DataTableStackView,
  DataTableView,
  EmptyState, formatBpAxis, PaneStatusBody, spanAxisFormatter, staticSeries,
  useChartTableSelection,
  usePaneMenuItems,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableKeyEvent,
  type PaneFooterSegment,
  type StatItem
} from "../../../components";
import type { CloudCdsHistoryPointPayload } from "../../../api-client";
import { signedMoveColor } from "../../../components/market-board";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneSettingValue } from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { TextAttributes } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { cycleSortPreference, nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { deriveHeadlessFreshness, paneStatusLineVariants } from "../../../cli/pane-functions/freshness";
import {
  CDS_TRADE_DAYS,
  loadCdsActivity,
  loadCdsSpreadHistory,
  loadCdsSpreadLevels,
  type CdsActivityLoader,
  type CdsSpreadHistory,
  type CdsSpreadHistoryLoader,
  type CdsSpreadLevelsLoader,
} from "./client";
import {
  DEFAULT_ISSUER_SORT,
  DEFAULT_TRADE_SORT,
  ISSUER_SORT_COLUMN_IDS,
  buildIssuerColumns,
  buildTradeColumns,
  cdsFreshness,
  formatBp,
  formatEventTime,
  formatMaturity,
  formatNotional,
  formatPoints,
  formatQuoted,
  formatQuotedMove,
  formatUpfront,
  hasPointsQuotes,
  issuerListSort,
  lastTradeOf,
  noLevelMessage,
  noTradesMessage,
  resolveIssuerQuery,
  sortIssuers,
  sortTrades,
  quotedLevel,
  quotedPoints,
  spreadChartPoints,
  spreadFigures,
  summarizeIssuers,
  tradeSortColumnIds,
  tradesForIssuer,
  withSpreadLevels,
  type CdsIssuerSummary,
  type CdsQuoteUnit,
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
): DataTableCell {
  switch (column.id) {
    case "issuer":
      return {
        text: row.issuer,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "trades":
      return { text: String(row.trades), color: colors.text };
    case "last":
      return { text: formatEventTime(row.lastTradeAt), color: colors.textMuted };
    case "spread": {
      const { unit, level } = quotedLevel(row);
      return { text: formatQuoted(unit, level), color: level == null ? colors.textDim : colors.text };
    }
    case "1w":
      return moveCell(quotedLevel(row).unit, quotedLevel(row).change1w);
    case "1m":
      return moveCell(quotedLevel(row).unit, quotedLevel(row).change1m);
  }
}

/**
 * A 1W or 1M move as the index board draws one: wider (more points upfront)
 * is adverse, and a move that prints as 0.0 is not coloured.
 */
function moveCell(unit: CdsQuoteUnit, value: number | null): DataTableCell {
  const shown = value == null ? null : Number(value.toFixed(1));
  return { text: formatQuotedMove(unit, value), color: signedMoveColor(shown, "up", colors) };
}

// Table-shaped adapters live at module level so memoized rows keep their
// identity between pane renders.
const issuerKey = (row: CdsIssuerSummary) => row.key;
const tradeKey = (trade: CdsTrade) => trade.id;
/**
 * Trades on another contract than the one the 5Y line follows are dimmed, so
 * the headline, the line and the bright rows describe the same instrument.
 */
function renderTradeCell(row: CdsTrade, column: TradeColumn, lineMaturity: string | null): DataTableCell {
  const dimmed = lineMaturity && row.maturity !== lineMaturity ? colors.textDim : undefined;
  switch (column.id) {
    case "time":
      return { text: formatEventTime(row.eventAt), color: dimmed ?? colors.textMuted };
    case "maturity":
      return { text: formatMaturity(row.maturity), color: dimmed ?? colors.text };
    case "notional":
      return { text: formatNotional(row), color: dimmed ?? colors.textBright };
    case "currency":
      return { text: row.currency ?? "--", color: dimmed ?? colors.textDim };
    case "coupon":
      return { text: formatBp(row.couponBp), color: dimmed ?? colors.text };
    case "spread":
      return {
        text: formatBp(row.spreadBp),
        color: dimmed ?? (row.spreadBp == null ? colors.textDim : colors.textBright),
      };
    case "points":
      return {
        text: formatPoints(row.pointsUpfront),
        color: dimmed ?? (row.pointsUpfront == null ? colors.textDim : colors.textBright),
      };
    case "upfront":
      return {
        text: formatUpfront(row),
        color: dimmed ?? (row.upfront == null ? colors.textDim : colors.text),
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
  emptyMessage,
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
  /** What an empty table says: the window and the name searched. */
  emptyMessage: string;
}) {
  const points = hasPointsQuotes(trades);
  const columns = useMemo(() => buildTradeColumns(width, points), [points, width]);
  const renderTradeRow = useCallback((trade: CdsTrade, column: TradeColumn) => (
    renderTradeCell(trade, column, lineMaturity)
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
      selectedTextOverridesCellColor
      emptyStateTitle={emptyMessage}
    />
  );
}

/** Points upfront on the chart's axis: `58pts`, `57.6pts`. */
const formatPointsAxis = spanAxisFormatter((value, digits) => `${value.toFixed(digits)}pts`);

const NO_TRADES: CdsTrade[] = [];
const NO_ISSUERS: CdsIssuerSummary[] = [];
const NO_POINTS: CloudCdsHistoryPointPayload[] = [];
const NO_LINE: CdsSpreadHistory = {
  issuer: null,
  points: NO_POINTS,
  change1W: null,
  change1M: null,
  quote: "spread",
  couponBp: null,
  upfrontPts: null,
  change1WPts: null,
  change1MPts: null,
  noLevelReason: null,
};
/**
 * The 5Y line has one point per New York trade date, dated at UTC midnight, so
 * a trade's cursor is its New York day, not its time: an afternoon print would
 * otherwise snap to the next day's point.
 */
const tradeDate = (trade: CdsTrade) =>
  new Date(`${new Date(trade.eventAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" })}T00:00:00Z`);

/**
 * The issuer's figures, then its 5Y line over the trades, sized by the chart
 * table layout. The selected trade is the chart's cursor. A name without a
 * level says why in the chart's band, when the server can say.
 */
function IssuerHeader({ issuer, line, trades, width, height, focused, loading, selectedId, onSelect }: {
  /** Left out in the stack detail, whose title already names the issuer. */
  issuer?: string;
  line: CdsSpreadHistory;
  trades: readonly CdsTrade[];
  width: number;
  height: number;
  focused: boolean;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // The level and its moves, as the index board heads its detail, then whose
  // spread it is and the range: in a short pane the figures at the end give
  // way. While the history loads the level holds its place, so the trades do
  // not move when it lands.
  const { points } = line;
  // A name quoted upfront charts in points, as its figures read.
  const unit: CdsQuoteUnit = line.quote === "upfront" && line.upfrontPts != null ? "pts" : "bp";
  const charted = useMemo(() => unit === "pts" ? quotedPoints(line) : points.map((point) => ({ date: point.date, value: point.spreadBp })), [line, points, unit]);
  const shown = loading && !points.length
    ? [{ id: "spread", label: "5Y spread", value: "--" }]
    : spreadFigures(line);
  const why = !points.length ? noLevelMessage(line.noLevelReason, null) : null;
  const moves = shown.filter((item) => item.id === "spread" || item.id === "1w" || item.id === "1m");
  const figures: StatItem[] = [
    ...moves,
    ...(issuer ? [{ id: "issuer", label: "Issuer", value: issuer }] : []),
    ...shown.filter((item) => !moves.includes(item)),
  ];
  const series = useMemo(() => [staticSeries(spreadChartPoints(charted), {
    id: "cds-5y", label: unit === "pts" ? "5Y upfront" : "5Y spread", color: colors.positive, calendarSpaced: true,
  })], [charted, unit]);
  const link = useChartTableSelection({
    rows: trades, getId: tradeKey, getDate: tradeDate,
    selectedId: selectedId && trades.some((trade) => trade.id === selectedId) ? selectedId : trades[0]?.id ?? null,
    onSelect, focused,
  });
  return (
    <ChartTableHeader width={width} height={height} tableRows={trades.length} figures={figures}
      tableColumns={buildTradeColumns(width, hasPointsQuotes(trades))}
      chart={points.length >= 2 || loading || why ? {
        series,
        formatValue: (value: number) => formatQuoted(unit, value),
        formatAxisValue: unit === "pts" ? formatPointsAxis : formatBpAxis,
        remoteKind: "cds-spread-history", loading, ...link,
        ...(why ? { empty: why } : {}),
      } : null} />
  );
}

interface CdsPaneProps extends PaneProps {
  /** Injected by tests so the pane renders without the cloud backend. */
  loadActivity?: CdsActivityLoader;
  loadHistory?: CdsSpreadHistoryLoader;
  loadLevels?: CdsSpreadLevelsLoader;
}

/**
 * The line `fn CDS` and `shot CDS` end with, from the same declaration:
 * `Source: DTCC · last trade 2026-10-09 · lag 2 days`.
 */
function cdsStatusSegments(lastTrade: number | string | null): PaneFooterSegment[] {
  if (lastTrade == null) return [];
  const freshness = deriveHeadlessFreshness({ shape: "rows" }, { rows: [], freshness: cdsFreshness(lastTrade) });
  const [line, ...shorter] = paneStatusLineVariants(freshness).map((text) => [{ text, tone: "muted" as const }]);
  return [{ id: "cds-freshness", asOf: true, parts: line!, variants: shorter }];
}

export function CdsPane({
  paneId,
  focused,
  width,
  height,
  loadActivity = loadCdsActivity,
  loadHistory = loadCdsSpreadHistory,
  loadLevels = loadCdsSpreadLevels,
}: CdsPaneProps) {
  const { symbol, ticker } = usePaneTickerIdentity();
  const issuerQuery = useMemo(() => resolveIssuerQuery(symbol, ticker), [symbol, ticker]);

  // `CDS --sort 1m` (and its shot) opens the list on that order; the headers re-sort it from there, and a reload keeps theirs.
  const [openingSort] = usePaneSettingValue<string>("sort", "trades");
  const openingIssuerSort = useMemo(() => issuerListSort(openingSort), [openingSort]);
  const [issuerSort, setIssuerSort] = usePluginPaneState<IssuerSortPreference>("issuerSort", openingIssuerSort);
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
  const summaries = useMemo(() => (issuerQuery ? NO_ISSUERS : summarizeIssuers(trades)), [issuerQuery, trades]);
  // Every listed issuer's latest 5Y level, one request beside the trades, so the list ranks by it as `fn CDS` does.
  const loadLevelsRef = useRef(loadLevels);
  loadLevelsRef.current = loadLevels;
  const levelsRequest = useCallback(() => loadLevelsRef.current(), []);
  const levels = useAsyncResource(issuerQuery ? null : levelsRequest);
  useAutoRefresh(levels.updatedAt, levels.load);
  const issuers = useMemo(
    () => (issuerQuery ? [] : sortIssuers(withSpreadLevels(summaries, levels.data), issuerSort)),
    [issuerQuery, issuerSort, levels.data, summaries],
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
  const spreadLine = history.data ?? NO_LINE;
  const spreadPoints = spreadLine.points;
  // The band holds its rows while the first history loads, so the trades do not jump.
  const historyLoading = !!historyIssuer && history.loading && !history.data;
  const lineMaturity = spreadPoints.at(-1)?.maturity ?? null;
  // A level older than the prints after it says why those prints set none; with no level at all the chart band says it.
  const staleLevel = spreadPoints.length ? noLevelMessage(spreadLine.noLevelReason, spreadPoints.at(-1)!.date) : null;
  // Without it a failed request reads as a name with no 5Y line.
  usePaneNoticeFooter({
    registrationId: `${paneId}:cds-history`,
    focused,
    notices: [
      ...(historyIssuer && history.error && !history.data ? ["5Y spread history unavailable."] : []),
      ...(historyIssuer && staleLevel ? [`${staleLevel}.`] : []),
      ...(summaries.length && levels.error && !levels.data ? ["5Y spreads unavailable."] : []),
    ],
  });

  useEffect(() => {
    if (issuerQuery) return;
    if (selectedIssuerKey && issuers.some((row) => row.key === selectedIssuerKey)) return;
    setSelectedIssuerKey(issuers[0]?.key ?? null);
    setDetailOpen(false);
  }, [issuerQuery, issuers, selectedIssuerKey]);

  const tradePoints = hasPointsQuotes(visibleTrades);
  const cycleTradeSort = useCallback((step: 1 | -1) => {
    setTradeSort((current) => {
      const next = cycleSortPreference<TradeColumnId>(tradeSortColumnIds(tradePoints), current, step);
      return { columnId: next.columnId ?? DEFAULT_TRADE_SORT.columnId, direction: next.direction };
    });
  }, [tradePoints]);
  const cycleIssuerSort = useCallback((step: 1 | -1) => {
    setIssuerSort((current) => {
      const next = cycleSortPreference<IssuerColumnId>(ISSUER_SORT_COLUMN_IDS, current, step);
      return { columnId: next.columnId ?? DEFAULT_ISSUER_SORT.columnId, direction: next.direction };
    });
  }, []);

  usePaneRefreshKey(() => {
    load();
    if (!issuerQuery) levels.load();
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

  // Dated by the last trade of what is in front: the issuer's, or the whole tape's.
  const lastTrade = tradesInFront
    ? lastTradeOf(visibleTrades, spreadPoints)
    : activity ? lastTradeOf(trades) : null;
  const footerInfo = useMemo(() => cdsStatusSegments(lastTrade), [lastTrade]);
  usePaneStatusFooter({
    registrationId: paneId,
    loading: status === "loading"
      || (!!historyIssuer && history.loading && !history.data)
      || (!issuerQuery && levels.loading && !levels.data),
    error,
    info: footerInfo,
  });
  const emptyMessage = noTradesMessage({
    query: issuerQuery ? activity?.query ?? issuerQuery : selectedSummary?.issuer ?? null,
    issuer: issuerQuery ? activity?.issuer ?? null : selectedSummary?.issuer ?? null,
    days: activity?.days ?? CDS_TRADE_DAYS,
    // A name the covered issuers do not have, once the tape has neither trades nor a line under it.
    unmatched: issuerQuery && activity?.unmatched && !trades.length && history.data && !history.data.issuer ? activity.unmatched : null,
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
      <IssuerHeader issuer={activity.issuer ?? issuerQuery} line={spreadLine} trades={visibleTrades}
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
        emptyMessage={emptyMessage}
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
          before={spreadPoints.length || historyLoading || spreadLine.noLevelReason ? (
            <IssuerHeader line={spreadLine} trades={visibleTrades} width={width}
              height={Math.max(0, height - 1)} focused={focused && detailOpen} loading={historyLoading}
              selectedId={selectedTradeId} onSelect={setSelectedTradeId} />
          ) : undefined}
          sort={tradeSort}
          onSort={(columnId) => setTradeSort((current) => nextHeaderSort(current, columnId, { resetTo: DEFAULT_TRADE_SORT }))}
          selectedId={selectedTradeId}
          onSelect={setSelectedTradeId}
          onKeyDown={handleTradeKey}
          lineMaturity={lineMaturity}
          emptyMessage={emptyMessage}
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
      renderCell={renderIssuerCell}
      selectedTextOverridesCellColor
      emptyStateTitle={error ? "CDS activity unavailable." : emptyMessage}
    />
  );
}
