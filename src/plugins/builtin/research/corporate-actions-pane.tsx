import { useCallback, useEffect, useMemo, useRef } from "react";
import { Box, ScrollBox, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
  KeyValueRow,
  Prose,
  SectionHeading,
  usePaneNoticeFooter,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
} from "../../../types/financials";
import { blendHex, colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { formatPercent } from "../../../utils/format";
import { useResolvedEntryValue, useSecFilingDocuments, useSecFilingsQuery } from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneTicker } from "../../../state/app/context";
import { isUsEquityTicker } from "../../../utils/sec";
import { useAssetData, usePluginPaneState } from "../../runtime";
import { handleRefreshKey, loadingErrorFooterInfo } from "../shared/table-pane";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { useBoundTicker as useSymbolBinding, useTickerRequest } from "../shared/ticker-request";
import {
  documentContentKey,
  formatCompactDocumentLabel,
  isDefaultVisibleFilingDocument,
  isInlineExhibitDocument,
} from "../sec/filing-documents";
import {
  buildInlineFilingContentTargets,
  useSecFilingContentCache,
} from "../sec/filing-content";
import {
  buildEventRows,
  eventSourceNotice,
  formatEventMetric,
  type EventRow,
  type EventStatus,
} from "./event-model";

export { buildEventRows } from "./event-model";

type EventColumnId = "date" | "status" | "period" | "qEps" | "qRevenue" | "annualEps" | "annualRevenue" | "value" | "detail";
type EventColumn = DataTableColumn & { id: EventColumnId };

const SEC_EVENT_FILING_LIMIT = 50;
const SEC_EVENT_MATCH_WINDOW_DAYS = 7;

const eventRowKey = (row: EventRow) => row.id;

function todayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeyToEpochDay(dateKey: string): number | null {
  const timestamp = new Date(`${dateKey}T00:00:00Z`).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.floor(timestamp / 86_400_000);
}

function signedDaysBetween(leftDate: string, rightDate: string): number {
  const left = dateKeyToEpochDay(leftDate);
  const right = dateKeyToEpochDay(rightDate);
  if (left == null || right == null) return Number.POSITIVE_INFINITY;
  return right - left;
}

