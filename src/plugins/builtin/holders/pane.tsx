import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, TextAttributes, useUiCapabilities } from "../../../ui";
import {
  DataTableView,
  Tabs,
  usePaneFooter,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors, priceColor } from "../../../theme/colors";
import type { HolderData } from "../../../types/financials";
import { formatCompact } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { useAssetData, usePluginAppActions, usePluginPaneState } from "../../runtime";
import { THIRTEENF_TEMPLATE_ID } from "../thirteenf/model";
import {
  displayDate,
  formatHolderOwnershipPercent,
  formatMaybePercent,
  formatMoneyCompact,
  formatSignedCompact,
  resolveHolderOwnershipPercent,
} from "./format";
import {
  buildColumns,
  buildRows,
  DEFAULT_SORT,
  nextSortPreference,
  sortRows,
  VIEW_TABS,
} from "./table-model";
import { loadHolderData } from "./client";
import { HoldersTreemap } from "./treemap";
import type { HolderColumn, HolderRow, SortPreference, ViewMode } from "./types";
import { loadHolder13FMatches, type Holder13FMatch } from "./thirteenf-match";

export function HoldersView({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const { nativePaneChrome } = useUiCapabilities();
  const { symbol, ticker, financials } = usePaneTicker();
  const dataProvider = useAssetData();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [viewMode, setViewMode] = usePluginPaneState<ViewMode>("viewMode", "chart");
  const [sortPreference, setSortPreference] = usePluginPaneState<SortPreference>("sortPreference", DEFAULT_SORT);
  const [data, setData] = useState<HolderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fundMatches, setFundMatches] = useState<Map<string, Holder13FMatch>>(() => new Map());
  const [fundMatching, setFundMatching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fetchGenRef = useRef(0);
  const fundMatchAbortRef = useRef<AbortController | null>(null);

  const currency = data?.currency ?? ticker?.metadata.currency ?? "USD";
  const quoteMarketCap = financials?.quote?.marketCap;
  const marketCap = financials?.quote?.currency && financials.quote.currency !== currency ? undefined : quoteMarketCap;
  const exchange = ticker?.metadata.exchange ?? "";
  const rows = useMemo(() => buildRows(data), [data]);
  const sortedRows = useMemo(() => sortRows(rows, sortPreference, marketCap), [marketCap, rows, sortPreference]);
  const columns = useMemo(() => buildColumns(width), [width]);
  const selectedIdx = selectedId
    ? sortedRows.findIndex((row) => row.id === selectedId)
    : -1;
  const activeIdx = selectedIdx >= 0 ? selectedIdx : (sortedRows.length > 0 ? 0 : -1);

  const loadHolders = useCallback(async (forceRefresh = false) => {
    if (!symbol || !dataProvider?.getHolders) {
      setData(null);
      setLoading(false);
      setError(dataProvider?.getHolders ? null : "Holder data unavailable");
      return;
    }

    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setError(null);

    try {
      const nextData = await loadHolderData(
        dataProvider,
        symbol,
        exchange,
        forceRefresh ? { cacheMode: "refresh" } : undefined,
      );
      if (fetchGenRef.current !== gen) return;
      setData(nextData);
      setSelectedId(null);
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, [dataProvider, exchange, symbol]);

  useEffect(() => {
    void loadHolders(false);
  }, [loadHolders]);

  useEffect(() => {
    if (selectedId && sortedRows.some((row) => row.id === selectedId)) return;
    setSelectedId(sortedRows[0]?.id ?? null);
  }, [selectedId, sortedRows]);

  // Keyed on the holder set itself: re-sorting or a ticking market cap must not
  // restart 25 two-request 13F lookups.
  useEffect(() => {
    fundMatchAbortRef.current?.abort();
    setFundMatches(new Map());
    if (rows.length === 0) {
      setFundMatching(false);
      return;
    }

    const controller = new AbortController();
    fundMatchAbortRef.current = controller;
    setFundMatching(true);
    void loadHolder13FMatches(rows, controller.signal)
      .then((matches) => {
        if (fundMatchAbortRef.current !== controller) return;
        setFundMatches(matches);
      })
      .finally(() => {
        if (fundMatchAbortRef.current === controller) setFundMatching(false);
      });

    return () => {
      controller.abort();
      if (fundMatchAbortRef.current === controller) {
        fundMatchAbortRef.current = null;
      }
    };
  }, [rows]);

  const selectedRow = activeIdx >= 0 ? sortedRows[activeIdx] ?? null : null;
  const selectedFundMatch = selectedRow ? fundMatches.get(selectedRow.id) ?? null : null;

  const openFundDetail = useCallback((row: HolderRow | null | undefined) => {
    if (!row) return;
    const match = fundMatches.get(row.id);
    if (!match) return;
    createPaneFromTemplate(THIRTEENF_TEMPLATE_ID, {
      arg: match.fundName,
      values: {
        cik: match.cik,
        query: match.fundName,
        tab: "search",
      },
    });
  }, [createPaneFromTemplate, fundMatches]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, [setSortPreference]);

  const toggleView = useCallback(() => {
    setViewMode((current) => current === "table" ? "chart" : "table");
  }, [setViewMode]);

  const refresh = useCallback(() => {
    void loadHolders(true);
  }, [loadHolders]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "r") {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    if (event.name === "s") {
      event.preventDefault?.();
      event.stopPropagation?.();
      toggleView();
      return true;
    }
    if ((event.name === "o" || event.name === "enter" || event.name === "return") && selectedFundMatch) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openFundDetail(selectedRow);
      return true;
    }
    return false;
  }, [openFundDetail, refresh, selectedFundMatch, selectedRow, toggleView]);

  useShortcut((event) => {
    if (!focused || viewMode !== "chart") return;
    if (isPlainKey(event, "j", "down")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const nextIdx = Math.min((selectedIdx >= 0 ? selectedIdx : 0) + 1, sortedRows.length - 1);
      const nextRow = sortedRows[nextIdx];
      if (nextRow) setSelectedId(nextRow.id);
      return;
    }
    if (isPlainKey(event, "k", "up")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const nextIdx = Math.max((selectedIdx >= 0 ? selectedIdx : 0) - 1, 0);
      const nextRow = sortedRows[nextIdx];
      if (nextRow) setSelectedId(nextRow.id);
      return;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return;
    }
    if (isPlainKey(event, "s")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      toggleView();
      return;
    }
    if (isPlainKey(event, "o", "enter", "return") && selectedFundMatch) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openFundDetail(selectedRow);
    }
  });

  const renderCell = useCallback((
    row: HolderRow,
    column: HolderColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "holder":
        return {
          text: fundMatches.has(row.id) ? `${row.name} 13F` : row.name,
          color: selectedColor ?? colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "value":
        return { text: formatMoneyCompact(row.value, currency), color: selectedColor ?? colors.text };
      case "shares":
        return { text: formatCompact(row.shares), color: selectedColor ?? colors.text };
      case "changeShares":
        return {
          text: formatSignedCompact(row.changeShares),
          color: selectedColor ?? (row.changeShares != null ? priceColor(row.changeShares) : colors.textDim),
        };
      case "changePercent":
        return {
          text: formatMaybePercent(row.changePercent),
          color: selectedColor ?? (row.changePercent != null ? priceColor(row.changePercent) : colors.textDim),
        };
      case "percentHeld":
        return {
          text: formatHolderOwnershipPercent(resolveHolderOwnershipPercent(row, marketCap)),
          color: selectedColor ?? colors.textDim,
        };
      case "reportDate":
        return { text: displayDate(row.reportDate), color: selectedColor ?? colors.textDim };
    }
  }, [currency, fundMatches, marketCap]);

  usePaneFooter("holders", () => {
    return {
      info: [
        ...(data?.asOf ? [{ id: "as-of", parts: [{ text: data.asOf, tone: "value" as const }] }] : []),
        ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
        ...(fundMatching ? [{ id: "fund-matching", parts: [{ text: "13F matching", tone: "muted" as const }] }] : []),
      ],
      hints: [
        { id: "view", key: "s", label: "witch", onPress: toggleView },
        // `f` is the filter key in sibling panes, so opening a fund uses `o`.
        ...(selectedFundMatch ? [{ id: "fund", key: "o", label: "pen 13F", onPress: () => openFundDetail(selectedRow) }] : []),
      ],
    };
  }, [data?.asOf, fundMatching, loading, openFundDetail, selectedFundMatch, selectedRow, toggleView]);

  // Both views share one status; the treemap must not claim "no chartable
  // values" while the request is still in flight or the pane has no ticker.
  const statusTitle = !symbol
    ? "No ticker selected."
    : loading
      ? "Loading holders..."
      : error ?? (sortedRows.length === 0 ? "No holders available" : null);
  const chartHeight = Math.max(1, height - 1 - (nativePaneChrome ? 1 : 0));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1}>
        <Tabs
          tabs={VIEW_TABS}
          activeValue={viewMode}
          onSelect={(value) => setViewMode(value as ViewMode)}
          compact
          variant="bare"
          focused={focused}
        />
      </Box>

      {viewMode === "table" ? (
        <DataTableView<HolderRow, HolderColumn>
          focused={focused}
          selection={{
            kind: "id",
            selectedId,
            getId: (row) => row.id,
            onChange: (id) => setSelectedId(id),
          }}
          onActivate={openFundDetail}
          onRootKeyDown={handleKeyDown}
          resetScrollKey={data?.symbol}
          rootWidth={width}
          columns={columns}
          items={sortedRows}
          sortColumnId={sortPreference.columnId}
          sortDirection={sortPreference.direction}
          onHeaderClick={handleHeaderClick}
          getItemKey={(row) => row.id}
          renderCell={renderCell}
          emptyStateTitle={statusTitle ?? "No holders available"}
        />
      ) : (
        <HoldersTreemap
          rows={sortedRows}
          emptyStateTitle={statusTitle ?? undefined}
          width={width}
          height={chartHeight}
          selectedId={selectedId}
          onSelect={(row) => setSelectedId(row.id)}
          onActivate={openFundDetail}
          currency={currency}
          marketCap={marketCap}
        />
      )}
    </Box>
  );
}
