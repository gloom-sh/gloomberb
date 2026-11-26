import { useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import {
  DetailScrollBody,
  KeyValueRow,
  Prose,
  SectionHeading,
} from "../../../components";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import { colors } from "../../../theme/colors";
import { MISSING_VALUE, formatPercent } from "../../../utils/format";
import { NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import { useResolvedEntryValue, useSecFilingDocuments, useSecFilingsQuery } from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { mayBeUsEquityTicker } from "../../../utils/sec";
import { demergerSuccessor } from "../../../market-data/price-adjustments";
import {
  documentContentKey,
  formatCompactDocumentLabel,
  isDefaultVisibleFilingDocument,
  isInlineExhibitDocument,
} from "../sec/filing-documents";
import {
  buildFilingContentPreviews,
  buildInlineFilingContentTargets,
  useSecFilingContentCache,
} from "../sec/filing-content";
import { formatEventMetric, type EventRow } from "./event-model";

const SEC_EVENT_FILING_LIMIT = 50;
const SEC_EVENT_MATCH_WINDOW_DAYS = 7;

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

function eventDetailTitle(row: EventRow): string {
  return `${row.status} | ${row.date}`;
}

/** The row's figures in one line; the date is left to the detail title. */
function eventSummaryLine(row: EventRow): string {
  return [
    row.period && row.period !== MISSING_VALUE ? row.period : null,
    row.qEps != null ? `EPS ${formatEventMetric(row.qEps, row.epsCurrency, "eps")}` : null,
    row.qRevenue != null ? `Rev ${formatEventMetric(row.qRevenue, row.revenueCurrency, "revenue")}` : null,
    row.annualEps != null ? `Ann EPS ${formatEventMetric(row.annualEps, row.epsCurrency, "eps")}` : null,
    row.annualRevenue != null ? `Ann Rev ${formatEventMetric(row.annualRevenue, row.revenueCurrency, "revenue")}` : null,
    row.value !== MISSING_VALUE ? row.value : null,
    row.detail || null,
  ].filter((line): line is string => !!line).join(" | ");
}

function earningsInput(value: number | undefined, currency?: string): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
  return currency ? `${amount} ${currency}` : amount;
}

type EventDetailBlock =
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
          detailRow("Growth", estimate.growth == null ? MISSING_VALUE : formatPercent(estimate.growth), undefined,
            estimate.growth == null || estimate.growth === 0 ? undefined : estimate.growth > 0 ? "positive" : "negative"),
          detailRow("Analysts", estimate.analysts == null ? MISSING_VALUE : String(estimate.analysts)),
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
    sections.push(closing);
    return sections;
  }

  if (row.status === "Dividend") {
    return [{ title: "Dividend", blocks: [
      detailRow("Ex-date", row.date),
      ...(row.payDate ? [detailRow("Payable", row.payDate)] : []),
      detailRow("Per share", row.value, [row.declared ? "declared" : row.published ? "as published" : null, row.special ? "special" : null]
        .filter(Boolean).join(", ") || undefined),
      // What a later price adjustment (CTVA's for the VYLR spin-off) did to the amount, which stays as the history states it.
      ...(row.adjustedFor ? [detailRow("Basis", row.adjustedFor)] : []),
      // The history's paid amounts are stated on today's shares; a declared amount is as declared, a published one as published.
      ...(row.declared || row.published ? []
        : [detailNote("Per share as the shares stand today: an amount paid before a later split, bonus issue or price adjustment is adjusted for it.")]),
    ] }];
  }

  const sections: EventDetailSection[] = [];
  const summary = eventSummaryLine(row);
  if (summary) sections.push({ title: "Summary", blocks: [{ kind: "prose", text: summary }] });
  if (row.status === "Spin-off" && row.demerger) {
    const { demerger } = row;
    sections.push({ title: "Spin-off", blocks: [
      detailRow("Into", demergerSuccessor(demerger)),
      ...(demerger.ratio ? [detailRow("Shares", `${demerger.ratio} per share held`)] : []),
      ...(demerger.recordDate ? [detailRow("Record date", demerger.recordDate)] : []),
      detailRow("Listed", demerger.successor.listedOn ?? "not yet"),
      detailRow("Price adjustment", row.value),
    ] });
  } else if (row.status === "Factor" && row.providerDescription) {
    sections.push({ title: "Split/adjustment factor", blocks: [detailRow("Description", row.providerDescription)] });
  }
  if (row.status !== "Earnings") return sections;

  const comparison: EventDetailBlock[] = [
    ...(row.dateStatus && row.dateStatus !== "reported" ? [detailRow("Report date", row.date, row.dateStatus)] : []),
    // When in the day the report came or comes out, as the source gives it; never the row's period.
    ...(row.reportTime ? [detailRow("Report time", row.reportTime)] : []),
    detailRow("Actual", earningsInput(row.epsActual, row.epsCurrency),
      row.epsActual == null ? undefined : [row.epsBasis === "unknown" ? "basis unknown" : row.epsBasis,
        row.epsProvisional ? "provisional, from the company's press release" : null].filter(Boolean).join(", ") || undefined),
    // An upcoming estimate names its basis when it is adjusted (a REIT's FFO consensus).
    detailRow("Consensus", earningsInput(row.epsEstimate, row.epsCurrency),
      [row.epsAnalysts != null ? `${row.epsAnalysts} analysts` : null,
        row.epsActual == null && row.epsBasis === "adjusted" ? "adjusted" : null].filter(Boolean).join(", ") || undefined),
  ];
  if (row.streetEps && row.epsBasis === "company-adjusted") comparison.push(
    detailRow("GAAP diluted EPS", earningsInput(row.gaapEps, row.epsCurrency)),
    detailRow("Street actual", earningsInput(row.streetEps.actual, row.epsCurrency), "includes stock compensation"),
    detailRow("Street estimate", earningsInput(row.streetEps.estimate ?? undefined, row.epsCurrency), "basis unconfirmed"),
  );
  if (row.epsDifference != null) comparison.push(detailRow("Difference", earningsInput(row.epsDifference, row.epsCurrency)));
  // Both figures as the history states them after a later price adjustment (CTVA's for the VYLR spin-off).
  if (row.adjustedFor) comparison.push(detailRow("Basis", row.adjustedFor));
  if (row.surpriseNotMeaningful) {
    comparison.push(detailRow("Surprise", NOT_MEANINGFUL_TEXT, "against a loss or zero estimate"));
  } else if (row.surprisePercent != null) {
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

/**
 * A row's detail as EE and EVT's Earnings view open it: an estimate's inputs,
 * or a report's EPS comparison and, for a US listing, the SEC filing matched
 * to it with its documents and exhibits. Nothing is read until a row is open;
 * what was read stays for the view's life, so reopening a row is instant.
 */
export function useEventRowDetail(openRow: EventRow | null, { symbol, exchange, ticker, width }: {
  symbol: string | null;
  exchange: string;
  ticker: Parameters<typeof instrumentFromTicker>[0];
  width: number;
}): { content: ReactNode; title: string | undefined; scrollRef: RefObject<ScrollBoxRenderable | null> } {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const instrument = useMemo(() => instrumentFromTicker(ticker, symbol), [symbol, ticker]);
  const secFilingsEntry = useSecFilingsQuery(
    openRow?.status === "Earnings" && instrument && mayBeUsEquityTicker(ticker)
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
  const { contentCache } = useSecFilingContentCache({
    scopeKey: `${symbol}:${exchange}`,
    targets: filingContentTargets,
  });
  const inlineContent = useMemo(() => buildFilingContentPreviews(filingContentTargets, contentCache), [filingContentTargets, contentCache]);
  const hasInlineExhibits = inlineTargets.length > 0;
  const primaryContent = matchedFiling
    ? inlineContent.get(matchedFiling.accessionNumber) ?? null
    : null;
  const primaryContentLoading = !!matchedFiling
    && !documentsLoading
    && !hasInlineExhibits
    && !inlineContent.has(matchedFiling.accessionNumber);

  if (!openRow) return { content: <Box flexGrow={1} />, title: undefined, scrollRef };
  const sections = buildEventDetail({
    row: openRow,
    secFilingsLoading,
    filing: matchedFiling,
    documents,
    documentsLoading,
    inlineContent,
    primaryContent,
    primaryContentLoading,
  });
  // Leave room for both horizontal padding cells and the vertical scrollbar.
  const textWidth = Math.max(width - 3, 12);
  return {
    content: (
      <DetailScrollBody ref={scrollRef} resetScrollKey={openRow.id}>
        <EventDetailSections sections={sections} width={textWidth} />
      </DetailScrollBody>
    ),
    title: eventDetailTitle(openRow),
    scrollRef,
  };
}
