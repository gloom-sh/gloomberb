import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginModule } from "../plugin-module";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import { useResolvedEntryValue, useSecFilingDocuments, useSecFilingsQuery } from "../../../market-data/hooks";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useDebouncedPluginPaneState } from "../../runtime";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import { EmptyState, FeedDataTableStackView, Prose, Spinner, useTableLoadMore, type FeedDataTableItem } from "../../../components";
import { isUsEquityTicker, secFilingItemCodes } from "../../../utils/sec";
import { parseForm4Xml, transactionTypeLabel } from "../insider/insider-data";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  formatFilingMetaDate,
  buildInsiderTransactionTitle,
  buildInsiderTransactionDetailBody,
  renderFilingNotice,
} from "./filing-display";
import {
  documentContentKey,
  documentHeading,
  formatCompactDocumentLabel,
  isDefaultVisibleFilingDocument,
  isInlineExhibitDocument,
  filingPreviewTruncated,
} from "./filing-documents";
import {
  buildInlineFilingContentTargets,
  useSecFilingContentCache,
} from "./filing-content";
import { usePaneStatusLinkFooter } from "../shared/pane-footer";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { SignInWall } from "../cloud/auth-actions";
import { secHeadless } from "./headless";
import {
  getFilingDisplayTitle,
  getFormDescription,
  getMeaningfulPrimaryDescription,
  secFilingIssuers,
  secIssuerLabel,
  secReportedAcceptance,
} from "./model";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

export { secHeadless } from "./headless";

const SEC_FILING_FETCH_LIMIT = 20_000;
const SEC_FILING_PAGE_SIZE = 50;
const OWNERSHIP_FORMS = new Set(["3", "4", "5"]);

function formatFiledAt(filing: SecFilingItem): string {
  return formatFilingMetaDate(filing.filingDate);
}

function buildDetailBody(filing: SecFilingItem): string {
  const items = secFilingItemCodes(filing.items);
  const sections = [
    getMeaningfulPrimaryDescription(filing),
    items ? `Items: ${items}` : undefined,
    filing.primaryDocument ? `Primary document: ${filing.primaryDocument}` : undefined,
  ].filter((value): value is string => !!value && value.trim().length > 0);

  return sections.length > 0
    ? sections.join("\n\n")
    : "No additional SEC filing description is available for this entry.";
}

function buildDetailBodyWithDocuments({
  filing,
  documents,
  documentsLoading,
  documentsError,
  contentCache,
  contentErrors,
  primaryContent,
}: {
  filing: SecFilingItem;
  documents: SecFilingDocument[];
  documentsLoading: boolean;
  documentsError: string | null;
  contentErrors: Map<string, string>;
  contentCache: Map<string, string | null>;
  primaryContent: string;
}): string {
  const lines: string[] = [];
  lines.push("Documents");
  if (documentsError && documents.length === 0) {
    lines.push(`Filing documents unavailable: ${documentsError}`);
  } else if (documentsLoading && documents.length === 0) {
    lines.push("Loading filing documents...");
  } else if (documents.length === 0) {
    lines.push("No filing documents were listed for this filing.");
  } else {
    const visibleDocuments = documents.filter(isDefaultVisibleFilingDocument);
    lines.push(...visibleDocuments.map(formatCompactDocumentLabel));
    const hiddenCount = documents.length - visibleDocuments.length;
    if (hiddenCount > 0) lines.push(`+ ${hiddenCount} support documents hidden`);
  }

  const exhibits = documents.filter(isInlineExhibitDocument);
  if (exhibits.length > 0) {
    lines.push("", "Inline Exhibits");
    for (const document of exhibits) {
      const key = documentContentKey(filing, document);
      const hasContent = contentCache.has(key);
      const content = contentCache.get(key);
      lines.push("", documentHeading(document));
      lines.push(contentErrors.has(key) && !content
        ? `Exhibit content unavailable: ${contentErrors.get(key)}`
        : hasContent ? content || "Readable document content was not available for this exhibit."
        : "Loading exhibit content...");
    }
  }

  lines.push("", "Primary Filing Content", primaryContent);
  return lines.join("\n");
}

