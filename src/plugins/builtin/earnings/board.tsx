import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  PageStackView,
  QueryBar,
  usePaneFooter,
  usePaneMenuItems,
  usePaneStatusFooter,
  usePaneTabs,
  type DataTableKeyEvent,
  type QueryBarFilter,
  type QueryBarView,
} from "../../../components";
import { ageFooterSegment } from "../../../components/layout/pane/footer";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { openFormModal } from "../../../components/form-modal";
import { FILL_REST } from "../../../components/ui/fill";
import type { EarningsCalendarQuery } from "../../../api-client/earnings";
import { useAppSelector, usePaneAppConfig, usePaneSettingValue } from "../../../state/app/context";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import { useUtcDay } from "../../../react/auto-refresh";
import { withSavedCopyMarkOf } from "../../../data/saved-copies";
import { reportFooterSegment } from "../shared/source-footer";
import { earningsBoardHeadless } from "./headless";
import type { EarningsEvent } from "../../../types/data-provider";
import { getSharedRegistry } from "../../registry/shared";
import { Box, useUiCapabilities } from "../../../ui";
import { useAssetData, usePluginAppActions, usePluginTickerActions } from "../../runtime";
import { earningsResultsAlertValues } from "../alerts/research-builder";
import { cachedMembers, loadMembers } from "../members/client";
import { isBoardRowLoading, useQuoteBoard } from "../shared/use-quote-board";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadEarningsHighlight } from "./highlight";
import {
  addDays,
  boardKey,
  boardReport,
  boardRowOf,
  boardRows,
  fallbackReport,
  newYorkToday,
  ownershipBySymbol,
  relativeDays,
  boardMove,
  boardReportKind,
  type BoardKind,
  type BoardReport,
  type BoardRow,
  type BoardSort,
} from "./board-model";
import { BOARD_CURRENCY_EXPORT, boardColumns, boardHasCurrencies, boardSymbolWidth, renderBoardCell, renderBoardSection, SORTABLE, type BoardCellContext, type BoardColumn } from "./board-table";
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
  noCalendarReportsTitle,
  requestedBoardRange,
  type BoardRange,
} from "./calendar-model";
import { cachedEarningsCalendar, earningsCalendarKey, loadEarningsBoard } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { EarningsHistoryView } from "./history";
import {
  ALL_SCOPE,
  earningsScopeOptions,
  MINE_SCOPE,
  readEarningsScope,
  fundSymbols,
  type EarningsScope,
} from "./scope";

const NO_SYMBOLS: string[] = [];
const NONE_EXPANDED: ReadonlySet<string> = new Set();

/** The stored calendar reaches about three months ahead. */
const HORIZON_DAYS = 90;
/** Ranked per day; a busy day has several hundred reports, most of them micro caps. */
const MARKET_PER_DAY = 200;
/** The server reads at most this many named companies. */
const MAX_SYMBOLS = 200;

const MARKET_SCOPE: EarningsScope = { kind: "all" };
/** A fund's companies the board reads, its largest first. */
const fundNames = (members: Parameters<typeof fundSymbols>[0]) => fundSymbols(members).slice(0, MAX_SYMBOLS);

type Order = "cap" | "mine";
type BoardView = "table" | "calendar";

const ORDER_OPTIONS: ReadonlyArray<{ value: Order; label: string }> = [{ value: "cap", label: "Size" }, { value: "mine", label: "Mine first" }];
/** The week as logos is for the desktop and the web; the terminal draws no logos and keeps the table. */
const ERN_VIEWS: ReadonlyArray<{ value: BoardView; label: string }> = [{ value: "table", label: "Table" }, { value: "calendar", label: "Calendar" }];
/** The table's reports to come and reports out, each with columns of its own. */
const BOARD_KINDS: Array<{ value: BoardKind; label: string }> = [{ value: "upcoming", label: "Upcoming" }, { value: "reported", label: "Reported" }];
const isBoardKind = (value: unknown): value is BoardKind => value === "upcoming" || value === "reported";

interface BoardData {
  /** The query read, by `earningsCalendarKey`: kept data from another week is not this week's. */
  queryKey: string;
  reports: BoardReport[];
  /** When the service built the calendar read, which dates the board; null without one. */
  asOf: string | null;
  stale: boolean;
  refreshError: string | null;
}

