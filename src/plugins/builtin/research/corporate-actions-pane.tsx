import { useCompanyDisclosureLinks } from "../company-kpis/related";
import { useEventData } from "./event-data";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Box, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
  ChartTableHeader,
  DetailScrollBody,
  KeyValueRow,
  Prose,
  SectionHeading,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import { blendHex, colors } from "../../../theme/colors";
import { MISSING_VALUE, formatPercent } from "../../../utils/format";
import { formatFilingDate } from "../../../utils/datetime-format";
import { NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import { useResolvedEntryValue, useSecFilingDocuments, useSecFilingsQuery } from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { mayBeUsEquityTicker } from "../../../utils/sec";
import { usePluginPaneState } from "../../runtime";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { SignInWall } from "../cloud/auth-actions";
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
import {
  buildEventSummary,
  formatEventMetric,
  type EventRow,
  type EventStatus,
} from "./event-model";

type EventColumnId = "date" | "status" | "period" | "detail" | "eps" | "revenue" | "surprise" | "growth";
type EventColumn = DataTableColumn & { id: EventColumnId };

const SEC_EVENT_FILING_LIMIT = 50;
const SEC_EVENT_MATCH_WINDOW_DAYS = 7;

const eventRowKey = (row: EventRow) => row.id;

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

/**
 * The one currency every stated amount of a column is in (EPS or revenue),
 * named once in its heading: `EPS CNY`. An amount whose
 * source stated no currency is marked `?` beside it rather than counted, so it
 * never reads as that currency; amounts in several currencies keep their own
 * codes and the heading names none.
 */
function sharedColumnCurrency(rows: readonly EventRow[], kind: "eps" | "revenue"): string | undefined {
  const currencies = new Set<string>();
  for (const row of rows) {
    const values = kind === "eps" ? [row.qEps, row.annualEps] : [row.qRevenue, row.annualRevenue];
    const currency = kind === "eps" ? row.epsCurrency : row.revenueCurrency;
    if (currency && values.some((value) => value != null && Number.isFinite(value))) currencies.add(currency);
  }
  const [only] = currencies;
  return currencies.size === 1 ? only : undefined;
}

/** The currencies the EPS and revenue columns are headed with, where each column has one. */
export interface EventColumnUnits {
  eps?: string;
  revenue?: string;
}

/** A figure column headed with its currency where every amount in it shares one: `EPS CNY`, wide enough for it. */
function amountColumn(id: "eps" | "revenue", label: string, unit: string | undefined, bareWidth: number, codedWidth: number): EventColumn {
  const heading = unit ? `${label} ${unit}` : label;
  return { id, label: heading, width: Math.max(unit ? bareWidth : codedWidth, heading.length), align: "right" };
}

/** EE's columns: one EPS and one revenue column, a quarter's or a year's as the row's Event and Period say. */
export function buildEventColumns(width: number, units: EventColumnUnits = {}): EventColumn[] {
  return fitChartTableColumns<EventColumn>([
    { id: "date", label: "DATE", width: 11, align: "left" },
    { id: "status", label: "EVENT", width: 8, align: "left" },
    { id: "period", label: "PERIOD", width: 9, align: "left" },
    amountColumn("eps", "EPS", units.eps, 7, 11),
    amountColumn("revenue", "REVENUE", units.revenue, 9, 13),
    { id: "surprise", label: "EPS SURP", width: 9, align: "right", omitWhenEmpty: "visible" },
    { id: "growth", label: "YOY GROWTH", width: 14, align: "right", omitWhenEmpty: true },
    { id: "detail", label: "DETAIL", width: 9, align: "left", flexGrow: 1 },
  ], width, ["detail", "growth", "revenue"]);
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
    if (row.estimateGrowthMetric) {
      closing.blocks.unshift(detailRow("Table growth", row.estimateGrowthMetric === "eps" ? "EPS" : "Revenue"));
    }
    sections.push(closing);
    return sections;
  }

  if (row.status === "Dividend") {
    return [{ title: "Dividend", blocks: [
      detailRow("Ex-date", row.date),
      ...(row.payDate ? [detailRow("Payable", row.payDate)] : []),
      detailRow("Per share", row.value, [row.declared ? "declared" : null, row.special ? "special" : null].filter(Boolean).join(", ") || undefined),
      // The paid history is stated on today's shares; a declared amount is as declared.
      ...(row.declared ? [] : [detailNote("Per share as the shares stand today: an amount paid before a later split or bonus issue is adjusted for it.")]),
    ] }];
  }

  const sections: EventDetailSection[] = [];
  const summary = eventSummaryLine(row);
  if (summary) sections.push({ title: "Summary", blocks: [{ kind: "prose", text: summary }] });
  if (row.status === "Factor" && row.providerDescription) {
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
  if (row.epsDifference != null) comparison.push(detailRow("Difference", earningsInput(row.epsDifference, row.epsCurrency)));
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
 * The row the pane opens on, in newest-first rows: the first row of the
 * earliest day from today on, else the latest row.
 */
function nextEventIndex(rows: readonly EventRow[], today: string): number {
  let next = 0;
  for (const [index, row] of rows.entries()) {
    if (row.date < today) break;
    if (row.date !== rows[next]!.date) next = index;
  }
  return next;
}

/** What a `?` after an amount means, in the footer's notes rather than a line of its own over the table. */
const UNSTATED_CURRENCY_NOTE = "? after an amount: its source stated no currency";

/** Statuses the Earnings Estimates surface keeps; the rest are corporate actions. */
const EARNINGS_STATUSES = new Set<EventStatus>(["Q Est", "FY Est", "Earnings", "TTM"]);

/**
 * EE: every estimate and report in one table, newest first as `fn EE` prints
 * them, what is ahead (estimates, the next report) on top and tinted, with the
 * next report and the last surprise over it. Enter opens a row's inputs and,
 * for a US report, its filing.
 */
export function EarningsEstimatesView({
  focused,
  width,
  height,
  footerPaneId = "earnings-estimates",
}: {
  focused: boolean;
  width: number;
  height: number;
  footerPaneId?: string;
}) {
  const {
    symbol, ticker, exchange, cloudSession, fund, recordedActions, actionsData, calendarError, today, allRows,
    sourceNotice, loading, authWall, error, reload,
  } = useEventData("earnings-estimates");
  useCompanyDisclosureLinks(symbol);
  const rows = useMemo(() => allRows.filter((row) => EARNINGS_STATUSES.has(row.status)), [allRows]);
  const epsUnit = useMemo(() => sharedColumnCurrency(rows, "eps"), [rows]);
  const revenueUnit = useMemo(() => sharedColumnCurrency(rows, "revenue"), [rows]);
  const hasUnstatedCurrency = rows.some((row) =>
    ((row.qEps != null || row.annualEps != null) && !row.epsCurrency)
    || ((row.qRevenue != null || row.annualRevenue != null) && !row.revenueCurrency));
  const columns = useMemo(() => buildEventColumns(width, { eps: epsUnit, revenue: revenueUnit }), [width, epsUnit, revenueUnit]);
  const figures = useMemo(() => buildEventSummary(rows, { today, fund, epsUnit, revenueUnit }),
    [epsUnit, fund, revenueUnit, rows, today]);
  // Keyed by row id, not by position, so a reload or a shared layout comes
  // back to the same event.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  // Until one is picked, the next event: the last of the rows ahead, right
  // above the history, or the latest one when nothing is ahead.
  const selectedIdx = useMemo(() => {
    const picked = rows.findIndex((row) => eventRowKey(row) === selectedKey);
    return picked >= 0 ? picked : nextEventIndex(rows, today);
  }, [rows, selectedKey, today]);
  const [openRowId, setOpenRowId] = usePluginPaneState<string | null>("openRowId", null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const futureRowBackground = blendHex(colors.bg, colors.positive, 0.16);
  // Tinted after the day the pane opens on, New York's, as the calendar dates
  // a report: on the local day, a reader east of New York saw today's row
  // opened untinted beside the next day's. Memoized so the table's row memo
  // holds while the selection moves.
  const rowBackground = useCallback((row: EventRow) => (
    row.date > today ? futureRowBackground : undefined
  ), [futureRowBackground, today]);
  const loadError = error ?? (sourceNotice?.failed ? sourceNotice.text : null)
    ?? (recordedActions && !rows.length ? calendarError : null);
  const openRow = openRowId
    ? rows.find((row) => row.id === openRowId) ?? null
    : null;
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

  useEffect(() => {
    if (openRowId && !rows.some((row) => row.id === openRowId)) {
      setOpenRowId(null);
    }
  }, [openRowId, rows]);

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
  const detailContent = openRow ? (
    <DetailScrollBody ref={detailScrollRef} resetScrollKey={openRow.id}>
      <EventDetailSections sections={detailSections} width={detailTextWidth} />
    </DetailScrollBody>
  ) : (
    <Box flexGrow={1} />
  );

  const renderCell = useCallback((
    row: EventRow,
    column: EventColumn,
  ): DataTableCell => {
    // Bare under the currency its column is headed with, with its own code otherwise, `?` when its source stated none.
    const metric = (value: number | undefined, currency: string | undefined, unit: string | undefined, kind: "eps" | "revenue"): DataTableCell => {
      const text = formatEventMetric(value, unit ? undefined : currency, kind);
      return { text: value != null && !currency ? `${text} ?` : text, value: unit && currency ? value : undefined, color: colors.textDim };
    };
    switch (column.id) {
      case "date":
        // Day-first as the Filings tab beside it dates its rows; the ISO day still sorts the column.
        return { text: formatFilingDate(row.date, row.date), value: row.date, color: colors.textDim };
      case "status":
        return { text: row.status, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "period":
        return { text: row.period, color: colors.textDim };
      case "eps":
        return metric(row.qEps ?? row.annualEps, row.epsCurrency, epsUnit, "eps");
      case "revenue":
        return metric(row.qRevenue ?? row.annualRevenue, row.revenueCurrency, revenueUnit, "revenue");
      case "surprise":
        return { text: row.status === "Earnings" ? row.value : MISSING_VALUE, value: row.surprisePercent, color: row.status === "Earnings" ? toneColor(row.tone) : colors.textDim };
      case "growth":
        return { text: row.estimateGrowthMetric && row.value !== MISSING_VALUE ? `${row.value} ${row.estimateGrowthMetric === "eps" ? "EPS" : "rev"}` : MISSING_VALUE, color: row.estimateGrowthMetric ? toneColor(row.tone) : colors.textDim };
      case "detail":
        return { text: row.detail, color: colors.text };
    }
  }, [epsUnit, revenueUnit]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, reload, { stopPropagation: true });
  }, [reload]);

  usePaneStatusFooter({
    registrationId: footerPaneId,
    loading,
    error: loadError,
    emptyResult: !!actionsData && !rows.length && !sourceNotice,
  });

  usePaneNoticeFooter({
    registrationId: `${footerPaneId}:source-notices`,
    notices: [
      ...(sourceNotice && !sourceNotice.failed ? [sourceNotice.text] : []),
      ...(hasUnstatedCurrency ? [UNSTATED_CURRENCY_NOTE] : []),
    ],
    focused: focused && !openRow,
    enabled: !authWall && rows.length > 0 && !openRow,
    title: "Event data",
  });

  if (authWall) return <SignInWall placement="earnings-estimates-signin" action="view earnings estimates" needsVerification={cloudSession.needsVerification} />;

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
      detailScrollRef={detailScrollRef}
      rootWidth={width}
      rootHeight={height}
      rootBefore={figures.length ? <ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns}
        figures={figures} /> : undefined}
      onRootKeyDown={handleKeyDown}
      columns={columns}
      items={rows}
      // Opens at the top; the next event is a few rows down, scrolled only as far as it takes to show it.
      scrollToIndex={selectedIdx}
      scrollToIndexVersion={rows.length}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={eventRowKey}
      renderCell={renderCell}
      getExportMetadata={() => [
        ...(epsUnit && revenueUnit && epsUnit !== revenueUnit
          ? [["EPS currency", epsUnit], ["Revenue currency", revenueUnit]]
          : epsUnit ?? revenueUnit ? [["Currency", (epsUnit ?? revenueUnit)!]] : []),
        ...(hasUnstatedCurrency ? [["?", "Currency unstated"]] : []),
      ]}
      selectedTextOverridesCellColor
      getRowBackgroundColor={rowBackground}
      status={{ loading: loading && !rows.length, error: !loading && !rows.length ? loadError : null, subject: "earnings estimates" }}
      emptyStateTitle={sourceNotice?.text ?? "No earnings estimates"}
    />
  );
}