function buildForm4Preview(content: string | null): string | null {
  if (!content) return null;
  const transactions = parseForm4Xml(content);
  const tx = transactions[0];
  if (!tx) return null;
  if (transactions.length === 1) return `${tx.reportedName} — ${buildInsiderTransactionTitle(tx)}`;
  const types = [...new Set(transactions.map((transaction) => transactionTypeLabel(transaction.transactionType)))];
  return `${tx.reportedName} — ${transactions.length} transactions: ${types.join(", ")}`;
}

function buildForm4Detail(content: string | null, filing: SecFilingItem): string {
  if (!content) return buildDetailBody(filing);
  const transactions = parseForm4Xml(content);
  const tx = transactions[0];
  if (!tx) return buildDetailBody(filing);

  const lines: string[] = [];
  lines.push(`Insider: ${tx.reportedName}`);
  if (tx.title) lines.push(`Title: ${tx.title}`);
  for (const [index, transaction] of transactions.entries()) {
    if (transactions.length > 1) lines.push("", `Transaction ${index + 1}`);
    lines.push(buildInsiderTransactionDetailBody(transaction));
  }
  return lines.join("\n");
}

function toFeedItems(
  filings: SecFilingItem[],
  selectedAccessionNumber: string | undefined,
  contentCache: Map<string, string | null>,
  loadingContent: boolean,
  selectedDocuments: SecFilingDocument[],
  loadingDocuments: boolean,
  documentsError: string | null,
  contentErrors: Map<string, string>,
): FeedDataTableItem[] {
  return filings.map((filing) => {
    const displayTitle = getFilingDisplayTitle(filing);
    const acceptedAt = secReportedAcceptance(filing);
    const formDesc = getFormDescription(filing.form);
    const hasFetchedContent = contentCache.has(filing.accessionNumber);
    const fetchedContent = contentCache.get(filing.accessionNumber);
    const isOwnership = OWNERSHIP_FORMS.has(filing.form.trim());
    const fallbackBody = hasFetchedContent && !loadingContent && !fetchedContent
      ? `${buildDetailBody(filing)}\n\nReadable filing content was not available for this document.`
      : buildDetailBody(filing);

    // For Form 4s, build structured preview and detail from parsed XML
    const form4Preview = isOwnership && hasFetchedContent
      ? buildForm4Preview(fetchedContent ?? null)
      : null;
    const form4Detail = isOwnership && hasFetchedContent
      ? buildForm4Detail(fetchedContent ?? null, filing)
      : null;
    const selected = filing.accessionNumber === selectedAccessionNumber;
    const primaryDetailBody = loadingContent && selected
      ? "Loading filing content..."
      : contentErrors.has(filing.accessionNumber) && !fetchedContent
        ? `Filing content unavailable: ${contentErrors.get(filing.accessionNumber)}`
        : form4Detail ?? fetchedContent ?? fallbackBody;
    const detailBody = selected
      ? buildDetailBodyWithDocuments({
          filing,
          documents: selectedDocuments,
          documentsLoading: loadingDocuments,
          documentsError,
          contentCache,
          contentErrors,
          primaryContent: primaryDetailBody,
        })
      : form4Detail ?? fallbackBody;

    const enrichedTitle = formDesc
      ? `${displayTitle} — ${formDesc}`
      : displayTitle;

    return {
      id: filing.accessionNumber,
      eyebrow: filing.form,
      title: form4Preview ? `${displayTitle} | ${form4Preview}` : enrichedTitle,
      timestamp: filing.filingDate,
      detailTitle: enrichedTitle,
      detailMeta: [
        secIssuerLabel(filing),
        `Filed ${formatFiledAt(filing)}`,
        ...(acceptedAt ? [`SEC-reported acceptance ${acceptedAt}`] : []),
        `Accession ${filing.accessionNumber}`,
        ...(secFilingItemCodes(filing.items) ? [`Items ${secFilingItemCodes(filing.items)}`] : []),
        ...(filingPreviewTruncated(filing, selected ? selectedDocuments : [], contentCache)
          ? ["Preview truncated. Open the SEC filing for the complete documents and terms."] : []),
      ],
      detailBody,
    };
  });
}

