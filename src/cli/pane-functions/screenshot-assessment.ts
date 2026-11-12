import { SHOT_REQUEST_REFUSED, SHOT_UNAVAILABLE } from "../../api-client/errors";
import { CHART_COMPOSER_PANE_ID } from "../../types/config";
import { isRecord } from "../../utils/guards";
import { parsePublicTickerKey } from "../../utils/exchanges";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult, DesktopPaneShotRenderedRow } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import { accessGateSentence, accessGateStatus } from "./access-gate";
import { isDataPaneForDomFallback } from "./capabilities";
import { paneEvidenceMismatches, paneScreenshotEvidenceHook } from "./screenshot-evidence";
import { collectShotSymbols } from "./data";
import { renderedReportNotices } from "./report-notices";
import { financialRatioRenderMismatches, financialRatioShotGap, shotRatioTab } from "./financial-ratio-shot";
import { paneFitsRows, COLLECTION_PANE_IDS } from "./screenshot-payload";
import { stripDesktopShotCredentials } from "./screenshot-bridge";
import type { PaneScreenshotExpectedSelection, PaneScreenshotReadinessSignals, PaneScreenshotResult } from "./screenshot-types";
import {
  shotDataEvidenceFor,
  shotUnavailableSymbols,
  shotGraphKind,
  shotSemanticRowCount,
  shotExpectedText,
} from "./screenshot-data-evidence";
import { shotExpectedChart, chartEvidenceMismatchesFor, intradayChartEvidenceMismatchesFor } from "./screenshot-chart-evidence";

/** Escapes `text` for use inside a regular expression. */
function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `token` as a whole: not inside a longer word or number ("8058:JPX" in
 * "18058:JPX", "1.2" in "1.25"). An edge that is itself punctuation ("$1.2B",
 * "(TTM)") needs no boundary. `notBefore` and `notAfter` list more characters
 * that may not touch it.
 */
function showsToken(visible: string, token: string, notBefore = "", notAfter = ""): boolean {
  const before = /^[\p{L}\p{N}]/u.test(token) ? `(?<![\\p{L}\\p{N}${notBefore}]|\\p{N}[.,])` : "";
  const after = /[\p{L}\p{N}]$/u.test(token) ? `(?![\\p{L}\\p{N}${notAfter}]|[.,]\\p{N})` : "";
  return new RegExp(`${before}${regexLiteral(token)}${after}`, "u").test(visible);
}

/**
 * Whether a capture's text shows `value` as a whole token: a listing as
 * written, or by its bare code where a chart legend names it so ("8053 Close ·
 * Sumitomo" for 8053:JPX), never as part of another listing or a price
 * ("8053:TWSE", "¥8,053.00", "8053.5"), and a listing saved under its MIC by
 * its venue's code (9992:XHKG as 9992:HKEX). Five names in a CMP title fold to
 * "+2", and the legend was the only place the other two showed, so a good
 * picture read "not usable".
 */
export function shotShowsText(visibleText: string, value: string): boolean {
  const visible = visibleText.toLowerCase();
  if (showsToken(visible, value.toLowerCase())) return true;
  const { symbol, exchange } = parsePublicTickerKey(value);
  if (!exchange || !symbol || !value.includes(":")) return false;
  // A listing saved under its MIC (9992:XHKG) is shown by its venue's code (9992:HKEX).
  return showsToken(visible, `${symbol}:${exchange}`.toLowerCase()) || showsToken(visible, symbol.toLowerCase(), ":.$¥€£", ":");
}

export function isPaneScreenshotUsable(signals: PaneScreenshotReadinessSignals): boolean {
  return !signals.refused
    && !signals.blankColumns?.length
    && (signals.interactive || ((signals.rowCount > 0 || signals.contentShown === true) && !signals.emptyStateDetected))
    && !signals.loadingStateDetected
    && !signals.errorStateDetected
    && signals.complete
    && !signals.semanticMismatch
    && (!signals.requiresStructuredDataEvidence || signals.hasStructuredDataEvidence);
}

/**
 * The words after `Status` in a capture's text output: why it is not
 * complete, empty, matching its data or usable, `partial: 2 stale`. Empty when
 * nothing is wrong.
 */
