import type { DesktopPaneShotRenderedRow } from "../desktop-pane-shot";
import { cliStyles, cliTerminalWidth, renderSection, renderTable, wrapText } from "../../utils/cli-output";
import { formatUtcTime, parseReportTime } from "../../utils/utc-time";
import type { MarketContext } from "../types";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";
import { collectShotSymbols } from "./data";
import { lockNoteLines } from "./lock-note";
import { createHeadlessPaneContext } from "./headless";
import type { HeadlessPaneContext } from "../../types/headless";
import { lockNoteReason } from "../../plugins/builtin/shared/pro-lock-note";
import { renderDesktopShot } from "./screenshot-render";
import { resolvePersistedCloudSessionToken } from "./cloud-session";
import type { PaneScreenshotResult } from "./screenshot-types";
import { deriveRenderedFreshness, formatFreshnessLine, type ReportFreshness } from "./freshness";
import { exportTextTable, reportFooterLines, type CliReportTables } from "../report-tables";
import { declaredReportFreshness, renderedReportFailure, renderedReportFreshness, renderedReportNotices, renderedReportObservations } from "./report-notices";

const DOM_REPORT_WIDTH = 1280;
const DOM_REPORT_HEIGHT = 720;
/** A pane whose reader has a page open grows to show all of it, up to about 18,000 px: a report saves no image to bound it. */
const DOM_REPORT_MAX_HEIGHT_CELLS = 1000;
const DOM_LIMITATION =
  "Only values visible in the rendered pane are returned; clipped or off-screen data may be omitted.";
const DOM_EVERY_ROW =
  "Every row of the pane's table is returned, including rows scrolled out of view.";
const DOM_WHOLE_PANE =
  "The pane was grown to fit the page it has open, so all of its text is returned.";

/** The sign-in wall's buttons, which a rendered view reads as words: `Log in ↵ Sign up free`. */
const SIGN_IN_WALL_BUTTONS = /\s*\b(?:Log in|Sign up free|Resend Verification Email)(?:\s*\u21B5)?(?=\s|$)/g;

/** Whether the wall asks for the account's email to be verified, not for a sign-in. */
function asksToVerifyEmail(visibleText: string): boolean {
  return /\bVerify your email\b/i.test(visibleText);
}

/**
 * A pane behind the sign-in wall, as a report reads it: the wall's headline
 * without its buttons, and what it needs in place of them.
 */
function signInWallText(visibleText: string): string {
  const headline = visibleText.replace(SIGN_IN_WALL_BUTTONS, "").trim();
  const needs = asksToVerifyEmail(visibleText)
    ? "Requires a verified email on your Gloom account; resend the verification email in the app."
    : "Requires a free Gloom sign-in: log in or sign up in the app.";
  return headline ? `${headline} ${needs}` : needs;
}

const LIST_MARKER = /^\s*[\u2022\u25E6\u25AA\u00B7\u2013-]\s*$/;

/**
 * The words of a pane that is prose, not a table, a line to each block it draws
 * and wrapped to the terminal's width (100 where it has none): the pane's own title,
 * which the report's heading says already, is left off its top.
 */
function proseLines(render: PaneScreenshotResult["render"], title: string): string[] {
  const lines = render.visibleLines?.length ? render.visibleLines : [render.visibleText];
  const width = Math.min(cliTerminalWidth() ?? 100, 100);
  const titled = lines[0]?.trim() === title ? lines.slice(1) : lines;
  const body: string[] = [];
  // A stack's detail opens under its Back button, a control and not part of the page.
  for (const line of titled[0] === "Back" ? titled.slice(1) : titled) {
    // A list marker is drawn as a block of its own, ahead of the item's words.
    const marker = body.at(-1);
    if (marker !== undefined && LIST_MARKER.test(marker)) body[body.length - 1] = `${marker.trim()} ${line}`;
    else body.push(line);
  }
  return body.flatMap((line) => wrapText(line, width));
}

