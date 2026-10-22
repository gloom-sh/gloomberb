import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  PageStackView,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneMenuItems,
  usePaneStatusFooter,
  type DataTableKeyEvent,
  type QueryBarFilter,
  type QueryBarView,
} from "../../../components";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { openFormModal } from "../../../components/form-modal";
import { FILL_REST } from "../../../components/ui/fill";
import type { EarningsCalendarQuery } from "../../../api-client/earnings";
import { useAppSelector, usePaneSettingValue } from "../../../state/app/context";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import type { EarningsEvent } from "../../../types/data-provider";
import { getSharedRegistry } from "../../registry/shared";
import { Box, useUiCapabilities } from "../../../ui";
import { useAssetData, usePluginAppActions, usePluginTickerActions } from "../../runtime";
import { earningsResultsAlertValues } from "../alerts/research-builder";
import { isBoardRowLoading, useQuoteBoard } from "../shared/use-quote-board";
import {
  addDays,
  boardReport,
  boardRows,
  fallbackReport,
  newYorkToday,
  ownershipBySymbol,
  relativeDays,
  reportMove,
  type BoardReport,
  type BoardRow,
  type BoardSort,
} from "./board-model";
import { boardColumns, boardHasActuals, renderBoardCell, renderBoardSection, SORTABLE, type BoardCellContext, type BoardColumn } from "./board-table";
import { EarningsCalendarView, CALENDAR_GROUP_ROWS, calendarSlotsPerRow } from "./calendar";
import {
  boardRangeDays,
  boardRangeLabel,
  boardRangeWeek,
  boardRangeWords,
  CALENDAR_WEEK_OFFSETS,
  calendarDays,
  calendarGroupKey,
  calendarWeekDates,
  calendarWeekLabel,
  isBoardRangeDay,
  requestedBoardRange,
  type BoardRange,
} from "./calendar-model";
import { cachedEarningsCalendar, earningsCalendarKey, loadEarningsBoard } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { EarningsHistoryView } from "./history";

const NO_SYMBOLS: string[] = [];
const NONE_EXPANDED: ReadonlySet<string> = new Set();

/** The stored calendar reaches about three months ahead. */
const HORIZON_DAYS = 90;
/** Ranked per day; a busy day has several hundred reports, most of them micro caps. */
const MARKET_PER_DAY = 200;
/** The server reads at most this many named companies. */
const MAX_SYMBOLS = 200;

type Order = "cap" | "mine";
type BoardView = "table" | "calendar";

const ORDER_OPTIONS: ReadonlyArray<{ value: Order; label: string }> = [{ value: "cap", label: "Size" }, { value: "mine", label: "Mine first" }];
/** The week as logos is for the desktop and the web; the terminal draws no logos and keeps the table. */
const ERN_VIEWS: ReadonlyArray<{ value: BoardView; label: string }> = [{ value: "table", label: "Table" }, { value: "calendar", label: "Calendar" }];

interface BoardData {
  /** The query read, by `earningsCalendarKey`: kept data from another week is not this week's. */
  queryKey: string;
  reports: BoardReport[];
  stale: boolean;
  refreshError: string | null;
}

/**
 * ERN without a ticker: the market's report days, largest companies first,
 * with the implied move and each company's average move. With tickers, or the
 * Mine filter, the upcoming reports of those companies instead.
 */
