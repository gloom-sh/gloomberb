import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
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
import { formatCompact, formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { wrapTextLines } from "../../../utils/text-wrap";
import { useResolvedEntryValue, useSecFilingDocuments, useSecFilingsQuery } from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneTicker } from "../../../state/app/context";
import { isUsEquityTicker } from "../../../utils/sec";
import { useAssetData } from "../../runtime";
import { handleRefreshKey, loadingErrorFooterInfo } from "../shared/table-pane";
import { useBoundTicker as useSymbolBinding, useTickerRequest } from "../shared/ticker-request";
import {
  documentContentKey,
  documentHeading,
  formatCompactDocumentLabel,
  isDefaultVisibleFilingDocument,
  isInlineExhibitDocument,
} from "../sec/filing-documents";
import {
  buildInlineFilingContentTargets,
  useSecFilingContentCache,
} from "../sec/filing-content";
import { buildEventRows, type EventRow, type EventStatus } from "./event-model";

export { buildEventRows } from "./event-model";

type EventColumnId = "date" | "status" | "period" | "qEps" | "qRevenue" | "annualEps" | "annualRevenue" | "value" | "detail";
type EventColumn = DataTableColumn & { id: EventColumnId };

const SEC_EVENT_FILING_LIMIT = 50;
const SEC_EVENT_MATCH_WINDOW_DAYS = 7;

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

export function matchEarningsSecFiling(row: { status: string; date: string } | null | undefined, filings: readonly SecFilingItem[]): SecFilingItem | null {
  if (!row || row.status !== "Earnings") return null;
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

function buildEventColumns(): EventColumn[] {
  return [
    { id: "date", label: "DATE", width: 10, align: "left" },
    { id: "status", label: "EVENT", width: 8, align: "left" },
    { id: "period", label: "PERIOD", width: 9, align: "left" },
    { id: "qEps", label: "Q EPS", width: 6, align: "right" },
    { id: "qRevenue", label: "Q REV", width: 7, align: "right" },
    { id: "annualEps", label: "ANN EPS", width: 7, align: "right" },
    { id: "annualRevenue", label: "ANN REV", width: 7, align: "right" },
    { id: "value", label: "VALUE", width: 8, align: "right" },
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

function eventSummaryLine(row: EventRow): string {
  return [
    row.date,
    row.period,
    row.qEps != null ? `EPS ${formatNumber(row.qEps, 2)}` : null,
    row.qRevenue != null ? `Rev ${formatCompact(row.qRevenue)}` : null,
    row.annualEps != null ? `Ann EPS ${formatNumber(row.annualEps, 2)}` : null,
    row.annualRevenue != null ? `Ann Rev ${formatCompact(row.annualRevenue)}` : null,
    row.value !== "-" ? row.value : null,
    row.detail || null,
  ].filter((line): line is string => !!line).join(" | ");
}

function buildEventDetailBody({
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
}): string {
  const lines: string[] = ["Summary", eventSummaryLine(row)];
  if (row.status !== "Earnings") {
    return lines.join("\n");
  }

  lines.push("", "SEC Filing");
  if (secFilingsLoading && !filing) {
    lines.push("Loading recent SEC filings...");
    return lines.join("\n");
  }
  if (!filing) {
    lines.push("No related SEC filing found in recent filings.");
    return lines.join("\n");
  }

  lines.push([
    `${filing.form} filed ${filingDateKey(filing)}`,
    filing.items ? `Items ${filing.items}` : null,
    `Accession ${filing.accessionNumber}`,
  ].filter(Boolean).join(" | "));

  lines.push("", "Documents");
  if (documentsLoading && documents.length === 0) {
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
      const hasContent = inlineContent.has(key);
      const content = inlineContent.get(key);
      lines.push("", documentHeading(document));
      lines.push(hasContent
        ? content || "Readable document content was not available for this exhibit."
        : "Loading exhibit content...");
    }
  }

  if (!documentsLoading && exhibits.length === 0) {
    lines.push("", "Primary Filing Content");
    lines.push(primaryContentLoading
      ? "Loading filing content..."
      : primaryContent || "Readable filing content was not available.");
  }
  return lines.join("\n");
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
  const { symbol, ticker, exchange, currency } = useSymbolBinding();
  // The shared ticker snapshot already subscribes to financials for this pane.
  const { financials: financialsData } = usePaneTicker();
  const actionsLoader = useCallback((nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider?.getCorporateActions) throw new Error("Corporate actions source unavailable");
    return dataProvider.getCorporateActions(nextSymbol, nextExchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  }, [dataProvider]);
  const analystLoader = useCallback(async (nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider?.getAnalystResearch) return null;
    return dataProvider.getAnalystResearch(nextSymbol, nextExchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  }, [dataProvider]);
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
  const columns = useMemo(() => buildEventColumns(), []);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const todayKey = todayDateKey();
  const futureRowBackground = blendHex(colors.bg, colors.positive, 0.16);
  const loading = actionsLoading || analystLoading;
  // Parallel requests fail with the same message ("No ticker selected"), so the
  // footer must report each distinct reason once.
  const error = [...new Set([actionsError, analystError].filter((value): value is string => !!value))]
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
    if (rows.length > 0 && selectedIdx >= rows.length) {
      setSelectedIdx(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIdx]);

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

  const detailBody = openRow
    ? buildEventDetailBody({
        row: openRow,
        secFilingsLoading,
        filing: matchedFiling,
        documents,
        documentsLoading,
        inlineContent,
        primaryContent,
        primaryContentLoading,
      })
    : "";
  const detailTextWidth = Math.max(width - 2, 12);
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
        <Box flexDirection="column">
          {wrapTextLines(detailBody, detailTextWidth).map((line, index) => (
            <Box key={`event-detail-${index}`} height={1}>
              <Text fg={colors.text}>{line}</Text>
            </Box>
          ))}
        </Box>
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
        return { text: formatNumber(row.qEps, 2), color: selectedColor ?? colors.textDim };
      case "qRevenue":
        return { text: formatCompact(row.qRevenue), color: selectedColor ?? colors.textDim };
      case "annualEps":
        return { text: formatNumber(row.annualEps, 2), color: selectedColor ?? colors.textDim };
      case "annualRevenue":
        return { text: formatCompact(row.annualRevenue), color: selectedColor ?? colors.textDim };
      case "value":
        return { text: row.value, color: selectedColor ?? toneColor(row.tone) };
      case "detail":
        return { text: row.detail, color: selectedColor ?? colors.text };
    }
  }, []);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, reload, { stopPropagation: true });
  }, [reload]);

  usePaneFooter(footerPaneId, () => ({
    info: loadingErrorFooterInfo(loading, error),
  }), [error, footerPaneId, loading]);

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
        onChange: (index) => setSelectedIdx(index),
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
      onHeaderClick={() => {}}
      getItemKey={(row) => row.id}
      renderCell={renderCell}
      getRowBackgroundColor={(row) => (
        row.date > todayKey ? futureRowBackground : undefined
      )}
      emptyStateTitle={loading
        ? (variant === "earnings-estimates" ? "Loading earnings estimates..." : "Loading events...")
        : error ?? (variant === "earnings-estimates" ? "No earnings estimates" : "No events")}
    />
  );
}
