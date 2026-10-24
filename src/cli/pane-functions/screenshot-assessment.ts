import { CHART_COMPOSER_PANE_ID } from "../../types/config";
import { isRecord } from "../../utils/guards";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import { accessGateSentence, accessGateStatus } from "./access-gate";
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

export function isPaneScreenshotUsable(signals: PaneScreenshotReadinessSignals): boolean {
  return signals.rowCount > 0
    && !signals.loadingStateDetected
    && !signals.errorStateDetected
    && !signals.emptyStateDetected
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
 * section headers count in neither. Null for any other pane, or a table that
 * reports only what is drawn.
 */
export function shotTableRows(
  resolved: Pick<ResolvedPaneFunction, "pane" | "instance">,
  render: Pick<DesktopPaneShotRenderResult, "rows" | "reportRows">,
): { shown: number; total: number } | null {
  if (!paneFitsRows(resolved) || !render.reportRows?.length) return null;
  const reported = render.reportRows.filter((row) => !row.section && row.key);
  if (reported.length === 0) return null;
  const drawn = new Set(render.rows.flatMap((row) => row.key ? [`${row.tableIndex}:${row.key}`] : []));
  return { shown: reported.filter((row) => drawn.has(`${row.tableIndex}:${row.key}`)).length, total: reported.length };
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
  // A live pane without a table, such as a ticker overview, shows its data
  // as labeled values.
  const rowCount = usesLiveDomEvidence
    ? render.rows.length || filledKeyValueCount(render.visibleKeyValues)
    : shotSemanticRowCount(resolved, payload, render.semanticUi);
  const unavailableSymbols = usesLiveDomEvidence
    ? []
    : shotUnavailableSymbols(resolved, payload, render.semanticUi);
  const complete = unavailableSymbols.length === 0;
  const expectedText = shotExpectedText(resolved, symbols, payload);
  const normalizedVisibleText = render.visibleText.toLowerCase();
  const missingExpectedText = expectedText.filter((value) => !normalizedVisibleText.includes(value.toLowerCase()));
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
  const empty = render.loadingStateDetected
    || render.errorStateDetected
    || render.emptyStateDetected
    || rowCount === 0
    || semanticMismatch;
  const usable = isPaneScreenshotUsable({
    rowCount,
    loadingStateDetected: render.loadingStateDetected,
    errorStateDetected: render.errorStateDetected,
    emptyStateDetected: render.emptyStateDetected,
    complete,
    semanticMismatch,
    requiresStructuredDataEvidence: requiresStructuredDataEvidence(resolved),
    hasStructuredDataEvidence: dataEvidence !== null,
  });
  const unusableReason = usable
    ? null
    : shotUnusableReasonFor(resolved, payload, render, unavailableSymbols, semanticMismatch);
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

/** Labeled values that hold data. A grid of labels over "-" placeholders,
 * as for a ticker without fundamentals, is an empty pane. */
export function filledKeyValueCount(rows: DesktopPaneShotRenderResult["visibleKeyValues"]): number {
  return (rows ?? []).filter(({ label, text }) => {
    const value = text.startsWith(label) ? text.slice(label.length) : text;
    return !PLACEHOLDER_VALUE.test(value.trim());
  }).length;
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
  render: Pick<DesktopPaneShotRenderResult, "loadingStateDetected" | "errorStateDetected" | "emptyStateDetected" | "accessGate" | "surfaces">,
  unavailableSymbols: string[],
  semanticMismatch: boolean,
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
  if (render.errorStateDetected) return "The pane rendered an error state.";
  if (render.emptyStateDetected) return "The pane rendered an empty state.";
  const surfaceGap = surfaceNotDrawnMismatches(render)[0];
  if (surfaceGap) return `${surfaceGap[0]!.toUpperCase()}${surfaceGap.slice(1)}.`;
  if (unavailableSymbols.length > 0) return `Data is unavailable for ${unavailableSymbols.join(", ")}.`;
  const ratioGap = financialRatioShotGap(resolved, payload);
  if (ratioGap) return ratioGap;
  if (semanticMismatch) return "The rendered content did not match the requested capability.";
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
