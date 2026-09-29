import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  DataTableStackView,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneStatusFooter,
  type DataTableKeyEvent,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import type { EarningsCalendarQuery } from "../../../api-client/earnings";
import { useAppSelector, usePaneSettingValue } from "../../../state/app/context";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import type { EarningsEvent } from "../../../types/data-provider";
import { useAssetData, usePluginAppActions, usePluginTickerActions } from "../../runtime";
import {
  addDays,
  boardReport,
  boardRows,
  fallbackReport,
  marketDays,
  newYorkToday,
  ownershipBySymbol,
  relativeDays,
  type BoardReport,
  type BoardRow,
  type BoardSort,
} from "./board-model";
import { boardColumns, renderBoardCell, renderBoardSection, SORTABLE, type BoardColumn } from "./board-table";
import { cachedEarningsCalendar, loadEarningsBoard } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { EarningsHistoryView } from "./history";

/** The stored calendar reaches about three months ahead. */
const HORIZON_DAYS = 90;
/** Ranked per day; a busy day has several hundred reports, most of them micro caps. */
const MARKET_PER_DAY = 200;
/** The server reads at most this many named companies. */
const MAX_SYMBOLS = 200;

type Order = "cap" | "mine";

interface BoardData {
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
  const { createPaneFromTemplate } = usePluginAppActions();
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
  const openedSymbol = useRef<string | null>(null);
  const highlighted = useRef<string | null>(null);

  const today = newYorkToday();
  const market = scopedSymbols.length === 0 && !mineOnly;
  const named = useMemo(
    () => (scopedSymbols.length > 0 ? [...scopedSymbols] : [...owned.keys()]).slice(0, MAX_SYMBOLS),
    [owned, scopedSymbols],
  );
  const days = useMemo(() => (market ? marketDays(today) : relativeDays(today)), [market, today]);
  const query = useMemo<EarningsCalendarQuery>(() => market
    ? { from: days[0]!.from, to: days.at(-1)!.to, perDay: MARKET_PER_DAY, symbols: named }
    : { from: today, to: addDays(today, HORIZON_DAYS), perDay: 0, symbols: named },
  [days, market, named, today]);

  const loader = useCallback(async (force: boolean): Promise<BoardData> => {
    if (!market && named.length === 0) return { reports: [], stale: false, refreshError: null };
    // Named companies also go to the per-ticker calendar, which covers listings the stored one does not.
    const [cloud, fallback] = await Promise.allSettled([
      loadEarningsBoard(query, force),
      market ? Promise.resolve([] as EarningsEvent[]) : loadEarningsCalendar(dataProvider, named, { force }).then((result) => result.events),
    ]);
    if (cloud.status === "rejected" && (market || fallback.status === "rejected")) throw cloud.reason;
    const reports = cloud.status === "fulfilled" ? cloud.value.payload.reports.map((report) => boardReport(report, owned)) : [];
    const covered = new Set(reports.map((report) => report.symbol));
    const extra = fallback.status === "fulfilled"
      ? fallback.value.filter((event) => !covered.has(event.symbol)).map((event) => fallbackReport(event, owned))
      : [];
    return {
      reports: [...reports, ...extra],
      stale: cloud.status === "fulfilled" && cloud.value.stale,
      refreshError: cloud.status === "rejected"
        ? (cloud.reason instanceof Error ? cloud.reason.message : String(cloud.reason))
        : cloud.value.refreshError,
    };
  }, [dataProvider, market, named, owned, query]);
  const resource = useAsyncResource(loader, {
    keepPreviousData: true,
    initialData: () => {
      const cached = cachedEarningsCalendar(query);
      return cached ? { reports: cached.payload.reports.map((report) => boardReport(report, owned)), stale: false, refreshError: null } : null;
    },
  });
  const data = resource.data;
  const rows = useMemo(() => boardRows(data?.reports ?? [], days, sort, order === "mine"), [data, days, order, sort]);
  const reportRows = useMemo(() => rows.filter((row): row is BoardRow & { kind: "report" } => row.kind === "report"), [rows]);
  const selected = reportRows.find((row) => row.key === selectedKey) ?? reportRows[0] ?? null;
  const open = reportRows.find((row) => row.key === openKey)?.report
    ?? (openKey ? data?.reports.find((report) => report.key === openKey) : undefined) ?? null;
  const columns = useMemo(() => boardColumns(width), [width]);

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
  const symbol = open?.symbol ?? selected?.report.symbol ?? null;
  usePaneFooter("earnings-actions", () => ({
    order: 10,
    hints: symbol
      ? [
          { id: "ticker", key: "t", label: "icker", onPress: () => navigateTicker(symbol) },
          { id: "estimates", key: "e", label: "stimates", onPress: () => createPaneFromTemplate("earnings-estimates-pane", { symbol }) },
          { id: "calls", key: "c", label: "alls", onPress: () => createPaneFromTemplate("earnings-calls-pane", { symbol }) },
          { id: "analysts", key: "a", label: "nalysts", onPress: () => createPaneFromTemplate("analyst-research-pane", { symbol }) },
        ]
      : [],
  }), [createPaneFromTemplate, navigateTicker, symbol]);

  // t, e, c and a are footer hints, which bind their own keys.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, () => void resource.reload()), [resource.reload]);

  const sortColumn = (Object.entries(SORTABLE).find(([, value]) => value === sort.column)?.[0]) ?? null;
  const queryBar = (
    <QueryBar
      width={width}
      filters={scopedSymbols.length > 0 ? [] : [
        { id: "mine", kind: "toggle", label: "Mine", value: mineOnly, defaultValue: false, onChange: setMineOnly },
      ]}
      view={{
        value: order,
        options: [{ value: "cap", label: "Size" }, { value: "mine", label: "Mine first" }],
        onChange: (value: Order) => setOrder(value),
      }}
    />
  );

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
        renderCell={renderBoardCell}
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
        detailContent={open ? (
          <EarningsHistoryView key={open.symbol} symbol={open.symbol} width={width} height={Math.max(4, height - 1)}
            focused={focused} registrationId="earnings-history" />
        ) : null}
        emptyStateTitle={
          market ? "No reports on the calendar these days."
            : named.length === 0 ? "No portfolio or watchlist names."
              : "No upcoming reports."
        }
      />
    </PaneStatusBody>
  );
}
