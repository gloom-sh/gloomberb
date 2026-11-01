import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginModule } from "../plugin-module";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import { useResolvedEntryValue, useSecFilingDocuments, useSecFilingsQuery, useTickerFinancials } from "../../../market-data/hooks";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import { usePaneSettingValue } from "../../../state/app/context";
import { Box, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { FILL_REST } from "../../../components/ui/fill";
import { t, tf } from "../../../i18n";
import { EmptyState, ExternalLinkText, FeedDataTableStackView, PaneLinkMenu, QueryBar, Spinner, TickerBadgeList, usePaneNoticeFooter, useTableLoadMore, type FeedDataTableItem, type PaneHint, type QueryBarFilter } from "../../../components";
import { useCompanyDataFooter } from "../../../components/layout/pane/status-footer";
import { displayWidth } from "../../../utils/format";
import type { DetailFact } from "../../../components/reader/detail-reader";
import type { ThemeColors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { useOpenDescription } from "../shared/open-description";
import { toneColor } from "../shared/research-cells";
import { mayBeUsEquityOrFundTicker, mayBeUsEquityTicker, secFilingItemCodes, US_FUND_FACTS_ONLY } from "../../../utils/sec";
import { fundAbroadProfile, venueAbroad, type FundAbroadProfile } from "./fund-abroad";
import { listingAnnouncementsPage } from "../../../utils/exchange-announcements";
import { pricingSupplementTest } from "../../../utils/sec-filings";
import { formatInsiderName } from "../insider/display";
import { parseForm4Xml } from "../insider/insider-data";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  formatFilingMetaDate,
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
import { usePaneStatusLinkFooter } from "../../../components/layout/pane/status-footer";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { SignInWall } from "../cloud/auth-actions";
import { ETF_FORMS_SETTING, filterFilingsByForms, fundSeriesFilings, parseFormsSetting, SEC_FILING_FETCH_LIMIT } from "./forms";
import { fundHeadless, secHeadless } from "./headless";
import { FundFactsSummary, FundViewNotice, useFundFacts } from "./fund-facts-view";
import { fundFactPublishers, fundFactsCache, listNames } from "./fund-facts";
import {
  ALL_FORMS,
  COMPANY_FORM_GROUPS,
  filingTone,
  filterFilingsByGroup,
  FUND_FORM_GROUPS,
  getFilingDisplayTitle,
  getFilingColumnText,
  getFormDescription,
  getMeaningfulPrimaryDescription,
  secFilingIssuers,
  secIssuerLabel,
  secReportedAcceptance,
} from "./model";
import { ownerNames, rowSummary, rowSummaryTarget } from "./row-summaries";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { createSecFilingSearchProvider, resetSecFilingFocusRequests, useSecFilingFocusRequest } from "./command-bar-search";

export { secHeadless } from "./headless";

const SEC_FILING_PAGE_SIZE = 50;
const NO_FILINGS: SecFilingItem[] = [];
const OWNERSHIP_FORMS = new Set(["3", "4", "5"]);
/** At most this many rows on screen have their insider forms and fund flow notices read for their row text. */
const OWNERSHIP_ROWS_READ = 40;

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

function buildForm4Detail(content: string | null, filing: SecFilingItem): string {
  if (!content) return buildDetailBody(filing);
  const transactions = parseForm4Xml(content);
  const tx = transactions[0];
  if (!tx) return buildDetailBody(filing);

  const lines: string[] = [];
  lines.push(`Insider: ${formatInsiderName(tx.reportedName)}`);
  if (tx.title) lines.push(`Title: ${tx.title}`);
  for (const [index, transaction] of transactions.entries()) {
    if (transactions.length > 1) lines.push("", `Transaction ${index + 1}`);
    lines.push(buildInsiderTransactionDetailBody(transaction));
  }
  return lines.join("\n");
}

function toFeedItems(
  colors: ThemeColors,
  issuerTicker: { symbol: string; open: () => void } | null,
  showIssuer: boolean,
  filings: SecFilingItem[],
  selectedAccessionNumber: string | undefined,
  contentCache: Map<string, string | null>,
  loadingContent: boolean,
  selectedDocuments: SecFilingDocument[],
  loadingDocuments: boolean,
  documentsError: string | null,
  contentErrors: Map<string, string>,
): FeedDataTableItem[] {
  // A Form 144 names its seller freely; the insider forms read beside it say which way round.
  const knownOwners = filings.flatMap((filing) => ownerNames(filing.form, contentCache.get(filing.accessionNumber)));
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

    // An insider form read once says who traded and how, a fund's 24F-2NT its
    // year's flows; the row says it too.
    const summaryTarget = rowSummaryTarget(filing);
    const readSummary = summaryTarget ? rowSummary(filing.form, contentCache.get(summaryTarget.accessionNumber), knownOwners) : null;
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
    const summary = readSummary?.title ?? getFilingColumnText(filing);
    const items = secFilingItemCodes(filing.items);
    const facts: DetailFact[] = [
      { label: "Issuer", value: filing.companyName || "Name unavailable" },
      ...(issuerTicker ? [{ label: "Ticker", value: issuerTicker.symbol, link: { label: `Open ${issuerTicker.symbol}`, onOpen: issuerTicker.open } }] : []),
      { label: "CIK", value: filing.cik },
      { label: "Form", value: formDesc ? `${filing.form} · ${formDesc}` : filing.form, color: toneColor(filingTone(filing, readSummary?.direction), colors) },
      { label: "Filed", value: formatFiledAt(filing) },
      ...(acceptedAt ? [{ label: "SEC-reported acceptance", value: acceptedAt }] : []),
      ...(items ? [{ label: "Items", value: items }] : []),
      { label: "Accession", value: filing.accessionNumber },
    ];

    return {
      id: filing.accessionNumber,
      eyebrow: filing.form,
      eyebrowColor: toneColor(filingTone(filing, readSummary?.direction), colors),
      // A ticker shared by several filers names the filer on each row.
      title: showIssuer && filing.companyName ? `${filing.companyName}: ${summary}` : summary,
      timestamp: filing.filingDate,
      detailTitle: enrichedTitle,
      detailFacts: facts,
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

/** `paneType` is set for the standalone pane and absent in the DES tab, whose header already names the security. */
function SecView({ width, height, focused, paneType }: { width: number; height: number; focused: boolean; paneType?: string }) {
  const { ticker } = usePaneTickerIdentity();
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const openDescription = useOpenDescription();
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
  const [formsSetting] = usePaneSettingValue("forms", "");
  const forms = useMemo(
    () => parseFormsSetting(typeof formsSetting === "string" ? formsSetting : ""),
    [formsSetting],
  );
  // A filing chosen in the command bar opens here once the pane is on its
  // ticker. The fund filings view (ETF) lists other forms, so it leaves it.
  useSecFilingFocusRequest(forms ? null : ticker?.metadata.ticker, setOpenItemId);
  // A form list is the fund filings view (ETF), which US-listed funds open too.
  const eligibleTicker = forms ? mayBeUsEquityOrFundTicker(ticker) : mayBeUsEquityTicker(ticker);
  // A fund listed abroad (3042.HK) gets what `ticker` says of it and its issuer's page, as `fn ETF` does.
  const abroadVenue = forms && !eligibleTicker && ticker ? venueAbroad(ticker.metadata.ticker) : null;
  const abroadFinancials = useTickerFinancials(abroadVenue ? ticker?.metadata.ticker : null, abroadVenue ? ticker : null);
  const abroad = abroadVenue ? fundAbroadProfile(abroadFinancials) : null;
  const abroadPage = abroad?.page ?? null;
  // An equity listed abroad links the page its exchange publishes its announcements on (ASX's for NST.AX).
  const announcements = !forms && !eligibleTicker && ticker
    ? listingAnnouncementsPage(ticker.metadata.ticker, ticker.metadata.exchange)
    : null;
  // The fund view (ETF) leads with the fund's facts, which load apart from its filings, so a filings wall or failure leaves them on screen.
  const fundFacts = useFundFacts(forms && eligibleTicker ? ticker?.metadata.ticker : null);
  const facts = fundFacts.data?.payload ?? null;
  const factsUrl = facts?.covered ? facts.nav?.url ?? facts.expenseRatio?.url ?? facts.netAssets?.url ?? null : null;
  const instrument = instrumentFromTicker(ticker, ticker?.metadata.ticker ?? null);
  const filingsEntry = useSecFilingsQuery(
    instrument && eligibleTicker
      ? { instrument, count: SEC_FILING_FETCH_LIMIT }
      : null,
  );
  const issuerFilings = useResolvedEntryValue(filingsEntry) ?? NO_FILINGS;
  // The filter runs over every filing the service returned for the issuer,
  // the same list the unfiltered pane shows, not over a first page of it.
  // The fund view keeps the fund's own series out of its trust's filings.
  const formFilings = useMemo(
    () => (forms ? filterFilingsByForms(fundSeriesFilings(issuerFilings), forms) : issuerFilings),
    [forms, issuerFilings],
  );
  // The fund view (ETF) has its own groups; each view keeps its own choice.
  const groups = forms ? FUND_FORM_GROUPS : COMPANY_FORM_GROUPS;
  const [storedGroup, setFormGroup] = usePluginPaneState<string>(forms ? "fundFormGroup" : "formGroup", ALL_FORMS);
  const formGroup = groups.some((group) => group.value === storedGroup) ? storedGroup : ALL_FORMS;
  // A ticker can map to more than one filer (CIK); each can be listed alone.
  const issuers = useMemo(() => secFilingIssuers(formFilings), [formFilings]);
  const [storedIssuer, setIssuer] = usePluginPaneState<string>("issuerCik", ALL_FORMS);
  const issuerCik = issuers.some((issuer) => issuer.cik === storedIssuer) ? storedIssuer : ALL_FORMS;
  const scopedFilings = useMemo(() => {
    const grouped = filterFilingsByGroup(formFilings, groups, formGroup);
    return issuerCik === ALL_FORMS ? grouped : grouped.filter((filing) => filing.cik === issuerCik);
  }, [formFilings, formGroup, groups, issuerCik]);
  // A bank files a pricing supplement for each note it sells, hundreds a week, which bury its
  // reports; they stay out until asked for, counted among the filings the other filters keep.
  const [showSupplements, setShowSupplements] = usePluginPaneState<boolean>("pricingSupplements", false);
  // Read over the issuer's whole list, so a Form or Filer filter does not change which 424B3 are term sheets.
  const isSupplement = useMemo(() => pricingSupplementTest(issuerFilings), [issuerFilings]);
  const supplementCount = useMemo(() => scopedFilings.filter(isSupplement).length, [isSupplement, scopedFilings]);
  const filings = useMemo(
    () => (showSupplements || supplementCount === 0 ? scopedFilings : scopedFilings.filter((filing) => !isSupplement(filing))),
    [isSupplement, scopedFilings, showSupplements, supplementCount],
  );
  const filterHistoryCapped = !!forms && issuerFilings.length >= SEC_FILING_FETCH_LIMIT;
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
  }, [ticker?.metadata.ticker, ticker?.metadata.exchange, formsSetting, formGroup, issuerCik, showSupplements]);
  const loading = filingsEntry?.phase === "loading" || filingsEntry?.phase === "refreshing";
  // A restored or shared open filing can sit past the first page, or be gone
  // from the feed entirely.
  useEffect(() => {
    if (!openItemId || filings.length === 0) return;
    const index = filings.findIndex((filing) => filing.accessionNumber === openItemId);
    if (index < 0) {
      // A pricing supplement opened from the command bar shows the supplements rather than closing.
      const supplement = !showSupplements && scopedFilings.some((filing) => filing.accessionNumber === openItemId && isSupplement(filing));
      if (supplement) setShowSupplements(true);
      else if (!loading) setOpenItemId(null);
      return;
    }
    if (index >= visibleCount) {
      setVisibleCount(Math.ceil((index + 1) / SEC_FILING_PAGE_SIZE) * SEC_FILING_PAGE_SIZE);
    }
  }, [filings, isSupplement, loading, openItemId, scopedFilings, setOpenItemId, setShowSupplements, showSupplements, visibleCount]);
  const error = filingsEntry?.error && filingsEntry.error.reasonCode !== "NO_DATA" ? filingsEntry.error.message : null;
  // Hosted, the only filings source is Gloom Cloud, which needs an account.
  const cloudSession = useResearchCloudSession();
  const authWall = formFilings.length === 0 && isCloudSessionRequired(error);

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

  // The open filing's content comes first. Insider forms say who traded only
  // in their text, so the ones around the cursor are read after it, one at a
  // time, for their rows; the rest of the list is never queued, which would
  // fire dozens of requests for rows nobody looks at. Read text is cached.
  const selectedFiling = visibleFilings[selectedIdx];
  // The rows on screen, as a share of the list so it holds for terminal rows and desktop pixels alike.
  const [onScreen, setOnScreen] = useState({ first: 0, count: height });
  const trackScroll = useCallback(() => {
    loadMore();
    const box = scrollRef.current;
    if (!box?.viewport || !(box.scrollHeight > 0) || visibleFilings.length === 0) return;
    const first = Math.floor((box.scrollTop / box.scrollHeight) * visibleFilings.length);
    const count = Math.ceil((box.viewport.height / box.scrollHeight) * visibleFilings.length) + 1;
    setOnScreen((current) => (current.first === first && current.count === count ? current : { first, count }));
  }, [loadMore, visibleFilings.length]);
  const nearbyOwnership = useMemo(() => [
    ...(selectedFiling ? [selectedFiling] : []),
    ...visibleFilings.slice(onScreen.first, onScreen.first + Math.min(OWNERSHIP_ROWS_READ, onScreen.count)),
  ].map(rowSummaryTarget).filter((target): target is SecFilingItem => !!target), [onScreen, selectedFiling, visibleFilings]);
  const viewedTargets = useMemo(() => [
    ...(openFiling ? [openFiling] : []),
    ...buildInlineFilingContentTargets(openFiling, openDocuments),
  ], [openDocuments, openFiling]);
  const contentTargets = useMemo(() => [...viewedTargets, ...nearbyOwnership], [nearbyOwnership, viewedTargets]);
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
    void coordinator.loadSecFilingDocuments(filing).catch(() => { /* Intentional ignore: the coordinator keeps a failed warm-up's error, which the filing shows when opened. */ });
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
  const reloadFacts = fundFacts.reload;
  useShortcut((event) => {
    if (!isPlainKey(event, "r")) return;
    refresh();
    if (forms && eligibleTicker) void reloadFacts();
  }, { enabled: focused, scope: "sec" });
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

  // The pane's own ticker opens its description; a fund or equity both have one.
  const issuerTicker = useMemo(() => (ticker && paneType ? {
    symbol: ticker.metadata.ticker,
    open: () => openDescription(ticker.metadata.ticker, ticker.metadata.exchange || undefined),
  } : null), [openDescription, paneType, ticker]);
  const hints = useMemo<PaneHint[]>(() => (issuerTicker
    ? [{ id: "sec-description", key: "d", label: "es", title: `Open ${issuerTicker.symbol}`, onPress: issuerTicker.open }]
    : []), [issuerTicker]);
  // An open filing links to itself; otherwise the fund view cites who published its facts.
  usePaneStatusLinkFooter({
    registrationId: "sec",
    focused,
    // A current report links its press release, where its figures are, when its index names one.
    url: openFiling ? openFiling.pressReleaseUrl ?? openFiling.filingUrl : factsUrl ?? abroadPage ?? announcements?.url,
    source: openFiling ? openFiling.form : facts?.covered ? listNames(fundFactPublishers(facts)) : announcements?.name ?? null,
    label: openFiling ? openFiling.pressReleaseUrl ? "press release" : "filing"
      : factsUrl ? "source" : abroadPage ? "issuer page" : announcements ? "announcements" : "filing",
    // Rows read in the background for their insiders do not hold up the pane.
    loading: loading || loadingDocuments || (!!loadingKey && viewedTargets.some((target) => target.accessionNumber === loadingKey)),
    error: authWall ? null : error ?? detailError,
    hints,
    showOpenHint: !!(openFiling ? openFiling.filingUrl : factsUrl ?? abroadPage ?? announcements),
  });

  // A foreign line's filings are its company's, read from the home line.
  useCompanyDataFooter(issuerFilings[0]?.companyFrom, !openFiling);
  usePaneNoticeFooter({
    registrationId: "sec:form-filter",
    notices: filterHistoryCapped
      ? [`Only the ${SEC_FILING_FETCH_LIMIT.toLocaleString("en-US")} most recent filings of this issuer were searched; older fund filings are not listed.`]
      : [],
    focused,
    enabled: !openFiling,
    title: "Fund filings",
  });

  const queryFilters = useMemo<QueryBarFilter[]>(() => [
    {
      id: "form",
      label: "Form",
      value: formGroup,
      defaultValue: ALL_FORMS,
      options: [{ value: ALL_FORMS, label: forms ? "All fund forms" : "All forms" }, ...groups.map((group) => ({ value: group.value, label: group.label }))],
      onChange: (value: string) => { setFormGroup(value); setSelectedIdx(0, { immediate: true }); setOpenItemId(null); },
    },
    ...(issuers.length > 1 ? [{
      id: "issuer",
      label: "Filer",
      value: issuerCik,
      defaultValue: ALL_FORMS,
      options: [{ value: ALL_FORMS, label: "All filers" }, ...issuers.map((issuer) => ({ value: issuer.cik, label: issuer.companyName || `CIK ${issuer.cik}` }))],
      onChange: (value: string) => { setIssuer(value); setSelectedIdx(0, { immediate: true }); setOpenItemId(null); },
    }] : []),
    ...(supplementCount > 0 ? [{
      id: "pricingSupplements",
      kind: "toggle" as const,
      label: `Pricing supplements (${supplementCount.toLocaleString("en-US")})`,
      short: `Supplements (${supplementCount.toLocaleString("en-US")})`,
      value: showSupplements,
      defaultValue: false,
      onChange: (value: boolean) => { setShowSupplements(value); setSelectedIdx(0, { immediate: true }); setOpenItemId(null); },
    }] : []),
  ], [formGroup, forms, groups, issuerCik, issuers, setFormGroup, setIssuer, setOpenItemId, setSelectedIdx, setShowSupplements, showSupplements, supplementCount]);
  // The ticker and the filer once, beside the filters: every row is their filing.
  const issuerMeta = issuers.length === 1 ? secIssuerLabel(issuers[0]!).replace(/CIK 0+/, "CIK ") : undefined;
  const queryBar = (
    <QueryBar
      width={width}
      filters={queryFilters}
      meta={issuerMeta}
      leading={issuerTicker
        ? <TickerBadgeList symbols={[issuerTicker.symbol]} width={displayWidth(issuerTicker.symbol) + 2} listed onOpen={issuerTicker.open} />
        : undefined}
    />
  );

  if (!ticker) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view SEC filings." />;
  }
  if (abroadVenue) return <FundAbroadNotice profile={abroad} />;
  if (!eligibleTicker) {
    return renderFilingNotice(forms ? "Fund filings are only shown for US-listed funds and equities." : "SEC filings are only shown for US equities.");
  }
  const factsSummary = forms
    ? <FundFactsSummary symbol={ticker.metadata.ticker} width={width} facts={facts} loading={fundFacts.loading} error={fundFacts.error} />
    : null;
  // On the desktop and the web the body takes what the bars leave by flex; the terminal counts rows.
  const fillRest = nativePaneChrome ? FILL_REST : { height };
  const withFacts = (body: ReactNode) => factsSummary
    ? (
      <Box flexDirection="column" width={width} overflow="hidden" {...fillRest}>
        {factsSummary}
        <Box flexDirection="column" {...FILL_REST}>{body}</Box>
      </Box>
    )
    : body;
  if (authWall) return withFacts(<SignInWall placement="sec-signin" action="view SEC filings" needsVerification={cloudSession.needsVerification} />);
  if (loading && filings.length === 0) return withFacts(<Spinner label="Loading SEC filings..." />);
  // The fund view keeps its facts and query bar over an empty or failed filings list, which says why in the table.
  if (!forms && error && formFilings.length === 0) return <EmptyState title="SEC filings unavailable." message={error} />;
  if (!forms && formFilings.length === 0) return renderFilingNotice(`No recent SEC filings for ${ticker.metadata.ticker}.`);
  const symbol = ticker.metadata.ticker;
  const fundEmptyTitle = error ? t("SEC filings unavailable.") : tf("No fund filings for {symbol}.", { symbol });
  // A trust (IBIT, GLD) files 10-Ks and 10-Qs, not fund forms.
  const fundEmptyHint = error ?? (issuerFilings.length > 0 ? tf("Its other filings: SEC {symbol}.", { symbol }) : undefined);
  if (forms && facts?.covered && formFilings.length === 0 && !error) {
    // A trust with facts (IBIT, GLD) files 10-Ks, not fund forms: the facts are the view, and one line says where its filings are.
    return (
      <Box flexDirection="column" width={width} overflow="hidden" {...fillRest}>
        {queryBar}
        {factsSummary}
        <FundViewNotice lines={[fundEmptyTitle, ...(fundEmptyHint ? [fundEmptyHint] : [])]} paddingTop={1} />
      </Box>
    );
  }

  return (
    <FeedDataTableStackView
      width={width}
      height={height}
      focused={focused}
      items={toFeedItems(
        colors,
        issuerTicker,
        issuers.length > 1 && issuerCik === ALL_FORMS,
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
      rootBefore={factsSummary ? <Box flexDirection="column" flexShrink={0}>{queryBar}{factsSummary}</Box> : queryBar}
      sourceLabel="Form"
      titleLabel="Filing"
      emptyStateTitle={forms && formFilings.length === 0 ? fundEmptyTitle
        : supplementCount > 0 && !showSupplements ? "Only pricing supplements."
        : formGroup === ALL_FORMS ? "No SEC filings." : "No filings of these forms."}
      emptyStateHint={forms && formFilings.length === 0 ? fundEmptyHint
        : supplementCount > 0 && !showSupplements ? "Turn on Pricing supplements to list them." : undefined}
      scrollRef={scrollRef}
      onBodyScrollActivity={trackScroll}
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
      tickerFollower: true,
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
        shortcutAliases: ["CF"],
        canCreate: (_context, options) => !options?.ticker || mayBeUsEquityTicker(options.ticker),
      }),
      headless: secHeadless,
    },
    {
      ...createTickerSurfacePaneTemplate({
        id: "sec-etf-pane",
        paneId: "sec",
        label: "Fund Facts",
        description: "A US-listed fund's fee, NAV, premium or discount, net assets, sponsor, inception and index, a leveraged or inverse fund's daily objective, then the fund's own SEC filings: prospectus updates, shareholder reports, N-CEN and N-PORT.",
        keywords: ["etf", "fund", "expense ratio", "fee", "nav", "premium", "discount", "aum", "net assets", "n-1a", "485bpos", "497", "n-csr", "n-cen", "n-port", "prospectus",
          "leveraged", "inverse", "daily objective", "daily-reset", "decay"],
        shortcut: "ETF",
        viewKey: "etf",
        canCreate: (_context, options) => !options?.ticker || mayBeUsEquityOrFundTicker(options.ticker),
        settings: () => ({ forms: ETF_FORMS_SETTING }),
      }),
      headless: fundHeadless,
    },
  ],

  setup(ctx) {
    fundFactsCache.attach(ctx.persistence);
    ctx.registerCommandBarSearchProvider(createSecFilingSearchProvider(ctx));
    ctx.registerTickerResearchTab({
      id: "sec",
      name: "SEC",
      order: 45,
      component: SecView,
      instruments: ["equity"],
      isVisible: ({ ticker }) => mayBeUsEquityTicker(ticker),
    });
  },
  dispose() {
    fundFactsCache.reset();
    resetSecFilingFocusRequests();
  },
};

/** A link under its label, as the CLI prints it ("Issuer page: ..."). */
function LabelledLink({ label, url, text }: { label: string; url: string; text: string }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row">
      <Text flexShrink={0} fg={colors.textDim}>{`${t(label)}: `}</Text>
      <ExternalLinkText url={url} label={text} />
    </Box>
  );
}

/**
 * ETF for a fund listed abroad (3042.HK): what `fn ETF` prints of it, its
 * name, its page at its issuer and where its description is from, the last
 * two as links the pane menu lists too. The footer's `o` opens the issuer page.
 */
function FundAbroadNotice({ profile }: { profile: FundAbroadProfile | null }) {
  const page = profile?.page;
  const source = profile?.descriptionSource;
  const links = page || source
    ? (
      <PaneLinkMenu>
        <Box flexDirection="column">
          {page && <LabelledLink label="Issuer page" url={page} text={new URL(page).hostname.replace(/^www\./, "")} />}
          {source && <LabelledLink label="Description from" url={source.url} text={source.publisher} />}
        </Box>
      </PaneLinkMenu>
    )
    : undefined;
  return <EmptyState title={US_FUND_FACTS_ONLY} message={profile?.name} actions={links} />;
}