function filingDateKey(filing: SecFilingItem): string {
  const value = filing.filingDate as Date | string | number;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isSecEarningsFilingCandidate(filing: SecFilingItem): boolean {
  const form = filing.form.trim().toUpperCase();
  return form === "8-K"
    || form === "8-K/A"
    || form === "10-Q"
    || form === "10-Q/A"
    || form === "10-K"
    || form === "10-K/A";
}

function filingSearchText(filing: SecFilingItem): string {
  return [
    filing.form,
    filing.items,
    filing.primaryDocument,
    filing.primaryDocDescription,
  ].filter(Boolean).join(" ").toUpperCase();
}

function scoreFilingForEarnings(filing: SecFilingItem, earningsDate: string): number | null {
  if (!isSecEarningsFilingCandidate(filing)) return null;
  const delta = signedDaysBetween(earningsDate, filingDateKey(filing));
  if (!Number.isFinite(delta) || delta < -1 || delta > SEC_EVENT_MATCH_WINDOW_DAYS) return null;

  const form = filing.form.trim().toUpperCase();
  const text = filingSearchText(filing);
  let score = Math.abs(delta) * 10;
  if (delta < 0) score += 12;
  if (form.startsWith("10-")) score += 30;
  if (text.includes("2.02")) score -= 18;
  if (text.includes("9.01")) score -= 5;
  if (/RESULTS OF OPERATIONS|FINANCIAL CONDITION|EARNINGS/i.test(text)) score -= 6;
  return score;
}

export function matchEarningsSecFiling(row: { status: string; date: string; dateType?: EventRow["dateType"]; dateEvidence?: EventRow["dateEvidence"] } | null | undefined, filings: readonly SecFilingItem[]): SecFilingItem | null {
  if (!row || row.status !== "Earnings") return null;
  if (row.dateType === "fiscal-period-end") {
    return row.dateEvidence ? filings.find((filing) => filing.accessionNumber === row.dateEvidence?.accessionNumber) ?? null : null;
  }
  let best: { filing: SecFilingItem; score: number } | null = null;
  for (const filing of filings) {
    const score = scoreFilingForEarnings(filing, row.date);
    if (score == null) continue;
    if (!best || score < best.score) {
      best = { filing, score };
    }
  }
  return best?.filing ?? null;
}

/** The one currency every EPS and revenue cell is in, so the headers carry it once. */
function sharedMetricCurrency(rows: readonly EventRow[]): string | undefined {
  const currencies = new Set<string | undefined>();
  for (const row of rows) {
    for (const [value, currency] of [
      [row.qEps, row.epsCurrency], [row.annualEps, row.epsCurrency],
      [row.qRevenue, row.revenueCurrency], [row.annualRevenue, row.revenueCurrency],
    ] as const) {
      if (value != null && Number.isFinite(value)) currencies.add(currency || undefined);
    }
  }
  const [only] = currencies;
  return currencies.size === 1 ? only : undefined;
}

function buildEventColumns(unit?: string): EventColumn[] {
  const withUnit = (label: string) => unit ? `${label} ${unit}` : label;
  return [
    { id: "date", label: "DATE", width: 10, align: "left" },
    { id: "status", label: "EVENT", width: 8, align: "left" },
    { id: "period", label: "PERIOD", width: 9, align: "left" },
    { id: "qEps", label: withUnit("Q EPS"), width: 12, align: "right" },
    { id: "qRevenue", label: withUnit("Q REV"), width: 12, align: "right" },
    { id: "annualEps", label: withUnit("ANN EPS"), width: 12, align: "right" },
    { id: "annualRevenue", label: withUnit("ANN REV"), width: 12, align: "right" },
    { id: "value", label: "VALUE", width: 11, align: "right" },
    { id: "detail", label: "DETAIL", width: 9, align: "left", flexGrow: 1 },
  ];
}

function toneColor(tone: EventRow["tone"]): string {
  if (tone === "positive") return colors.positive;
  if (tone === "negative") return colors.negative;
  if (tone === "muted") return colors.textDim;
  return colors.text;
}

function eventDetailTitle(row: EventRow): string {
  return `${row.status} | ${row.date}`;
}

/** The row's figures in one line; the date is left to the detail title. */
function eventSummaryLine(row: EventRow): string {
  return [
    row.period !== "-" ? row.period : null,
    row.qEps != null ? `EPS ${formatEventMetric(row.qEps, row.epsCurrency, "eps")}` : null,
    row.qRevenue != null ? `Rev ${formatEventMetric(row.qRevenue, row.revenueCurrency, "revenue")}` : null,
    row.annualEps != null ? `Ann EPS ${formatEventMetric(row.annualEps, row.epsCurrency, "eps")}` : null,
    row.annualRevenue != null ? `Ann Rev ${formatEventMetric(row.annualRevenue, row.revenueCurrency, "revenue")}` : null,
    row.value !== "-" ? row.value : null,
    row.detail || null,
  ].filter((line): line is string => !!line).join(" | ");
}

function earningsInput(value: number | undefined, currency?: string): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
  return currency ? `${amount} ${currency}` : amount;
}

export type EventDetailBlock =
  | { kind: "row"; label: string; value: string; detail?: string; tone?: "positive" | "negative" }
  | { kind: "note"; text: string }
  | { kind: "prose"; text: string };

/** One headed group of the event detail: labelled figures, notes, or filing text. */
export interface EventDetailSection {
  title?: string;
  blocks: EventDetailBlock[];
}

