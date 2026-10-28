import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, TextAttributes, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import {
  Badge,
  DataTableView,
  useCompanyDataFooter,
  usePagedRows,
  usePaneFooter,
  usePaneTabs,
  usePaneTicker,
  useTableLoadMore,
  type DataTableCell,
  type DataTableKeyEvent,
  type PageRequest,
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
  formatHolderChangePercent,
  formatHolderOwnershipPercent,
  formatMoneyCompact,
  formatSignedCompact,
  holderStakeMarketCap,
  holderValueCurrency,
  resolveHolderOwnershipPercent,
} from "./format";
import { holderPeriodsDiffer, holderShareBasisMarker } from "./report-header";
import {
  buildColumns,
  hasHolderChanges,
  buildRows,
  DEFAULT_SORT,
  nextViewMode,
  sortRows,
  VIEW_TABS,
} from "./table-model";
import { classSharesAsOf, classSharesToday, loadHolderData } from "./client";
import { HoldersTreemap } from "./treemap";
import { BeneficialOwnersView } from "./beneficial-view";
import { useIssuerListing } from "../shared/ticker-request";
import type { HolderColumn, HolderColumnId, HolderRow, SortPreference, ViewMode } from "./types";
import { loadHolder13FMatches, type Holder13FMatch } from "./thirteenf-match";
import { indexedHolderUnits, indexHolderTicker, loadIndexedHolderPage, withIndexedHolders } from "./index-holders";
import { useSampledValue, useTickerQuoteStream } from "../../../state/hooks/live-ticker-financials";

const HOLDER_MARKET_CAP_SAMPLE_MS = 5_000;
/** Rows past the end of the table that a scroll loads the next page within, as `useTableLoadMore` does. */
const LOAD_MORE_ROWS = 8;

/** Index rows have their CIK, so their 13F filing needs no name search. */
function cikMatches(rows: readonly HolderRow[]): Map<string, Holder13FMatch> {
  return new Map(rows.flatMap((row) => row.cik ? [[row.id, { cik: row.cik, fundName: row.name, periodOfReport: row.reportDate }]] : []));
}

