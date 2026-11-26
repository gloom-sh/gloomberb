import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import type { PluginModule } from "../plugin-module";
import type { PaneProps, PaneTemplateDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import type { InsiderSignalSide } from "../../../api-client/insider-signals";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { useAppDispatch, useAppSelector, useAppStateRef, usePaneInstance } from "../../../state/app/context";
import { resolveTickerOpenTarget, tickerOpenFailureMessage } from "../../../tickers/open-target";
import { offerTickerListings, publishTickerOpenTarget } from "../../../app/pane-runtime/ticker-open-target";
import { getSharedRegistry } from "../../registry";
import {
  useChartQueries,
  useResolvedEntryValue,
  useSecFilingsQuery,
} from "../../../market-data/hooks";
import { instrumentFromTicker, type ChartRequest } from "../../../market-data/request-types";
import { buildChartKey } from "../../../market-data/selectors";
import { Box, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import {
  ChartTableHeader,
  ChoiceDialog,
  DataTableStackView,
  EmptyState,
  PaneLinkMenu,
  QueryBar,
  Spinner,
  sortStackItems,
  useChartTableSelection,
  useExternalLinkFooter,
  usePaneFooter,
  usePaneNoticeFooter,
  useTableLoadMore,
  type ChartTableChart,
  type QueryBarView,
  type StackSortPreference,
  type StatItem,
} from "../../../components";
import { useDebouncedPluginPaneState, usePluginAppActions, usePluginPaneState } from "../../runtime";
import { homeInsiderReportsNote, mayBeSecEquityListing, mayBeUsEquityTicker, noSecReportsNotice, nonUsSecListingVenue } from "../../../utils/sec";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { formatCompact } from "../../../utils/format";
import { nextHeaderSort } from "../../../utils/sort-values";
import { formatShortDate } from "../../../utils/datetime-format";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { SignInWall } from "../cloud/auth-actions";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { formatFilingFormLabel, renderFilingNotice } from "../sec/filing-display";
import { useInsiderFilingRows } from "./filing-rows";
import {
  DEFAULT_INSIDER_TYPE_FILTER,
  buildInsiderSummaryFigures,
  insiderSummaryCutoff,
  isInsiderTypeFilter,
  matchesInsiderOwner,
  matchesInsiderTypeFilter,
  insiderReportedName,
  type InsiderSummaryFigures,
  type InsiderTypeFilter,
} from "./model";
import { formatInsiderName } from "./display";
import { insiderHeadless } from "./headless";
import { FORM4_CURRENCY } from "./base-values";
import { isInsiderForm } from "./insider-data";
import { filesAsForeignPrivateIssuer, insiderEmptyNotice } from "./issuer";
import { relevantInsiderAmendments } from "./amendments";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import {
  buildInsiderColumns,
  buildInsiderTableRows,
  compareInsiderRows,
  type InsiderColumn,
  type InsiderColumnId,
  type InsiderTableRow,
} from "./table-model";
import { insiderToneColor, renderInsiderCell } from "./table";
import { insiderActivitySeries, insiderAxisValue, insiderChartValue, insiderPlanShare, insiderWeeklyActivity } from "./activity-chart";
import { useThemeColors } from "../../../theme/theme-context";
import { InsiderDetail, insiderDetailTitle } from "./detail";
import { useFilingStories, type FilingStory } from "./filing-stories";
import { useOptionalDialog, type PromptContext } from "../../../ui/dialog";
import { logFailure } from "../../../utils/log-failure";
import { InsiderActivityView, type InsiderViewControl } from "./insiders";
import { InsiderSignalsView, type InsiderOpenedCompany } from "./signals";
import { InsiderTickersView } from "./tickers";
import { formatTickerListInput } from "../../../tickers/list";
import { DEFAULT_INSIDER_SIGNAL_WINDOW, insiderSignalsCache } from "./signals-client";
import { INSIDER_SIGNALS_TITLE, INSIDER_VIEW_OPTIONS, insiderSignalsQueryFrom, insiderViewMode, type InsiderViewMode } from "./signals-model";


const FORM4_PAGE_SIZE = 20;
// The first page grows to every filing inside the 90-day window, up to this
// many, so the totals do not depend on how far the list is scrolled.
const INSIDER_WINDOW_CAP = 120;
// Recent EDGAR dumps cap at 1,000 mixed forms. Older archives are fetched
// until this many filings or company history ends.
const SEC_FILING_SCAN_LIMIT = 20_000;
// A narrowed list too short to scroll cannot ask for more, so older filings
// load on their own until it fills a page, as far back as a year and no more
// filings than a busy 90-day window already loads.
const AUTO_FILL_DAYS = 365;
const AUTO_FILL_FILING_CAP = INSIDER_WINDOW_CAP;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Narrower panes pick the Type filter from a menu instead of showing every choice. */
const TYPE_FILTER_INLINE_WIDTH = 80;
/** Back as a query bar draws it at the head of a stack's detail: the arrow, the word and their padding. */
const STACK_BACK_CELLS = 8;
/** The bar draws the stack's title up to this many characters, with a cell of padding each side. */
const STACK_TITLE_MAX_CELLS = 40;
/**
 * The cells Back and the title take in the query bar of a company opened
 * from the ranking, on the desktop, where they lead INS's own bar.
 */
function stackHeaderCells(title: string): number {
  return STACK_BACK_CELLS + Math.min(title.length, STACK_TITLE_MAX_CELLS) + 2;
}
/** The insider filter's value for every reporting owner. */
const ALL_INSIDERS = "*";

const TYPE_FILTER_LABELS: Record<InsiderTypeFilter, string> = {
  all: "All",
  trades: "Buys and sells",
  other: "Other",
};

/** `21 Aug`, with the year when it is not this one's. */
function windowDay(day: string, now = Date.now()): string {
  const sameYear = day.slice(0, 4) === new Date(now).toISOString().slice(0, 4);
  return formatShortDate(`${day}T00:00:00Z`, { utc: true, year: sameYear ? false : "numeric" });
}

/**
 * The 90-day buy and sale totals as figures: one cell per side, and per
 * security when there are several. The last cell says once, for the band,
 * what they count: trades dated since the window's first day (by trade date,
 * not filing date) in the filings loaded, which a narrow pane gives up before
 * the figures, the 90 days staying in the labels. A side with no trades shows
 * 0 shares, muted. Buys read in the gain colour and sales in the loss colour,
 * as in the table; when the Type filter hides open-market trades the figures
 * dim and say so. With `currency` the dollars read with its code (1.2M USD),
 * as the table's CCY column names them.
 */
function summaryItems(figures: InsiderSummaryFigures, typeFilter: InsiderTypeFilter, currency?: string, plans: readonly PlanFigure[] = []): StatItem[] {
  const securities = new Set(figures.totals.map((total) => total.security));
  const hidden = typeFilter === "other";
  const since = windowDay(figures.window.from);
  const items: StatItem[] = [];
  for (const side of ["P", "S"] as const) {
    const label = side === "P" ? "90d buys" : "90d sales";
    const totals = figures.totals.filter((total) => total.side === side);
    if (totals.length === 0) items.push({ id: side, label, value: "0 shares", tone: "muted" });
    for (const total of totals) {
      items.push({
        id: `${total.security}:${side}`,
        label,
        value: total.unreconciled ? "Unavailable" : `${formatCompact(total.shares)} shares`,
        detail: [
          total.unreconciled ? "amended" : !total.knownValue ? "value unavailable"
            : currency ? `${formatCompact(total.value)} ${currency}` : `$${formatCompact(total.value)}`,
          securities.size > 1 ? total.security : null,
          hidden ? "not in this view" : null,
        ].filter(Boolean).join(" · "),
        tone: total.unreconciled || hidden ? "muted" : side === "P" ? "positive" : "negative",
      });
    }
  }
  // Rule 10b5-1 trades, said once here instead of on every row: what share of a side's shares was under a plan.
  for (const plan of plans) {
    items.push({
      id: `plan:${plan.side}`,
      label: plan.side === "buy" ? "90d plan buys" : "90d plan sales",
      value: `${Math.round((plan.shares / plan.total) * 100)}%`,
      detail: `of shares ${plan.side === "buy" ? "bought" : "sold"}, 10b5-1`,
      tone: hidden ? "muted" : undefined,
    });
  }
  // Once, after the last figure: the trade dates counted, and that they are the loaded filings' trades.
  const last = items.at(-1);
  if (last) {
    const detail = last.detail ?? "";
    const window = `trades since ${since}`;
    const coverage = `${window}, ${figures.filings} ${figures.filings === 1 ? "filing" : "filings"} loaded`;
    const join = (...parts: string[]) => parts.filter(Boolean).join(" \u00b7 ");
    // Narrower, the window keeps its first day longest: what "90d" is from.
    items[items.length - 1] = { ...last, detail: join(detail, coverage), detailVariants: [join(detail, window), join(detail, `since ${since}`), detail] };
  }
  return items;
}

/** A side's open-market shares in the 90 days traded under a Rule 10b5-1 plan, of all its shares. */
interface PlanFigure {
  side: "buy" | "sell";
  shares: number;
  total: number;
}

type Setter<T> = (value: SetStateAction<T>) => void;

/** The Trades view's selected row, Insider and Type filters, and open transaction. */
interface InsiderTradesState {
  selectedId: string | null;
  setSelectedId: Setter<string | null>;
  nameFilter: string | null;
  setNameFilter: Setter<string | null>;
  typeFilter: InsiderTypeFilter;
  setTypeFilter: Setter<InsiderTypeFilter>;
  openItemId: string | null;
  setOpenItemId: (itemId: string | null) => void;
}

interface StackedTradesState {
  tickerKey: string;
  selectedId: string | null;
  nameFilter: string | null;
  typeFilter: InsiderTypeFilter;
  openItemId: string | null;
}

const freshTradesState = (tickerKey: string, insider: string | null = null): StackedTradesState => ({
  tickerKey, selectedId: null, nameFilter: insider, typeFilter: insider ? "trades" : DEFAULT_INSIDER_TYPE_FILTER, openItemId: null,
});

/**
 * Where the Trades view keeps its selection, filters and open transaction.
 * A pane of its own keeps them as pane state, by ticker, so it comes back as
 * it was left. A company opened from the ranking keeps them only while it is
 * open, so opening it again, or another company, starts clean: no trade
 * still open, no filter left on the last insider.
 */
function useInsiderTradesState(tickerKey: string, stacked: boolean, insider: string | null = null): InsiderTradesState {
  const [paneSelectedId, setPaneSelectedId] = usePluginPaneState<string | null>(`insider:selectedId:${tickerKey}`, null);
  // A pane opened on an insider (a story's filings) starts filtered to them, as one opened from the ranking does.
  const [paneNameFilter, setPaneNameFilter] = usePluginPaneState<string | null>(`insider:nameFilter:${tickerKey}`, insider);
  const [paneTypeFilter, setPaneTypeFilter] = usePluginPaneState<InsiderTypeFilter>("insider:typeFilter", DEFAULT_INSIDER_TYPE_FILTER);
  const [paneOpenItemId, setPaneOpenItemIdState] = useDebouncedPluginPaneState<string | null>(`insider:openItemId:${tickerKey}`, null);
  const setPaneOpenItemId = useCallback(
    (itemId: string | null) => setPaneOpenItemIdState(itemId, { immediate: true }),
    [setPaneOpenItemIdState],
  );
  const [stackedState, setStackedState] = useState<StackedTradesState>(() => freshTradesState(tickerKey, insider));
  const stackedSetters = useMemo(() => {
    const setter = <K extends "selectedId" | "nameFilter" | "typeFilter" | "openItemId">(field: K) =>
      (value: SetStateAction<StackedTradesState[K]>) => setStackedState((current) => {
        const base = current.tickerKey === tickerKey ? current : freshTradesState(tickerKey, insider);
        const next = typeof value === "function" ? (value as (previous: StackedTradesState[K]) => StackedTradesState[K])(base[field]) : value;
        return { ...base, [field]: next };
      });
    return {
      setSelectedId: setter("selectedId"),
      setNameFilter: setter("nameFilter"),
      setTypeFilter: setter("typeFilter"),
      setOpenItemId: setter("openItemId") as (itemId: string | null) => void,
    };
  }, [insider, tickerKey]);

  if (stacked) {
    const current = stackedState.tickerKey === tickerKey ? stackedState : freshTradesState(tickerKey, insider);
    return { ...current, ...stackedSetters };
  }
  return {
    selectedId: paneSelectedId,
    setSelectedId: setPaneSelectedId,
    nameFilter: paneNameFilter,
    setNameFilter: setPaneNameFilter,
    typeFilter: isInsiderTypeFilter(paneTypeFilter) ? paneTypeFilter : DEFAULT_INSIDER_TYPE_FILTER,
    setTypeFilter: setPaneTypeFilter,
    openItemId: paneOpenItemId,
    setOpenItemId: setPaneOpenItemId,
  };
}

const insiderRowId = (row: InsiderTableRow) => row.id;
const insiderRowDate = (row: InsiderTableRow) => row.date;

/**
 * INS on a ticker, its trades as filed: the 90-day totals, a chart of each
 * week's buys and sales against the price, the Insider and Type filters, and
 * Enter opening a transaction.
 */
function InsiderTradesView({ ticker, viewBar, state, width, height, focused, stackTitle, onDetailChange }: {
  ticker: TickerRecord;
  viewBar: QueryBarView<InsiderViewMode>;
  state: InsiderTradesState;
  width: number;
  height: number;
  focused: boolean;
  /** Opened from the ranking: the stack's title, which on the desktop leads this view's query bar with Back. */
  stackTitle?: string;
  onDetailChange?: (open: boolean) => void;
}) {
  const tickerKey = ticker.metadata.ticker;
  const { nativePaneChrome } = useUiCapabilities();
  // Every Type choice in view only where Back and the whole title still fit beside them.
  const typeInlineWidth = TYPE_FILTER_INLINE_WIDTH + (stackTitle != null && nativePaneChrome ? stackHeaderCells(stackTitle) : 0);
  const { selectedId, setSelectedId, nameFilter, setNameFilter, typeFilter, setTypeFilter, openItemId, setOpenItemId } = state;
  const [sort, setSort] = useState<StackSortPreference<InsiderColumnId>>({ columnId: "date", direction: "desc" });
  // A listing abroad is looked up by its company; an empty list means it files nothing with the SEC.
  const abroadVenue = nonUsSecListingVenue(ticker.metadata.ticker, ticker.metadata.exchange);
  const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker);

  const filingsEntry = useSecFilingsQuery(
    instrument ? { instrument, count: SEC_FILING_SCAN_LIMIT } : null,
  );
  const allFilings = useResolvedEntryValue(filingsEntry) ?? [];
  const form4Filings = useMemo(
    () => allFilings.filter((f) => isInsiderForm(f.form)),
    [allFilings],
  );
  const windowCount = useMemo(() => {
    const cutoff = insiderSummaryCutoff();
    return form4Filings.findLastIndex((filing) => new Date(filing.filingDate).getTime() >= cutoff) + 1;
  }, [form4Filings]);
  const windowShown = Math.min(windowCount, INSIDER_WINDOW_CAP);
  const [visibleCount, setVisibleCount] = useState(FORM4_PAGE_SIZE);
  const shownCount = Math.max(visibleCount, windowShown);
  const visibleForm4Filings = useMemo(
    () => form4Filings.slice(0, shownCount),
    [form4Filings, shownCount],
  );
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadNextPage = useCallback(
    () => setVisibleCount((current) => Math.min(form4Filings.length, Math.max(current, windowShown) + FORM4_PAGE_SIZE)),
    [form4Filings.length, windowShown],
  );
  useEffect(() => {
    setVisibleCount(FORM4_PAGE_SIZE);
  }, [tickerKey]);

  const loading =
    filingsEntry?.phase === "loading" ||
    (filingsEntry?.phase === "refreshing" && allFilings.length === 0);
  const error =
    filingsEntry?.phase === "error"
      ? (filingsEntry.error?.message ?? "Failed to load SEC filings")
      : null;
  // Hosted, the only filings source is Gloom Cloud, which needs an account.
  const cloudSession = useResearchCloudSession();
  const authWall = allFilings.length === 0 && isCloudSessionRequired(error);
  const sessionKeyRef = useRef(cloudSession.requestKey);
  useEffect(() => {
    if (sessionKeyRef.current === cloudSession.requestKey) return;
    sessionKeyRef.current = cloudSession.requestKey;
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !instrument) return;
    void coordinator.loadSecFilings({ instrument, count: SEC_FILING_SCAN_LIMIT }, { forceRefresh: true });
  }, [cloudSession.requestKey, instrument]);

  const access = useCloudDisplayScope();
  // The list also holds the Form 4s the company filed as an owner of another
  // company's shares, which only their documents tell apart. Until one of its
  // own is read, the pages are read on to the end, so a list of none says so.
  const { ownerFilingsShown, ownFilingShown, pendingCount, rows: allParsed } = useInsiderFilingRows(
    `${tickerKey}:${ticker.metadata.exchange ?? ""}`, access, visibleForm4Filings,
  );
  const searchingOwn = !ownFilingShown && pendingCount === 0 && shownCount < form4Filings.length;
  const noOwnFilings = !loading && !ownFilingShown && pendingCount === 0 && shownCount >= form4Filings.length;

  // The insider filter narrows the totals and the table; the Type filter only the table.
  const parsed = useMemo(() => (
    nameFilter
      ? allParsed.filter((entry) => matchesInsiderOwner(entry, nameFilter))
      : allParsed
  ), [allParsed, nameFilter]);
  const typeCounts = useMemo(() => {
    const counts: Record<InsiderTypeFilter, number> = { all: 0, trades: 0, other: 0 };
    for (const entry of parsed) {
      if (entry.isLoading) continue;
      counts.all += 1;
      if (matchesInsiderTypeFilter(entry, "trades")) counts.trades += 1;
      if (matchesInsiderTypeFilter(entry, "other")) counts.other += 1;
    }
    return counts;
  }, [parsed]);
  const shown = useMemo(
    () => parsed.filter((entry) => matchesInsiderTypeFilter(entry, typeFilter)),
    [parsed, typeFilter],
  );
  const rows = useMemo(() => buildInsiderTableRows(shown), [shown]);
  const sortedRows = useMemo(() => {
    const order = new Map(rows.map((row, index) => [row.id, index]));
    return sortStackItems(rows, sort, compareInsiderRows, (a, b) => order.get(a.id)! - order.get(b.id)!);
  }, [rows, sort]);
  // Form 4 amounts are dollars: a reader whose base currency is another one gets them named, as PF names a holding's.
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const amountCurrency = baseCurrency.trim().toUpperCase() === FORM4_CURRENCY ? undefined : FORM4_CURRENCY;
  const columns = useMemo(() => buildInsiderColumns(width, rows, amountCurrency), [amountCurrency, rows, width]);

  // A narrowed list that cannot scroll cannot ask for older filings, so they
  // load here until it fills a page, back to a year at most.
  const oldestShown = visibleForm4Filings[visibleForm4Filings.length - 1]?.filingDate;
  const oldestShownTime = oldestShown ? new Date(oldestShown).getTime() : Number.NaN;
  const wantsOlderFilings = (typeFilter !== "all" || nameFilter != null || ownerFilingsShown)
    && shown.length < Math.max(FORM4_PAGE_SIZE, height)
    && shownCount < Math.min(form4Filings.length, AUTO_FILL_FILING_CAP)
    && oldestShownTime >= Date.now() - AUTO_FILL_DAYS * DAY_MS;
  useEffect(() => {
    if (searchingOwn || (wantsOlderFilings && pendingCount === 0)) loadNextPage();
  }, [loadNextPage, pendingCount, searchingOwn, shownCount, wantsOlderFilings]);

  const summary = useMemo(() => buildInsiderSummaryFigures(parsed, Date.now(), allParsed), [parsed, allParsed]);
  // A page loading in on scroll clears the totals until it is read; the last
  // totals for the same ticker and owner stay up so the table does not jump.
  const summaryScope = `${tickerKey}:${nameFilter ?? ""}`;
  const lastSummaryRef = useRef<{ scope: string; figures: InsiderSummaryFigures } | null>(null);
  if (summary) lastSummaryRef.current = { scope: summaryScope, figures: summary };
  const shownSummary = summary ?? (lastSummaryRef.current?.scope === summaryScope ? lastSummaryRef.current.figures : null);
  // The weeks of open-market trades the chart draws, and the 90 days' plan share the figures state once.
  const weeks = useMemo(() => insiderWeeklyActivity(parsed), [parsed]);
  const plans = useMemo<PlanFigure[]>(() => {
    const recent = insiderWeeklyActivity(parsed, insiderSummaryCutoff());
    return (["buy", "sell"] as const).flatMap((side) => {
      const { plan, total } = insiderPlanShare(recent, side);
      return plan > 0 ? [{ side, shares: plan, total }] : [];
    });
  }, [parsed]);
  const statItems = useMemo(() => shownSummary ? summaryItems(shownSummary, typeFilter, amountCurrency, plans) : [], [amountCurrency, plans, shownSummary, typeFilter]);
  // The totals miss window filings only when the window passes the cap.
  const windowPartial = shownCount < windowCount;
  const insiderOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of allParsed) {
      const name = insiderReportedName(entry);
      if (name) names.set(name, formatInsiderName(name));
    }
    if (nameFilter && !names.has(nameFilter)) names.set(nameFilter, formatInsiderName(nameFilter));
    return [
      { value: ALL_INSIDERS, label: "All" },
      ...[...names].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    ];
  }, [allParsed, nameFilter]);
  const typeOptions = useMemo(() => (["all", "trades", "other"] as const).map((value) => ({
    value,
    label: `${TYPE_FILTER_LABELS[value]} (${typeCounts[value]})`,
  })), [typeCounts]);
  const amendments = useMemo(() => relevantInsiderAmendments(parsed, allParsed), [parsed, allParsed]);
  const selectedRowIndex = Math.max(0, sortedRows.findIndex((row) => row.id === selectedId));
  const selectedRow = sortedRows[selectedRowIndex] ?? null;
  const selectedFilterName = selectedRow ? insiderReportedName(selectedRow.entry) : null;
  const openRow = openItemId ? rows.find((row) => row.id === openItemId) ?? null : null;
  const openFiling = openRow?.entry.filing ?? null;
  // A stack around this one (a company opened from the ranking) leaves Esc to the open transaction.
  const transactionOpen = !!openRow;
  useEffect(() => {
    onDetailChange?.(transactionOpen);
  }, [onDetailChange, transactionOpen]);
  useEffect(() => () => onDetailChange?.(false), [onDetailChange]);
  const loadMore = useTableLoadMore(scrollRef, shownCount < form4Filings.length && !openRow, loadNextPage);

  // The daily close the weekly trades are set against.
  const priceRequest = useMemo<ChartRequest | null>(() => (instrument ? { instrument, bufferRange: "1Y", granularity: "resolution", resolution: "1d" } : null), [instrument]);
  const priceEntries = useChartQueries(priceRequest ? [priceRequest] : []);
  const prices = useResolvedEntryValue(priceRequest ? priceEntries.get(buildChartKey(priceRequest)) ?? null : null);
  const colors = useThemeColors();
  const series = useMemo(() => insiderActivitySeries(weeks, prices ?? null, {
    buy: insiderToneColor("buy"), planBuy: insiderToneColor("buy", true),
    sell: insiderToneColor("sell"), planSell: insiderToneColor("sell", true), price: colors.text,
  }), [colors, prices, weeks]);
  const link = useChartTableSelection({
    rows: sortedRows,
    getId: insiderRowId,
    getDate: insiderRowDate,
    selectedId: selectedRow?.id ?? null,
    onSelect: setSelectedId,
    focused: focused && !openRow,
  });
  const chart = useMemo<ChartTableChart | null>(() => (series.length ? {
    series, formatValue: insiderChartValue, formatAxisValue: insiderAxisValue, remoteKind: "insider-trades-by-week", ...link,
  } : null), [link, series]);

  const toggleNameFilter = useCallback((reportedName: string) => {
    setNameFilter((current) => current === reportedName ? null : reportedName);
    setSelectedId(null);
  }, [setNameFilter, setSelectedId]);
  const selectInsider = useCallback((value: string) => {
    setNameFilter(value === ALL_INSIDERS ? null : value);
    setSelectedId(null);
  }, [setNameFilter, setSelectedId]);
  const selectType = useCallback((value: string) => {
    if (!isInsiderTypeFilter(value)) return;
    setTypeFilter(value);
    setSelectedId(null);
  }, [setSelectedId, setTypeFilter]);
  const clearNameFilter = useCallback(() => {
    setNameFilter(null);
    setSelectedId(null);
  }, [setNameFilter, setSelectedId]);
  // The [f]ilter hint is the binding, so the key works over an open
  // transaction and an empty filtered list, and always does what a click does.
  const filterActionRef = useRef<() => void>(() => {});
  filterActionRef.current = () => {
    if (nameFilter) clearNameFilter();
    else if (selectedFilterName) toggleNameFilter(selectedFilterName);
  };
  const handleFilterPress = useCallback(() => filterActionRef.current(), []);

  // The stories that report the open transaction's filing: back from the Form 4 to the news about it.
  const openStories = useFilingStories(openRow && !openRow.entry.isLoading ? openRow.entry.filing.accessionNumber : null);
  const { createPaneFromTemplate } = usePluginAppActions();
  const dialog = useOptionalDialog();
  const openStory = useCallback((story: FilingStory) => {
    createPaneFromTemplate("news-story-pane", { arg: story.id, values: { title: story.headline } });
  }, [createPaneFromTemplate]);
  const chooseStory = useCallback(() => {
    if (openStories.length === 1) {
      openStory(openStories[0]!);
      return;
    }
    if (!dialog || openStories.length === 0) return;
    void dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<string>) => (
        <ChoiceDialog
          {...ctx}
          title="Stories"
          choices={openStories.map((story, index) => ({ id: String(index), label: story.headline, detail: story.publisher }))}
        />
      ),
    }).then((choice) => {
      const story = choice ? openStories[Number(choice)] : undefined;
      if (story) openStory(story);
    }).catch(logFailure("insider.detail", "Choose a story reporting the filing failed"));
  }, [dialog, openStories, openStory]);

  // Reading on: the next or previous row opens in place, and the cursor
  // follows it so Back lands on the last one read.
  const openIndex = openRow ? sortedRows.findIndex((row) => row.id === openRow.id) : -1;
  const openAdjacent = useCallback((step: 1 | -1) => {
    const row = openIndex >= 0 ? sortedRows[openIndex + step] : undefined;
    if (!row) return;
    setSelectedId(row.id);
    setOpenItemId(row.id);
  }, [openIndex, setOpenItemId, setSelectedId, sortedRows]);
  usePaneFooter("insider:detail", () => (focused && openIndex >= 0 ? {
    // After the pane's own hints.
    order: 1,
    hints: [
      { id: "insider-next", key: "n", label: "ext", title: "Next Transaction", disabled: openIndex >= sortedRows.length - 1, onPress: () => openAdjacent(1) },
      { id: "insider-previous", key: "p", label: "rev", title: "Previous Transaction", disabled: openIndex <= 0, onPress: () => openAdjacent(-1) },
      ...(openStories.length > 0 ? [{ id: "insider-story", key: "s", label: "tory", title: "Open Story", onPress: chooseStory }] : []),
    ],
  } : null), [chooseStory, focused, openAdjacent, openIndex, openStories.length, sortedRows.length]);

  const pendingLabel = pendingCount > 0 ? `loading ${pendingCount}...` : "";
  const footerInfo = useMemo(() => [
    ...(pendingLabel ? [{ id: "pending", parts: [{ text: pendingLabel, tone: "muted" as const }] }] : []),
    ...(error && allFilings.length > 0 ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
  ], [allFilings.length, error, pendingLabel]);
  // An unreconciled 4/A or an unread filing is a limitation of the totals on
  // screen, not a status.
  usePaneNoticeFooter({
    registrationId: "insider:amendments",
    notices: [
      ...(amendments.length ? ["A Form 4/A in this window is unreconciled, so the affected transaction totals are unavailable."] : []),
      ...(summary?.incomplete ? ["Some transactions are unavailable or incomplete, so the 90-day totals leave them out."] : []),
      ...(summary && windowPartial ? ["The 90-day totals cover the filings loaded so far; scroll the list to load older ones."] : []),
    ],
    focused,
  });
  const footerHints = useMemo(() => (
    selectedFilterName || nameFilter
      ? [{
          id: "filter",
          key: "f",
          label: "ilter",
          title: nameFilter ? "Clear Filter" : "Filter by Insider",
          onPress: handleFilterPress,
        }]
      : []
  ), [handleFilterPress, nameFilter, selectedFilterName]);
  useExternalLinkFooter({
    registrationId: "insider",
    focused,
    url: error ? null : openFiling?.filingUrl,
    source: openFiling?.form && !amendments.length ? formatFilingFormLabel(openFiling.form) : null,
    info: footerInfo,
    hints: footerHints,
    label: "filing",
  });

  if (authWall) return <SignInWall placement="insider-signin" action="view insider transactions" needsVerification={cloudSession.needsVerification} />;
  // Loading, a failure or no filings of its own: the view stays a click away above it.
  const underBar = (body: ReactNode) => (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar width={width} view={viewBar} />
      {body}
    </Box>
  );
  if (loading && allFilings.length === 0) return underBar(<Spinner label="Loading insider filings..." />);
  if (error && allFilings.length === 0) return underBar(<EmptyState title="Insider filings unavailable." message={error} />);
  if (noOwnFilings) {
    // A company from abroad also says its home market's insider reports are not covered (RY:TSX: SEDI).
    const foreignPrivateIssuer = filesAsForeignPrivateIssuer(allFilings);
    const home = homeInsiderReportsNote({ exchange: abroadVenue, foreignPrivateIssuer });
    return underBar(renderFilingNotice(abroadVenue && allFilings.length === 0
      ? [noSecReportsNotice({ symbol: parsePublicTickerKey(ticker.metadata.ticker).symbol, exchange: abroadVenue, name: ticker.metadata.name ?? null }), home].filter(Boolean).join(" ")
      : insiderEmptyNotice(foreignPrivateIssuer, home)));
  }

  // Until a filing is read there is nothing to say; after that the empty
  // list says how far back the filings it has read go, while older ones load.
  const oldestRead = allParsed.findLast((entry) => !entry.isLoading)?.filing.filingDate;
  const since = oldestRead ? ` since ${formatShortDate(oldestRead, { utc: true })}` : "";
  const emptyTitle = typeCounts.all === 0 && (pendingCount > 0 || wantsOlderFilings || searchingOwn)
    ? "Loading Form 4 transactions..."
    : typeFilter === "trades"
      ? `No open-market buys or sells${nameFilter ? " by this insider" : ""}${since}.`
      : nameFilter ? "No insider transactions for this filter." : "No insider transactions.";
  const emptyHint = typeFilter === "trades" && typeCounts.other > 0
    ? `Type Other has ${typeCounts.other} awards, exercises, tax and gift lines.`
    : undefined;

  return (
    <DataTableStackView<InsiderTableRow, InsiderColumn>
      focused={focused}
      detailOpen={!!openRow}
      onBack={() => setOpenItemId(null)}
      detailTitle={openRow ? insiderDetailTitle(openRow) : undefined}
      detailScrollRef={detailScrollRef}
      detailContent={openRow
        ? <PaneLinkMenu><InsiderDetail row={openRow} width={width} scrollRef={detailScrollRef} stories={openStories} onOpenStory={openStory} /></PaneLinkMenu>
        : <Box flexGrow={1} />}
      selection={{
        kind: "index",
        selectedIndex: sortedRows.length > 0 ? selectedRowIndex : null,
        onChange: (_index, row) => setSelectedId(row.id),
      }}
      onActivate={(row) => {
        setSelectedId(row.id);
        setOpenItemId(row.id);
      }}
      rootBefore={<ChartTableHeader
        width={width}
        height={height}
        tableRows={sortedRows.length}
        tableColumns={columns}
        figures={statItems}
        chart={chart}
        query={<QueryBar
          width={width}
          filters={[
            {
              id: "insider",
              label: "Insider",
              value: nameFilter ?? ALL_INSIDERS,
              defaultValue: ALL_INSIDERS,
              options: insiderOptions,
              onChange: selectInsider,
            },
            {
              id: "type",
              label: "Type",
              value: typeFilter,
              defaultValue: DEFAULT_INSIDER_TYPE_FILTER,
              options: typeOptions,
              onChange: selectType,
              // Every count in view where there is room, so a short list never looks like missing data.
              inline: width >= typeInlineWidth,
            },
          ]}
          view={viewBar}
        />}
      />}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={sortedRows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as InsiderColumnId, {
        firstDirection: columnId === "insider" || columnId === "role" || columnId === "type" || columnId === "security" ? "asc" : "desc",
      }))}
      getItemKey={(row) => row.id}
      renderCell={renderInsiderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={emptyTitle}
      emptyStateHint={emptyHint}
      showHorizontalScrollbar={false}
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
    />
  );
}

