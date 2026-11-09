import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DataTableStackView,
  PaneLinkMenu,
  PaneStatusBody,
  QueryBar,
  sortStackItems,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableCell,
  type QueryBarView,
  type StackSortPreference,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { useAppSelector } from "../../../state/app/context";
import { getSharedMarketData } from "../../registry";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { logFailure } from "../../../utils/log-failure";
import { displayWidth } from "../../../utils/format";
import { formatShortDate } from "../../../utils/datetime-format";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { SignInWall } from "../cloud/auth-actions";
import { listingCell } from "../shared/research-cells";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { FORM4_CURRENCY } from "./base-values";
import { INSIDER_REPORT_FILINGS, loadParsedInsiderFilings } from "./client";
import { InsiderDetail, insiderDetailTitle } from "./detail";
import { insiderActivityCell, type InsiderViewControl } from "./insiders";
import { insiderEmptyNotice } from "./issuer";
import {
  DEFAULT_INSIDER_TYPE_FILTER,
  isInsiderTypeFilter,
  matchesInsiderTypeFilter,
  type InsiderTypeFilter,
  type ParsedInsiderFiling,
} from "./model";
import { renderInsiderCell } from "./table";
import {
  buildInsiderColumns,
  buildInsiderTableRows,
  compareInsiderRows,
  type InsiderColumn,
  type InsiderColumnId,
  type InsiderTableRow,
} from "./table-model";
import { DEFAULT_INSIDER_SIGNAL_WINDOW, loadInsiderCompany } from "./signals-client";
import {
  buildInsiderActivityColumns,
  INSIDER_SIGNAL_WINDOW_OPTIONS,
  insiderActivityEmptyTitle,
  insiderActivityFirstDirection,
  insiderActivityKey,
  insiderActivityLines,
  insiderActivitySortValue,
  insiderSignalsCoverageNotice,
  insiderSignalsQueryFrom,
  insiderViewMode,
  INSIDER_VIEW_OPTIONS,
  type InsiderActivityColumn,
  type InsiderActivityColumnId,
  type InsiderActivityLine,
  type InsiderViewMode,
} from "./signals-model";
import type { InsiderOpenedCompany } from "./signals";

/** Companies whose insiders are read at once. */
const TICKER_CONCURRENCY = 3;
/** Cells between two columns. */
const COLUMN_GAP = 1;
/** The width from which the Type filter shows every choice, as INS on a ticker does. */
const TYPE_FILTER_INLINE_WIDTH = 80;

type TickerLine = InsiderActivityLine & { ticker: string };
type TickerColumnId = InsiderActivityColumnId | "ticker";
type TickerColumn = Omit<InsiderActivityColumn, "id"> & { id: TickerColumnId };

interface TickersAnswer {
  key: string;
  lines: TickerLine[];
  /** A company with no insider trades in the window, or whose list failed, as a line each. */
  notes: string[];
  asOf: string | null;
  stale: boolean;
}

interface TickersViewProps {
  symbols: readonly string[];
  width: number;
  height: number;
  focused: boolean;
  renderCompany: (company: InsiderOpenedCompany) => ReactNode;
}

/**
 * INS on several tickers (`INS MO,PM,LMT`, or a watchlist's name), as `fn INS
 * MO,PM,LMT` reads them: their Form 4 lines in one table with the Ticker
 * column first, or their insiders, a choice in the query bar as for one
 * ticker.
 */
export function InsiderTickersView(props: TickersViewProps) {
  const [storedView, setView] = usePluginPaneState<InsiderViewMode>("insider:view", "trades");
  const view = insiderViewMode(storedView);
  const viewBar = useMemo<QueryBarView<InsiderViewMode>>(() => ({ value: view, options: INSIDER_VIEW_OPTIONS, onChange: setView }), [setView, view]);
  return view === "insiders"
    ? <TickersInsidersView {...props} viewBar={viewBar} />
    : <TickersTradesView {...props} viewBar={viewBar} />;
}

/** A company's Form 4 lines in the several tickers' table: the line with its company. */
type TickerTradeRow = InsiderTableRow & { ticker: string };
type TradeColumnId = InsiderColumnId | "ticker";
type TradeColumn = Omit<InsiderColumn, "id"> & { id: TradeColumnId };