/**
 * ERN without a ticker: the market's report days, largest companies first,
 * with the implied move and each company's average move. With tickers, or the
 * Names filter (Mine, a portfolio, a watchlist or a fund's holdings),
 * the upcoming reports of those companies instead. Every board reads the Hong
 * Kong, China A and Singapore top 100's reports too, ranked by their value in
 * dollars beside US companies, a code after each figure not in dollars.
 */
export function EarningsBoard({ focused, width, height, scopedSymbols, highlight = null }: {
  focused: boolean;
  width: number;
  height: number;
  /** Named on the command bar; empty for the market board. */
  scopedSymbols: readonly string[];
  /** `EVTS <ticker>`: open on this company's report and select its row. */
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
  // Before the Names filter, a Mine toggle; a layout saved with it on opens on Mine.
  const [mineOnly] = usePluginPaneState<boolean>("mineOnly", false);
  const [savedScope, setScope] = usePluginPaneState<string | null>("scope", null);
  const [order, setOrder] = usePluginPaneState<Order>("order", "cap");
  const [sort, setSort] = usePluginPaneState<BoardSort>("sort", { column: "cap", direction: "desc" });
  // Keyed by symbol and date, so a reload or a shared layout keeps the row.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  const [openKey, setOpenKey] = usePluginPaneState<string | null>("openEvent", null);
  // A layout or `gloom shot ERN NVDA,AMD --open NVDA` lands on that company's history.
  const [openSymbol] = usePaneSettingValue<string>("open", "");
  // A layout's `view` setting opens on the week; a choice made in the pane wins.
  const [requestedView] = usePaneSettingValue<string>("view", "");
  const [chosenView, setView] = usePluginPaneState<BoardView | null>("view", null);
  // `EVTS --week last` or `--date 2026-10-15` opens on those days; a choice in the bar's Range wins. One
  // range for both views: the table draws its days, the calendar its week (this week for the days ahead).
  const [requestedDate] = usePaneSettingValue<string>("date", "");
  const [requestedWeek] = usePaneSettingValue<string>("week", "");
  const [chosenRange, setRange] = usePluginPaneState<BoardRange | null>("range", null);
  // The table's Upcoming or Reported view: a layout's or `shot`'s `kind` setting, else the reports to come while the
  // range has any; a choice made in the pane wins.
  const [requestedKind] = usePaneSettingValue<string>("kind", "");
  const [chosenKind, setKind] = usePluginPaneState<BoardKind | null>("kind", null);
  // The calendar's groups opened past their "+N more" slot, by `calendarGroupKey`.
  const [expanded, setExpanded] = useState(NONE_EXPANDED);
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const config = usePaneAppConfig();
  const scopeOptions = useMemo(
    () => earningsScopeOptions({ portfolios: config.portfolios, watchlists: config.watchlists }),
    [config.portfolios, config.watchlists],
  );
  const scopeOption = readEarningsScope(savedScope ?? (mineOnly ? MINE_SCOPE : ALL_SCOPE), scopeOptions);
  const scoped = scopedSymbols.length > 0;
  const scope = scoped ? MARKET_SCOPE : scopeOption.scope;
  const view: BoardView = !desktop ? "table"
    : chosenView ?? (ERN_VIEWS.some((option) => option.value === requestedView) ? requestedView as BoardView : "table");
  const calendar = view === "calendar";
  const openedSymbol = useRef<string | null>(null);
  const highlighted = useRef<string | null>(null);

  const today = newYorkToday();
  const market = !scoped && scope.kind === "all";
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "pro" : "free"}`;
  const highlightLoader = useCallback(async (force: boolean) => ({
    value: await loadEarningsHighlight(highlight!, today, dataProvider, force, accessKey),
  }), [accessKey, dataProvider, highlight, today]);
  const highlightedReport = useAsyncResource(market && highlight ? highlightLoader : null, {
    savedCopy: session.displayScope ? { key: ["earnings-highlight", highlight, today, session.displayScope] } : null,
    shouldSave: ({ value }) => !value?.refreshError,
  });
  const highlightedData = highlightedReport.data?.value;
  const range = chosenRange ?? (requestedBoardRange(requestedDate, requestedWeek) || highlightedData?.report.date || "");
  // Keyed by content: ticker records change for many reasons, the board reloads only when the list's names do.
  const collectionKey = useMemo(() => {
    if (scope.kind !== "portfolio" && scope.kind !== "watchlist") return "";
    return [...tickers.values()]
      .filter(({ metadata }) => (scope.kind === "portfolio" ? metadata.portfolios : metadata.watchlists).includes(scope.id))
      .map(({ metadata }) => metadata.ticker.trim().toUpperCase())
      .sort()
      .join(",");
  }, [scope, tickers]);
  const fund = scope.kind === "fund" ? scope : null;
  // A fund's companies come with its holdings, which the loader reads; the others are known here.
  const named = useMemo(() => {
    const names = scoped ? [...scopedSymbols]
      : scope.kind === "portfolio" || scope.kind === "watchlist" ? (collectionKey ? collectionKey.split(",") : [])
        : scope.kind === "fund" ? [] : [...owned.keys()];
    return names.slice(0, MAX_SYMBOLS);
  }, [collectionKey, owned, scope.kind, scoped, scopedSymbols]);
  // Named companies also go to the per-ticker calendar, which covers listings the stored one does not;
  // fund scopes use the stored calendar, including members outside the S&P 500.
  const perTicker = !market && !fund;
  // The days ahead by default; a chosen week or day, past or ahead, for the market and for named companies alike.
  const days = useMemo(() => (market || range ? boardRangeDays(range, today) : relativeDays(today)), [market, range, today]);
  const weekOffset = boardRangeWeek(range, today);
  const week = useMemo(() => calendarWeekDates(today, weekOffset), [today, weekOffset]);
  // EVTS 0700.HK names its listing, which the market board then keeps whatever the day's cut.
  const highlightListing = market && highlight ? boardKey(highlight) : null;
  // The calendar reads its week, reported days included; the table its days. A report not in dollars says its
  // currency after its figures, so every board reads the listings abroad too.
  const query = useMemo<EarningsCalendarQuery>(() => {
    const symbols = highlightListing && !named.includes(highlightListing) ? [...named, highlightListing] : named;
    return calendar
      ? { from: week[0]!, to: week.at(-1)!, perDay: market ? MARKET_PER_DAY : 0, symbols, markets: "all" }
      : market || range
        ? { from: days[0]!.from, to: days.at(-1)!.to, perDay: market ? MARKET_PER_DAY : 0, symbols, markets: "all" }
        : { from: today, to: addDays(today, HORIZON_DAYS), perDay: 0, symbols, markets: "all" };
  }, [calendar, days, highlightListing, market, named, range, today, week]);
  // A fund's read is named by the fund: its companies are known once its holdings are.
  const queryKey = fund ? `${fund.etf}|${earningsCalendarKey(query)}` : earningsCalendarKey(query);

  const loader = useCallback(async (force: boolean): Promise<BoardData> => {
    const holdings = fund ? await loadMembers(fund.etf, force) : null;
    const names = holdings ? fundNames(holdings.payload.members) : named;
    if (!market && names.length === 0) return { queryKey, reports: [], asOf: null, stale: !!holdings && (holdings.stale || holdings.payload.stale), refreshError: holdings?.refreshError ?? null };
    const read = fund ? { ...query, symbols: names } : query;
    const [cloud, fallback] = await Promise.allSettled([
      loadEarningsBoard(read, force),
      !perTicker ? Promise.resolve([] as EarningsEvent[]) : loadEarningsCalendar(dataProvider, names, { force }).then((result) => result.events
        // The per-ticker calendar is upcoming reports; a week or a chosen range keeps those in it.
        .filter((event) => (!calendar && !range) || (event.earningsDate.toISOString().slice(0, 10) >= read.from && event.earningsDate.toISOString().slice(0, 10) <= read.to))),
    ]);
    if (cloud.status === "rejected" && (!perTicker || fallback.status === "rejected")) throw cloud.reason;
    const reports = cloud.status === "fulfilled" ? cloud.value.payload.reports.map((report) => boardReport(report, owned)) : [];
    // A listing abroad named by another of its company's lines (0939.HK) is covered by its row.
    const covered = new Set(reports.flatMap((report) => [report.symbol, ...report.listings ?? []]));
    const extra = fallback.status === "fulfilled"
      ? fallback.value.filter((event) => !covered.has(event.symbol)).map((event) => fallbackReport(event, owned, today))
      : [];
    const target = highlightedData?.report;
    if (target && target.date >= read.from && target.date <= read.to && ![...reports, ...extra].some((report) => boardRowOf(report, target.symbol))) {
      extra.push({ ...target, owned: owned.get(target.symbol) ?? null });
    }
    return withSavedCopyMarkOf({
      queryKey,
      reports: [...reports, ...extra],
      asOf: cloud.status === "fulfilled" ? cloud.value.payload.asOf : null,
      stale: (!!holdings && (holdings.stale || holdings.payload.stale)) || (cloud.status === "fulfilled" && cloud.value.stale),
      refreshError: cloud.status === "rejected"
        ? (cloud.reason instanceof Error ? cloud.reason.message : String(cloud.reason))
        : holdings?.refreshError ?? cloud.value.refreshError,
    }, cloud.status === "fulfilled" ? cloud.value : null);
  }, [calendar, dataProvider, highlightedData, market, named, owned, perTicker, query, queryKey, range, fund, today, session.displayScope]);
  const resource = useAsyncResource(highlightedReport.loading ? null : loader, {
    keepPreviousData: session.displayScope,
    savedCopy: session.displayScope ? { key: ["earnings-board", queryKey, accessKey] } : null,
    initialData: () => {
      const holdings = fund ? cachedMembers(fund.etf) : null;
      if (fund && !holdings) return null;
      const cached = cachedEarningsCalendar(holdings ? { ...query, symbols: fundNames(holdings.payload.members) } : query);
      return cached ? withSavedCopyMarkOf({ queryKey, reports: cached.payload.reports.map((report) => boardReport(report, owned)), asOf: cached.payload.asOf, stale: !!holdings?.payload.stale, refreshError: null }, cached) : null;
    },
  });
  // A new fund or range never shows the previous scope while its holdings load or fail.
  const data = resource.data?.queryKey === queryKey ? resource.data : null;
  const weekData = data;
  const kinds = useMemo(() => {
    const split: Record<BoardKind, BoardReport[]> = { upcoming: [], reported: [] };
    for (const report of data?.reports ?? []) split[boardReportKind(report, today)].push(report);
    return split;
  }, [data, today]);
  const kind: BoardKind = chosenKind ?? (isBoardKind(requestedKind) ? requestedKind
    : kinds.upcoming.length > 0 || kinds.reported.length === 0 ? "upcoming" : "reported");
  const rows = useMemo(() => boardRows(kinds[kind], days, sort, order === "mine"), [days, kind, kinds, order, sort]);
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
  // Each view has its own columns, with room for a code after the figures while one of its reports is in another
  // currency than dollars; keyed by the flags, so the columns hold between renders.
  const currencies = boardHasCurrencies(rows);
  // TICKER fits a listing abroad's key (601939:SSE) when the board has one.
  const symbolWidth = boardSymbolWidth(rows);
  const columns = useMemo(() => boardColumns(width, { kind, currencies, symbolWidth }), [currencies, kind, symbolWidth, width]);
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
        const move = boardMove(report, state?.quote, today);
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
    if (!highlight || highlighted.current === highlight || !data) return;
    // 0700.HK as typed is the board's 0700:HKEX; 0939.HK is CCB's row under its A share. In the range, in its view.
    const report = boardRows(data.reports, days, sort, false).find((candidate): candidate is BoardRow & { kind: "report" } =>
      candidate.kind === "report" && boardRowOf(candidate.report, highlight))?.report;
    if (!report) return;
    highlighted.current = highlight;
    // A view named by `--kind` or a layout's `kind` wins: the ticker's report is selected only in it.
    const reportKind = boardReportKind(report, today);
    if (isBoardKind(requestedKind)) {
      if (requestedKind === reportKind) setSelectedKey(report.key);
      return;
    }
    setKind(reportKind);
    setSelectedKey(report.key);
  }, [data, days, highlight, requestedKind, setKind, setSelectedKey, sort, today]);

  useAutoRefresh(resource.updatedAt, resource.load);
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const utcDay = useUtcDay();
  // Its source and when the calendar was read, as `fn EVTS` ends; how long ago it loaded goes first on a narrow row.
  const highlightMissing = market && highlight && !resource.loading && !highlightedReport.loading && !data?.reports.some((report) => boardRowOf(report, highlight));
  const footerInfo = useMemo(() => [
    ...(highlightMissing ? [{ id: "highlight", capture: true, parts: [{
      text: highlightedReport.error ? `${highlight}: report date unavailable`
        : highlightedData ? `${highlight} reports on ${highlightedData.report.date}; not in this range`
          : `No report date for ${highlight}.`,
      tone: "warning" as const,
    }] }] : []),
    ...(data ? [reportFooterSegment(earningsBoardHeadless, { rows: [], metadata: { asOf: data.asOf } }),
      ...(updatedAgo ? [ageFooterSegment(updatedAgo)] : [])] : []),
  ], [data, highlight, highlightedData, highlightedReport.error, highlightMissing, updatedAgo, utcDay]);
  usePaneStatusFooter({
    registrationId: "earnings-board",
    enabled: !open,
    loading: resource.loading || highlightedReport.loading,
    error: resource.error ?? highlightedReport.error ?? data?.refreshError ?? highlightedData?.refreshError ?? null,
    stale: !!data?.stale || !!highlightedData?.stale,
    info: footerInfo,
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
  const refresh = useCallback(() => { highlightedReport.reload(); resource.reload(); }, [highlightedReport.reload, resource.reload]);
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, refresh), [refresh]);
  usePaneRefreshKey(refresh, { focused, enabled: calendar && !open });

  const sortColumn = (Object.entries(SORTABLE).find(([, value]) => value === sort.column)?.[0]) ?? null;
  const namesFilter: QueryBarFilter[] = scoped ? [] : [{
    id: "names",
    label: "Names",
    value: scopeOption.value,
    defaultValue: ALL_SCOPE,
    options: scopeOptions.map(({ value, label, description, group, scope }) => ({ value, label, description, group, short: !desktop && scope.kind === "fund" ? scope.etf : undefined })),
    onChange: (value: string) => setScope(value),
  }];
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
      // Another range opens on its reports to come, or on those out when none is.
      onChange: (value: string) => { setRange(value); setSelectedKey(null); setKind(null); },
    };
  // On the desktop the view picks the table or the week, and the order is a filter beside the names and the Range.
  const queryBar = !desktop ? <QueryBar width={width} filters={[...namesFilter, rangeFilter]} view={orderView} /> : (
    <QueryBar
      width={width}
      filters={[
        ...namesFilter,
        rangeFilter,
        { id: "order", label: "Order", inline: true, value: order, options: ORDER_OPTIONS, onChange: setOrder },
      ]}
      view={{ value: view, options: ERN_VIEWS, onChange: setView }}
    />
  );
  // "last week", "on Thu Oct 15", "in the week of Nov 2": the days the empty board or week is of.
  const rangeWords = calendar ? boardRangeWords(String(weekOffset), today) : boardRangeWords(range, today);
  // A view with none of the range's reports says so: all are out, or none is yet.
  const otherKind = kind === "upcoming" ? kinds.reported.length > 0 : kinds.upcoming.length > 0;
  const emptyStateTitle = !calendar && otherKind
    ? kind === "upcoming" ? `Every report ${rangeWords ?? "these days"} is out.` : "None of these reports is out yet."
    : market ? noCalendarReportsTitle(rangeWords)
    : scope.kind === "mine" && named.length === 0 ? "No portfolio or watchlist names."
      : (scope.kind === "portfolio" || scope.kind === "watchlist") && named.length === 0 ? `No tickers in ${scope.name}.`
        : rangeWords ? `No reports from these companies ${rangeWords}.` : "No upcoming reports.";
  // The table's two views. The week draws both kinds as logos, and a company's report history replaces the board.
  const { strip: kindStrip, rows: kindRows } = usePaneTabs(calendar || open ? null : {
    tabs: BOARD_KINDS,
    activeValue: kind,
    onSelect: (value) => { if (isBoardKind(value)) { setKind(value); setSelectedKey(null); } },
    focused,
    dense: true,
  });
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
    <Box flexDirection="column" width={width} height={height}>
      {kindStrip}
      <DataTableStackView<BoardRow, BoardColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={Math.max(3, height - kindRows)}
        rootBefore={queryBar}
        status={{ loading: (resource.loading || highlightedReport.loading) && !data, error: !data ? resource.error : null, subject: "the earnings calendar" }}
        columns={columns}
        items={rows}
        getItemKey={(row) => row.key}
        isNavigable={(row) => row.kind === "report"}
        renderSectionHeader={renderBoardSection}
        renderCell={renderCell}
        // The figures export bare; a board with a report in another currency names each row's after them.
        exportIdentity={currencies ? BOARD_CURRENCY_EXPORT : undefined}
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
    </Box>
  );
}

/** ALRT's form for an earnings alert on `symbol`, set to go off when the results are out. */
function openEarningsAlert(symbol: string): boolean {
  return openFormModal({ kind: "plugin-command", commandId: "set-event-alert", values: earningsResultsAlertValues(symbol) });
}
