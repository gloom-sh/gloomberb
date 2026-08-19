import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes } from "../../../ui";
import {
  DataTableView,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import type { TickerFinancials } from "../../../types/financials";
import type { PaneProps } from "../../../types/plugin";
import { usePaneInstance } from "../../../state/app/context";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { colors, priceColor } from "../../../theme/colors";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { formatCompact, formatCurrency, formatNumber, formatPercent, formatPercentRaw } from "../../../utils/format";
import { usePluginTickerActions } from "../../runtime";
import { handleRefreshKey, loadingErrorFooterInfo, useClampSelectedIndex } from "../shared/table-pane";
import { useBoundTicker as useSymbolBinding } from "../shared/ticker-request";

type RelativeColumnId = "symbol" | "price" | "change" | "marketCap" | "pe" | "forwardPe" | "evSales" | "fcfYield" | "revenueGrowth" | "margin";
type RelativeColumn = DataTableColumn & { id: RelativeColumnId };
type RelativeRow = {
  symbol: string;
  financials: TickerFinancials | null;
  error?: string;
};

function relativeSymbolsFromPane(symbol: string | null, paneSettings: Record<string, unknown> | undefined): string[] {
  const settingsSymbols = Array.isArray(paneSettings?.symbols)
    ? paneSettings.symbols.filter((value): value is string => typeof value === "string")
    : [];
  if (settingsSymbols.length > 0) return settingsSymbols;
  return symbol ? [symbol] : [];
}

function buildRelativeColumns(width: number): RelativeColumn[] {
  const symbolWidth = 8;
  const priceWidth = 10;
  const pctWidth = 8;
  const capWidth = 9;
  const metricWidth = 8;
  return [
    { id: "symbol", label: "TICKER", width: symbolWidth, align: "left" },
    { id: "price", label: "LAST", width: priceWidth, align: "right" },
    { id: "change", label: "CHG%", width: pctWidth, align: "right" },
    { id: "marketCap", label: "MCAP", width: capWidth, align: "right" },
    { id: "pe", label: "P/E", width: metricWidth, align: "right" },
    { id: "forwardPe", label: "FWD", width: metricWidth, align: "right" },
    { id: "evSales", label: "EV/S", width: metricWidth, align: "right" },
    { id: "fcfYield", label: "FCF%", width: metricWidth, align: "right" },
    { id: "revenueGrowth", label: "REV%", width: metricWidth, align: "right" },
    { id: "margin", label: "OP%", width: Math.max(metricWidth, width - symbolWidth - priceWidth - pctWidth - capWidth - metricWidth * 5 - 10), align: "right" },
  ];
}

interface RelativeSortPreference {
  columnId: RelativeColumnId;
  direction: SortDirection;
}

const DEFAULT_RELATIVE_SORT: RelativeSortPreference = { columnId: "marketCap", direction: "desc" };

function evSales(financials: TickerFinancials | null): number | undefined {
  const ev = financials?.fundamentals?.enterpriseValue;
  const revenue = financials?.fundamentals?.revenue;
  return ev != null && revenue ? ev / revenue : undefined;
}

function fcfYield(financials: TickerFinancials | null): number | undefined {
  const fcf = financials?.fundamentals?.freeCashFlow;
  const marketCap = financials?.quote?.marketCap;
  return fcf != null && marketCap ? fcf / marketCap : undefined;
}

function relativeSortValue(row: RelativeRow, columnId: RelativeColumnId): string | number | null {
  const quote = row.financials?.quote;
  const fundamentals = row.financials?.fundamentals;
  switch (columnId) {
    case "symbol":
      return row.symbol.toLocaleLowerCase();
    case "price":
      return quote?.price ?? null;
    case "change":
      return quote?.changePercent ?? null;
    case "marketCap":
      return quote?.marketCap ?? null;
    case "pe":
      return fundamentals?.trailingPE ?? null;
    case "forwardPe":
      return fundamentals?.forwardPE ?? null;
    case "evSales":
      return evSales(row.financials) ?? null;
    case "fcfYield":
      return fcfYield(row.financials) ?? null;
    case "revenueGrowth":
      return fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth ?? null;
    case "margin":
      return fundamentals?.operatingMargin ?? null;
  }
}

function sortRelativeRows(
  rows: readonly RelativeRow[],
  preference: RelativeSortPreference,
): RelativeRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => (
      compareSortValues(
        relativeSortValue(left.row, preference.columnId),
        relativeSortValue(right.row, preference.columnId),
        preference.direction,
      ) || left.index - right.index
    ))
    .map((entry) => entry.row);
}