interface TradesAnswer {
  key: string;
  /** Each company's own Form 4 lines, newest first, in the order the tickers were given. */
  parsed: Array<{ ticker: string; entries: ParsedInsiderFiling[] }>;
  /** A company with no Form 4 of its own, or whose filings failed, as a line each. */
  notes: string[];
}

const TYPE_FILTER_LABELS: Record<InsiderTypeFilter, string> = { all: "All", trades: "Buys and sells", other: "Other" };

/**
 * The several tickers' trades: each company's last Form 4 filings, as many as
 * `fn INS` reads (20), its lines together and newest first in the order the
 * tickers were given, the Ticker column first. The Type filter is the one INS
 * on a ticker has, opening on buys and sells; Enter opens a line's filing.
 */
function TickersTradesView({ symbols, width, height, focused, viewBar }: TickersViewProps & { viewBar: QueryBarView<InsiderViewMode> }) {
  const colors = useThemeColors();
  const key = symbols.join(",");
  const loader = useCallback(async (_force: boolean): Promise<TradesAnswer> => {
    const provider = getSharedMarketData();
    if (!provider) throw new Error("Insider filing data unavailable");
    const reads = await mapWithConcurrency([...symbols], TICKER_CONCURRENCY, async (ticker) => {
      try {
        return { ticker, read: await loadParsedInsiderFilings(provider, ticker, { limit: INSIDER_REPORT_FILINGS }) };
      } catch (error) {
        return { ticker, error };
      }
    });
    const read = reads.flatMap((entry) => "read" in entry && entry.read ? [{ ticker: entry.ticker, ...entry.read }] : []);
    const failed = reads.flatMap((entry) => "error" in entry ? [entry] : []);
    if (read.length === 0 && failed[0]) throw failed[0].error;
    return {
      key,
      parsed: read.map((entry) => ({ ticker: entry.ticker, entries: entry.parsed })),
      notes: [
        ...read.filter((entry) => entry.parsed.length === 0).map((entry) => `${entry.ticker}: ${insiderEmptyNotice(entry.foreignPrivateIssuer)}`),
        ...failed.map((entry) => `${entry.ticker}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`),
      ],
    };
  }, [key, symbols]);
  const resource = useAsyncResource(loader, { keepPreviousData: true });
  const answer = resource.data?.key === key ? resource.data : null;
  useAutoRefresh(resource.updatedAt, resource.load);
  const resourceReload = resource.reload;
  const reload = useCallback(() => resourceReload().catch(logFailure("insider.tickers", "Insider filings reload failed")), [resourceReload]);

  const [storedType, setTypeFilter] = usePluginPaneState<InsiderTypeFilter>("insider:typeFilter", DEFAULT_INSIDER_TYPE_FILTER);
  const typeFilter = isInsiderTypeFilter(storedType) ? storedType : DEFAULT_INSIDER_TYPE_FILTER;
  const [sort, setSort] = useState<StackSortPreference<TradeColumnId> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  usePaneRefreshKey(reload, { focused, enabled: !openId });

  const typeCounts = useMemo(() => {
    const counts: Record<InsiderTypeFilter, number> = { all: 0, trades: 0, other: 0 };
    for (const { entries } of answer?.parsed ?? []) {
      for (const entry of entries) {
        if (entry.isLoading) continue;
        counts.all += 1;
        if (matchesInsiderTypeFilter(entry, "trades")) counts.trades += 1;
        if (matchesInsiderTypeFilter(entry, "other")) counts.other += 1;
      }
    }
    return counts;
  }, [answer]);
  // Each company's lines newest first, by trade day, as INS on a ticker opens.
  const rows = useMemo<TickerTradeRow[]>(() => (answer?.parsed ?? []).flatMap(({ ticker, entries }) =>
    sortStackItems(buildInsiderTableRows(entries.filter((entry) => matchesInsiderTypeFilter(entry, typeFilter))), { columnId: "date", direction: "desc" }, compareInsiderRows)
      .map((row) => ({ ...row, id: `${ticker}:${row.id}`, ticker }))), [answer, typeFilter]);
  // As given until a header is clicked: each company's lines together, newest first.
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const order = new Map(rows.map((row, index) => [row.id, index]));
    return sortStackItems(rows, sort, (a, b, columnId) => columnId === "ticker"
      ? a.ticker.localeCompare(b.ticker)
      : compareInsiderRows(a, b, columnId), (a, b) => order.get(a.id)! - order.get(b.id)!);
  }, [rows, sort]);
  // Form 4 amounts are dollars: a reader whose base currency is another one gets them named, as INS on a ticker does.
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const amountCurrency = baseCurrency.trim().toUpperCase() === FORM4_CURRENCY ? undefined : FORM4_CURRENCY;
  const columns = useMemo<TradeColumn[]>(() => {
    const tickerWidth = Math.max(displayWidth("Ticker") + 2, ...rows.map((row) => displayWidth(row.ticker)));
    return [
      { id: "ticker", label: "Ticker", width: tickerWidth, align: "left" },
      ...buildInsiderColumns(Math.max(0, width - tickerWidth - COLUMN_GAP), rows, amountCurrency),
    ];
  }, [amountCurrency, rows, width]);
  const openRow = openId ? rows.find((row) => row.id === openId) ?? null : null;

  usePaneStatusFooter({
    registrationId: "insider:tickers:trades",
    enabled: !openRow,
    loading: resource.loading,
    error: answer ? resource.error : null,
  });
  usePaneNoticeFooter({ registrationId: "insider:tickers:trades:notices", focused, enabled: !openRow, notices: answer?.notes ?? [] });

  const typeOptions = useMemo(() => (["all", "trades", "other"] as const).map((value) => ({
    value,
    label: `${TYPE_FILTER_LABELS[value]} (${typeCounts[value]})`,
  })), [typeCounts]);
  const queryBar = (
    <QueryBar
      width={width}
      filters={[{
        id: "type",
        label: "Type",
        value: typeFilter,
        defaultValue: DEFAULT_INSIDER_TYPE_FILTER,
        options: typeOptions,
        // Every count in view where there is room, as on one ticker.
        inline: width >= TYPE_FILTER_INLINE_WIDTH,
        onChange: (value: string) => {
          if (!isInsiderTypeFilter(value)) return;
          setTypeFilter(value);
          setSelectedId(null);
        },
      }]}
      view={viewBar}
    />
  );
  if (!answer) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <QueryBar width={width} view={viewBar} />
        <PaneStatusBody
          loading={resource.loading}
          error={resource.error}
          retry={{ onRetry: reload, pending: resource.loading }}
          subject="Insider filings"
        />
      </Box>
    );
  }
  const renderCell = (row: TickerTradeRow, column: TradeColumn, index: number, state: { selected: boolean }): DataTableCell =>
    column.id === "ticker"
      ? listingCell(row.ticker, colors, state.selected)
      : renderInsiderCell(row, column as InsiderColumn, index, state);
  return (
    <DataTableStackView<TickerTradeRow, TradeColumn>
      focused={focused}
      detailOpen={!!openRow}
      onBack={() => setOpenId(null)}
      detailTitle={openRow ? `${openRow.ticker} · ${insiderDetailTitle(openRow)}` : undefined}
      detailScrollRef={detailScrollRef}
      detailContent={openRow ? <PaneLinkMenu><InsiderDetail row={openRow} width={width} scrollRef={detailScrollRef} /></PaneLinkMenu> : <Box flexGrow={1} />}
      rootBefore={queryBar}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={sortedRows}
      getItemKey={(row) => row.id}
      selection={{ kind: "id", selectedId, getId: (row) => row.id, onChange: setSelectedId }}
      onActivate={(row) => {
        setSelectedId(row.id);
        setOpenId(row.id);
      }}
      sortColumnId={sort?.columnId ?? null}
      sortDirection={sort?.direction ?? "desc"}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current ?? { columnId: null, direction: "desc" }, columnId as TradeColumnId, {
        firstDirection: (id) => id === "ticker" || id === "insider" || id === "role" || id === "type" || id === "security" ? "asc" : "desc",
      }))}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      showHorizontalScrollbar={false}
      emptyStateTitle={typeFilter === "trades" ? "No open-market buys or sells in these filings." : "No insider transactions."}
      emptyStateHint={typeFilter === "trades" && typeCounts.other > 0 ? `Type Other has ${typeCounts.other} awards, exercises, tax and gift lines.` : undefined}
    />
  );
}

