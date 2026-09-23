import type { DesktopPaneShotRenderedRow } from "../desktop-pane-shot";
import { renderSection, renderTable } from "../../utils/cli-output";
import type { MarketContext } from "../types";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";
import { collectShotSymbols } from "./data";
import { renderDesktopShot, type PaneScreenshotResult } from "./screenshot";

const DOM_REPORT_WIDTH = 1280;
const DOM_REPORT_HEIGHT = 720;
const DOM_LIMITATION =
  "Only values visible in the rendered pane are returned; clipped or off-screen data may be omitted.";

function rowsContainEllipsis(rows: DesktopPaneShotRenderedRow[]): boolean {
  return rows.some((row) => row.cells.some((cell) => /\u2026|\.\.\./.test(cell.text)));
}

export function isDomReportTruncated(
  render: Pick<PaneScreenshotResult["render"], "rows" | "truncated">,
): boolean {
  return render.truncated || rowsContainEllipsis(render.rows);
}

/** Column identity per cell; a repeated label within one row stays distinct. */
function domCellKeys(row: DesktopPaneShotRenderedRow): string[] {
  const seen = new Map<string, number>();
  return row.cells.map((cell) => {
    const base = cell.columnId ?? cell.columnLabel;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}#${occurrence}`;
  });
}

function renderDomTables(rows: DesktopPaneShotRenderedRow[]): string[] {
  const byTable = new Map<number, DesktopPaneShotRenderedRow[]>();
  for (const row of rows) {
    const tableRows = byTable.get(row.tableIndex) ?? [];
    tableRows.push(row);
    byTable.set(row.tableIndex, tableRows);
  }

  return [...byTable.entries()].flatMap(([tableIndex, tableRows], index) => {
    // Captured rows omit blank cells, so a cell's position is not its column.
    const columns: Array<{ key: string; header: string }> = [];
    for (const row of tableRows) {
      let previous = -1;
      const keys = domCellKeys(row);
      for (const [cellIndex, cell] of row.cells.entries()) {
        const key = keys[cellIndex]!;
        let position = columns.findIndex((column) => column.key === key);
        if (position < 0) {
          position = previous + 1;
          columns.splice(position, 0, { key, header: cell.columnLabel });
        }
        previous = position;
      }
    }
    const output = renderTable(
      columns,
      tableRows.map((row) => {
        const keys = domCellKeys(row);
        const textByKey = new Map(row.cells.map((cell, cellIndex) => [keys[cellIndex]!, cell.text]));
        return columns.map((column) => textByKey.get(column.key) ?? "");
      }),
    );
    return [
      ...(index > 0 ? [""] : []),
      ...(byTable.size > 1 ? [renderSection(`Rendered table ${tableIndex + 1}`)] : []),
      output,
    ];
  });
}

function renderedFailureReason(
  result: PaneScreenshotResult,
  rows: DesktopPaneShotRenderedRow[],
): string | null {
  if (result.render.loadingStateDetected) return "The rendered pane was still loading.";
  if (result.render.errorStateDetected) {
    const marker = result.render.errorStateMarkers[0];
    return marker ? `The rendered pane reported: ${marker}` : "The rendered pane reported an error.";
  }
  if (result.render.emptyStateDetected) {
    const marker = result.render.emptyStateMarkers[0];
    return marker ? `The rendered pane reported: ${marker}` : "The rendered pane reported an empty state.";
  }
  if (rows.length === 0) return "The rendered pane exposed no structured rows or visible text.";
  return null;
}

function reportRows(result: PaneScreenshotResult): DesktopPaneShotRenderedRow[] {
  if (result.render.rows.length > 0) return result.render.rows;
  if (
    result.render.loadingStateDetected
    || result.render.errorStateDetected
    || result.render.emptyStateDetected
    || !result.render.visibleText
  ) {
    return [];
  }
  return [{
    tableIndex: 0,
    rowIndex: 0,
    selected: false,
    cells: [{ columnLabel: "Rendered view", text: result.render.visibleText }],
  }];
}

export function buildDomPaneReportFromRender(
  resolved: ResolvedPaneFunction,
  result: PaneScreenshotResult,
): PaneFunctionReport {
  const rows = reportRows(result);
  const hasStructuredRows = result.render.rows.length > 0;
  const truncated = isDomReportTruncated({ ...result.render, rows });
  const truncationReasons = [...result.render.truncationReasons];
  if (rowsContainEllipsis(rows) && !truncationReasons.includes("one or more cells are visibly clipped")) {
    truncationReasons.push("one or more cells are visibly clipped");
  }
  const failureReason = renderedFailureReason(result, rows);
  const unavailableSymbols = failureReason && result.symbols.length > 0 ? result.symbols : [];
  const textLines = [resolved.label, ""];
  if (hasStructuredRows) {
    textLines.push(...renderDomTables(rows));
  } else if (result.render.visibleText) {
    textLines.push(result.render.visibleText);
  } else {
    textLines.push(failureReason ?? "No rendered values were available.");
  }
  if (failureReason && rows.length > 0) textLines.push("", failureReason);

  return {
    data: {
      kind: "rendered-view",
      target: resolved.token,
      capabilityId: resolved.capability.id,
      symbols: result.symbols,
      options: resolved.options,
      rowCount: rows.length,
      empty: rows.length === 0,
      complete: failureReason === null && !truncated,
      unavailableSymbols,
      rows,
      visibleText: result.render.visibleText,
      truncated,
      truncationReasons,
      limitation: DOM_LIMITATION,
      ...(failureReason ? { reason: failureReason } : {}),
    },
    text: textLines.join("\n").trimEnd(),
  };
}

export function appendDomReportFooter(
  text: string,
  elapsedMs: number,
  truncated: boolean,
): string {
  const clipping = truncated ? "The rendered view is clipped." : "The rendered view may be clipped.";
  return [
    text,
    "",
    `Rendered view: values come from the visible pane. ${clipping} Render time: ${elapsedMs} ms.`,
  ].join("\n");
}

function failedDomReport(
  resolved: ResolvedPaneFunction,
  rawArg: string,
  error: unknown,
): PaneFunctionReport {
  const message = (error instanceof Error ? error.message : String(error))
    .split("\n")[0]!
    .replace(/^Error:\s*/, "")
    .trim();
  const reason = `The rendered view could not be read: ${message || "unknown renderer error"}`;
  const symbols = collectShotSymbols(resolved, rawArg);
  return {
    data: {
      kind: "rendered-view",
      target: resolved.token,
      capabilityId: resolved.capability.id,
      symbols,
      options: resolved.options,
      rowCount: 0,
      empty: true,
      complete: false,
      unavailableSymbols: symbols,
      rows: [],
      visibleText: "",
      truncated: false,
      truncationReasons: [],
      limitation: DOM_LIMITATION,
      reason,
    },
    text: [resolved.label, "", reason].join("\n"),
  };
}

export async function buildDomFunctionReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport> {
  try {
    const result = await renderDesktopShot({
      resolved,
      context,
      rawArg,
      outputPath: "",
      width: DOM_REPORT_WIDTH,
      height: DOM_REPORT_HEIGHT,
      theme: null,
      scale: 1,
      watermark: null,
      options: {},
      captureImage: false,
    });
    return buildDomPaneReportFromRender(resolved, result);
  } catch (error) {
    return failedDomReport(resolved, rawArg, error);
  }
}