/** INS on a ticker in a pane of its own (or a research tab): what it shows is pane state, as the CLI's options set it. */
function usePaneInsiderViewControl(): InsiderViewControl {
  const [storedView, setView] = usePluginPaneState<InsiderViewMode>("insider:view", "trades");
  // The window and side are the pane's, as for the ranking: a pane retargeted to a company keeps them.
  const [storedWindow, setWindow] = usePluginPaneState<number>("insider:signals:window", DEFAULT_INSIDER_SIGNAL_WINDOW);
  const [storedSide] = usePluginPaneState<InsiderSignalSide>("insider:signals:side", "buy");
  const { window, side } = insiderSignalsQueryFrom({ window: storedWindow, side: storedSide });
  return useMemo(() => ({ view: insiderViewMode(storedView), setView, window, setWindow, side }), [setView, setWindow, side, storedView, window]);
}

/**
 * INS on a ticker: its trades as filed, or its insiders in the ranking's
 * terms, a choice in the query bar. Enter on an insider shows their trades.
 * A company opened from the ranking passes its ticker, which the pane does
 * not have, and the ranking's choices.
 */
function InsiderView({ width, height, focused, ticker: openedTicker, control: openedControl, insider, stackTitle, onDetailChange }: {
  width: number;
  height: number;
  focused: boolean;
  ticker?: TickerRecord | null;
  control?: InsiderViewControl;
  /** Opened from an insider's row: their reported name, which the Trades view starts narrowed to. */
  insider?: string;
  /** Opened from the ranking: the stack's title, under its Back. */
  stackTitle?: string;
  onDetailChange?: (open: boolean) => void;
}) {
  const identity = usePaneTickerIdentity();
  const ticker = openedTicker !== undefined ? openedTicker : identity.ticker;
  const paneControl = usePaneInsiderViewControl();
  const control = openedControl ?? paneControl;
  const tickerKey = ticker?.metadata.ticker ?? "none";
  const trades = useInsiderTradesState(tickerKey, stackTitle != null, insider ?? null);
  const { setNameFilter, setSelectedId, setTypeFilter } = trades;
  const { setView } = control;
  const viewBar = useMemo<QueryBarView<InsiderViewMode>>(() => ({ value: control.view, options: INSIDER_VIEW_OPTIONS, onChange: setView }), [control.view, setView]);
  // An insider's trades: the Trades view narrowed to them with the Insider filter, open-market lines first.
  const openInsider = useCallback((reportedName: string) => {
    setNameFilter(reportedName);
    setSelectedId(null);
    setTypeFilter("trades");
    setView("trades");
  }, [setNameFilter, setSelectedId, setTypeFilter, setView]);

  if (!ticker) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view insider activity." />;
  }
  if (!mayBeSecEquityListing(ticker)) return renderFilingNotice("Insider transactions are only shown for US equities.");
  if (control.view === "insiders") {
    return (
      <InsiderActivityView
        key={tickerKey}
        symbol={parsePublicTickerKey(ticker.metadata.ticker).symbol}
        control={control}
        viewBar={viewBar}
        width={width}
        height={height}
        focused={focused}
        onOpenInsider={openInsider}
      />
    );
  }
  return <InsiderTradesView key={tickerKey} ticker={ticker} viewBar={viewBar} state={trades} width={width} height={height} focused={focused} stackTitle={stackTitle} onDetailChange={onDetailChange} />;
}

