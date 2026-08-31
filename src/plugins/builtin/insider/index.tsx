import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginModule } from "../plugin-module";
import type { SecFilingItem } from "../../../types/data-provider";
import {
  useResolvedEntryValue,
  useSecFilingsQuery,
} from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneTicker } from "../../../state/app/context";
import type { ScrollBoxRenderable } from "../../../ui";
import { EmptyState, FeedDataTableStackView, Spinner, useExternalLinkFooter, useTableLoadMore, type FeedDataTableItem } from "../../../components";
import { usePluginPaneState } from "../../runtime";
import { isUsEquityTicker } from "../../../utils/sec";
import { formatCompact, formatCurrency } from "../../../utils/format";
import { truncateWithEllipsis as truncateText } from "../../../utils/text-wrap";
import { parseForm4Xml, type InsiderTransaction } from "./insider-data";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  buildInsiderTransactionDetailBody,
  buildInsiderTransactionTitle,
  formatFilingFormLabel,
  formatFilingShortDate,
  renderFilingNotice,
} from "../sec/filing-display";
import { useSecFilingContentCache } from "../sec/filing-content";

const FORM4_PAGE_SIZE = 20;
// Recent EDGAR dumps cap at 1,000 mixed forms. Older archives are fetched
// until this many filings or company history ends.
const SEC_FILING_SCAN_LIMIT = 20_000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

interface ParsedFiling {
  filing: SecFilingItem;
  transaction: InsiderTransaction | null;
  isLoading: boolean;
}

/** Null while filings are still parsing, so the pane never claims "no activity" early. */
function buildSummary(parsed: ParsedFiling[]): string | null {
  if (parsed.some(({ isLoading }) => isLoading)) return null;
  const cutoff = new Date(Date.now() - NINETY_DAYS_MS);
  let buyShares = 0;
  let sellShares = 0;
  let buyValue = 0;
  let sellValue = 0;

  for (const { transaction } of parsed) {
    if (!transaction) continue;
    const txDate = transaction.filingDate instanceof Date ? transaction.filingDate : new Date(transaction.filingDate);
    if (isNaN(txDate.getTime()) || txDate < cutoff) continue;
    if (transaction.transactionType === "P") {
      buyShares += transaction.shares;
      buyValue += transaction.totalValue ?? 0;
    } else if (transaction.transactionType === "S") {
      sellShares += transaction.shares;
      sellValue += transaction.totalValue ?? 0;
    }
  }

  if (buyShares === 0 && sellShares === 0) return "No buy/sell activity in last 90 days.";

  const parts: string[] = [];
  if (buyShares > 0) parts.push(`Bought ${formatCompact(buyShares)} shares (${formatCurrency(buyValue)})`);
  if (sellShares > 0) parts.push(`Sold ${formatCompact(sellShares)} shares (${formatCurrency(sellValue)})`);
  return parts.join("  |  ");
}

function toFeedItems(parsed: ParsedFiling[]): FeedDataTableItem[] {
  return parsed.map(({ filing, transaction, isLoading }) => {
    const filingMeta = [
      `Filed ${formatFilingShortDate(filing.filingDate)}`,
      `Accession ${filing.accessionNumber}`,
      formatFilingFormLabel(filing.form),
    ];

    if (!transaction) {
      return {
        id: filing.accessionNumber,
        eyebrow: formatFilingFormLabel(filing.form),
        title: isLoading ? "Loading Form 4 filing..." : "Form 4 transaction unavailable",
        timestamp: filing.filingDate,
        detailTitle: isLoading ? "Loading Form 4 filing..." : "Form 4 transaction unavailable",
        detailMeta: filingMeta,
        detailBody: isLoading
          ? "Loading filing content..."
          : "This Form 4 filing could not be parsed into a transaction summary.",
      };
    }

    return {
      id: filing.accessionNumber,
      eyebrow: transaction.reportedName,
      title: buildInsiderTransactionTitle(transaction),
      timestamp: transaction.filingDate,
      detailTitle: transaction.reportedName,
      detailMeta: [
        ...(transaction.title ? [transaction.title] : []),
        ...filingMeta,
      ],
      detailBody: buildInsiderTransactionDetailBody(transaction),
    };
  });
}