function rowsContainEllipsis(rows: DesktopPaneShotRenderedRow[]): boolean {
  return rows.some((row) => row.cells.some((cell) => /\u2026|\.\.\./.test(cell.text)));
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

const DAY_MS = 86_400_000;
/** A time of day in what a cell draws: `11:27`, `9am`. */
const DRAWN_CLOCK = /\d{1,2}:\d{2}|\b\d{1,2}\s?[ap]m\b/i;

/**
 * A pane may shorten a time to fit ("Wed 11:27", "Oct 2"); the report prints
 * the instant behind it with its date and zone instead. An instant at exactly
 * 00:00 UTC that the cell draws without a time of day (a filing's date, an
 * all-day event) is a day, not a midnight: it prints as the date, as a
 * date-only value does. The CSV and JSON keep the instant.
 */
function cellText(cell: DesktopPaneShotRenderedRow["cells"][number]): string {
  if (!cell.instant) return cell.text;
  const time = parseReportTime(cell.instant);
  if (time && !time.dateOnly && time.time % DAY_MS === 0 && !DRAWN_CLOCK.test(cell.text)) return formatUtcTime({ ...time, dateOnly: true });
  return formatUtcTime(cell.instant) || cell.text;
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
  freshness: ReportFreshness | null,
  incomplete: boolean | string,
  notices: readonly string[],
): CliReportTables {
  const tables = domTables(rows);
  return {
    tables: tables.map((table) => exportTextTable(
      tables.length > 1 ? domTableTitle(table) : title,
      table.columns.map((column) => column.header),
      table.rows.map((cells) => table.columns.map((column) => cells.get(column.key))),
    )),
    footer: reportFooterLines({ ...(freshness ? { freshness } : {}), incomplete, notes: notices }),
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

/** The rows a report reads: every row of a table that publishes them all, else what the viewport shows. */
function reportRows(result: PaneScreenshotResult): DesktopPaneShotRenderedRow[] {
  const rows = result.render.reportRows ?? result.render.rows;
  if (rows.length > 0) return rows;
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

export async function buildDomPaneReportFromRender(
  resolved: ResolvedPaneFunction,
  result: PaneScreenshotResult,
  /** Reads data for the lock note, which names a free route only when it has data for the symbol. */
  context?: HeadlessPaneContext,
): Promise<PaneFunctionReport> {
  const rows = reportRows(result);
  const hasStructuredRows = (result.render.reportRows ?? result.render.rows).length > 0;
  // A table that reported every row is whole, whatever the viewport cut from the capture.
  const truncationReasons = [...(result.render.reportTruncationReasons ?? result.render.truncationReasons)];
  if (rowsContainEllipsis(rows) && !truncationReasons.includes("one or more cells are visibly clipped")) {
    truncationReasons.push("one or more cells are visibly clipped");
  }
  const truncated = truncationReasons.length > 0
    || (result.render.reportTruncationReasons ? false : result.render.truncated);
  const failureReason = renderedFailureReason(result, rows);
  // A pane that drew rows beside an error or empty marker ("Quote unavailable.") has data: only one with none has no data for its symbols.
  const unavailableSymbols = failureReason && rows.length === 0 && result.symbols.length > 0 ? result.symbols : [];
  // What the view leaves out and how to see more, such as OMON's strikes outside its window.
  const rendered = renderedReportNotices(result.render.semanticUi ?? []);
  const notices = [...(resolved.pane.reportNotices?.(resolved.instance.settings ?? {}) ?? []), ...rendered.notices];
  const textLines = [resolved.label, "", ...notices, ...(notices.length > 0 ? [""] : [])];
  // A wall in place of the whole pane: nothing was read, so the report says
  // what is locked and how to reach it, and cites no source.
  const gate = !hasStructuredRows ? result.render.accessGate ?? null : null;
  const lockNote = gate
    ? await resolved.pane.reportLockNote?.({
      gate,
      symbol: result.symbols[0] ?? null,
      token: resolved.token,
      ...gate === "sign-in" && asksToVerifyEmail(result.render.visibleText ?? "") ? { verifyEmail: true } : {},
      ...context ? { context } : {},
    }) ?? null
    : null;
  const locked = gate === "sign-in" || lockNote ? gate : null;
  const lockReason = lockNote ? lockNoteReason(lockNote) : null;
  if (hasStructuredRows) {
    textLines.push(...renderDomTables(rows));
  } else if (lockNote) {
    textLines.push(...lockNoteLines(lockNote));
  } else if (result.render.visibleText) {
    textLines.push(...(gate === "sign-in" ? [signInWallText(result.render.visibleText)] : proseLines(result.render, resolved.label)));
  } else {
    textLines.push(failureReason ?? "No rendered values were available.");
  }
  if (failureReason && rows.length > 0) textLines.push("", failureReason);
  // A pane that knows its feed dates the report; the footer and cell times fill in the rest.
  const declared = { ...declaredReportFreshness(resolved), ...renderedReportFreshness(result.render.semanticUi ?? []) };
  const freshness = deriveRenderedFreshness(declared, {
    footerText: result.render.footerText ?? "",
    cellTimes: rows.flatMap((row) => row.cells.flatMap((cell) => cell.instant ?? [])),
    observed: renderedReportObservations(result.render.semanticUi ?? []),
  });

  const complete = failureReason === null && !truncated;
  // Each table published its rows and nothing else was cut: the report is the whole view.
  const everyRow = complete && result.render.reportRows !== undefined;
  // A reader grown to fit its page (a docs page) and not cut once grown is read whole.
  const wholePane = complete && !everyRow && resolved.pane.shotFitsReader === true;
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
      ...(everyRow ? { everyRow } : {}),
      ...(wholePane ? { wholePane } : {}),
      limitation: everyRow ? DOM_EVERY_ROW : wholePane ? DOM_WHOLE_PANE : DOM_LIMITATION,
      ...(lockReason ?? failureReason ? { reason: lockReason ?? failureReason } : {}),
      ...(notices.length > 0 ? { metadata: { ...rendered.facts, notices } } : {}),
      ...(locked ? { locked } : { freshness }),
    },
    text: textLines.join("\n").trimEnd(),
    tables: domReportTables(
      rows,
      resolved.label,
      locked ? null : freshness,
      !complete && (lockReason ?? failureReason ?? (truncationReasons.length > 0 ? truncationReasons.join("; ") : true)),
      notices,
    ),
  };
}

/** The report's closing lines; a locked view, which read nothing, cites no source. */
export function appendDomReportFooter(
  text: string,
  view: DomReportView,
  freshness: ReportFreshness | undefined,
): string {
  return [
    text,
    "",
    domReportNote(view),
    ...(freshness ? [cliStyles.muted(formatFreshnessLine(freshness))] : []),
  ].join("\n");
}

/** How much of the pane a rendered-view report holds: none behind a wall, cut, every row its tables publish, all of a pane grown to fit, or what the viewport shows. */
export type DomReportView = "locked" | "clipped" | "every-row" | "whole" | "visible";

export function domReportView(data: Readonly<Record<string, unknown>>): DomReportView {
  if (data.locked) return "locked";
  return data.truncated === true ? "clipped" : data.everyRow === true ? "every-row" : data.wholePane === true ? "whole" : "visible";
}

/**
 * What a rendered-view report says about where its values come from. How long
 * the render took is no part of it: that is the machine's, not the data's
 * (`elapsedMs` in JSON keeps it).
 */
export function domReportNote(view: DomReportView): string {
  return view === "locked"
    ? "Rendered view: the pane is locked, so no values were read."
    : view === "every-row"
    ? "Rendered view: every row of the pane's table, including rows scrolled out of view."
    : view === "whole"
    ? "Rendered view: the pane grown to fit the whole page."
    : `Rendered view: values come from the visible pane. ${view === "clipped" ? "The rendered view is clipped." : "The rendered view may be clipped."}`;
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
  const freshness = deriveRenderedFreshness(declaredReportFreshness(resolved), { footerText: "", cellTimes: [] });
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

/** A report the rendered pane says it cannot give; the command fails with the pane's words and advice line. */
class RenderedReportFailure extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
  }
}

/**
 * The report of a pane the sign-in wall covers whole (`PaneDef.signInWall`)
 * when there is no session: its lock note, as the rendered wall reports it,
 * without waiting for the wall to render. Null with a session, or for any
 * other pane.
 */
async function signedOutDomReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport | null> {
  if (!resolved.pane.signInWall || !resolved.pane.reportLockNote || resolvePersistedCloudSessionToken(context)) return null;
  const symbols = collectShotSymbols(resolved, rawArg);
  const note = await resolved.pane.reportLockNote({
    gate: "sign-in", symbol: symbols[0] ?? null, token: resolved.token,
    context: createHeadlessPaneContext(resolved, context, new AbortController().signal),
  });
  const reason = lockNoteReason(note);
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
      unavailableSymbols: [],
      rows: [],
      visibleText: "",
      truncated: false,
      truncationReasons: [],
      limitation: DOM_LIMITATION,
      reason,
      locked: "sign-in",
    },
    text: [resolved.label, "", ...lockNoteLines(note)].join("\n").trimEnd(),
    tables: domReportTables([], resolved.label, null, reason, []),
  };
}

export async function buildDomFunctionReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport> {
  const signedOut = await signedOutDomReport(resolved, context, rawArg);
  if (signedOut) return signedOut;
  let result: PaneScreenshotResult;
  try {
    result = await renderDesktopShot({
      resolved,
      context,
      rawArg,
      outputPath: "",
      width: DOM_REPORT_WIDTH,
      height: DOM_REPORT_HEIGHT,
      theme: null,
      scale: 1,
      watermark: null,
      fitReader: true,
      maxHeightCells: DOM_REPORT_MAX_HEIGHT_CELLS,
      options: {},
      captureImage: false,
    });
  } catch (error) {
    return failedDomReport(resolved, rawArg, error);
  }
  // No header and no partial view: the error alone, and a failed exit, as the plain command gives.
  const failure = renderedReportFailure(result.render.semanticUi ?? []);
  if (failure) throw new RenderedReportFailure(failure.message, failure.details);
  try {
    return await buildDomPaneReportFromRender(resolved, result, createHeadlessPaneContext(resolved, context, new AbortController().signal));
  } catch (error) {
    return failedDomReport(resolved, rawArg, error);
  }
}
