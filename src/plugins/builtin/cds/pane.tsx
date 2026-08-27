import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataTableStackView,
  DataTableView,
  EmptyState,
  Spinner,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { cycleSortPreference } from "../../../utils/sort-values";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { loadCdsActivity, type CdsActivity, type CdsActivityLoader } from "./client";
import {
  buildIssuerColumns,
  buildTradeColumns,
  DEFAULT_ISSUER_SORT,
  DEFAULT_TRADE_SORT,
  formatAsOf,
  formatBp,
  formatEventTime,
  formatMaturity,
  formatNotional,
  formatUpfront,
  ISSUER_SORT_COLUMN_IDS,
  nextSort,
  resolveIssuerQuery,
  sortIssuers,
  sortTrades,
  summarizeIssuers,
  TRADE_SORT_COLUMN_IDS,
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
      getItemKey={(trade) => trade.id}
      renderCell={(trade, column, _index, state) => renderTradeCell(trade, column, state.selected)}
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
  const { symbol, ticker } = usePaneTicker();
  const issuerQuery = useMemo(() => resolveIssuerQuery(symbol, ticker), [symbol, ticker]);

  const [activity, setActivity] = useState<CdsActivity | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [issuerSort, setIssuerSort] = useState<IssuerSortPreference>(DEFAULT_ISSUER_SORT);
  const [tradeSort, setTradeSort] = useState<TradeSortPreference>(DEFAULT_TRADE_SORT);
  const [selectedIssuerKey, setSelectedIssuerKey] = useState<string | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const generation = useRef(0);
  // Held in a ref so an inline loader prop cannot turn every render into a fetch.
  const loadActivityRef = useRef(loadActivity);
  loadActivityRef.current = loadActivity;

  const load = useCallback(() => {
    generation.current += 1;
    const current = generation.current;
    setStatus((previous) => (previous === "loaded" ? "loaded" : "loading"));
    setError(null);
    loadActivityRef.current(issuerQuery)
      .then((next) => {
        if (generation.current !== current) return;
        setActivity(next);
        setStatus("loaded");
        setFetchedAt(Date.now());
      })
      .catch((loadError: unknown) => {
        if (generation.current !== current) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [issuerQuery]);

  useEffect(() => { load(); }, [load]);
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

  const handleKey = useCallback((event: DataTableKeyEvent, cycle: (step: 1 | -1) => void): boolean => {
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      load();
      return true;
    }
    if (isPlainKey(event, "]", "[")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycle(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, [load]);
  const handleIssuerKey = useCallback(
    (event: DataTableKeyEvent) => handleKey(event, cycleIssuerSort),
    [cycleIssuerSort, handleKey],
  );
  const handleTradeKey = useCallback(
    (event: DataTableKeyEvent) => handleKey(event, cycleTradeSort),
    [cycleTradeSort, handleKey],
  );

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
      <Box width={width} height={height} justifyContent="center" alignItems="center">
        <Spinner label="Loading CDS activity..." />
      </Box>
    );
  }
  if (!activity) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column">
        {/* The reason lives in the footer, so the body never repeats it. */}
        <EmptyState title="CDS activity unavailable." />
      </Box>
    );
  }

  if (issuerQuery) {
    // The pane title already carries the ticker, so the body leads with the
    // issuer name the backend was actually queried for, which is the expanded
    // company name once instrument search has resolved a bare symbol.
    const resolved = (
      <Box height={1} paddingX={1}>
        <Text fg={colors.textMuted} wrapMode="ellipsis">
          {`${activity.issuer ?? issuerQuery} · ${activity.source}`}
        </Text>
      </Box>
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

  const issuerColumns = buildIssuerColumns(width);
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
      getItemKey={(row) => row.key}
      renderCell={(row, column, _index, state) => renderIssuerCell(row, column, state.selected)}
      emptyStateTitle={error ? "CDS activity unavailable." : "No reported single-name CDS trades."}
    />
  );
}
