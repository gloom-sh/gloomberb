import { formatPriceEarnings, NOT_MEANINGFUL } from "../../../utils/price-earnings";
import { useCallback, useMemo, useState } from "react";
import { TextAttributes } from "../../../ui";
import {
  DataTableView,
  usePaneStatusFooter,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { useAppSelector, usePaneInstance } from "../../../state/app/context";
import { getSharedMarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import { buildQuoteKey } from "../../../market-data/selectors";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { useSampledValue } from "../../../state/hooks/live-ticker-financials";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { TickerFinancials } from "../../../types/financials";
import { normalizeSymbol } from "../../../utils/exchanges";
import { colors, priceColor } from "../../../theme/colors";
import { extendedSessionStateLabel, type ExtendedSession } from "../../../market-data/market/status";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { formatCompact, formatLevelPercent, formatNumber, formatPercent, formatPercentRaw } from "../../../utils/format";
import { parseDisplayDate } from "../../../utils/datetime-format";
import { convertMarketCapitalization } from "../../../utils/market-capitalization";
import { usePluginTickerActions } from "../../runtime";
import { handleRefreshKey, useClampSelectedIndex } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useBoundTicker as useSymbolBinding } from "../shared/ticker-request";
import { useFxRatesMap } from "../../../market-data/hooks";
import { RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE, formatRelativePrice, relativeValuationValues, withLiveQuote } from "./relative-valuation-model";

type ExtendedColumnId = "preMarket" | "afterHours" | "overnight";
type RelativeColumnId = "symbol" | "price" | "changePercent" | ExtendedColumnId | "marketCap" | "trailingPE" | "forwardPE" | "evSales" | "fcfYield" | "revenueGrowth" | "operatingMargin";
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

const EXTENDED_COLUMN_IDS: Record<ExtendedSession, ExtendedColumnId> = { PRE: "preMarket", POST: "afterHours", OVERNIGHT: "overnight" };

/** The extended sessions some peer has a print for, in the order their columns go. */
function extendedSessionsOf(rows: readonly RelativeRow[]): ExtendedSession[] {
  return (["PRE", "POST", "OVERNIGHT"] as const).filter((session) => rows.some((row) => row.extendedSession === session));
}

/** A peer's move in the extended-session column `columnId`, from the close in LAST. */
function extendedMove(row: RelativeRow, columnId: ExtendedColumnId): number | null {
  return row.extendedSession != null && EXTENDED_COLUMN_IDS[row.extendedSession] === columnId ? row.extendedChangePercent : null;
}

/**
 * LAST and CHG% are the regular session, as `quote` reads them; a PRE-MKT,
 * AFTER-HRS or OVERNIGHT column, named as BI and MOST name it, follows CHG%
 * for each session in `extendedSessions`.
 */
function buildRelativeColumns(baseCurrency: string, extendedSessions: readonly ExtendedSession[]): RelativeColumn[] {
  const symbolWidth = 8;
  const priceWidth = 10;
  const pctWidth = 8;
  const capWidth = 12;
  const metricWidth = 8;
  return [
    { id: "symbol", label: "TICKER", width: symbolWidth, align: "left" },
    { id: "price", label: "LAST", width: priceWidth, align: "right" },
    { id: "changePercent", label: "CHG%", width: pctWidth, align: "right" },
    ...extendedSessions.map((session): RelativeColumn => ({
      id: EXTENDED_COLUMN_IDS[session], label: extendedSessionStateLabel(session), width: 9, align: "right",
    })),
    { id: "marketCap", label: `MCAP ${baseCurrency}`, width: capWidth, align: "right" },
    { id: "trailingPE", label: "P/E", width: metricWidth, align: "right" },
    { id: "forwardPE", label: "FWD", width: metricWidth, align: "right" },
    { id: "evSales", label: "EV/S", width: metricWidth, align: "right" },
    { id: "fcfYield", label: "FCF%", width: metricWidth, align: "right" },
    // Latest quarter against the year before, and a trailing-twelve-month margin.
    { id: "revenueGrowth", label: "Q REV%", width: metricWidth, align: "right" },
    { id: "operatingMargin", label: "TTM OP%", width: metricWidth, align: "right" },
  ];
}

interface RelativeSortPreference {
  columnId: RelativeColumnId;
  direction: SortDirection;
}

const DEFAULT_RELATIVE_SORT: RelativeSortPreference = { columnId: "marketCap", direction: "desc" };

function relativeSortValue(row: RelativeRow, columnId: RelativeColumnId): string | number | null {
  if (columnId === "symbol") return row.symbol.toLocaleLowerCase();
  if (columnId === "preMarket" || columnId === "afterHours" || columnId === "overnight") return extendedMove(row, columnId);
  return row[columnId];
}

function sortRelativeRowIndices(
  rows: readonly RelativeRow[],
  preference: RelativeSortPreference,
): number[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => (
      compareSortValues(
        relativeSortValue(left.row, preference.columnId),
        relativeSortValue(right.row, preference.columnId),
        preference.direction,
      ) || left.index - right.index
    ))
    .map((entry) => entry.index);
}