const detailRow = (label: string, value: string, detail?: string, tone?: "positive" | "negative"): EventDetailBlock => (
  { kind: "row", label, value, ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) }
);
const detailNote = (text: string): EventDetailBlock => ({ kind: "note", text });

function asOfSection(row: EventRow): EventDetailSection {
  return { blocks: [row.fetchedAt ? detailRow("As of", row.fetchedAt) : detailNote("Retrieval time unavailable.")] };
}

export function buildEventDetail({
  row,
  secFilingsLoading,
  filing,
  documents,
  documentsLoading,
  inlineContent,
  primaryContent,
  primaryContentLoading,
}: {
  row: EventRow;
  secFilingsLoading: boolean;
  filing: SecFilingItem | null;
  documents: SecFilingDocument[];
  documentsLoading: boolean;
  inlineContent: Map<string, string | null>;
  primaryContent: string | null | undefined;
  primaryContentLoading: boolean;
}): EventDetailSection[] {
  if (row.status === "Q Est" || row.status === "FY Est") {
    const sections: EventDetailSection[] = [];
    for (const [key, label] of [["eps", "EPS"], ["revenue", "Revenue"]] as const) {
      const estimate = row.estimateInputs?.[key];
      if (!estimate) continue;
      const amount = (value: number | undefined) => earningsInput(value, estimate.currency);
      sections.push({
        title: `${label} consensus`,
        blocks: [
          detailRow("Average", amount(estimate.average)),
          detailRow("Low", amount(estimate.low)),
          detailRow("High", amount(estimate.high)),
          detailRow("Prior year", amount(estimate.yearAgo)),
          detailRow("Growth", estimate.growth == null ? "-" : formatPercent(estimate.growth), undefined,
            estimate.growth == null || estimate.growth === 0 ? undefined : estimate.growth > 0 ? "positive" : "negative"),
          detailRow("Analysts", estimate.analysts == null ? "-" : String(estimate.analysts)),
          ...(estimate.currency ? [] : [detailNote("Currency unavailable.")]),
        ],
      });
    }
    if (!row.estimateInputs) {
      sections.push({ title: "Summary", blocks: [
        { kind: "prose", text: eventSummaryLine(row) },
        detailNote("Detailed estimate inputs are unavailable."),
      ] });
    }
    const closing = asOfSection(row);
    closing.blocks.unshift(detailRow("Period end", row.date));
    if (row.estimateGrowthMetric) {
      closing.blocks.unshift(detailRow("Table growth", row.estimateGrowthMetric === "eps" ? "EPS" : "Revenue"));
    }
    sections.push(closing);
    return sections;
  }

  const sections: EventDetailSection[] = [];
  const summary = eventSummaryLine(row);
  if (summary) sections.push({ title: "Summary", blocks: [{ kind: "prose", text: summary }] });
  if (row.status === "Factor" && row.providerDescription) {
    sections.push({ title: "Split/adjustment factor", blocks: [detailRow("Description", row.providerDescription)] });
  }
  if (row.status !== "Earnings") return sections;

  const comparison: EventDetailBlock[] = [
    detailRow("Actual", earningsInput(row.epsActual, row.epsCurrency)),
    detailRow("Consensus", earningsInput(row.epsEstimate, row.epsCurrency)),
  ];
  if (row.epsDifference != null) comparison.push(detailRow("Difference", earningsInput(row.epsDifference, row.epsCurrency)));
  if (row.surprisePercent != null) {
    comparison.push(detailRow("Surprise", `${earningsInput(row.surprisePercent)}%`, undefined,
      row.surprisePercent === 0 ? undefined : row.surprisePercent > 0 ? "positive" : "negative"));
  }
  if (row.fiscalPeriodEnd) {
    comparison.push(detailRow("Fiscal period", row.fiscalPeriodEnd, row.periodDateSource === "sec" ? "SEC corroborated" : "not SEC corroborated"));
  }
  if (row.providerPeriodDate) comparison.push(detailRow("Reported period", row.providerPeriodDate));
  if (row.dateEvidence) comparison.push(detailRow("Period evidence", row.dateEvidence.accessionNumber, `filed ${row.dateEvidence.filed}`));
  if (row.fetchedAt) comparison.push(detailRow("As of", row.fetchedAt));
  if (row.qRevenue == null && row.earningsState === "reported") {
    comparison.push(detailNote("Quarterly revenue unavailable: no matching statement period was identified."));
  }
  sections.push({ title: "EPS comparison", blocks: comparison });

  const secFiling: EventDetailSection = { title: "SEC filing", blocks: [] };
  sections.push(secFiling);
  if (row.dateType === "fiscal-period-end" && !row.dateEvidence) {
    secFiling.blocks.push(detailNote("Related SEC filing unavailable."));
    return sections;
  }
  if (secFilingsLoading && !filing) {
    secFiling.blocks.push(detailNote("Loading recent SEC filings..."));
    return sections;
  }
  if (!filing) {
    secFiling.blocks.push(detailNote("No related SEC filing found in recent filings."));
    return sections;
  }
  secFiling.blocks.push(
    detailRow("Form", filing.form, `filed ${filingDateKey(filing)}`),
    ...(filing.items ? [detailRow("Items", filing.items)] : []),
    detailRow("Accession", filing.accessionNumber),
  );

  const documentBlocks: EventDetailBlock[] = [];
  if (documentsLoading && documents.length === 0) {
    documentBlocks.push(detailNote("Loading filing documents..."));
  } else if (documents.length === 0) {
    documentBlocks.push(detailNote("No filing documents were listed for this filing."));
  } else {
    const visibleDocuments = documents.filter(isDefaultVisibleFilingDocument);
    documentBlocks.push(...visibleDocuments.map((document): EventDetailBlock => ({ kind: "prose", text: formatCompactDocumentLabel(document) })));
    const hiddenCount = documents.length - visibleDocuments.length;
    if (hiddenCount > 0) documentBlocks.push(detailNote(`+ ${hiddenCount} support documents hidden`));
  }
  sections.push({ title: "Documents", blocks: documentBlocks });

  const exhibits = documents.filter(isInlineExhibitDocument);
  for (const document of exhibits) {
    const key = documentContentKey(filing, document);
    const content = inlineContent.get(key);
    // Headings are upper-cased and cut to one line, so only the exhibit type
    // goes there; the file name and description keep their case, wrapped below.
    const described = document.description
      && document.description !== document.document
      && document.description !== document.type;
    sections.push({
      title: document.type || "Document",
      blocks: [detailNote(described ? `${document.document} | ${document.description}` : document.document), inlineContent.has(key)
        ? content ? { kind: "prose", text: content } : detailNote("Readable document content was not available for this exhibit.")
        : detailNote("Loading exhibit content...")],
    });
  }

  if (!documentsLoading && exhibits.length === 0) {
    sections.push({
      title: "Primary filing content",
      blocks: [primaryContentLoading
        ? detailNote("Loading filing content...")
        : primaryContent ? { kind: "prose", text: primaryContent } : detailNote("Readable filing content was not available.")],
    });
  }
  return sections;
}