export function shotStatusIssues(
  data: Pick<PaneScreenshotResult, "empty" | "complete" | "gaps" | "semanticMismatch" | "usable"> & {
    render: Pick<PaneScreenshotResult["render"], "accessGate">;
  },
): string[] {
  const gated = data.render.accessGate && (data.empty || !data.usable) ? data.render.accessGate : null;
  return [
    gated ? accessGateStatus(gated) : data.empty ? "empty" : null,
    // A gate already says why a report is not whole.
    data.complete ? null : data.gaps ? `partial: ${data.gaps}` : gated ? null : "partial",
    data.semanticMismatch ? "does not match the data" : null,
    data.usable ? null : "not usable",
  ].filter((issue): issue is string => issue != null);
}

/**
 * For a pane that grows to fit its rows, the rows its table reports (every
 * one, `reportEveryRow`) and how many of them the image shows, by key;
 * section headers count in neither. For any other pane whose tables hold more
 * rows than the image draws, the rows drawn of all they hold ("36 of 76").
 * Null when the image holds every row, or no table says how many it holds.
 */
export function shotTableRows(
  resolved: Pick<ResolvedPaneFunction, "pane" | "instance">,
  render: Pick<DesktopPaneShotRenderResult, "rows" | "reportRows" | "tableRowTotals">,
): { shown: number; total: number } | null {
  if (!paneFitsRows(resolved) || !render.reportRows?.length) return cutTableRows(render);
  const reported = render.reportRows.filter((row) => !row.section && row.key);
  if (reported.length === 0) return null;
  const drawn = new Set(render.rows.flatMap((row) => row.key ? [`${row.tableIndex}:${row.key}`] : []));
  return { shown: reported.filter((row) => drawn.has(`${row.tableIndex}:${row.key}`)).length, total: reported.length };
}

/** The rows drawn of all the visible tables hold, for the tables that say how many; null when nothing is left out. */
function cutTableRows(render: Pick<DesktopPaneShotRenderResult, "rows" | "tableRowTotals">): { shown: number; total: number } | null {
  let shown = 0, total = 0;
  for (const [tableIndex, rows] of (render.tableRowTotals ?? []).entries()) {
    if (rows === null) continue;
    total += rows;
    shown += render.rows.filter((row) => row.tableIndex === tableIndex).length;
  }
  return total > shown ? { shown, total } : null;
}

