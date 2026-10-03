import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginModule } from "../plugin-module";
import {
  useResolvedEntryValue,
  useSecFilingsQuery,
} from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
  EmptyState,
  PaneLinkMenu,
  QueryBar,
  Spinner,
  StatGrid,
  sortStackItems,
  useExternalLinkFooter,
  usePaneFooter,
  usePaneNoticeFooter,
  useTableLoadMore,
  type StackSortPreference,
  type StatItem,
} from "../../../components";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import { isUsEquityTicker } from "../../../utils/sec";
import { formatCompact } from "../../../utils/format";
import { nextHeaderSort } from "../../../utils/sort-values";
import { formatShortDate } from "../../../utils/datetime-format";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { SignInWall } from "../cloud/auth-actions";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { formatFilingFormLabel, renderFilingNotice } from "../sec/filing-display";
import { useSecFilingContentCache } from "../sec/filing-content";
import {
  DEFAULT_INSIDER_TYPE_FILTER,
  buildInsiderSummaryFigures,
  insiderSummaryCutoff,
  isInsiderTypeFilter,
  matchesInsiderOwner,
  matchesInsiderTypeFilter,
  insiderReportedName,
  parseInsiderFiling,
  type InsiderSummaryFigures,
  type InsiderTypeFilter,
  type ParsedInsiderFiling as ParsedFiling,
} from "./model";
import { formatInsiderName } from "./display";
import { insiderHeadless } from "./headless";
import { isInsiderForm } from "./insider-data";
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
import { renderInsiderCell } from "./table";
import { InsiderDetail, insiderDetailTitle } from "./detail";


const FORM4_PAGE_SIZE = 20;
// The first page grows to every filing inside the 90-day window, up to this
// many, so the totals do not depend on how far the list is scrolled.
const INSIDER_WINDOW_CAP = 120;
// Recent EDGAR dumps cap at 1,000 mixed forms. Older archives are fetched
// until this many filings or company history ends.
const SEC_FILING_SCAN_LIMIT = 20_000;
// A narrowed list too short to scroll cannot ask for more, so older filings
// load on their own until it fills a page, as far back as a year and this many.
const AUTO_FILL_DAYS = 365;
const AUTO_FILL_FILING_CAP = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Narrower panes pick the Type filter from a menu instead of showing every choice. */
const TYPE_FILTER_INLINE_WIDTH = 80;
/** The insider filter's value for every reporting owner. */
const ALL_INSIDERS = "*";

const TYPE_FILTER_LABELS: Record<InsiderTypeFilter, string> = {
  all: "All",
  trades: "Buys and sells",
  other: "Other",
};

/**
 * The 90-day buy and sale totals as figures: one cell per side, and per
 * security when there are several. A side with no trades says so. Buys read
 * in the gain colour and sales in the loss colour, as in the table; when the
 * Type filter hides open-market trades the figures dim and say so.
 */
function summaryItems(figures: InsiderSummaryFigures, typeFilter: InsiderTypeFilter): StatItem[] {
  const securities = new Set(figures.totals.map((total) => total.security));
  const hidden = typeFilter === "other";
  const items: StatItem[] = [];
  for (const side of ["P", "S"] as const) {
    const label = side === "P" ? "90d buys" : "90d sales";
    const totals = figures.totals.filter((total) => total.side === side);
    if (totals.length === 0) items.push({ id: side, label, value: "None", tone: "muted" });
    for (const total of totals) {
      items.push({
        id: `${total.security}:${side}`,
        label,
        value: total.unreconciled ? "Unavailable" : `${formatCompact(total.shares)} shares`,
        detail: [
          total.unreconciled ? "amended" : total.knownValue ? `$${formatCompact(total.value)}` : "value unavailable",
          securities.size > 1 ? total.security : null,
          hidden ? "not in this view" : null,
        ].filter(Boolean).join(" · "),
        tone: total.unreconciled || hidden ? "muted" : side === "P" ? "positive" : "negative",
      });
    }
  }
  return items;
}