export function EarningsBoard({ focused, width, height, scopedSymbols, highlight = null }: {
  focused: boolean;
  width: number;
  height: number;
  /** Named on the command bar; empty for the market board. */
  scopedSymbols: readonly string[];
  /** `EVTS <ticker>`: the row to select when that company reports in these days. */
  highlight?: string | null;
}) {
  const dataProvider = useAssetData();
  const { navigateTicker } = usePluginTickerActions();
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  usePaneMenuItems("earnings:catalysts", () => [{ id: "catalysts", label: "Catalyst calendar", onSelect: () => createPaneFromTemplate("catalysts-pane") }], [createPaneFromTemplate]);
  const tickers = useAppSelector((state) => state.tickers);
  // Ticker records change for many reasons; the board reloads only when the held and watched names do.
  const ownedKey = useMemo(
    () => [...ownershipBySymbol(tickers.values())].map(([symbol, kind]) => `${symbol}:${kind}`).sort().join(","),
    [tickers],
  );
  const owned = useMemo(
    () => new Map(ownedKey ? ownedKey.split(",").map((entry) => entry.split(":") as [string, "held" | "watched"]) : []),
    [ownedKey],
  );
  const [mineOnly, setMineOnly] = usePluginPaneState<boolean>("mineOnly", false);
  const [order, setOrder] = usePluginPaneState<Order>("order", "cap");
  const [sort, setSort] = usePluginPaneState<BoardSort>("sort", { column: "cap", direction: "desc" });
  // Keyed by symbol and date, so a reload or a shared layout keeps the row.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  const [openKey, setOpenKey] = usePluginPaneState<string | null>("openEvent", null);
  // A layout or `gloomberb shot ERN NVDA,AMD --open NVDA` lands on that company's history.
  const [openSymbol] = usePaneSettingValue<string>("open", "");
  // A layout's `view` setting opens on the week; a choice made in the pane wins.
  const [requestedView] = usePaneSettingValue<string>("view", "");
  const [chosenView, setView] = usePluginPaneState<BoardView | null>("view", null);
  // `EVTS --week last` or `--date 2026-10-15` opens on those days; a choice in the bar's Range wins. One
  // range for both views: the table draws its days, the calendar its week (this week for the days ahead).
  const [requestedDate] = usePaneSettingValue<string>("date", "");
  const [requestedWeek] = usePaneSettingValue<string>("week", "");
  const [range, setRange] = usePluginPaneState<BoardRange>("range", requestedBoardRange(requestedDate, requestedWeek));
  // The calendar's groups opened past their "+N more" slot, by `calendarGroupKey`.
  const [expanded, setExpanded] = useState(NONE_EXPANDED);
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const view: BoardView = !desktop ? "table"
    : chosenView ?? (ERN_VIEWS.some((option) => option.value === requestedView) ? requestedView as BoardView : "table");
  const calendar = view === "calendar";
  const openedSymbol = useRef<string | null>(null);
  const highlighted = useRef<string | null>(null);

  const today = newYorkToday();
  const market = scopedSymbols.length === 0 && !mineOnly;
  const named = useMemo(
    () => (scopedSymbols.length > 0 ? [...scopedSymbols] : [...owned.keys()]).slice(0, MAX_SYMBOLS),
    [owned, scopedSymbols],
  );
  // The days ahead by default; a chosen week or day, past or ahead, for the market and for named companies alike.
  const days = useMemo(() => (market || range ? boardRangeDays(range, today) : relativeDays(today)), [market, range, today]);
  const weekOffset = boardRangeWeek(range, today);
  const week = useMemo(() => calendarWeekDates(today, weekOffset), [today, weekOffset]);
  // The calendar reads its week, reported days included; the table its days.
  const query = useMemo<EarningsCalendarQuery>(() => calendar
    ? { from: week[0]!, to: week.at(-1)!, perDay: market ? MARKET_PER_DAY : 0, symbols: named }
    : market || range
      ? { from: days[0]!.from, to: days.at(-1)!.to, perDay: market ? MARKET_PER_DAY : 0, symbols: named }
      : { from: today, to: addDays(today, HORIZON_DAYS), perDay: 0, symbols: named },
  [calendar, days, market, named, range, today, week]);
  const queryKey = earningsCalendarKey(query);

  const loader = useCallback(async (force: boolean): Promise<BoardData> => {
    if (!market && named.length === 0) return { queryKey, reports: [], stale: false, refreshError: null };
    // Named companies also go to the per-ticker calendar, which covers listings the stored one does not.
    const [cloud, fallback] = await Promise.allSettled([
      loadEarningsBoard(query, force),
      market ? Promise.resolve([] as EarningsEvent[]) : loadEarningsCalendar(dataProvider, named, { force }).then((result) => result.events
        // The per-ticker calendar is upcoming reports; a week or a chosen range keeps those in it.
        .filter((event) => (!calendar && !range) || (event.earningsDate.toISOString().slice(0, 10) >= query.from && event.earningsDate.toISOString().slice(0, 10) <= query.to))),
    ]);
    if (cloud.status === "rejected" && (market || fallback.status === "rejected")) throw cloud.reason;
    const reports = cloud.status === "fulfilled" ? cloud.value.payload.reports.map((report) => boardReport(report, owned)) : [];
    const covered = new Set(reports.map((report) => report.symbol));
    const extra = fallback.status === "fulfilled"
      ? fallback.value.filter((event) => !covered.has(event.symbol)).map((event) => fallbackReport(event, owned, today))
      : [];
    return {
      queryKey,
      reports: [...reports, ...extra],
      stale: cloud.status === "fulfilled" && cloud.value.stale,
      refreshError: cloud.status === "rejected"
        ? (cloud.reason instanceof Error ? cloud.reason.message : String(cloud.reason))
        : cloud.value.refreshError,
    };
  }, [calendar, dataProvider, market, named, owned, query, queryKey, range, today]);
  const resource = useAsyncResource(loader, {
    keepPreviousData: true,
    initialData: () => {
      const cached = cachedEarningsCalendar(query);
      return cached ? { queryKey, reports: cached.payload.reports.map((report) => boardReport(report, owned)), stale: false, refreshError: null } : null;
    },
  });
  const data = resource.data;
  // The week on screen is only the one read for it, never the last week's kept while this one loads or after it failed.
  const weekData = data?.queryKey === queryKey ? data : null;
  const rows = useMemo(() => boardRows(data?.reports ?? [], days, sort, order === "mine"), [data, days, order, sort]);
  const reportRows = useMemo(() => rows.filter((row): row is BoardRow & { kind: "report" } => row.kind === "report"), [rows]);
  const slotsPerRow = calendarSlotsPerRow(width);
  const weekDays = useMemo(
    () => (calendar
      ? calendarDays(weekData?.reports ?? [], week, { today, mineFirst: order === "mine", limit: slotsPerRow * CALENDAR_GROUP_ROWS, expanded })
      : []),
    [calendar, expanded, order, slotsPerRow, today, week, weekData],
  );
  const selectedReport = calendar
    ? weekData?.reports.find((report) => report.key === selectedKey) ?? null
    : (reportRows.find((row) => row.key === selectedKey) ?? reportRows[0] ?? null)?.report ?? null;
  const selected = reportRows.find((row) => row.key === selectedKey) ?? reportRows[0] ?? null;
  const open = reportRows.find((row) => row.key === openKey)?.report
    ?? (openKey ? data?.reports.find((report) => report.key === openKey) : undefined) ?? null;
  // A board with an actual keeps EPS ACT and EPS SURP when narrow; keyed by the flag, so the columns hold between renders.
  const actuals = boardHasActuals(rows);
  const columns = useMemo(() => boardColumns(width, { actuals }), [actuals, width]);
  // The move on each report out today, beside its implied move, from the quotes every board reads.
  // Keyed by content: the rows are rebuilt on renders that change nothing, and the quote board reloads on a new list.
  const reportedKey = [...new Set(reportRows.filter((row) => row.report.dateStatus === "reported" && row.report.date === today)
    .map((row) => row.report.symbol))].join(",");
  const reportedSymbols = useMemo(() => (reportedKey ? reportedKey.split(",") : []), [reportedKey]);
  const liveStreaming = useLiveStreamingSetting();
  const { quotes } = useQuoteBoard(calendar ? NO_SYMBOLS : reportedSymbols, { liveStreaming, selectedSymbol: calendar ? null : selected?.report.symbol ?? null });
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  const statusShown = columns.some((column) => column.id === "status");
  const logos = desktop;
  // Stable while the quotes tick: each row redraws by its own quote's version.
  const renderCell = useCallback((row: BoardRow, column: BoardColumn) => {
    const context: BoardCellContext = {
      statusShown,
      logos,
      move: (report) => {
        const state = quotesRef.current.get(report.symbol);
        const move = reportMove(report, state?.quote, today);
        return move == null && report.dateStatus === "reported" && report.date === today && isBoardRowLoading(state) ? "loading" : move;
      },
    };
    return renderBoardCell(row, column, context);
  }, [logos, statusShown, today]);
  const rowVersion = useCallback((row: BoardRow) => {
    if (row.kind !== "report") return row.key;
    const state = quotes.get(row.report.symbol);
    return state ? `${state.quote?.lastUpdated ?? ""}:${state.loading}` : row.key;
  }, [quotes]);

  useEffect(() => {
    const symbol = openSymbol.trim().toUpperCase();
    if (!symbol || openedSymbol.current === symbol || !data) return;
    const match = data.reports.find((report) => report.symbol === symbol);
    if (!match) return;
    openedSymbol.current = symbol;
    setOpenKey(match.key);
  }, [data, openSymbol, setOpenKey]);

  useEffect(() => {
    if (!highlight || highlighted.current === highlight) return;
    const row = reportRows.find((candidate) => candidate.report.symbol === highlight);
    if (!row) return;
    highlighted.current = highlight;
    setSelectedKey(row.key);
  }, [highlight, reportRows, setSelectedKey]);

  useAutoRefresh(resource.updatedAt, resource.load);
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  usePaneStatusFooter({
    registrationId: "earnings-board",
    enabled: !open,
    loading: resource.loading,
    error: resource.error ?? data?.refreshError ?? null,
    stale: !!data?.stale,
    info: data && updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : [],
  });
  const symbol = open?.symbol ?? selectedReport?.symbol ?? null;
  // The desktop and the web only: the terminal's footer stays as it was.
  const alerts = desktop && getSharedRegistry()?.commands.has("set-event-alert") === true;
  usePaneFooter("earnings-actions", () => ({
    order: 10,
    hints: symbol
      ? [
          { id: "catalysts", key: "v", label: "iew catalysts", onPress: () => createPaneFromTemplate("catalysts-pane", { symbol }) },
          { id: "ticker", key: "t", label: "icker", onPress: () => navigateTicker(symbol) },
          { id: "estimates", key: "e", label: "stimates", onPress: () => createPaneFromTemplate("earnings-estimates-pane", { symbol }) },
          { id: "calls", key: "c", label: "alls", onPress: () => createPaneFromTemplate("earnings-calls-pane", { symbol }) },
          { id: "analysts", key: "a", label: "nalysts", onPress: () => createPaneFromTemplate("analyst-research-pane", { symbol }) },
          // ALRT's earnings alert, set to go off when the results are out.
          ...(alerts ? [{ id: "alert", key: "n", label: "otify", title: "Earnings alert", onPress: () => {
            if (!openEarningsAlert(symbol)) notify({ body: "Open this from the main window.", type: "info" });
          } }] : []),
        ]
      : [],
  }), [alerts, createPaneFromTemplate, navigateTicker, notify, symbol]);

  // t, e, c, a and n are footer hints, which bind their own keys.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, () => void resource.reload()), [resource.reload]);
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: calendar && !open });

  const sortColumn = (Object.entries(SORTABLE).find(([, value]) => value === sort.column)?.[0]) ?? null;
  const mineFilter: QueryBarFilter[] = scopedSymbols.length > 0 ? [] : [
    { id: "mine", kind: "toggle", label: "Mine", value: mineOnly, defaultValue: false, onChange: setMineOnly },
  ];
  const orderView: QueryBarView<Order> = { value: order, options: ORDER_OPTIONS, onChange: setOrder };
  // The weeks the bar offers, last week to three ahead, and the one on screen when it is another.
  const weekOptions = (shown: number | null) => [...new Set([...CALENDAR_WEEK_OFFSETS, ...(shown == null ? [] : [shown])])]
    .sort((left, right) => left - right)
    .map((offset) => ({ value: String(offset), label: calendarWeekLabel(today, offset) }));
  // One Range for both views. The table's: the days ahead, a week, or a day asked for (`--date`), which stays a
  // choice once the bar moves off it. The calendar's: the week it draws, a day's own week.
  const rangeDates = [...new Set([requestedDate, range].filter(isBoardRangeDay))];
  const rangeFilter: QueryBarFilter = calendar
    ? { id: "range", label: "Range", value: String(weekOffset), options: weekOptions(weekOffset), onChange: setRange }
    : {
      id: "range",
      label: "Range",
      value: range,
      defaultValue: "",
      options: [
        { value: "", label: "Upcoming" },
        ...weekOptions(range && !isBoardRangeDay(range) ? weekOffset : null),
        ...rangeDates.map((date) => ({ value: date, label: boardRangeLabel(date, today)! })),
      ],
      onChange: (value: string) => { setRange(value); setSelectedKey(null); },
    };
  // On the desktop the view picks the table or the week, and the order is a filter beside Mine and the Range.
  const queryBar = !desktop ? <QueryBar width={width} filters={[...mineFilter, rangeFilter]} view={orderView} /> : (
    <QueryBar
      width={width}
      filters={[
        ...mineFilter,
        rangeFilter,
        { id: "order", label: "Order", inline: true, value: order, options: ORDER_OPTIONS, onChange: setOrder },
      ]}
      view={{ value: view, options: ERN_VIEWS, onChange: setView }}
    />
  );
  // "last week", "on Thu Oct 15", "in the week of Nov 2": the days the empty board or week is of.
  const rangeWords = calendar ? boardRangeWords(String(weekOffset), today) : boardRangeWords(range, today);
  const emptyStateTitle = market ? `No reports on the calendar ${rangeWords ?? "these days"}.`
    : named.length === 0 ? "No portfolio or watchlist names."
      : rangeWords ? `No reports from these companies ${rangeWords}.` : "No upcoming reports.";
  const history = open ? (
    <EarningsHistoryView key={open.symbol} symbol={open.symbol} width={width} height={Math.max(4, height - 1)}
      focused={focused} registrationId="earnings-history" />
  ) : null;

  if (calendar) {
    // The query bar stays up while a week loads or fails, so another week or the table is a click away.
    return (
      <PageStackView
        focused={focused}
        detailOpen={!!open}
        onBack={() => setOpenKey(null)}
        detailTitle={open ? `${open.symbol} · ${open.name}` : undefined}
        rootContent={(
          <Box flexDirection="column" {...FILL_REST}>
            {queryBar}
            <EarningsCalendarView
              days={weekDays}
              width={width}
              focused={focused && !open}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onOpen={(report) => setOpenKey(report.key)}
              onMore={(day, group) => {
                // The group draws in full, the cursor on the first company its last slot counted.
                const all = calendarDays(weekData?.reports ?? [], [day.date], { today, mineFirst: order === "mine" })[0]
                  ?.groups.find((entry) => entry.session === group.session);
                setExpanded((current) => new Set(current).add(calendarGroupKey(day.date, group.session)));
                const next = all?.reports[group.reports.length];
                if (next) setSelectedKey(next.key);
              }}
              loading={!weekData && !resource.error}
              error={weekData ? null : resource.error}
              emptyTitle={emptyStateTitle}
            />
          </Box>
        )}
        detailContent={history}
      />
    );
  }

  return (
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} subject="the earnings calendar">
      <DataTableStackView<BoardRow, BoardColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={height}
        rootBefore={queryBar}
        columns={columns}
        items={rows}
        getItemKey={(row) => row.key}
        isNavigable={(row) => row.kind === "report"}
        renderSectionHeader={renderBoardSection}
        renderCell={renderCell}
        getRowVersion={rowVersion}
        selectedTextOverridesCellColor
        sortColumnId={sortColumn}
        sortDirection={sort.direction}
        onHeaderClick={(columnId) => {
          const column = SORTABLE[columnId as BoardColumn["id"]];
          if (!column) return;
          setSort((current) => ({ column, direction: current.column === column && current.direction === "desc" ? "asc" : column === "symbol" ? "asc" : "desc" }));
        }}
        selection={{
          kind: "index",
          selectedIndex: selected ? rows.indexOf(selected) : -1,
          onChange: (_index, row) => { if (row.kind === "report") setSelectedKey(row.key); },
        }}
        onActivate={(row) => { if (row.kind === "report") setOpenKey(row.key); }}
        onRootKeyDown={handleKeyDown}
        detailOpen={!!open}
        onBack={() => setOpenKey(null)}
        detailTitle={open ? `${open.symbol} · ${open.name}` : undefined}
        detailContent={history}
        emptyStateTitle={emptyStateTitle}
      />
    </PaneStatusBody>
  );
}

/** ALRT's form for an earnings alert on `symbol`, set to go off when the results are out. */
function openEarningsAlert(symbol: string): boolean {
  return openFormModal({ kind: "plugin-command", commandId: "set-event-alert", values: earningsResultsAlertValues(symbol) });
}
