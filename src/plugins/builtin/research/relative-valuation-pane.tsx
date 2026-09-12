import { formatPriceEarnings } from "../../../utils/price-earnings";
import { describeFundamentalMarketCap } from "../../../utils/market-capitalization";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, TextAttributes } from "../../../ui";
import {
  DataTableView,
  Prose,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { useAppSelector, usePaneInstance } from "../../../state/app/context";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { colors, priceColor } from "../../../theme/colors";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { formatCompact, formatCurrency, formatNumber, formatPercent, formatPercentRaw } from "../../../utils/format";
import { usePluginTickerActions } from "../../runtime";
import { handleRefreshKey, loadingErrorFooterInfo, useClampSelectedIndex } from "../shared/table-pane";
import { useBoundTicker as useSymbolBinding } from "../shared/ticker-request";
import { useFxRatesMap } from "../../../market-data/hooks";
import { comparableMarketCap, relativeValuationValues } from "./relative-valuation-model";

type RelativeColumnId = "symbol" | "price" | "changePercent" | "marketCap" | "trailingPE" | "forwardPE" | "evSales" | "fcfYield" | "revenueGrowth" | "operatingMargin";
type RelativeColumn = DataTableColumn & { id: RelativeColumnId };
type RelativeRow = ReturnType<typeof relativeValuationValues> & {
  symbol: string;
  error?: string;
};

function relativeSymbolsFromPane(symbol: string | null, paneSettings: Record<string, unknown> | undefined): string[] {
  const settingsSymbols = Array.isArray(paneSettings?.symbols)
    ? paneSettings.symbols.filter((value): value is string => typeof value === "string")
    : [];
  if (settingsSymbols.length > 0) return settingsSymbols;
  return symbol ? [symbol] : [];
}

function buildRelativeColumns(width: number, baseCurrency: string): RelativeColumn[] {
  const symbolWidth = 8;
  const priceWidth = 10;
  const pctWidth = 8;
  const capWidth = 12;
  const metricWidth = 8;
  return [
    { id: "symbol", label: "TICKER", width: symbolWidth, align: "left" },
    { id: "price", label: "LAST", width: priceWidth, align: "right" },
    { id: "changePercent", label: "CHG%", width: pctWidth, align: "right" },
    { id: "marketCap", label: `MCAP ${baseCurrency}`, width: capWidth, align: "right" },
    { id: "trailingPE", label: "P/E", width: metricWidth, align: "right" },
    { id: "forwardPE", label: "FWD", width: metricWidth, align: "right" },
    { id: "evSales", label: "EV/S", width: metricWidth, align: "right" },
    { id: "fcfYield", label: "FCF%", width: metricWidth, align: "right" },
    { id: "revenueGrowth", label: "REV%", width: metricWidth, align: "right" },
    { id: "operatingMargin", label: "OP%", width: Math.max(metricWidth, width - symbolWidth - priceWidth - pctWidth - capWidth - metricWidth * 5 - 10), align: "right" },
  ];
}

interface RelativeSortPreference {
  columnId: RelativeColumnId;
  direction: SortDirection;
}

const DEFAULT_RELATIVE_SORT: RelativeSortPreference = { columnId: "marketCap", direction: "desc" };

function relativeSortValue(row: RelativeRow, columnId: RelativeColumnId): string | number | null {
  return columnId === "symbol" ? row.symbol.toLocaleLowerCase() : row[columnId];
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
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const fxRates = useFxRatesMap([baseCurrency, ...rows.map((row) => row.marketCapCurrency)]);
  const columns = useMemo(() => buildRelativeColumns(width, baseCurrency), [width, baseCurrency]);
  const fetchGenRef = useRef(0);

  const reload = useCallback((forceRefresh = false) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    if (symbols.length === 0) {
      setRows([]);
      setLoading(false);
      setError("No tickers selected");
      return;
    }
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) {
      setRows([]);
      setLoading(false);
      setError("Market data unavailable");
      return;
    }
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
            ...relativeValuationValues(entry?.data ?? entry?.lastGoodData ?? null),
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
    return () => { fetchGenRef.current += 1; };
  }, [reload]);

  const comparableRows = useMemo(() => rows.map((row) => ({
    ...row, marketCap: comparableMarketCap(row.marketCap, row.marketCapCurrency, baseCurrency, fxRates),
  })), [rows, baseCurrency, fxRates]);
  const missingFx = rows.some((row, index) => row.marketCap != null && comparableRows[index]?.marketCap == null);
  const sortedRows = useMemo(() => sortRelativeRows(comparableRows, sortPreference), [comparableRows, sortPreference]);

  const staleSymbols = rows.filter((row) => row.quoteStale).map((row) => row.symbol);
  const rowErrors = rows.filter((row) => row.error).map((row) => `${row.symbol}: ${row.error}`);
  const status = [error, ...rowErrors, staleSymbols.length ? `Stale quotes: ${staleSymbols.join(", ")}` : null,
    missingFx ? "Market-cap FX unavailable" : null].filter(Boolean).join(" · ") || null;
  const selectedRow = sortedRows[selectedIdx];
  const selectedCapNotice = selectedRow?.marketCapProvenance?.kind === "fundamentals"
    ? `${selectedRow.symbol} cap: ${describeFundamentalMarketCap(selectedRow.marketCapProvenance)}.` : undefined;

  useClampSelectedIndex(rows.length, selectedIdx, setSelectedIdx);

  const renderCell = useCallback((row: RelativeRow, column: RelativeColumn, _index: number, rowState: { selected: boolean }): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "symbol":
        return { text: row.symbol, color: selectedColor ?? (row.error || row.quoteStale ? colors.warning : colors.textBright), attributes: TextAttributes.BOLD };
      case "price":
        return { text: row.price != null ? formatCurrency(row.price, row.currency ?? "USD") : "-", color: selectedColor ?? colors.text };
      case "changePercent":
        return { text: row.changePercent != null ? formatPercentRaw(row.changePercent) : "-", color: selectedColor ?? priceColor(row.changePercent ?? 0) };
      case "marketCap":
        return { text: formatCompact(row.marketCap ?? undefined), color: selectedColor ?? colors.textDim };
      case "trailingPE":
        return { text: formatPriceEarnings(row.reportedMultiples.trailingPE), color: selectedColor ?? colors.text };
      case "forwardPE":
        return { text: formatPriceEarnings(row.reportedMultiples.forwardPE), color: selectedColor ?? colors.text };
      case "evSales":
        return { text: formatNumber(row.evSales ?? undefined, 1), color: selectedColor ?? colors.text };
      case "fcfYield":
        return { text: formatPercent(row.fcfYield ?? undefined), color: selectedColor ?? priceColor(row.fcfYield ?? 0) };
      case "revenueGrowth":
        return { text: formatPercent(row.revenueGrowth ?? undefined), color: selectedColor ?? priceColor(row.revenueGrowth ?? 0) };
      case "operatingMargin":
        return { text: formatPercent(row.operatingMargin ?? undefined), color: selectedColor ?? colors.text };
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
    info: loadingErrorFooterInfo(loading, status),
  }), [status, loading]);

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
      rootBefore={selectedCapNotice ? <Box paddingX={1} flexShrink={0} flexDirection="column">
        <Prose text={selectedCapNotice} width={Math.max(8, width - 2)} color={colors.textDim} />
      </Box> : undefined}
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
