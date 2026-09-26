import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginModule } from "../plugin-module";
import {
  useResolvedEntryValue,
  useSecFilingsQuery,
} from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import type { ScrollBoxRenderable } from "../../../ui";
import { EmptyState, FeedDataTableStackView, QueryBar, Spinner, StatGrid, useExternalLinkFooter, usePaneNoticeFooter, useTableLoadMore, type FeedDataTableItem, type StatItem } from "../../../components";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import { isUsEquityTicker } from "../../../utils/sec";
import { formatCompact } from "../../../utils/format";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { SignInWall } from "../cloud/auth-actions";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import {
  buildInsiderTransactionDetailBody,
  buildInsiderTransactionTitle,
  formatFilingFormLabel,
  formatFilingShortDate,
  renderFilingNotice,
} from "../sec/filing-display";
import { useSecFilingContentCache } from "../sec/filing-content";
import {
  buildInsiderSummaryFigures,
  buildInsiderDisclosureText,
  insiderSummaryCutoff,
  matchesInsiderOwner,
  insiderTransactionId,
  isInsiderDisclosureOnly,
  insiderReportedName,
  parseInsiderFiling,
  type InsiderSummaryFigures,
  type ParsedInsiderFiling as ParsedFiling,
} from "./model";
import { insiderHeadless } from "./headless";
import { isInsiderForm } from "./insider-data";
import { isAmendedInsiderFiling, relevantInsiderAmendments } from "./amendments";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";


const FORM4_PAGE_SIZE = 20;
// The first page grows to every filing inside the 90-day window, up to this
// many, so the totals do not depend on how far the list is scrolled.
const INSIDER_WINDOW_CAP = 120;
// Recent EDGAR dumps cap at 1,000 mixed forms. Older archives are fetched
// until this many filings or company history ends.
const SEC_FILING_SCAN_LIMIT = 20_000;
/** The insider filter's value for every reporting owner. */
const ALL_INSIDERS = "*";

/**
 * The 90-day buy and sale totals as figures: one cell per side, and per
 * security when there are several. A side with no trades says so.
 */
function summaryItems(figures: InsiderSummaryFigures): StatItem[] {
  const securities = new Set(figures.totals.map((total) => total.security));
  const items: StatItem[] = [];
  for (const side of ["P", "S"] as const) {
    const label = side === "P" ? "90d buys" : "90d sales";
    const totals = figures.totals.filter((total) => total.side === side);
    if (totals.length === 0) items.push({ id: side, label, value: "None" });
    for (const total of totals) {
      items.push({
        id: `${total.security}:${side}`,
        label,
        value: total.unreconciled ? "Unavailable" : `${formatCompact(total.shares)} shares`,
        detail: [
          total.unreconciled ? "amended" : total.knownValue ? `$${formatCompact(total.value)}` : "value unavailable",
          securities.size > 1 ? total.security : null,
        ].filter(Boolean).join(" · "),
        tone: total.unreconciled ? "muted" : undefined,
      });
    }
  }
  return items;
}

function toFeedItems(parsed: ParsedFiling[]): FeedDataTableItem[] {
  return parsed.map((entry) => {
    const { filing, transaction, isLoading } = entry;
    const id = insiderTransactionId(entry);
    const amendment = isAmendedInsiderFiling(entry);
    const disclosureText = buildInsiderDisclosureText(entry);
    const filingMeta = [
      `Filed ${formatFilingShortDate(filing.filingDate)}`,
      `Accession ${filing.accessionNumber}`,
      formatFilingFormLabel(filing.form),
      ...(amendment ? ["Unreconciled amendment"] : []),
      ...(entry.disclosure?.originalFilingDate ? [`Original filed ${entry.disclosure.originalFilingDate}`] : []),
    ];

    if (!transaction) {
      const disclosureOnly = isInsiderDisclosureOnly(entry);
      const title = isLoading ? `Loading ${formatFilingFormLabel(filing.form)} filing...`
        : disclosureOnly ? `${amendment ? "Form 4/A" : "Form 4"} disclosure` : "Form 4 transaction unavailable";
      return {
        id,
        eyebrow: insiderReportedName(entry) ?? formatFilingFormLabel(filing.form),
        title,
        timestamp: filing.filingDate,
        detailTitle: insiderReportedName(entry) ?? title,
        detailMeta: filingMeta,
        detailBody: isLoading
          ? "Loading filing content..."
          : disclosureText || (disclosureOnly ? "No transaction lines reported." : "This Form 4 filing could not be parsed into a transaction summary."),
      };
    }

    return {
      id,
      eyebrow: transaction.reportedName,
      title: `${amendment ? "4/A · " : ""}${buildInsiderTransactionTitle(transaction)}`,
      timestamp: transaction.filingDate ?? filing.filingDate,
      detailTitle: transaction.reportedName,
      detailMeta: [
        ...(transaction.title ? [transaction.title] : []),
        ...filingMeta,
      ],
      detailBody: [disclosureText, buildInsiderTransactionDetailBody(transaction)].filter(Boolean).join("\n\n"),
    };
  });
}