/** What a rendered capture shows, and whether it is fit to use. */
export function assessPaneScreenshot(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  render: DesktopPaneShotRenderResult,
  rawArg: string,
  outputPath: string,
): PaneScreenshotResult {
  const evidenceHook = paneScreenshotEvidenceHook(resolved);
  // The sizer carries portfolio members to value holdings and the earnings board
  // to mark them, but each shows only what its argument asks for.
  const symbols = evidenceHook?.symbols?.({ resolved, payload })
    ?? (resolved.pane.id === "kelly-sizer" || resolved.pane.id === "earnings-calendar" ? collectShotSymbols(resolved, rawArg)
      : payload.financials.map(([symbol]) => symbol));
  const usesLiveDomEvidence = resolved.capability.screenshotReadiness === "live-dom" && !evidenceHook;
  const rowCount = usesLiveDomEvidence
    ? liveDomRowCount(render)
    : shotSemanticRowCount(resolved, payload, render.semanticUi);
  const unavailableSymbols = usesLiveDomEvidence
    ? []
    : shotUnavailableSymbols(resolved, payload, render.semanticUi);
  const complete = unavailableSymbols.length === 0;
  const expectedText = shotExpectedText(resolved, symbols, payload);
  const normalizedVisibleText = render.visibleText.toLowerCase();
  const missingExpectedText = expectedText.filter((value) => !shotShowsText(normalizedVisibleText, value));
  const expectedSelections = shotExpectedSelections(resolved);
  const missingExpectedSelections = missingActiveTabSelections(
    render.semanticUi,
    expectedSelections,
  );
  const expectedChart = shotExpectedChart(resolved, payload);
  const dataEvidence = shotDataEvidenceFor(resolved, payload, render.semanticUi);
  const chartEvidenceMismatches = [
    ...(expectedChart ? chartEvidenceMismatchesFor(render.semanticUi, expectedChart) : []),
    ...intradayChartEvidenceMismatchesFor(resolved, payload, render.semanticUi),
    ...paneEvidenceMismatches(resolved, payload, render),
    ...financialRatioRenderMismatches(resolved, payload, render),
    ...surfaceNotDrawnMismatches(render),
  ];
  const semanticMismatch = missingExpectedText.length > 0
    || missingExpectedSelections.length > 0
    || chartEvidenceMismatches.length > 0;
  // Layouts and the other panes that are surfaces to operate have no rows to count: a capture of one is not empty for that.
  const interactive = !isDataPaneForDomFallback(resolved.pane);
  // A pane that marks no rows, labeled values or plotted values (DIAG's prose, CORR's matrix over the
  // symbols it chose itself) is read by the figures its body shows; one whose data is checked another way is not,
  // nor one that locks or walls off any of it: what shows beside a Pro lock is not the pane asked for.
  const contentShown = rowCount === 0 && !evidenceHook && !requiresStructuredDataEvidence(resolved) && !render.accessGate
    && shotShowsContent(render);
  // The capture's refusal of a request (chat, a team's) drawn where the pane's content goes is not the pane.
  const refused = shotShowsRefusal(render);
  // A column with no value in any row is data the pane lost, as Market Movers' VOL and V/AVG did before the open.
  const blankColumns = interactive ? [] : shotBlankColumns(render.rows);
  const empty = render.loadingStateDetected
    || render.errorStateDetected
    || refused
    || (!interactive && (render.emptyStateDetected || (rowCount === 0 && !contentShown)))
    || semanticMismatch;
  const usable = isPaneScreenshotUsable({
    interactive,
    rowCount,
    contentShown,
    refused,
    loadingStateDetected: render.loadingStateDetected,
    errorStateDetected: render.errorStateDetected,
    emptyStateDetected: render.emptyStateDetected,
    complete,
    semanticMismatch,
    requiresStructuredDataEvidence: requiresStructuredDataEvidence(resolved),
    hasStructuredDataEvidence: dataEvidence !== null,
    blankColumns,
  });
  const unusableReason = usable
    ? null
    : refused ? refusedShotReason(resolved)
    : shotUnusableReasonFor(resolved, payload, render, unavailableSymbols, semanticMismatch, blankColumns);
  const tableRows = shotTableRows(resolved, render);
  const notices = [
    ...renderedReportNotices(render.semanticUi ?? []).notices,
    ...unquotedHoldingsNotice(resolved, payload),
    ...(render.surfaces?.some((surface) => surface.renderer === "software")
      ? ["The 3D surface was drawn by the software renderer: this browser has no WebGL."] : []),
  ];
  return {
    kind: "pane-screenshot",
    target: resolved.token,
    capability: {
      id: resolved.capability.id,
      botSafe: resolved.capability.botSafe,
      outputKind: resolved.capability.outputKind,
      reportReadiness: resolved.capability.reportReadiness,
      screenshotReadiness: resolved.capability.screenshotReadiness,
    },
    symbols,
    options: stripDesktopShotCredentials(resolved.options),
    rowCount,
    empty,
    complete,
    unavailableSymbols,
    semanticMismatch,
    usable,
    unusableReason,
    ...(refused ? { refused: true as const } : {}),
    ...(blankColumns.length > 0 ? { blankColumns } : {}),
    dataEvidence,
    ...(notices.length > 0 ? { notices } : {}),
    ...(tableRows ? { tableRows } : {}),
    outputPath,
    render: {
      ...stripDesktopShotCredentials(render),
      expectedText,
      missingExpectedText,
      expectedSelections,
      missingExpectedSelections,
      expectedChart,
      chartEvidenceMismatches,
    },
  };
}

/**
 * The holdings of a portfolio or watchlist capture no source quoted (an
 * over-the-counter name none carries), whose rows show no price: "No quote
 * for KISB; its row shows no price."
 */
function unquotedHoldingsNotice(resolved: ResolvedPaneFunction, payload: DesktopPaneShotPayload): string[] {
  if (!COLLECTION_PANE_IDS.has(resolved.pane.id)) return [];
  const unquoted = payload.financials.flatMap(([symbol, financials]) => (
    !financials.quote && financials.priceHistory.length === 0 && financials.annualStatements.length === 0 ? [symbol] : []
  ));
  if (unquoted.length === 0) return [];
  return [`No quote for ${unquoted.join(", ")}; ${unquoted.length === 1 ? "its row shows" : "their rows show"} no price.`];
}

