import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataTableStackView,
  DataTableView,
  EmptyState, PaneStatusBody, StatGrid,
  usePaneMenuItems,
  type DataTableCell,
  type DataTableKeyEvent,
  type PaneFooterSegment
} from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { TextAttributes } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { cycleSortPreference } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { loadCdsActivity, type CdsActivityLoader } from "./client";
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
  nextSort,
  resolveIssuerQuery,
  sortIssuers,
  sortTrades,
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
const renderTradeRow = (
  trade: CdsTrade,
  column: TradeColumn,
  _index: number,
  state: { selected: boolean },
) => renderTradeCell(trade, column, state.selected);

function renderTradeCell(row: CdsTrade, column: TradeColumn, selected: boolean): DataTableCell {
  const selectedColor = selected ? colors.selectedText : undefined;
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
}) {
  const columns = useMemo(() => buildTradeColumns(width), [width]);
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

interface CdsPaneProps extends PaneProps {
  /** Injected by tests so the pane renders without the cloud backend. */
  loadActivity?: CdsActivityLoader;
}

export function CdsPane({
  paneId,
  focused,
  width,
  height,
  loadActivity = loadCdsActivity,
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

  // Refresh answers in every state, including the failed load that mounts no table.
  useShortcut((event) => {
    if (!isPlainKey(event, "r")) return;
    event.preventDefault();
    load();
  }, { enabled: focused });

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
    loading: status === "loading",
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
    const resolved = (
      <StatGrid items={[{ id: "issuer", label: "Issuer", value: activity.issuer ?? issuerQuery }]} width={width} />
    );
    return (
      <CdsTradeTable
        trades={visibleTrades}
        focused={focused}
        width={width}
        height={height}
        sort={tradeSort}
        onSort={(columnId) => setTradeSort((current) => nextSort(current, columnId, DEFAULT_TRADE_SORT))}
        selectedId={selectedTradeId}
        onSelect={setSelectedTradeId}
        onKeyDown={handleTradeKey}
        before={resolved}
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
          sort={tradeSort}
          onSort={(columnId) => setTradeSort((current) => nextSort(current, columnId, DEFAULT_TRADE_SORT))}
          selectedId={selectedTradeId}
          onSelect={setSelectedTradeId}
          onKeyDown={handleTradeKey}
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
        nextSort(current, columnId as IssuerColumnId, DEFAULT_ISSUER_SORT)
      ))}
      getItemKey={issuerKey}
      renderCell={renderIssuerRow}
      emptyStateTitle={error ? "CDS activity unavailable." : "No reported single-name CDS trades."}
    />
  );
}
