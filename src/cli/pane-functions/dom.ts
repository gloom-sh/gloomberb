import type { DesktopPaneShotRenderedRow } from "../desktop-pane-shot";
import { cliStyles, renderSection, renderTable } from "../../utils/cli-output";
import { formatUtcTime } from "../../utils/utc-time";
import type { MarketContext } from "../types";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";
import { collectShotSymbols } from "./data";
import { renderDesktopShot, type PaneScreenshotResult } from "./screenshot";
import { deriveRenderedFreshness, formatFreshnessLine, type ReportFreshness } from "./freshness";
import { exportTextTable, reportFooterLines, type CliReportTables } from "../report-tables";

const DOM_REPORT_WIDTH = 1280;
const DOM_REPORT_HEIGHT = 720;
const DOM_LIMITATION =
  "Only values visible in the rendered pane are returned; clipped or off-screen data may be omitted.";

function rowsContainEllipsis(rows: DesktopPaneShotRenderedRow[]): boolean {
  return rows.some((row) => row.cells.some((cell) => /\u2026|\.\.\./.test(cell.text)));
}

function isDomReportTruncated(
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

/**
 * A pane may shorten a time to fit ("Wed 11:27", "Oct 2"); the report prints
 * the instant behind it with its date and zone instead.
 */
function cellText(cell: DesktopPaneShotRenderedRow["cells"][number]): string {
  return cell.instant ? formatUtcTime(cell.instant) || cell.text : cell.text;
}

interface DomTable {
  tableIndex: number;
  columns: Array<{ key: string; header: string }>;
  rows: Array<Map<string, DesktopPaneShotRenderedRow["cells"][number]>>;
}

function domTables(rows: DesktopPaneShotRenderedRow[]): DomTable[] {
  const byTable = new Map<number, DesktopPaneShotRenderedRow[]>();
  for (const row of rows) {
    const tableRows = byTable.get(row.tableIndex) ?? [];
    tableRows.push(row);
    byTable.set(row.tableIndex, tableRows);
  }

  return [...byTable.entries()].map(([tableIndex, tableRows]) => {
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
    return {
      tableIndex,
      columns,
      rows: tableRows.map((row) => {
        const keys = domCellKeys(row);
        return new Map(row.cells.map((cell, cellIndex) => [keys[cellIndex]!, cell]));
      }),
    };
  });
}

function domTableTitle(table: DomTable): string {
  return `Rendered table ${table.tableIndex + 1}`;
}

function renderDomTables(rows: DesktopPaneShotRenderedRow[]): string[] {
  const tables = domTables(rows);
  return tables.flatMap((table, index) => [
    ...(index > 0 ? [""] : []),
    ...(tables.length > 1 ? [renderSection(domTableTitle(table))] : []),
    renderTable(
      table.columns,
      table.rows.map((cells) => table.columns.map((column) => {
        const cell = cells.get(column.key);
        return cell ? cellText(cell) : "";
      })),
    ),
  ]);
}

/** The rendered tables as `--csv` writes them, with the instant behind a shortened time. */
function domReportTables(
  rows: DesktopPaneShotRenderedRow[],
  title: string,
  freshness: ReportFreshness,
  incomplete: boolean | string,
): CliReportTables {
  const tables = domTables(rows);
  return {
    tables: tables.map((table) => exportTextTable(
      tables.length > 1 ? domTableTitle(table) : title,
      table.columns.map((column) => column.header),
      table.rows.map((cells) => table.columns.map((column) => cells.get(column.key))),
    )),
    footer: reportFooterLines({ freshness, incomplete }),
  };
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
  const freshness = deriveRenderedFreshness(resolved.pane.reportFreshness, {
    footerText: result.render.footerText ?? "",
    cellTimes: rows.flatMap((row) => row.cells.flatMap((cell) => cell.instant ?? [])),
  });

  const complete = failureReason === null && !truncated;
  return {
    data: {
      kind: "rendered-view",
      target: resolved.token,
      capabilityId: resolved.capability.id,
      symbols: result.symbols,
      options: resolved.options,
      rowCount: rows.length,
      empty: rows.length === 0,
      complete,
      unavailableSymbols,
      rows,
      visibleText: result.render.visibleText,
      truncated,
      truncationReasons,
      limitation: DOM_LIMITATION,
      ...(failureReason ? { reason: failureReason } : {}),
      freshness,
    },
    text: textLines.join("\n").trimEnd(),
    tables: domReportTables(
      rows,
      resolved.label,
      freshness,
      !complete && (failureReason ?? (truncationReasons.length > 0 ? truncationReasons.join("; ") : true)),
    ),
  };
}

export function appendDomReportFooter(
  text: string,
  elapsedMs: number,
  truncated: boolean,
  freshness: ReportFreshness,
): string {
  return [
    text,
    "",
    domReportNote(elapsedMs, truncated),
    cliStyles.muted(formatFreshnessLine(freshness)),
  ].join("\n");
}

/** What a rendered-view report says about where its values come from. */
export function domReportNote(elapsedMs: number, truncated: boolean): string {
  const clipping = truncated ? "The rendered view is clipped." : "The rendered view may be clipped.";
  return `Rendered view: values come from the visible pane. ${clipping} Render time: ${elapsedMs} ms.`;
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
  const freshness = deriveRenderedFreshness(resolved.pane.reportFreshness, { footerText: "", cellTimes: [] });
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
      freshness,
    },
    text: [resolved.label, "", reason].join("\n"),
    tables: { tables: [], footer: reportFooterLines({ freshness, incomplete: reason }) },
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