export function RelativeValuationPane({ focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  const { symbol } = useSymbolBinding();
  const symbols = useMemo(
    () => relativeSymbolsFromPane(symbol, pane?.settings),
    [pane?.settings, symbol],
  );
  const { navigateTicker } = usePluginTickerActions();
  const [rows, setRows] = useState<RelativeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [sortPreference, setSortPreference] = useState<RelativeSortPreference>(DEFAULT_RELATIVE_SORT);
  const columns = useMemo(() => buildRelativeColumns(width), [width]);
  const fetchGenRef = useRef(0);

  const reload = useCallback((forceRefresh = false) => {
    if (symbols.length === 0) {
      setRows([]);
      setError("No tickers selected");
      return;
    }
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) {
      setRows([]);
      setError("Market data unavailable");
      return;
    }
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setError(null);
    // One batched snapshot request instead of one request per peer.
    coordinator.loadSnapshotsBatch(symbols.map((peer) => ({ symbol: peer })), { forceRefresh })
      .then((entries) => {
        if (fetchGenRef.current !== gen) return;
        setRows(symbols.map((peer, index) => {
          const entry = entries[index];
          return {
            symbol: peer,
            financials: entry?.data ?? entry?.lastGoodData ?? null,
            error: entry?.error?.message,
          };
        }));
      })
      .catch((err) => {
        if (fetchGenRef.current !== gen) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (fetchGenRef.current === gen) setLoading(false);
      });
  }, [symbols]);

  useEffect(() => {
    reload(false);
  }, [reload]);

  const sortedRows = useMemo(() => sortRelativeRows(rows, sortPreference), [rows, sortPreference]);

  useClampSelectedIndex(rows.length, selectedIdx, setSelectedIdx);

  const renderCell = useCallback((row: RelativeRow, column: RelativeColumn, _index: number, rowState: { selected: boolean }): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    const quote = row.financials?.quote;
    const fundamentals = row.financials?.fundamentals;
    switch (column.id) {
      case "symbol":
        return { text: row.symbol, color: selectedColor ?? (row.error ? colors.warning : colors.textBright), attributes: TextAttributes.BOLD };
      case "price":
        return { text: quote?.price != null ? formatCurrency(quote.price, quote.currency) : "-", color: selectedColor ?? colors.text };
      case "change":
        return { text: quote?.changePercent != null ? formatPercentRaw(quote.changePercent) : "-", color: selectedColor ?? priceColor(quote?.changePercent ?? 0) };
      case "marketCap":
        return { text: formatCompact(quote?.marketCap), color: selectedColor ?? colors.textDim };
      case "pe":
        return { text: formatNumber(fundamentals?.trailingPE, 1), color: selectedColor ?? colors.text };
      case "forwardPe":
        return { text: formatNumber(fundamentals?.forwardPE, 1), color: selectedColor ?? colors.text };
      case "evSales":
        return { text: formatNumber(evSales(row.financials), 1), color: selectedColor ?? colors.text };
      case "fcfYield":
        return { text: formatPercent(fcfYield(row.financials)), color: selectedColor ?? priceColor(fcfYield(row.financials) ?? 0) };
      case "revenueGrowth":
        return { text: formatPercent(fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth), color: selectedColor ?? priceColor(fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth ?? 0) };
      case "margin":
        return { text: formatPercent(fundamentals?.operatingMargin), color: selectedColor ?? colors.text };
    }
  }, []);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, () => reload(true), { stopPropagation: true });
  }, [reload]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => (
      current.columnId === columnId
        ? { columnId: current.columnId, direction: current.direction === "asc" ? "desc" : "asc" }
        : { columnId: columnId as RelativeColumnId, direction: columnId === "symbol" ? "asc" : "desc" }
    ));
  }, []);

  usePaneFooter("relative-valuation", () => ({
    info: loadingErrorFooterInfo(loading, error),
  }), [error, loading]);

  return (
    <DataTableView<RelativeRow, RelativeColumn>
      focused={focused}
      selection={{
        kind: "index",
        selectedIndex: rows.length > 0 ? selectedIdx : -1,
        onChange: (index) => setSelectedIdx(index),
      }}
      onActivate={(row) => navigateTicker(row.symbol)}
      onRootKeyDown={handleKeyDown}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={sortedRows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(row) => row.symbol}
      renderCell={renderCell}
      emptyStateTitle={loading ? "Loading peers..." : error ?? "No peers"}
    />
  );
}