const DETAIL_LABEL_WIDTH = 17;

/** The event detail drawn with the kit: headed sections of labelled figures and wrapped text. */
function EventDetailSections({ sections, width }: { sections: EventDetailSection[]; width: number }) {
  return (
    <Box flexDirection="column" gap={1}>
      {sections.map((section, sectionIndex) => (
        <Box key={`${sectionIndex}:${section.title ?? ""}`} flexDirection="column">
          {section.title ? <SectionHeading title={section.title} width={width} /> : null}
          {section.blocks.map((block, blockIndex) => {
            const key = `${sectionIndex}:${blockIndex}`;
            if (block.kind === "row") {
              return (
                <KeyValueRow
                  key={key}
                  label={block.label}
                  value={block.value}
                  detail={block.detail}
                  color={block.tone === "positive" ? colors.positive : block.tone === "negative" ? colors.negative : undefined}
                  labelWidth={DETAIL_LABEL_WIDTH}
                  width={width}
                />
              );
            }
            return block.kind === "note"
              ? <Prose key={key} text={block.text} width={width} color={colors.textDim} figures={false} />
              : <Prose key={key} text={block.text} width={width} />;
          })}
        </Box>
      ))}
    </Box>
  );
}

/** Statuses the Earnings Estimates surface keeps; the rest are corporate actions. */
const EARNINGS_STATUSES = new Set<EventStatus>(["Q Est", "FY Est", "Earnings", "TTM"]);