/** The width of a three-letter badge ("13F", "ADR"): the label and its padding. */
const BADGE_WIDTH = 5;

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
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const exchange = ticker?.metadata.exchange ?? "";
  const issuerListing = useIssuerListing(ticker);
  const loadHolders = useMemo(() => symbol ? async (forceRefresh: boolean) => {
    if (!dataProvider) throw new Error("Holder data unavailable");
    return loadHolderData(dataProvider, symbol, exchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  } : null, [dataProvider, exchange, symbol]);
  // Another ticker's holders stay up until its own answer, and a failed
  // refresh keeps the last holders; the failure goes to the footer.
  const { data, loading, error, reload } = useAsyncResource<HolderData>(loadHolders, {
    initialData: () => symbol && dataProvider?.getCachedQuery
      ? dataProvider.getCachedQuery("getHolders", [symbol, exchange]).getSnapshot().result?.value ?? null
      : null,
    keepPreviousData: true,
  });

  // A US line's 13F holders are every filer in the SEC holder index, paged
  // as fn 13F pages them and asked beside the source's short list, which
  // stands until the first page answers and whenever the index cannot be read.
  const indexTicker = indexHolderTicker(symbol, exchange);
  const loadIndexPage = useMemo(() => indexTicker
    ? ({ offset, signal }: PageRequest) => loadIndexedHolderPage(indexTicker, offset, signal)
    : null, [indexTicker]);
  const index = usePagedRows(loadIndexPage, { getId: (row) => row.cik });
  // The source's list kept from the previous ticker must not price this one's filers: they wait for its own.
  const base = data && indexHolderTicker(data.symbol) === indexTicker ? data : null;
  const indexed = index.rows.length > 0 && (!!base || !loading) && indexHolderTicker(symbol, exchange, base) != null;
  const indexPending = !!indexTicker && index.loading && index.rows.length === 0;
  // Index rows take the source's price; the quote's only when the source gave none, sampled so ticks do not re-sort.
  // The rows follow the units in use, so a quote that is not the price used leaves them as they are.
  const quotePrice = useSampledValue(financials?.quote?.price, HOLDER_MARKET_CAP_SAMPLE_MS, symbol ?? "");
  const { price: unitPrice, classShares: unitClassShares } = indexedHolderUnits(base, quotePrice);
  const listData = useMemo(() => {
    const first = index.pages[0];
    if (!indexed || !first || !indexTicker) return data;
    return withIndexedHolders(base, indexTicker, { ...first, rows: index.rows }, {
      ...(unitPrice != null ? { price: unitPrice } : {}),
      ...(unitClassShares != null ? { classShares: unitClassShares } : {}),
    });
  }, [base, data, index.pages, index.rows, indexTicker, indexed, unitClassShares, unitPrice]);

  // The values' own currency: dollars from the 13F filings on a London line, not its pence.
  const currency = holderValueCurrency(listData, ticker?.metadata.currency || "USD")!;
  // A stake without a reported percentage is the holding's value over the
  // market cap, when both are in one currency. The stream keeps the cap
  // current, about once a second; the stakes follow it at most every few
  // seconds so ticks do not re-sort them.
  useTickerQuoteStream(ticker ? symbol : null, ticker, { surface: "detail", visible: false, weight: 30 });
  const liveMarketCap = holderStakeMarketCap(financials?.quote?.marketCap, financials?.quote?.currency, currency);
  const marketCap = useSampledValue(liveMarketCap, HOLDER_MARKET_CAP_SAMPLE_MS, `${symbol ?? ""}:${currency}`);
  // Today's share count, which a 13D/13G report's own base is checked against.
  const sharesOutstanding = classSharesToday(financials);
  const sharesOutstandingAsOf = classSharesAsOf(financials);
  const rows = useMemo(() => buildRows(listData), [listData]);
  const periodsDiffer = useMemo(() => holderPeriodsDiffer(rows), [rows]);
  const sortedRows = useMemo(() => sortRows(rows, sortPreference, marketCap), [marketCap, rows, sortPreference]);
  // Change columns only when the source reports a change; otherwise every row would read as missing.
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
    if (rows.length > 0 && rows.every((row) => row.cik)) {
      setFundMatches(cikMatches(rows));
      setFundMatching(false);
      return;
    }
    setFundMatches(new Map());
    // The source's rows are not matched while the index's may replace them.
    if (rows.length === 0 || indexPending) {
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
  }, [indexPending, rows]);

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

  const reloadIndex = index.reload;
  const refresh = useCallback(() => {
    void reload();
    reloadIndex();
  }, [reload, reloadIndex]);
  const loadMoreFromScroll = useTableLoadMore(tableScrollRef, indexed && index.hasMore, index.loadMore);

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
        // ADR: a position held as receipts on a home line's list. 13F: a fund
        // whose filing opens on Enter or o.
        const receipts = holderShareBasisMarker(row);
        const fund = fundMatches.has(row.id);
        if (!receipts && !fund) return { text: row.name, color, attributes: TextAttributes.BOLD };
        const badges = (receipts ? 1 : 0) + (fund ? 1 : 0);
        // The name gives way first, so the markers survive a narrow column.
        return {
          text: [row.name, receipts, fund ? "13F" : ""].filter(Boolean).join(" "),
          content: (
            <Box flexDirection="row" gap={1} width={column.width} overflow="hidden">
              <Text fg={color} attributes={TextAttributes.BOLD}>
                {clipToDisplayWidth(row.name, Math.max(1, column.width - badges * (BADGE_WIDTH + 1)))}
              </Text>
              {receipts ? <Badge label={receipts} /> : null}
              {fund ? <Badge label="13F" tone="accent" /> : null}
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
          text: formatHolderChangePercent(row.changePercent),
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

  // Holders read from the company's home line say whose; the SEC index's rows are the listing's own.
  useCompanyDataFooter(indexed ? null : listData?.companyFrom, viewMode !== "13dg");
  // The 13D/G tab registers its own footer.
  usePaneFooter("holders", () => {
    if (viewMode === "13dg") return null;
    return {
      info: [
        // One date only when every holder's row is of it; the PERIOD column dates each row.
        ...(periodsDiffer
          ? [{ id: "as-of", parts: [{ text: "latest period per holder", tone: "muted" as const }] }]
          : listData?.asOf ? [{ id: "as-of", parts: [{ text: listData.asOf, tone: "value" as const }] }] : []),
        // The index's first page replaces the source's list, so it is loading too; a failed one leaves that list.
        ...loadingErrorFooterInfo(loading || (indexPending && !!data), listData ? error : null),
        ...(index.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
        // A later page that failed keeps the rows loaded; scrolling asks for it again.
        ...(indexed && index.moreError && !index.loadingMore
          ? [{ id: "more-error", parts: [{ text: "more holders could not be read", tone: "warning" as const }] }]
          : []),
        ...(fundMatching ? [{ id: "fund-matching", parts: [{ text: "13F matching", tone: "muted" as const }] }] : []),
      ],
      // The title-bar tabs (or the query bar inside Ticker Research) switch
      // views, so the footer only carries the fund action.
      hints: [
        // `f` is the filter key in sibling panes, so opening a fund uses `o`.
        ...(selectedFundMatch ? [{ id: "fund", key: "o", label: "pen 13F", onPress: () => openFundDetail(selectedRow) }] : []),
      ],
    };
  }, [data, error, fundMatching, index.loadingMore, index.moreError, indexed, indexPending, listData, loading, openFundDetail, periodsDiffer, selectedFundMatch, selectedRow, viewMode]);

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
    : (loading || indexPending) && !listData
      ? "Loading holders..."
      : !listData && error ? error : sortedRows.length === 0 ? "No holders available" : null;
  const chartHeight = Math.max(1, height - tabRows - (nativePaneChrome ? 1 : 0));

  // A list shorter than the table cannot scroll to load more, so it pages on
  // until it fills the table, as a scroll would; a failed page waits for one.
  const { hasMore: indexHasMore, loading: indexLoading, loadingMore: indexLoadingMore, moreError: indexMoreError, loadMore: loadMoreIndex } = index;
  useEffect(() => {
    if (viewMode !== "table" || !indexed || !indexHasMore || indexLoading || indexLoadingMore || indexMoreError) return;
    if (sortedRows.length < chartHeight + LOAD_MORE_ROWS) loadMoreIndex();
  }, [chartHeight, indexHasMore, indexLoading, indexLoadingMore, indexMoreError, indexed, loadMoreIndex, sortedRows.length, viewMode]);

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
          scrollRef={tableScrollRef}
          onBodyScrollActivity={loadMoreFromScroll}
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
          listing={issuerListing}
          holderRows={rows}
          fundMatches={fundMatches}
          sharesOutstanding={sharesOutstanding}
          sharesOutstandingAsOf={sharesOutstandingAsOf}
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