/**
 * A company opened from the ranking, as INS on its ticker. One the app has
 * not seen is looked up first, as the command bar looks up `INS CTSO`, and
 * joins the app's tickers the way every open adds one. Back before the
 * lookup answers leaves nothing behind: no ticker saved or added, no search
 * offered.
 */
function RankedCompany({ symbol, title, control, insider, width, height, focused, onDetailChange }: InsiderOpenedCompany) {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const [resolved, setResolved] = useState<{ symbol: string; key: string | null; error: string | null } | null>(null);
  const known = useAppSelector((state) => state.tickers.get(symbol) ?? null);
  const resolvedKey = resolved?.symbol === symbol ? resolved.key : null;
  const looked = useAppSelector((state) => (resolvedKey ? state.tickers.get(resolvedKey) ?? null : null));
  const ticker = known ?? looked;
  const isKnown = !!known;
  useEffect(() => {
    if (isKnown || resolved?.symbol === symbol) return;
    let current = true;
    const registry = getSharedRegistry();
    const fail = (error: string) => setResolved({ symbol, key: null, error });
    if (!registry) {
      fail(tickerOpenFailureMessage(symbol));
      return;
    }
    // The lookup saves a ticker it finds; once Back has closed the company it saves none.
    const repository = registry.tickerRepository;
    const closed = () => Promise.reject(new Error(`${symbol} was closed.`));
    const tickerRepository: typeof repository = {
      loadAllTickers: () => repository.loadAllTickers(),
      loadTicker: (key) => repository.loadTicker(key),
      saveTicker: (ticker) => current ? repository.saveTicker(ticker) : closed(),
      createTicker: (metadata) => current ? repository.createTicker(metadata) : closed(),
      deleteTicker: (key) => current ? repository.deleteTicker(key) : closed(),
    };
    resolveTickerOpenTarget({
      query: symbol,
      tickers: stateRef.current.tickers,
      dataProvider: registry.marketData,
      tickerRepository,
    }).then((target) => {
      if (!current) return;
      if (!target) return fail(tickerOpenFailureMessage(symbol));
      publishTickerOpenTarget(target, { tickers: stateRef.current.tickers, dispatch, events: registry.events });
      setResolved({ symbol, key: target.symbol, error: null });
    }, (error: unknown) => {
      if (!current) return;
      // A symbol that names several listings is offered in ticker search, as any open offers it.
      offerTickerListings(error, symbol, dispatch);
      fail(error instanceof Error ? error.message : tickerOpenFailureMessage(symbol));
    });
    return () => { current = false; };
  }, [dispatch, isKnown, resolved?.symbol, stateRef, symbol]);

  if (!ticker) {
    const error = resolved?.symbol === symbol ? resolved.error : null;
    return error ? <EmptyState title={`Could not open ${symbol}.`} message={error} /> : <Spinner label={`Opening ${symbol}...`} />;
  }
  return <InsiderView ticker={ticker} control={control} {...(insider ? { insider } : {})} width={width} height={height} focused={focused} stackTitle={title} onDetailChange={onDetailChange} />;
}