/**
 * Blocks with a figure a pane's body shows outside its controls, chrome,
 * charts and labels (`countContentFigures`) that make it data: a form's hint
 * ("Up to 4 letters"), a page counter or a date beside an empty message is
 * fewer.
 */
const MIN_CONTENT_FIGURES = 4;

/** Whether the body shows figures enough to be data, for a pane that marks no rows. */
function shotShowsContent(render: Pick<DesktopPaneShotRenderResult, "contentFigures">): boolean {
  return (render.contentFigures ?? 0) >= MIN_CONTENT_FIGURES;
}

/**
 * Whether the pane drew the capture's refusal of a request it made (CHAT's
 * channels, TheBuildout's plan): the proxy's answer, or what a pane says in
 * its place. Every capture's shell asks for reads the proxy refuses (a team's,
 * notes), which a pane drawing its own content never shows.
 */
function shotShowsRefusal(render: Pick<DesktopPaneShotRenderResult, "visibleText">): boolean {
  return render.visibleText.includes(SHOT_REQUEST_REFUSED) || render.visibleText.includes(SHOT_UNAVAILABLE);
}

/** Why a capture that drew the refusal is not the pane, and where to see it. */
function refusedShotReason(resolved: Pick<ResolvedPaneFunction, "token">): string {
  return `${resolved.token} is not available in screenshots: the capture does not send the requests it reads its content with. `
    + `Open ${resolved.token} in the app.`;
}

function requiresStructuredDataEvidence(resolved: ResolvedPaneFunction): boolean {
  return paneScreenshotEvidenceHook(resolved) !== null || [
    "price-chart",
    "intraday-price-chart",
    "price-comparison",
    "fundamental-series",
    "financial-statements",
  ].includes(resolved.capability.id);
}

const PLACEHOLDER_VALUE = /^(?:[-\u2013\u2014]+|n\/?a)?$/i;

/**
 * Rows a table must draw before a column that is blank in all of them reads
 * as a column the pane lost, rather than a short list's gaps.
 */
const BLANK_COLUMN_MIN_ROWS = 3;

/**
 * The columns of a capture's tables whose every drawn row shows a placeholder
 * for a missing value ("—", "n/a"), by their headers, as Market Movers' VOL
 * and V/AVG did before the open. A column some rows leave empty is a sparse
 * marker (an event column), not a blank one, and neither is a column the pane
 * says can be blank (`mayBeBlank`: a value that comes after an event, such as
 * an upcoming report's move); section headers and tables of fewer than
 * BLANK_COLUMN_MIN_ROWS rows are not read.
 */
export function shotBlankColumns(rows: readonly Pick<DesktopPaneShotRenderedRow, "tableIndex" | "cells" | "section">[]): string[] {
  const tables = new Map<number, Array<Pick<DesktopPaneShotRenderedRow, "cells">>>();
  for (const row of rows) {
    // A row drawn as one cell is a section header or a prose entry, not a row of the table's columns.
    if (row.section || row.cells.length < 2) continue;
    tables.set(row.tableIndex, [...tables.get(row.tableIndex) ?? [], row]);
  }
  const blank: string[] = [];
  for (const tableRows of tables.values()) {
    if (tableRows.length < BLANK_COLUMN_MIN_ROWS) continue;
    const columns = new Map<string, { label: string; placeholders: number; filled: boolean }>();
    for (const row of tableRows) {
      for (const cell of row.cells) {
        const key = cell.columnId ?? cell.columnLabel;
        const column = columns.get(key) ?? { label: cell.columnLabel, placeholders: 0, filled: false };
        if (PLACEHOLDER_VALUE.test(cell.text.trim()) && !cell.mayBeBlank) column.placeholders += 1;
        else column.filled = true;
        columns.set(key, column);
      }
    }
    for (const { label, placeholders, filled } of columns.values()) {
      if (!filled && placeholders === tableRows.length && !blank.includes(label)) blank.push(label);
    }
  }
  return blank;
}

/** "The VOL and V/AVG columns are blank in every row." */
export function blankColumnsSentence(columns: readonly string[]): string {
  const named = columns.length === 1 ? columns[0]!
    : `${columns.slice(0, -1).join(", ")} and ${columns[columns.length - 1]}`;
  return `The ${named} column${columns.length === 1 ? " is" : "s are"} blank in every row.`;
}