export function CorporateActionsView({
  focused,
  width,
  height,
  footerPaneId = "corporate-actions",
  variant = "corporate-actions",
}: {
  focused: boolean;
  width: number;
  height: number;
  footerPaneId?: string;
  variant?: "corporate-actions" | "earnings-estimates";
}) {
  const dataProvider = useAssetData();
  const cloudSession = useResearchCloudSession();
  const { symbol, ticker, exchange, currency } = useSymbolBinding();
  // The shared ticker snapshot already subscribes to financials for this pane.
  // Only the statements are read, so the rows do not rebuild on price ticks.
  const { financials: tickerFinancials } = usePaneTicker();
  const quarterlyStatements = tickerFinancials?.quarterlyStatements;
  const financialCurrency = tickerFinancials?.financialCurrency;
  const financialsData = useMemo(
    () => (quarterlyStatements || financialCurrency ? { quarterlyStatements: quarterlyStatements ?? [], financialCurrency } : null),
    [financialCurrency, quarterlyStatements],
  );
  const actionsLoader = useCallback((nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider?.getCorporateActions) throw new Error("Corporate actions source unavailable");
    return dataProvider.getCorporateActions(nextSymbol, nextExchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  }, [dataProvider, cloudSession.requestKey]);
  const analystLoader = useCallback(async (nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider?.getAnalystResearch) return null;
    return dataProvider.getAnalystResearch(nextSymbol, nextExchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  }, [dataProvider, cloudSession.requestKey]);
  const {
    data: actionsData,
    loading: actionsLoading,
    error: actionsError,
    reload: reloadActions,
  } = useTickerRequest<CorporateActionsData>(actionsLoader, symbol, exchange);
  const {
    data: analystData,
    loading: analystLoading,
    error: analystError,
    reload: reloadAnalyst,
  } = useTickerRequest<AnalystResearchData | null>(analystLoader, symbol, exchange);
  const displayCurrency = actionsData?.currency ?? analystData?.currency ?? currency;
  const allRows = useMemo(() => (
    buildEventRows(actionsData, analystData, financialsData, displayCurrency)
  ), [actionsData, analystData, displayCurrency, financialsData]);
  const rows = useMemo(() => (
    variant === "earnings-estimates"
      ? allRows.filter((row) => EARNINGS_STATUSES.has(row.status))
      : allRows
  ), [allRows, variant]);
  const unit = useMemo(() => sharedMetricCurrency(rows), [rows]);
  const columns = useMemo(() => buildEventColumns(unit), [unit]);
  const sourceNotice = useMemo(() => (
    actionsLoading || analystLoading
      ? null
      : eventSourceNotice({
        variant,
        symbol: symbol ?? "this ticker",
        actions: actionsData,
        actionsError,
        estimates: analystData,
        estimatesError: analystError,
      })
  ), [actionsData, actionsError, actionsLoading, analystData, analystError, analystLoading, symbol, variant]);
  // Keyed by row id, not by position, so a reload or a shared layout comes
  // back to the same event.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  const selectedIdx = Math.max(0, rows.findIndex((row) => eventRowKey(row) === selectedKey));
  const [openRowId, setOpenRowId] = usePluginPaneState<string | null>("openRowId", null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const todayKey = todayDateKey();
  const futureRowBackground = blendHex(colors.bg, colors.positive, 0.16);
  // Memoized so the table's row memo holds while the selection moves.
  const rowBackground = useCallback((row: EventRow) => (
    row.date > todayKey ? futureRowBackground : undefined
  ), [futureRowBackground, todayKey]);
  const loading = actionsLoading || analystLoading;
  const authWall = !loading && !actionsData && !analystData && (isCloudSessionRequired(actionsError) || isCloudSessionRequired(analystError));
  // Parallel requests fail with the same message ("No ticker selected"), so the
  // footer must report each distinct reason once.
  const error = [...new Set([actionsError, analystError].filter((value): value is string => !!value && !isCloudSessionRequired(value)))]
    .join(" | ") || null;
  const reload = useCallback(() => {
    reloadActions();
    reloadAnalyst();
  }, [reloadActions, reloadAnalyst]);
  const openRow = openRowId
    ? rows.find((row) => row.id === openRowId) ?? null
    : null;
  const instrument = useMemo(() => instrumentFromTicker(ticker, symbol), [symbol, ticker]);
  const secFilingsEntry = useSecFilingsQuery(
    openRow?.status === "Earnings" && instrument && isUsEquityTicker(ticker)
      ? { instrument, count: SEC_EVENT_FILING_LIMIT }
      : null,
  );
  const secFilings = useResolvedEntryValue(secFilingsEntry) ?? [];
  const secFilingsLoading = openRow?.status === "Earnings" && (
    secFilingsEntry?.phase === "idle"
    || secFilingsEntry?.phase === "loading"
    || secFilingsEntry?.phase === "refreshing"
  );
  const matchedFiling = useMemo(
    () => matchEarningsSecFiling(openRow, secFilings),
    [openRow, secFilings],
  );
  const documentsEntry = useSecFilingDocuments(matchedFiling);
  const documents = useResolvedEntryValue(documentsEntry) ?? [];
  const documentsLoading = !!matchedFiling && (
    documentsEntry?.phase === "idle"
    || documentsEntry?.phase === "loading"
    || documentsEntry?.phase === "refreshing"
  );
  const inlineTargets = useMemo(
    () => buildInlineFilingContentTargets(matchedFiling, documents),
    [documents, matchedFiling],
  );
  const filingContentTargets = useMemo(() => {
    if (!matchedFiling || documentsLoading) return [];
    return inlineTargets.length > 0 ? inlineTargets : [matchedFiling];
  }, [documentsLoading, inlineTargets, matchedFiling]);
  const { contentCache: inlineContent } = useSecFilingContentCache({
    scopeKey: `${symbol}:${exchange}`,
    targets: filingContentTargets,
  });
  const hasInlineExhibits = inlineTargets.length > 0;
  const primaryContent = matchedFiling
    ? inlineContent.get(matchedFiling.accessionNumber) ?? null
    : null;
  const primaryContentLoading = !!matchedFiling
    && !documentsLoading
    && !hasInlineExhibits
    && !inlineContent.has(matchedFiling.accessionNumber);

  useEffect(() => {
    if (openRowId && !rows.some((row) => row.id === openRowId)) {
      setOpenRowId(null);
    }
  }, [openRowId, rows]);

  useEffect(() => {
    if (!openRowId) return;
    const scrollBox = detailScrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [openRowId]);

  const detailSections = openRow
    ? buildEventDetail({
        row: openRow,
        secFilingsLoading,
        filing: matchedFiling,
        documents,
        documentsLoading,
        inlineContent,
        primaryContent,
        primaryContentLoading,
      })
    : [];
  // Leave room for both horizontal padding cells and the vertical scrollbar.
  const detailTextWidth = Math.max(width - 3, 12);
  const scrollDetailBy = useCallback((delta: number) => {
    const scrollBox = detailScrollRef.current;
    if (!scrollBox?.viewport) return;
    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollBox.scrollTop + delta));
  }, []);

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "j", "down")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      scrollDetailBy(1);
      return true;
    }
    if (isPlainKey(event, "k", "up")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      scrollDetailBy(-1);
      return true;
    }
    return false;
  }, [scrollDetailBy]);
  const detailContent = openRow ? (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
      paddingX={1}
      paddingY={1}
    >
      <ScrollBox
        ref={detailScrollRef}
        flexGrow={1}
        flexBasis={0}
        minHeight={0}
        scrollY
        focusable={false}
      >
        <EventDetailSections sections={detailSections} width={detailTextWidth} />
      </ScrollBox>
    </Box>
  ) : (
    <Box flexGrow={1} />
  );

  const renderCell = useCallback((
    row: EventRow,
    column: EventColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "date":
        return { text: row.date, color: selectedColor ?? colors.textDim };
      case "status":
        return { text: row.status, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "period":
        return { text: row.period, color: selectedColor ?? colors.textDim };
      case "qEps":
        return { text: formatEventMetric(row.qEps, unit ? undefined : row.epsCurrency, "eps"), color: selectedColor ?? colors.textDim };
      case "qRevenue":
        return { text: formatEventMetric(row.qRevenue, unit ? undefined : row.revenueCurrency, "revenue"), color: selectedColor ?? colors.textDim };
      case "annualEps":
        return { text: formatEventMetric(row.annualEps, unit ? undefined : row.epsCurrency, "eps"), color: selectedColor ?? colors.textDim };
      case "annualRevenue":
        return { text: formatEventMetric(row.annualRevenue, unit ? undefined : row.revenueCurrency, "revenue"), color: selectedColor ?? colors.textDim };
      case "value":
        return { text: row.value, color: selectedColor ?? toneColor(row.tone) };
      case "detail":
        return { text: row.detail, color: selectedColor ?? colors.text };
    }
  }, [unit]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, reload, { stopPropagation: true });
  }, [reload]);

  usePaneFooter(footerPaneId, () => ({
    info: loadingErrorFooterInfo(loading, error ?? (sourceNotice?.failed ? sourceNotice.text : null)),
  }), [error, footerPaneId, loading, sourceNotice]);

  usePaneNoticeFooter({
    registrationId: `${footerPaneId}:source-notices`,
    notices: sourceNotice && !sourceNotice.failed ? [sourceNotice.text] : [],
    focused: focused && !openRow,
    enabled: !authWall && rows.length > 0 && !openRow,
    title: "Event data",
  });

  if (authWall) return <SignInWall
    action={variant === "earnings-estimates" ? "view earnings estimates" : "view corporate actions"}
    needsVerification={cloudSession.needsVerification}
  />;

  return (
    <DataTableStackView<EventRow, EventColumn>
      focused={focused}
      detailOpen={!!openRow}
      onBack={() => setOpenRowId(null)}
      detailContent={detailContent}
      detailTitle={openRow ? eventDetailTitle(openRow) : undefined}
      selection={{
        kind: "index",
        selectedIndex: selectedIdx,
        onChange: (_index, row) => setSelectedKey(eventRowKey(row)),
      }}
      onActivate={(row) => setOpenRowId(row.id)}
      onDetailKeyDown={handleDetailKeyDown}
      rootWidth={width}
      rootHeight={height}
      onRootKeyDown={handleKeyDown}
      columns={columns}
      items={rows}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={eventRowKey}
      renderCell={renderCell}
      getRowBackgroundColor={rowBackground}
      emptyStateTitle={loading
        ? (variant === "earnings-estimates" ? "Loading earnings estimates..." : "Loading events...")
        : error ?? sourceNotice?.text ?? (variant === "earnings-estimates" ? "No earnings estimates" : "No events")}
    />
  );
}