const renderRankedCompany = (company: InsiderOpenedCompany) => <RankedCompany {...company} />;

/** The tickers a pane opened on several holds (`settings.symbols`), upper case; none for any other INS pane. */
function insiderPaneSymbols(settings: Record<string, unknown> | undefined): string[] {
  const symbols = settings?.symbols;
  return Array.isArray(symbols)
    ? symbols.filter((symbol): symbol is string => typeof symbol === "string" && !!symbol.trim()).map((symbol) => symbol.trim().toUpperCase())
    : [];
}

/**
 * INS on a ticker is that company's insider transactions, or its insiders;
 * without one it is the ranking of companies whose insiders are buying, or
 * selling. A ranked company opens here as INS on its ticker, and Back
 * returns to the ranking.
 */
/** The insider a pane was opened on (`settings.insider`, as filed), whose trades it starts filtered to. */
function insiderPaneInsider(settings: Record<string, unknown> | undefined): string | undefined {
  const insider = settings?.insider;
  return typeof insider === "string" && insider.trim() ? insider.trim() : undefined;
}

function InsiderPane({ width, height, focused }: PaneProps) {
  const { symbol: paneSymbol } = usePaneTickerIdentity();
  const instance = usePaneInstance();
  const openedInsider = insiderPaneInsider(instance?.settings);
  // One list per set of tickers, so the views' loads do not start again on every render.
  const symbolsKey = insiderPaneSymbols(instance?.settings).join(",");
  const symbols = useMemo(() => (symbolsKey ? symbolsKey.split(",") : []), [symbolsKey]);

  // Several tickers (`INS MO,PM,LMT`, a watchlist's name): their insiders in one table.
  if (symbols.length > 1) {
    return <InsiderTickersView symbols={symbols} width={width} height={height} focused={focused} renderCompany={renderRankedCompany} />;
  }

  // No ticker at all is the ranking; a pane linked to a list keeps its own
  // empty state while the list has nothing selected.
  if (!paneSymbol && instance?.binding?.kind !== "follow") {
    return <InsiderSignalsView width={width} height={height} focused={focused} renderCompany={renderRankedCompany} />;
  }
  return <InsiderView width={width} height={height} focused={focused} {...(openedInsider ? { insider: openedInsider } : {})} />;
}