function SecView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { ticker } = usePaneTickerIdentity();
  const selectionKey = `selectedIdx:${ticker?.metadata.ticker ?? "none"}`;
  const [selectedIdx, setSelectedIdx] = useDebouncedPluginPaneState<number>(selectionKey, 0);
  // The open filing is what the pane shows, so it is pane state: it restores
  // on relaunch and a shared pane opens on the same document.
  const [openItemId, setOpenItemIdState] = useDebouncedPluginPaneState<string | null>(
    `openAccession:${ticker?.metadata.ticker ?? "none"}`,
    null,
  );
  const setOpenItemId = useCallback(
    (itemId: string | null) => setOpenItemIdState(itemId, { immediate: true }),
    [setOpenItemIdState],
  );
  const eligibleTicker = isUsEquityTicker(ticker);
  const instrument = instrumentFromTicker(ticker, ticker?.metadata.ticker ?? null);
  const filingsEntry = useSecFilingsQuery(
    instrument && eligibleTicker
      ? { instrument, count: SEC_FILING_FETCH_LIMIT }
      : null,
  );
  const filings = useResolvedEntryValue(filingsEntry) ?? [];
  const [visibleCount, setVisibleCount] = useState(SEC_FILING_PAGE_SIZE);
  const visibleFilings = useMemo(() => filings.slice(0, visibleCount), [filings, visibleCount]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(
    scrollRef,
    visibleCount < filings.length,
    () => setVisibleCount((current) => Math.min(filings.length, current + SEC_FILING_PAGE_SIZE)),
  );
  useEffect(() => {
    setVisibleCount(SEC_FILING_PAGE_SIZE);
  }, [ticker?.metadata.ticker, ticker?.metadata.exchange]);
  const loading = filingsEntry?.phase === "loading" || filingsEntry?.phase === "refreshing";
  // A restored or shared open filing can sit past the first page, or be gone
  // from the feed entirely.
  useEffect(() => {
    if (!openItemId || filings.length === 0) return;
    const index = filings.findIndex((filing) => filing.accessionNumber === openItemId);
    if (index < 0) {
      if (!loading) setOpenItemId(null);
      return;
    }
    if (index >= visibleCount) {
      setVisibleCount(Math.ceil((index + 1) / SEC_FILING_PAGE_SIZE) * SEC_FILING_PAGE_SIZE);
    }
  }, [filings, loading, openItemId, setOpenItemId, visibleCount]);
  const error = filingsEntry?.error && filingsEntry.error.reasonCode !== "NO_DATA" ? filingsEntry.error.message : null;
  // Hosted, the only filings source is Gloom Cloud, which needs an account.
  const cloudSession = useResearchCloudSession();
  const authWall = filings.length === 0 && isCloudSessionRequired(error);

  const openFiling = openItemId
    ? filings.find((filing) => filing.accessionNumber === openItemId) ?? null
    : null;
  const documentsEntry = useSecFilingDocuments(openFiling ?? null);
  const openDocuments = useResolvedEntryValue(documentsEntry) ?? [];
  const documentsError = documentsEntry?.error && documentsEntry.error.reasonCode !== "NO_DATA" ? documentsEntry.error.message : null;
  const loadingDocuments = !!openFiling && (
    documentsEntry?.phase === "idle"
    || documentsEntry?.phase === "loading"
    || documentsEntry?.phase === "refreshing"
  );

  // Only the filing in view needs its content; queueing every ownership form in
  // the list fires dozens of SEC requests the user never looks at.
  const selectedFiling = visibleFilings[selectedIdx];
  const contentTargets = useMemo(() => [
    ...(openFiling ? [openFiling] : []),
    ...buildInlineFilingContentTargets(openFiling, openDocuments),
    ...(selectedFiling && OWNERSHIP_FORMS.has(selectedFiling.form.trim()) ? [selectedFiling] : []),
  ], [openDocuments, openFiling, selectedFiling]);
  const { contentCache, contentErrors, retry: retryContent, loadingKey } = useSecFilingContentCache({
    scopeKey: `${ticker?.metadata.ticker ?? "none"}:${ticker?.metadata.exchange ?? ""}:${eligibleTicker}`,
    targets: contentTargets,
  });
  const loadingContent = !!openFiling && (!contentCache.has(openFiling.accessionNumber) || loadingKey === openFiling.accessionNumber);
  const activeContentError = [openFiling, ...buildInlineFilingContentTargets(openFiling, openDocuments)]
    .filter((target): target is SecFilingItem => !!target)
    .map((target) => contentErrors.get(target.accessionNumber)).find(Boolean);
  const detailError = openFiling ? documentsError ?? activeContentError ?? null : null;

  // The document list is the first of the two round trips behind a filing.
  // Warming it while the cursor rests on the row leaves only the content
  // fetch for Enter; the content itself stays on demand, as the note above
  // says, so a scroll through the list does not fire a request per filing.
  const prefetchDocuments = useCallback((item: { id: string }) => {
    const coordinator = getSharedMarketDataCoordinator();
    const filing = visibleFilings.find((candidate) => candidate.accessionNumber === item.id);
    if (!coordinator || !filing) return;
    if (coordinator.getSecDocumentsEntry(filing.accessionNumber).phase !== "idle") return;
    void coordinator.loadSecFilingDocuments(filing).catch(() => {});
  }, [visibleFilings]);

  const refresh = useCallback(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !instrument || !eligibleTicker) return;
    void coordinator.loadSecFilings({ instrument, count: SEC_FILING_FETCH_LIMIT }, { forceRefresh: true });
    if (openFiling && (documentsError || openDocuments.length === 0)) {
      void coordinator.loadSecFilingDocuments(openFiling, { forceRefresh: true });
    }
    void retryContent();
  }, [instrument, eligibleTicker, openFiling, documentsError, openDocuments.length, retryContent]);
  useShortcut((event) => { if (isPlainKey(event, "r")) refresh(); }, { enabled: focused, scope: "sec" });
  // Signing in must retry the request the wall was shown for.
  const sessionKeyRef = useRef(cloudSession.requestKey);
  useEffect(() => {
    if (sessionKeyRef.current === cloudSession.requestKey) return;
    sessionKeyRef.current = cloudSession.requestKey;
    refresh();
  }, [cloudSession.requestKey, refresh]);

  useEffect(() => {
    if (visibleFilings.length > 0 && selectedIdx >= visibleFilings.length) {
      setSelectedIdx(Math.max(0, visibleFilings.length - 1));
    }
  }, [selectedIdx, setSelectedIdx, visibleFilings.length]);

  usePaneStatusLinkFooter({
    registrationId: "sec",
    focused,
    url: openFiling?.filingUrl,
    source: openFiling?.form,
    label: "filing",
    loading: loading || loadingDocuments || !!loadingKey,
    error: authWall ? null : error ?? detailError,
    showOpenHint: !!openFiling?.filingUrl,
  });

  if (!ticker) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view SEC filings." />;
  }
  if (!eligibleTicker) return renderFilingNotice("SEC filings are only shown for US equities.", width);
  if (authWall) return <SignInWall action="view SEC filings" needsVerification={cloudSession.needsVerification} />;
  if (loading && filings.length === 0) return <Spinner label="Loading SEC filings..." />;
  if (error && filings.length === 0) return <EmptyState title="SEC filings unavailable." message={error} />;
  if (filings.length === 0) return renderFilingNotice(`No recent SEC filings for ${ticker.metadata.ticker}.`, width);

  return (
    <FeedDataTableStackView
      width={width}
      height={height}
      focused={focused}
      items={toFeedItems(
        visibleFilings,
        openFiling?.accessionNumber,
        contentCache,
        loadingContent,
        openDocuments,
        loadingDocuments,
        documentsError,
        contentErrors,
      )}
      selectedIdx={selectedIdx}
      onSelect={setSelectedIdx}
      openItemId={openItemId}
      onOpenItemIdChange={setOpenItemId}
      prefetchDetail={prefetchDocuments}
      rootBefore={<Box flexDirection="column" paddingX={1}>
        {secFilingIssuers(filings).map((issuer) => <Prose key={issuer.cik} text={secIssuerLabel(issuer)} width={Math.max(width - 2, 12)} />)}
      </Box>}
      sourceLabel="Form"
      titleLabel="Filing"
      emptyStateTitle="No SEC filings."
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
    />
  );
}

export const secModule: PluginModule = {
  panes: [
    {
      id: "sec",
      name: "SEC",
      icon: "S",
      component: SecView,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 32 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "sec-pane",
        paneId: "sec",
        label: "SEC",
        description: "Recent SEC filings for the selected ticker.",
        keywords: ["sec", "filings", "10-k", "10-q", "8-k"],
        shortcut: "SEC",
        canCreate: (_context, options) => !options?.ticker || isUsEquityTicker(options.ticker),
      }),
      headless: secHeadless,
    },
  ],

  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "sec",
      name: "SEC",
      order: 45,
      component: SecView,
      instruments: ["equity"],
      isVisible: ({ ticker }) => isUsEquityTicker(ticker),
    });
  },
};