function InsiderView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { ticker } = usePaneTicker();
  const tickerKey = ticker?.metadata.ticker ?? "none";
  const [selectedIdx, setSelectedIdx] = usePluginPaneState<number>(`insider:selectedIdx:${tickerKey}`, 0);
  const [nameFilter, setNameFilter] = usePluginPaneState<string | null>(`insider:nameFilter:${tickerKey}`, null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const eligibleTicker = isUsEquityTicker(ticker);
  const instrument = instrumentFromTicker(ticker, ticker?.metadata.ticker ?? null);

  const filingsEntry = useSecFilingsQuery(
    instrument && eligibleTicker ? { instrument, count: SEC_FILING_SCAN_LIMIT } : null,
  );
  const allFilings = useResolvedEntryValue(filingsEntry) ?? [];
  const form4Filings = useMemo(
    () => allFilings.filter((f) => f.form.trim() === "4"),
    [allFilings],
  );
  const [visibleCount, setVisibleCount] = useState(FORM4_PAGE_SIZE);
  const visibleForm4Filings = useMemo(
    () => form4Filings.slice(0, visibleCount),
    [form4Filings, visibleCount],
  );
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(
    scrollRef,
    visibleCount < form4Filings.length,
    () => setVisibleCount((current) => Math.min(form4Filings.length, current + FORM4_PAGE_SIZE)),
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

  const { contentCache: contentMap, pendingCount } = useSecFilingContentCache({
    scopeKey: `${ticker?.metadata.ticker ?? "none"}:${ticker?.metadata.exchange ?? ""}`,
    targets: visibleForm4Filings,
  });

  const allParsed: ParsedFiling[] = useMemo(() => visibleForm4Filings.map((filing) => {
    const hasContent = contentMap.has(filing.accessionNumber);
    const xml = contentMap.get(filing.accessionNumber) ?? null;
    return {
      filing,
      transaction: xml ? parseForm4Xml(xml) : null,
      isLoading: !hasContent,
    };
  }), [contentMap, visibleForm4Filings]);

  // Apply name filter
  const parsed = useMemo(() => (
    nameFilter
      ? allParsed.filter((p) => p.transaction?.reportedName === nameFilter)
      : allParsed
  ), [allParsed, nameFilter]);
  const feedItems = useMemo(() => toFeedItems(parsed), [parsed]);
  const summary = useMemo(() => buildSummary(allParsed), [allParsed]);
  const selectedTransaction = parsed[selectedIdx]?.transaction ?? null;
  const openFiling = openItemId
    ? parsed.find(({ filing }) => filing.accessionNumber === openItemId)?.filing ?? null
    : null;

  const toggleNameFilter = useCallback((reportedName: string) => {
    setNameFilter((current) => current === reportedName ? null : reportedName);
    setSelectedIdx(0);
  }, [setNameFilter, setSelectedIdx]);
  const clearNameFilter = useCallback(() => {
    setNameFilter(null);
    setSelectedIdx(0);
  }, [setNameFilter, setSelectedIdx]);

  const handleRootKeyDown = useCallback((event: {
    name?: string;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    if (event.name !== "f") return false;
    if (!selectedTransaction) return false;
    event.stopPropagation?.();
    event.preventDefault?.();
    toggleNameFilter(selectedTransaction.reportedName);
    return true;
  }, [selectedTransaction, toggleNameFilter]);

  const selectedFilterName = selectedTransaction?.reportedName ?? null;
  const pendingLabel = pendingCount > 0 ? `loading ${pendingCount}...` : "";
  const footerInfo = useMemo(() => [
    ...(summary ? [{ id: "summary", parts: [{ text: truncateText(summary, Math.max(24, width - 20)), tone: "muted" as const }] }] : []),
    ...(nameFilter ? [{ id: "filter", parts: [{ text: `filter: ${truncateText(nameFilter, 24)}`, tone: "warning" as const }] }] : []),
    ...(pendingLabel ? [{ id: "pending", parts: [{ text: pendingLabel, tone: "muted" as const }] }] : []),
  ], [nameFilter, pendingLabel, summary, width]);
  const footerHints = useMemo(() => (
    selectedFilterName || nameFilter
      ? [{
          id: "filter",
          key: "f",
          label: "ilter",
          onPress: () => {
            if (nameFilter) clearNameFilter();
            else if (selectedFilterName) toggleNameFilter(selectedFilterName);
          },
        }]
      : []
  ), [clearNameFilter, nameFilter, selectedFilterName, toggleNameFilter]);
  useExternalLinkFooter({
    registrationId: "insider",
    focused,
    url: error ? null : openFiling?.filingUrl,
    source: openFiling?.form ? formatFilingFormLabel(openFiling.form) : null,
    info: footerInfo,
    hints: footerHints,
    label: "filing",
  });

  if (!ticker) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view insider activity." />;
  }
  if (!eligibleTicker) return renderFilingNotice("Insider transactions are only shown for US equities.", width);
  if (loading && allFilings.length === 0) return <Spinner label="Loading insider filings..." />;
  if (error) return <EmptyState title="Insider filings unavailable." message={error} />;
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
      onOpenItemIdChange={setOpenItemId}
      onRootKeyDown={handleRootKeyDown}
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
    createTickerSurfacePaneTemplate({
      id: "insider-pane",
      paneId: "insider",
      label: "Insider",
      description: "Insider transaction activity for the selected ticker.",
      keywords: ["insider", "form 4", "ownership", "transactions", "ins"],
      shortcut: "INS",
      canCreate: (_context, options) => !options?.ticker || isUsEquityTicker(options.ticker),
    }),
  ],

  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "insider",
      name: "Insider",
      order: 47,
      component: InsiderView,
      isVisible: ({ ticker }) => isUsEquityTicker(ticker),
    });
  },
};