const tickerTemplate = createTickerSurfacePaneTemplate({
  id: "insider-pane",
  paneId: "insider",
  label: "Insider",
  description: "Insider transactions for a ticker; for several, their insiders; alone, the companies whose insiders are buying or selling.",
  keywords: ["insider", "form 4", "ownership", "transactions", "ins", "insider buying", "insider selling", "insider activity", "cluster buying"],
  shortcut: "INS",
  canCreate: (_context, options) => !options?.ticker || mayBeSecEquityListing(options.ticker),
  // Typed alone with no active ticker it ranks the market's insider buying or selling.
  withoutTickerTitle: INSIDER_SIGNALS_TITLE,
  // Opened on one insider (a story's filings, `values.insider` as filed): a window of its own, filtered to them.
  settings: (_symbol, _context, options) => {
    const insider = options?.values?.insider?.trim();
    return insider ? { insider } : undefined;
  },
  viewKey: (_symbol, _context, options) => options?.values?.insider?.trim() || undefined,
});

/**
 * INS takes tickers in the command bar as `fn INS` does: one opens that
 * company, several (`INS MO,PM,LMT`, or a watchlist's name) their insiders
 * in one table, and none the ranking.
 */
const insiderPaneTemplate: PaneTemplateDef = {
  ...tickerTemplate,
  // The bar reads a list (or a watchlist's name); the open resolves one of them as the ticker it opens on.
  shortcut: { ...tickerTemplate.shortcut!, argKind: "ticker-list" },
  canCreate: (context, options) => (options?.symbols?.length ?? 0) > 1
    || tickerTemplate.canCreate!(context, options?.symbols?.length === 1 ? { ...options, symbol: options.symbols[0] } : options),
  createInstance: (context, options) => {
    const symbols = options?.symbols ?? [];
    if (symbols.length > 1) {
      return { title: `INS ${formatTickerListInput(symbols)}`, binding: { kind: "none" }, placement: "floating", settings: { symbols } };
    }
    return tickerTemplate.createInstance!(context, symbols.length === 1 ? { ...options, symbol: symbols[0] } : options);
  },
};

export const insiderModule: PluginModule = {
  panes: [
    {
      id: "insider",
      name: "Insider",
      icon: "I",
      component: InsiderPane,
      defaultPosition: "right",
      shareItem: { ticker: true },
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      ...insiderPaneTemplate,
      headless: insiderHeadless,
    },
  ],

  setup(ctx) {
    insiderSignalsCache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "insider",
      name: "Insider",
      order: 47,
      component: InsiderView,
      instruments: ["equity"],
      isVisible: ({ ticker }) => mayBeUsEquityTicker(ticker),
    });
  },

  dispose() {
    insiderSignalsCache.reset();
  },
};