function InsiderView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { ticker } = usePaneTickerIdentity();
  const tickerKey = ticker?.metadata.ticker ?? "none";
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(`insider:selectedId:${tickerKey}`, null);
  const [nameFilter, setNameFilter] = usePluginPaneState<string | null>(`insider:nameFilter:${tickerKey}`, null);
  const [storedTypeFilter, setTypeFilter] = usePluginPaneState<InsiderTypeFilter>("insider:typeFilter", DEFAULT_INSIDER_TYPE_FILTER);
  const typeFilter = isInsiderTypeFilter(storedTypeFilter) ? storedTypeFilter : DEFAULT_INSIDER_TYPE_FILTER;
  const [openItemId, setOpenItemIdState] = useDebouncedPluginPaneState<string | null>(`insider:openItemId:${tickerKey}`, null);
  const setOpenItemId = useCallback(
    (itemId: string | null) => setOpenItemIdState(itemId, { immediate: true }),
    [setOpenItemIdState],
  );
  const [sort, setSort] = useState<StackSortPreference<InsiderColumnId>>({ columnId: "date", direction: "desc" });
  const eligibleTicker = isUsEquityTicker(ticker);
  const instrument = instrumentFromTicker(ticker, ticker?.metadata.ticker ?? null);

  const filingsEntry = useSecFilingsQuery(
    instrument && eligibleTicker ? { instrument, count: SEC_FILING_SCAN_LIMIT } : null,
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
    if (!coordinator || !instrument || !eligibleTicker) return;
    void coordinator.loadSecFilings({ instrument, count: SEC_FILING_SCAN_LIMIT }, { forceRefresh: true });
  }, [cloudSession.requestKey, eligibleTicker, instrument]);

  const { contentCache: contentMap, pendingCount } = useSecFilingContentCache({
    scopeKey: `${ticker?.metadata.ticker ?? "none"}:${ticker?.metadata.exchange ?? ""}`,
    targets: visibleForm4Filings,
  });

  const allParsed: ParsedFiling[] = useMemo(() => visibleForm4Filings.flatMap((filing) => {
    const hasContent = contentMap.has(filing.accessionNumber);
    const xml = contentMap.get(filing.accessionNumber) ?? null;
    return parseInsiderFiling(filing, xml, !hasContent);
  }), [contentMap, visibleForm4Filings]);

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
  const columns = useMemo(() => buildInsiderColumns(width, rows), [rows, width]);

  // A narrowed list that cannot scroll cannot ask for older filings, so they
  // load here until it fills a page, back to a year at most.
  const oldestShown = visibleForm4Filings[visibleForm4Filings.length - 1]?.filingDate;
  const oldestShownTime = oldestShown ? new Date(oldestShown).getTime() : Number.NaN;
  const wantsOlderFilings = (typeFilter !== "all" || nameFilter != null)
    && shown.length < Math.max(FORM4_PAGE_SIZE, height)
    && shownCount < Math.min(form4Filings.length, AUTO_FILL_FILING_CAP)
    && oldestShownTime >= Date.now() - AUTO_FILL_DAYS * DAY_MS;
  useEffect(() => {
    if (wantsOlderFilings && pendingCount === 0) loadNextPage();
  }, [loadNextPage, pendingCount, shownCount, wantsOlderFilings]);

  const summary = useMemo(() => buildInsiderSummaryFigures(parsed, Date.now(), allParsed), [parsed, allParsed]);
  // A page loading in on scroll clears the totals until it is read; the last
  // totals for the same ticker and owner stay up so the table does not jump.
  const summaryScope = `${tickerKey}:${nameFilter ?? ""}`;
  const lastSummaryRef = useRef<{ scope: string; figures: InsiderSummaryFigures } | null>(null);
  if (summary) lastSummaryRef.current = { scope: summaryScope, figures: summary };
  const shownSummary = summary ?? (lastSummaryRef.current?.scope === summaryScope ? lastSummaryRef.current.figures : null);
  const statItems = useMemo(() => shownSummary ? summaryItems(shownSummary, typeFilter) : [], [shownSummary, typeFilter]);
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
  const loadMore = useTableLoadMore(scrollRef, shownCount < form4Filings.length && !openRow, loadNextPage);

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
    ],
  } : null), [focused, openAdjacent, openIndex, sortedRows.length]);

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

  if (!ticker) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view insider activity." />;
  }
  if (!eligibleTicker) return renderFilingNotice("Insider transactions are only shown for US equities.", width);
  if (authWall) return <SignInWall action="view insider transactions" needsVerification={cloudSession.needsVerification} />;
  if (loading && allFilings.length === 0) return <Spinner label="Loading insider filings..." />;
  if (error && allFilings.length === 0) return <EmptyState title="Insider filings unavailable." message={error} />;
  if (!loading && form4Filings.length === 0) {
    return renderFilingNotice(`No Form 4 filings found for ${ticker.metadata.ticker}.`, width);
  }

  // Until a filing is read there is nothing to say; after that the empty
  // list says how far back the filings it has read go, while older ones load.
  const oldestRead = allParsed.findLast((entry) => !entry.isLoading)?.filing.filingDate;
  const since = oldestRead ? ` since ${formatShortDate(oldestRead, { utc: true })}` : "";
  const emptyTitle = typeCounts.all === 0 && (pendingCount > 0 || wantsOlderFilings)
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
      detailContent={openRow ? <PaneLinkMenu><InsiderDetail row={openRow} width={width} scrollRef={detailScrollRef} /></PaneLinkMenu> : <Box flexGrow={1} />}
      selection={{
        kind: "index",
        selectedIndex: sortedRows.length > 0 ? selectedRowIndex : null,
        onChange: (_index, row) => setSelectedId(row.id),
      }}
      onActivate={(row) => {
        setSelectedId(row.id);
        setOpenItemId(row.id);
      }}
      rootBefore={<>
        <QueryBar
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
              inline: width >= TYPE_FILTER_INLINE_WIDTH,
            },
          ]}
        />
        <StatGrid items={statItems} width={width} />
      </>}
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

export const insiderModule: PluginModule = {
  panes: [
    {
      id: "insider",
      name: "Insider",
      icon: "I",
      component: InsiderView,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "insider-pane",
        paneId: "insider",
        label: "Insider",
        description: "Insider transaction activity for the selected ticker.",
        keywords: ["insider", "form 4", "ownership", "transactions", "ins"],
        shortcut: "INS",
        canCreate: (_context, options) => !options?.ticker || isUsEquityTicker(options.ticker),
      }),
      headless: insiderHeadless,
    },
  ],

  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "insider",
      name: "Insider",
      order: 47,
      component: InsiderView,
      instruments: ["equity"],
      isVisible: ({ ticker }) => isUsEquityTicker(ticker),
    });
  },
};