/**
 * What the pane's states said, quoted after the sentence that names the
 * state: ` It reads "Market movers temporarily unavailable. Try again in a
 * moment."` Empty when the capture read no words for it.
 */
function stateSaid(lines: readonly string[] | undefined): string {
  if (!lines?.length) return "";
  const quoted = lines.map((line) => `"${line}"`).join(" and ");
  return ` It reads ${quoted}${/[.!?]$/.test(lines[lines.length - 1]!) ? "" : "."}`;
}

/**
 * What a live pane shows, counted: its table's rows; else the values its
 * chart plotted, as a chart pane counts them (RETURN's chart view, whose
 * figures above the bars are not its rows); else, for a pane without a table
 * such as a ticker overview, its labeled values.
 */
export function liveDomRowCount(render: Pick<DesktopPaneShotRenderResult, "rows" | "visibleKeyValues" | "semanticUi">): number {
  const plotted = (render.semanticUi ?? []).reduce((count, node) => (
    node.role === "chart-data" && isRecord(node.metadata) && typeof node.metadata.plottedValueCount === "number"
      ? count + Math.max(0, node.metadata.plottedValueCount) : count
  ), 0);
  return render.rows.length || plotted || filledKeyValueCount(render.visibleKeyValues);
}

/** Labeled values that hold data. A grid of labels over "-" placeholders,
 * as for a ticker without fundamentals, is an empty pane. */
export function filledKeyValueCount(rows: DesktopPaneShotRenderResult["visibleKeyValues"]): number {
  return (rows ?? []).filter(({ label, text }) => {
    const value = text.startsWith(label) ? text.slice(label.length) : text;
    return !PLACEHOLDER_VALUE.test(value.trim());
  }).length;
}

/**
 * Whether a capture shows nothing that was loaded: a wall that needs an
 * account, or an empty, loading or failed state, with no rows, labeled values
 * or plotted chart beside it. Its footer carries no status line then, as it
 * has no data to date: the quotes the capture loaded for its symbol are not on
 * screen. A pane that only locks or fails part of what it shows keeps it.
 */
export function shotLoadedNothing(
  render: Pick<DesktopPaneShotRenderResult, "accessGate" | "emptyStateDetected" | "loadingStateDetected" | "errorStateDetected" | "rows" | "visibleKeyValues" | "semanticUi">,
): boolean {
  const stated = !!render.accessGate || render.emptyStateDetected || render.loadingStateDetected || render.errorStateDetected;
  return stated
    && render.rows.length === 0
    && filledKeyValueCount(render.visibleKeyValues) === 0
    && !render.semanticUi.some(plotsData);
}

/**
 * A pane's chart evidence node that says it plotted something: a count of
 * plotted values, or series with points. A node that is neither (a shape this
 * does not know) counts as plotted, so its pane keeps its line.
 */
function plotsData(node: RemoteUiNodeSnapshot): boolean {
  if (node.role !== "chart-data") return false;
  const metadata = node.metadata;
  if (!isRecord(metadata)) return true;
  const counts = [metadata.plottedValueCount, metadata.projectedPointCount].filter((count): count is number => typeof count === "number");
  if (counts.length > 0) return counts.some((count) => count > 0);
  const lists = [metadata.series, metadata.baseSeries, metadata.resolvedSeries].filter(Array.isArray);
  if (lists.length === 0) return true;
  return lists.some((list) => list.some((series) => isRecord(series) && typeof series.pointCount === "number" && series.pointCount > 0));
}

/**
 * A 3D surface that is not the real drawing: the frame has no mesh, or the 2D
 * grid stands in for it. Both are fine for a person using the pane and wrong
 * for a capture of it.
 */
export function surfaceNotDrawnMismatches(render: Pick<DesktopPaneShotRenderResult, "surfaces">): string[] {
  const surfaces = render.surfaces ?? [];
  return [
    ...(surfaces.some((surface) => surface.state === "blank") ? ["the 3D surface drew no mesh"] : []),
    ...(surfaces.some((surface) => surface.renderer === "grid") ? ["the 3D surface was replaced by a 2D grid"] : []),
  ];
}

