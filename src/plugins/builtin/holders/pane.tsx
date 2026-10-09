import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import {
  Badge,
  DataTableView,
  usePaneFooter,
  usePaneTabs,
  usePaneTicker,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { colors, priceColor } from "../../../theme/colors";
import type { HolderData } from "../../../types/financials";
import { clipToDisplayWidth, formatCompact } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { nextHeaderSort } from "../../../utils/sort-values";
import { useAssetData, usePluginAppActions, usePluginPaneState } from "../../runtime";
import { THIRTEENF_TEMPLATE_ID } from "../thirteenf/model";
import { useInResearchTab } from "../ticker-detail/research-tab-keys";
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
  hasHolderChanges,
  buildRows,
  DEFAULT_SORT,
  nextViewMode,
  sortRows,
  VIEW_TABS,
} from "./table-model";
import { loadHolderData } from "./client";
import { HoldersTreemap } from "./treemap";
import { BeneficialOwnersView } from "./beneficial-view";
import type { HolderColumn, HolderColumnId, HolderRow, SortPreference, ViewMode } from "./types";
import { loadHolder13FMatches, type Holder13FMatch } from "./thirteenf-match";
import { useSampledValue, useTickerQuoteStream } from "../../../state/hooks/live-ticker-financials";

const HOLDER_MARKET_CAP_SAMPLE_MS = 5_000;

/** The "13F" badge: the label and its padding. */
const FUND_BADGE_WIDTH = 5;

