import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  DataTableStackView,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableCell,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, useUiCapabilities } from "../../../ui";
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
import { insiderActivityCell, type InsiderViewControl } from "./insiders";
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

/**
 * INS on several tickers (`INS MO,PM,LMT`, or a watchlist's name): each
 * company's insiders over the window in one table, the Ticker column first,
 * as `fn INS MO,PM,LMT --view insiders` lists them. Enter opens the row's
 * company on that insider's trades, Back returns here.
 */
export function InsiderTickersView({ symbols, width, height, focused, renderCompany }: {
  symbols: readonly string[];
  width: number;
  height: number;
  focused: boolean;
  renderCompany: (company: InsiderOpenedCompany) => ReactNode;
}) {
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