/**
 * The several tickers' insiders: each company's insiders over the window in
 * one table, the Ticker column first, as `fn INS MO,PM,LMT --view insiders`
 * lists them. Enter opens the row's company on that insider's trades, Back
 * returns here.
 */
function TickersInsidersView({ symbols, width, height, focused, renderCompany, viewBar }: TickersViewProps & { viewBar: QueryBarView<InsiderViewMode> }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const session = useResearchCloudSession();
  const [storedWindow, setWindow] = usePluginPaneState<number>("insider:signals:window", DEFAULT_INSIDER_SIGNAL_WINDOW);
  const window = insiderSignalsQueryFrom({ window: storedWindow }).window;
  const key = `${symbols.join(",")}:${window}`;
  const loader = useCallback(async (force: boolean): Promise<TickersAnswer> => {
    const reads = await mapWithConcurrency([...symbols], TICKER_CONCURRENCY, async (symbol) => {
      try {
        return { symbol, read: await loadInsiderCompany({ ticker: parsePublicTickerKey(symbol).symbol, window }, { force }) };
      } catch (error) {
        return { symbol, error };
      }
    });
    const read = reads.flatMap((entry) => "read" in entry && entry.read ? [{ symbol: entry.symbol, ...entry.read }] : []);
    const failed = reads.flatMap((entry) => "error" in entry ? [entry] : []);
    // Nothing read: the first failure is the answer, so a signed-out pane shows its wall.
    if (read.length === 0 && failed[0]) throw failed[0].error;
    const lines = read.flatMap((entry) => insiderActivityLines(entry.payload).map((line) => ({ ...line, ticker: entry.symbol })));
    const notes = [
      ...read.filter((entry) => !lines.some((line) => line.ticker === entry.symbol))
        .map((entry) => `${entry.symbol}: ${insiderActivityEmptyTitle(window)}`),
      ...failed.map((entry) => `${entry.symbol}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`),
      ...new Set(read.flatMap((entry) => [entry.payload.buy, entry.payload.sell]
        .map((payload) => insiderSignalsCoverageNotice(payload, { subject: "this list" }))
        .filter((notice): notice is string => !!notice))),
    ];
    return {
      key,
      lines,
      notes,
      asOf: read.map((entry) => entry.payload.buy.asOf).filter((at): at is string => !!at).sort().at(-1) ?? null,
      stale: read.some((entry) => entry.stale),
    };
  }, [key, symbols, window]);
  const resource = useAsyncResource(loader, {
    clearOnError: (error) => error instanceof Error && isCloudSessionRequired(error.message),
    keepPreviousData: true,
  });
  const answer = resource.data?.key === key ? resource.data : resource.loading ? resource.data ?? null : null;
  useAutoRefresh(resource.updatedAt, resource.load);

  // The opened company, and the insider whose trades it shows.
  const [openTicker, setOpenTicker] = usePluginPaneState<string | null>("insider:tickers:open", null);
  const [openInsider, setOpenInsider] = usePluginPaneState<string | null>("insider:tickers:insider", null);
  const [openView, setOpenView] = useState<InsiderViewMode>("trades");
  const [transactionOpen, setTransactionOpen] = useState(false);
  const detailOpen = !!openTicker;
  const resourceReload = resource.reload;
  const reload = useCallback(() => resourceReload().catch(logFailure("insider.tickers", "Insiders reload failed")), [resourceReload]);
  usePaneRefreshKey(reload, { focused, enabled: !detailOpen });

  const [sort, setSort] = useState<{ columnId: TickerColumnId; direction: SortDirection }>({ columnId: "bought", direction: "desc" });
  const lines = useMemo(() => answer?.lines ?? [], [answer]);
  const sortedLines = useMemo(() => {
    const order = new Map(lines.map((line, index) => [line, index]));
    const value = (line: TickerLine) => sort.columnId === "ticker" ? line.ticker : insiderActivitySortValue(line, sort.columnId);
    return [...lines].sort((a, b) => compareSortValues(value(a), value(b), sort.direction) || order.get(a)! - order.get(b)!);
  }, [lines, sort]);
  const columns = useMemo<TickerColumn[]>(() => {
    const tickerWidth = Math.max(displayWidth("Ticker") + 2, ...lines.map((line) => displayWidth(line.ticker)));
    return [
      { id: "ticker", label: "Ticker", width: tickerWidth, align: "left" },
      ...buildInsiderActivityColumns(Math.max(0, width - tickerWidth - COLUMN_GAP), lines),
    ];
  }, [lines, width]);
  const lineKey = useCallback((line: TickerLine) => `${line.ticker}:${insiderActivityKey(line)}`, []);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  usePaneStatusFooter({
    registrationId: "insider:tickers",
    enabled: !detailOpen,
    loading: resource.loading,
    error: answer ? resource.error : null,
    stale: !!answer?.stale,
    info: answer?.asOf
      ? [{ id: "asof", asOf: true, parts: [{ text: `as of ${formatShortDate(answer.asOf, { utc: true })}`, tone: "muted" as const }] }]
      : [],
  });
  usePaneNoticeFooter({ registrationId: "insider:tickers:notices", focused, enabled: !detailOpen, notices: answer?.notes ?? [] });

  const openControl = useMemo<InsiderViewControl>(() => ({
    view: openView, setView: setOpenView, window, setWindow, side: "buy",
  }), [openView, setWindow, window]);
  const openCompany = useCallback((line: TickerLine) => {
    setSelectedKey(lineKey(line));
    setOpenView("trades");
    setOpenInsider(line.buyer.name);
    setOpenTicker(line.ticker);
  }, [lineKey, setOpenInsider, setOpenTicker]);
  const closeCompany = useCallback(() => {
    setTransactionOpen(false);
    setOpenTicker(null);
    setOpenInsider(null);
  }, [setOpenInsider, setOpenTicker]);

  const renderCell = (line: TickerLine, column: TickerColumn, _index: number, state: { selected: boolean }): DataTableCell =>
    column.id === "ticker"
      ? listingCell(line.ticker, colors, state.selected)
      : insiderActivityCell(line, column as InsiderActivityColumn, colors, state.selected, !!nativePaneChrome);

  if (!answer && isCloudSessionRequired(resource.error)) {
    return <SignInWall placement="insider-tickers-signin" width={width} height={height} action="view insiders" needsVerification={session.needsVerification} />;
  }
  const queryBar = (
    <QueryBar
      width={width}
      filters={[{
        id: "window",
        label: "Window",
        title: "Days of insider buying and selling",
        value: String(window),
        defaultValue: String(DEFAULT_INSIDER_SIGNAL_WINDOW),
        options: INSIDER_SIGNAL_WINDOW_OPTIONS,
        inline: true,
        onChange: (value: string) => setWindow(Number(value)),
      }]}
      view={viewBar}
    />
  );
  if (!answer && !detailOpen) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {queryBar}
        <PaneStatusBody
          loading={resource.loading}
          error={resource.error}
          retry={{ onRetry: reload, pending: resource.loading }}
          subject="Insiders"
        />
      </Box>
    );
  }
  const company = openTicker
    ? renderCompany({
      symbol: parsePublicTickerKey(openTicker).symbol,
      title: openTicker,
      control: openControl,
      ...(openInsider ? { insider: openInsider } : {}),
      width,
      height,
      focused,
      onDetailChange: setTransactionOpen,
    })
    : null;
  return (
    <DataTableStackView<TickerLine, TickerColumn>
      focused={focused && !transactionOpen}
      detailOpen={detailOpen}
      onBack={closeCompany}
      detailTitle={openTicker ?? undefined}
      detailContent={company}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      columns={columns}
      items={sortedLines}
      getItemKey={lineKey}
      selection={{ kind: "id", selectedId: selectedKey, getId: lineKey, onChange: setSelectedKey }}
      onActivate={openCompany}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as TickerColumnId, {
        firstDirection: (id) => id === "ticker" ? "asc" : insiderActivityFirstDirection(id as InsiderActivityColumnId),
      }))}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      showHorizontalScrollbar={false}
      emptyStateTitle={insiderActivityEmptyTitle(window)}
      emptyStateHint="Enter on an insider shows their trades."
    />
  );
}