export function shotUnusableReasonFor(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  render: Pick<DesktopPaneShotRenderResult, "loadingStateDetected" | "errorStateDetected" | "emptyStateDetected" | "accessGate" | "surfaces" | "stateText" | "errorStateMarkers" | "emptyStateMarkers">,
  unavailableSymbols: string[],
  semanticMismatch: boolean,
  blankColumns: readonly string[] = [],
): string {
  if (resolved.capability.id === "intraday-price-chart") {
    const intraday = payload.intradayHistories[0];
    if (intraday?.unavailableReason) return intraday.unavailableReason;
    if (intraday && intraday.points.length > 0) {
      return `Intraday bars were loaded for ${intraday.symbol}, but the chart did not render them.`;
    }
    const symbol = payload.financials[0]?.[0] ?? resolved.createOptions?.symbol ?? "the ticker";
    return `No intraday price history is available for ${symbol} for the requested session window.`;
  }
  if (render.loadingStateDetected) return "The pane was still loading when the screenshot was captured.";
  if (render.accessGate) return accessGateSentence(render.accessGate);
  // The first sentence stays as scripts match it; the state's own words follow it.
  if (render.errorStateDetected) return `The pane rendered an error state.${stateSaid(render.stateText?.error ?? render.errorStateMarkers)}`;
  if (render.emptyStateDetected) return `The pane rendered an empty state.${stateSaid(render.stateText?.empty ?? render.emptyStateMarkers)}`;
  const surfaceGap = surfaceNotDrawnMismatches(render)[0];
  if (surfaceGap) return `${surfaceGap[0]!.toUpperCase()}${surfaceGap.slice(1)}.`;
  if (unavailableSymbols.length > 0) return `Data is unavailable for ${unavailableSymbols.join(", ")}.`;
  const ratioGap = financialRatioShotGap(resolved, payload);
  if (ratioGap) return ratioGap;
  if (semanticMismatch) return "The rendered content did not match the requested capability.";
  if (blankColumns.length > 0) return blankColumnsSentence(blankColumns);
  return "The pane did not produce verifiable screenshot evidence.";
}

function shotExpectedSelections(
  resolved: ResolvedPaneFunction,
): PaneScreenshotExpectedSelection[] {
  if (resolved.pane.id === CHART_COMPOSER_PANE_ID) return [];
  if (shotGraphKind(resolved)) {
    return [{
      control: "metric",
      value: String(resolved.options.metric),
    }];
  }
  if (resolved.capability.id !== "financial-statements") return [];
  const ratioTab = shotRatioTab(resolved);
  if (ratioTab) {
    return [
      { control: "ratio", value: ratioTab.key, label: ratioTab.name },
      { control: "period", value: String(resolved.options.period) },
    ];
  }
  const labels: Record<string, string> = {
    income: "Income",
    cashflow: "Cash Flow",
    balance: "Balance Sheet",
  };
  return [
    {
      control: "statement",
      label: labels[String(resolved.options.statement)] ?? String(resolved.options.statement),
    },
    {
      control: "period",
      value: String(resolved.options.period),
    },
  ];
}

export function missingActiveTabSelections(
  semanticUi: RemoteUiNodeSnapshot[],
  expected: PaneScreenshotExpectedSelection[],
): PaneScreenshotExpectedSelection[] {
  const activeTabs = semanticUi.flatMap((node): { value: string | null; label: string | null }[] => {
    if (!node.metadata) return [];
    // Query bars carry the active choice of each inline filter and the view.
    if (node.role === "query-bar") {
      const selections = Array.isArray(node.metadata.selections) ? node.metadata.selections : [];
      return selections.flatMap((selection) => (
        isRecord(selection) ? [{
          value: typeof selection.value === "string" ? selection.value : null,
          label: typeof selection.label === "string" ? selection.label : null,
        }] : []
      ));
    }
    if (node.role !== "tabs") return [];
    const activeValue = typeof node.metadata.activeValue === "string"
      ? node.metadata.activeValue
      : null;
    const tabs = Array.isArray(node.metadata.tabs)
      ? node.metadata.tabs.filter((tab): tab is Record<string, unknown> => (
        !!tab && typeof tab === "object" && !Array.isArray(tab)
      ))
      : [];
    const activeTab = tabs.find((tab) => String(tab.value) === activeValue);
    return [{
      value: activeValue,
      label: typeof activeTab?.label === "string" ? activeTab.label : null,
    }];
  });

  return expected.filter((selection) => !activeTabs.some((active) => (
    (selection.value == null || active.value === selection.value)
    && (selection.label == null || active.label?.toLowerCase() === selection.label.toLowerCase())
  )));
}