export function HoldersView({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const { nativePaneChrome } = useUiCapabilities();
  const { symbol, ticker, financials } = usePaneTicker();
  const dataProvider = useAssetData();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [viewMode, setViewMode] = usePluginPaneState<ViewMode>("viewMode", "table");
  const [sortPreference, setSortPreference] = usePluginPaneState<SortPreference>("sortPreference", DEFAULT_SORT);
  const [fundMatches, setFundMatches] = useState<Map<string, Holder13FMatch>>(() => new Map());
  const [fundMatching, setFundMatching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fundMatchAbortRef = useRef<AbortController | null>(null);

  const exchange = ticker?.metadata.exchange ?? "";
  const loadHolders = useMemo(() => symbol ? async (forceRefresh: boolean) => {
    if (!dataProvider) throw new Error("Holder data unavailable");
    return loadHolderData(dataProvider, symbol, exchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  } : null, [dataProvider, exchange, symbol]);
  // Another ticker's holders stay up until its own answer, and a failed
  // refresh keeps the last holders; the failure goes to the footer.
  const { data, loading, error, reload } = useAsyncResource<HolderData>(loadHolders, { keepPreviousData: true });

  const currency = data?.currency || ticker?.metadata.currency || "USD";
  // A stake without a reported percentage is the holding's value over the
  // market cap. The stream keeps the cap current, about once a second; the
  // stakes follow it at most every few seconds so ticks do not re-sort them.
  useTickerQuoteStream(ticker ? symbol : null, ticker, { surface: "detail", visible: false, weight: 30 });
  const quoteMarketCap = financials?.quote?.marketCap;
  const liveMarketCap = financials?.quote?.currency && financials.quote.currency !== currency ? undefined : quoteMarketCap;
  const marketCap = useSampledValue(liveMarketCap, HOLDER_MARKET_CAP_SAMPLE_MS, `${symbol ?? ""}:${currency}`);
  const rows = useMemo(() => buildRows(data), [data]);
  const sortedRows = useMemo(() => sortRows(rows, sortPreference, marketCap), [marketCap, rows, sortPreference]);
  // Change columns only when the source reports a change; otherwise they read "-" on every row.
  const showChange = useMemo(() => hasHolderChanges(rows), [rows]);
  const columns = useMemo(() => buildColumns(width, showChange), [showChange, width]);
  const selectedIdx = selectedId
    ? sortedRows.findIndex((row) => row.id === selectedId)
    : -1;
  const activeIdx = selectedIdx >= 0 ? selectedIdx : (sortedRows.length > 0 ? 0 : -1);

  // Fresh holders start from the top row.
  useEffect(() => { setSelectedId(null); }, [data]);

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
    setSortPreference((current) => nextHeaderSort(current, columnId as HolderColumnId, {
      firstDirection: (id) => id === "holder" || id === "reportDate" ? "asc" : "desc",
    }));
  }, [setSortPreference]);

  const toggleView = useCallback(() => {
    setViewMode(nextViewMode);
  }, [setViewMode]);

  const refresh = useCallback(() => {
    void reload();
  }, [reload]);

  // Plain keys only: Cmd/Ctrl+Shift+R, S and O resize, share and pop out the pane.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return true;
    if (isPlainKey(event, "s")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      toggleView();
      return true;
    }
    if (isPlainKey(event, "o", "enter", "return") && selectedFundMatch) {
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
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return;
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
    switch (column.id) {
      case "holder": {
        const color = rowState.selected ? colors.selectedText : colors.textBright;
        if (!fundMatches.has(row.id)) return { text: row.name, color, attributes: TextAttributes.BOLD };
        // A fund with a 13F opens on Enter or o. The name gives way first, so
        // the marker survives a narrow column.
        return {
          text: `${row.name} 13F`,
          content: (
            <Box flexDirection="row" gap={1} width={column.width} overflow="hidden">
              <Text fg={color} attributes={TextAttributes.BOLD}>
                {clipToDisplayWidth(row.name, Math.max(1, column.width - FUND_BADGE_WIDTH - 1))}
              </Text>
              <Badge label="13F" tone="accent" />
            </Box>
          ),
        };
      }
      case "value":
        return { text: formatMoneyCompact(row.value, currency), color: colors.text };
      case "shares":
        return { text: formatCompact(row.shares), color: colors.text };
      case "changeShares":
        return {
          text: formatSignedCompact(row.changeShares),
          color: row.changeShares != null ? priceColor(row.changeShares) : colors.textDim,
        };
      case "changePercent":
        return {
          text: formatMaybePercent(row.changePercent),
          color: row.changePercent != null ? priceColor(row.changePercent) : colors.textDim,
        };
      case "percentHeld":
        return {
          text: formatHolderOwnershipPercent(resolveHolderOwnershipPercent(row, marketCap)),
          color: colors.textDim,
        };
      case "reportDate":
        return { text: displayDate(row.reportDate), color: colors.textDim };
    }
  }, [currency, fundMatches, marketCap]);

  // The 13D/G tab registers its own footer.
  usePaneFooter("holders", () => {
    if (viewMode === "13dg") return null;
    return {
      info: [
        ...(data?.asOf ? [{ id: "as-of", parts: [{ text: data.asOf, tone: "value" as const }] }] : []),
        ...loadingErrorFooterInfo(loading, data ? error : null),
        ...(fundMatching ? [{ id: "fund-matching", parts: [{ text: "13F matching", tone: "muted" as const }] }] : []),
      ],
      // The title-bar tabs (or the query bar inside Ticker Research) switch
      // views, so the footer only carries the fund action.
      hints: [
        // `f` is the filter key in sibling panes, so opening a fund uses `o`.
        ...(selectedFundMatch ? [{ id: "fund", key: "o", label: "pen 13F", onPress: () => openFundDetail(selectedRow) }] : []),
      ],
    };
  }, [data, error, fundMatching, loading, openFundDetail, selectedFundMatch, selectedRow, viewMode]);

  const selectView = useCallback((value: string) => setViewMode(value as ViewMode), [setViewMode]);
  // As a research tab, h/l move between research tabs; `s` switches the view.
  const inResearchTab = useInResearchTab();
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: VIEW_TABS,
    activeValue: viewMode,
    onSelect: selectView,
    focused,
    keyboardNavigation: !inResearchTab,
    compact: true,
    variant: "bare",
    queryBarWidth: width,
  });

  // Both views share one status; the treemap must not claim "no chartable
  // values" while the request is still in flight or the pane has no ticker.
  const statusTitle = !symbol
    ? "No ticker selected."
    : loading && !data
      ? "Loading holders..."
      : !data && error ? error : sortedRows.length === 0 ? "No holders available" : null;
  const chartHeight = Math.max(1, height - tabRows - (nativePaneChrome ? 1 : 0));

  return (
    <Box flexDirection="column" width={width} height={height}>
      {nativePaneChrome ? tabStrip : tabStrip && <Box height={1} paddingX={1}>{tabStrip}</Box>}

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
          selectedTextOverridesCellColor
          emptyStateTitle={statusTitle ?? "No holders available"}
        />
      ) : viewMode === "13dg" ? (
        <BeneficialOwnersView
          focused={focused}
          width={width}
          symbol={symbol ?? null}
          holderRows={rows}
          fundMatches={fundMatches}
          onCycleView={toggleView}
          onRefreshHolders={refresh}
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