function InsiderView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { ticker } = usePaneTickerIdentity();
  const tickerKey = ticker?.metadata.ticker ?? "none";
  const [selectedIdx, setSelectedIdx] = usePluginPaneState<number>(`insider:selectedIdx:${tickerKey}`, 0);
  const [nameFilter, setNameFilter] = usePluginPaneState<string | null>(`insider:nameFilter:${tickerKey}`, null);
  const [openItemId, setOpenItemIdState] = useDebouncedPluginPaneState<string | null>(`insider:openItemId:${tickerKey}`, null);
  const setOpenItemId = useCallback(
    (itemId: string | null) => setOpenItemIdState(itemId, { immediate: true }),
    [setOpenItemIdState],
  );
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
  const loadMore = useTableLoadMore(
    scrollRef,
    shownCount < form4Filings.length,
    () => setVisibleCount((current) => Math.min(form4Filings.length, Math.max(current, windowShown) + FORM4_PAGE_SIZE)),
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

  // Apply name filter
  const parsed = useMemo(() => (
    nameFilter
      ? allParsed.filter((entry) => matchesInsiderOwner(entry, nameFilter))
      : allParsed
  ), [allParsed, nameFilter]);
  const feedItems = useMemo(() => toFeedItems(parsed), [parsed]);
  const summary = useMemo(() => buildInsiderSummaryFigures(parsed, Date.now(), allParsed), [parsed, allParsed]);
  // A page loading in on scroll clears the totals until it is read; the last
  // totals for the same ticker and owner stay up so the table does not jump.
  const summaryScope = `${tickerKey}:${nameFilter ?? ""}`;
  const lastSummaryRef = useRef<{ scope: string; figures: InsiderSummaryFigures } | null>(null);
  if (summary) lastSummaryRef.current = { scope: summaryScope, figures: summary };
  const shownSummary = summary ?? (lastSummaryRef.current?.scope === summaryScope ? lastSummaryRef.current.figures : null);
  const statItems = useMemo(() => shownSummary ? summaryItems(shownSummary) : [], [shownSummary]);
  // The totals miss window filings only when the window passes the cap.
  const windowPartial = shownCount < windowCount;
  const insiderOptions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of allParsed) {
      const name = insiderReportedName(entry);
      if (name) names.add(name);
    }
    if (nameFilter) names.add(nameFilter);
    return [
      { value: ALL_INSIDERS, label: "All" },
      ...[...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: name })),
    ];
  }, [allParsed, nameFilter]);
  const amendments = useMemo(() => relevantInsiderAmendments(parsed, allParsed), [parsed, allParsed]);
  const selectedFilterName = parsed[selectedIdx] ? insiderReportedName(parsed[selectedIdx]!) : null;
  const openFiling = openItemId
    ? parsed.find((entry) => insiderTransactionId(entry) === openItemId)?.filing ?? null
    : null;

  const toggleNameFilter = useCallback((reportedName: string) => {
    setNameFilter((current) => current === reportedName ? null : reportedName);
    setSelectedIdx(0);
  }, [setNameFilter, setSelectedIdx]);
  const selectInsider = useCallback((value: string) => {
    setNameFilter(value === ALL_INSIDERS ? null : value);
    setSelectedIdx(0);
  }, [setNameFilter, setSelectedIdx]);
  const clearNameFilter = useCallback(() => {
    setNameFilter(null);
    setSelectedIdx(0);
  }, [setNameFilter, setSelectedIdx]);
  // The [f]ilter hint is the binding, so the key works over an open
  // transaction and an empty filtered list, and always does what a click does.
  const filterActionRef = useRef<() => void>(() => {});
  filterActionRef.current = () => {
    if (nameFilter) clearNameFilter();
    else if (selectedFilterName) toggleNameFilter(selectedFilterName);
  };
  const handleFilterPress = useCallback(() => filterActionRef.current(), []);

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

  return (
    <FeedDataTableStackView
      width={width}
      height={height}
      focused={focused}
      items={feedItems}
      selectedIdx={selectedIdx}
      onSelect={setSelectedIdx}
      openItemId={openItemId}
      onOpenItemIdChange={setOpenItemId}
      rootBefore={<>
        <QueryBar
          width={width}
          filters={[{
            id: "insider",
            label: "Insider",
            value: nameFilter ?? ALL_INSIDERS,
            defaultValue: ALL_INSIDERS,
            options: insiderOptions,
            onChange: selectInsider,
          }]}
        />
        <StatGrid items={statItems} width={width} />
      </>}
      sourceLabel="Insider"
      titleLabel="Transaction"
      emptyStateTitle={nameFilter
        ? "No insider transactions for this filter."
        : pendingCount > 0
          ? "Loading Form 4 transactions..."
          : "No insider transactions."}
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