/** Live values keep moving; the row order follows them at most this often. */
const RELATIVE_ORDER_SAMPLE_MS = 5_000;

interface PeerSnapshot {
  symbol: string;
  financials: TickerFinancials | null;
  error?: string;
}

function peerQuoteKey(symbol: string): string {
  return buildQuoteKey({ symbol: normalizeSymbol(symbol), exchange: "", instrument: null });
}

export function RelativeValuationPane({ focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  const { symbol } = useSymbolBinding();
  // Keyed on the list itself, so a settings write that leaves the peers alone
  // does not start the snapshot over.
  const symbolList = relativeSymbolsFromPane(symbol, pane?.settings).join(",");
  const symbols = useMemo(() => (symbolList ? symbolList.split(",") : []), [symbolList]);
  const { navigateTicker } = usePluginTickerActions();
  const loadPeers = useCallback(async (forceRefresh: boolean): Promise<PeerSnapshot[]> => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) throw new Error("Market data unavailable");
    // One batched snapshot request instead of one request per peer.
    const entries = await coordinator.loadSnapshotsBatch(symbols.map((peer) => ({ symbol: peer })), { forceRefresh });
    return symbols.map((peer, index) => {
      const entry = entries[index];
      return {
        symbol: peer,
        financials: entry?.data ?? entry?.lastGoodData ?? null,
        error: entry?.error?.message,
      };
    });
  }, [symbols]);
  // Fundamentals come from one batched snapshot; prices stream on top of it.
  // A changed peer list keeps the last snapshot up until its own answer.
  const peerSnapshot = useAsyncResource(symbols.length > 0 ? loadPeers : null, { keepPreviousData: true });
  const { data: peers, loading, updatedAt, reload } = peerSnapshot;
  const error = symbols.length > 0 ? peerSnapshot.error : "No tickers selected";
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [sortPreference, setSortPreference] = useState<RelativeSortPreference>(DEFAULT_RELATIVE_SORT);
  const appBaseCurrency = useAppSelector((state) => state.config.baseCurrency);
  // `--currency` on a capture asks for another currency than the app's.
  const capCurrency = typeof pane?.settings?.capCurrency === "string" ? pane.settings.capCurrency : null;
  const baseCurrency = capCurrency ?? appBaseCurrency;
  const quoteTargets = useMemo<QuoteSubscriptionTarget[]>(() => symbols.map((peer) => ({
    symbol: peer,
    exchange: "",
    surface: "screener",
    visible: true,
    weight: 60,
  })), [symbols]);
  const { entries: liveQuotes } = useLiveQuoteEntries(quoteTargets);
  const rows = useMemo<RelativeRow[]>(() => (peers ?? []).map((peer) => {
    const entry = liveQuotes.get(peerQuoteKey(peer.symbol));
    return {
      symbol: peer.symbol,
      ...relativeValuationValues(withLiveQuote(peer.financials, entry ? resolveEntryValue(entry) : null)),
      error: peer.error,
    };
  }), [liveQuotes, peers]);
  const fxRates = useFxRatesMap([baseCurrency, ...rows.map((row) => row.marketCapCurrency)]);
  // A pre-market or after-hours print gets its own column when a peer has one.
  const extendedSessionsKey = extendedSessionsOf(rows).join(",");
  const columns = useMemo(
    () => buildRelativeColumns(baseCurrency, extendedSessionsKey ? extendedSessionsKey.split(",") as ExtendedSession[] : []),
    [baseCurrency, extendedSessionsKey],
  );

  const comparableRows = useMemo(() => rows.map((row) => ({
    ...row, marketCap: convertMarketCapitalization(row.marketCap, row.marketCapCurrency, baseCurrency, fxRates),
  })), [rows, baseCurrency, fxRates]);
  const missingFx = rows.some((row, index) => row.marketCap != null && comparableRows[index]?.marketCap == null);
  // Sorting by a live column would reshuffle rows under the cursor on every
  // tick; the order is taken from values sampled every few seconds instead,
  // and at once when the sort or the peer set changes.
  const orderRows = useSampledValue(
    comparableRows,
    RELATIVE_ORDER_SAMPLE_MS,
    `${updatedAt}:${sortPreference.columnId}:${sortPreference.direction}`,
  );
  const order = useMemo(() => sortRelativeRowIndices(orderRows, sortPreference), [orderRows, sortPreference]);
  const sortedRows = useMemo(
    () => order.flatMap((index) => (comparableRows[index] ? [comparableRows[index]] : [])),
    [comparableRows, order],
  );

  const staleSymbols = rows.filter((row) => row.quoteStale).map((row) => row.symbol);
  const rowErrors = rows.filter((row) => row.error).map((row) => `${row.symbol}: ${row.error}`);
  const status = [error, ...rowErrors, staleSymbols.length ? `Stale quotes: ${staleSymbols.join(", ")}` : null,
    missingFx ? "Market-cap FX unavailable" : null].filter(Boolean).join(" · ") || null;

  usePaneNoticeFooter({
    registrationId: "relative-valuation-notices",
    notices: [
      ...rows.filter((row) => row.fundamentalsProvenance?.stale)
        .map((row) => `${row.symbol}: ${RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE}.`),
      ...rows.flatMap((row) => row.evSalesUnavailable ? [`${row.symbol}: ${row.evSalesUnavailable}`] : []),
      ...rows.flatMap((row) => row.evSalesNote ? [`${row.symbol}: ${row.evSalesNote}`] : []),
    ],
    focused,
  });

  useClampSelectedIndex(rows.length, selectedIdx, setSelectedIdx);

  const renderCell = useCallback((row: RelativeRow, column: RelativeColumn): DataTableCell => {
    switch (column.id) {
      case "symbol":
        return { text: row.symbol, color: row.error || row.quoteStale || row.fundamentalsProvenance?.stale ? colors.warning : colors.textBright, attributes: TextAttributes.BOLD };
      case "price":
        return { text: formatRelativePrice(row.price, row.currency), color: colors.text };
      case "changePercent":
        return { text: row.changePercent != null ? formatPercentRaw(row.changePercent) : "-", color: priceColor(row.changePercent ?? 0) };
      case "preMarket":
      case "afterHours":
      case "overnight": {
        const move = extendedMove(row, column.id);
        return { text: move != null ? formatPercentRaw(move) : "-", value: move, color: move == null ? colors.textDim : priceColor(move) };
      }
      case "marketCap":
        return { text: formatCompact(row.marketCap ?? undefined, { fixedDecimals: true }), color: colors.textDim };
      case "trailingPE":
        return { text: formatPriceEarnings(row.notMeaningful.trailingPE ? NOT_MEANINGFUL : row.reportedMultiples.trailingPE), color: colors.text };
      case "forwardPE":
        return { text: formatPriceEarnings(row.notMeaningful.forwardPE ? NOT_MEANINGFUL : row.reportedMultiples.forwardPE), color: colors.text };
      case "evSales":
        // A withdrawn EV says so, one at or below zero reads N/M as a P/E over a loss does; the footer says why.
        if (row.evSales == null && row.notMeaningful.evSales) return { text: formatPriceEarnings(NOT_MEANINGFUL), color: colors.text };
        return row.evSales == null && row.evSalesUnavailable
          ? { text: "EV n/a", color: colors.textDim }
          : { text: formatNumber(row.evSales ?? undefined, 1), color: colors.text };
      case "fcfYield":
        return { text: formatLevelPercent(row.fcfYield ?? undefined), color: priceColor(row.fcfYield ?? 0) };
      case "revenueGrowth":
        return { text: formatPercent(row.revenueGrowth ?? undefined), color: priceColor(row.revenueGrowth ?? 0) };
      case "operatingMargin":
        return { text: formatLevelPercent(row.operatingMargin ?? undefined), color: colors.text };
    }
  }, []);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, () => void reload(), { stopPropagation: true });
  }, [reload]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextHeaderSort(current, columnId as RelativeColumnId, {
      firstDirection: columnId === "symbol" ? "asc" : "desc",
    }));
  }, []);

  usePaneStatusFooter({ registrationId: "relative-valuation", loading, error: status });

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
      selectedTextOverridesCellColor
      getExportMetadata={() => sortedRows.flatMap((row) => [
        [row.symbol, "Quote as of", parseDisplayDate(row.quoteAsOf)?.toISOString() ?? "unavailable", "Stale", String(row.quoteStale ?? "unknown")],
        [row.symbol, "Fundamentals retrieved", row.fundamentalsProvenance?.retrievedAt ?? "unavailable",
          "Stale", String(row.fundamentalsProvenance?.stale ?? "unknown")],
        ...(row.fundamentalsProvenance?.stale ? [[row.symbol, RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE]] : []),
      ])}
      emptyStateTitle={loading ? "Loading peers..." : error ?? "No peers"}
    />
  );
}
