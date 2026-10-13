import { ApiRequestError } from "../../api-client/errors";
import { cliTerminalWidth, wrapText } from "../../utils/cli-output";
import { reportFooterLines } from "../report-tables";
import type { PaneAccessGate } from "./access-gate";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";

/** The widest a lock note wraps to, as the catalog's text. */
const LOCK_NOTE_WIDTH = 100;

/** The closing line of a headless report whose pane was walled whole, as a rendered view's says it. */
const LOCKED_VIEW_NOTE = "The pane is locked, so no values were read.";

/** A pane's `reportLockNote`, wrapped for the text report. */
export function lockNoteLines(note: string): string[] {
  return wrapText(note, Math.min(cliTerminalWidth() ?? LOCK_NOTE_WIDTH, LOCK_NOTE_WIDTH));
}

/** JSON and CSV say why a locked report is empty in the note's words, on one line. */
export function lockNoteReason(note: string): string {
  return note.replace(/\s*\n\s*/g, " ");
}

/**
 * The wall a refused read stands for, as the pane's own wall puts it up: no
 * session or an unverified email is the sign-in wall, a plan without access
 * the Pro wall.
 */
function refusalGate(error: unknown): PaneAccessGate | null {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  return status === 401 || status === 403 ? "sign-in" : status === 402 ? "pro" : null;
}

/**
 * What a headless report prints when the server refused its read behind a
 * wall, as the rendered view of the same pane prints that wall: the pane's
 * `reportLockNote`, no source line and `locked` in JSON. Null when the error
 * is no such refusal or the pane has no note, and the error stands.
 */
export function lockedHeadlessReport(
  resolved: ResolvedPaneFunction,
  error: unknown,
  /** The symbols the report was asked for, read once the error is known to be a refusal. */
  symbolsOf: () => string[],
): PaneFunctionReport | null {
  const gate = refusalGate(error);
  if (!gate || !resolved.pane.reportLockNote) return null;
  const symbols = symbolsOf();
  const note = resolved.pane.reportLockNote({ gate, symbol: symbols[0] ?? null });
  const reason = lockNoteReason(note);
  return {
    data: {
      kind: resolved.headless?.shape ?? "rendered-view",
      target: resolved.token,
      capabilityId: resolved.capability.id,
      symbols,
      options: resolved.options,
      rowCount: 0,
      empty: true,
      complete: false,
      unavailableSymbols: symbols,
      reason,
      locked: gate,
    },
    text: [resolved.label, "", ...lockNoteLines(note), "", LOCKED_VIEW_NOTE].join("\n"),
    tables: { tables: [], footer: reportFooterLines({ incomplete: reason, notes: [LOCKED_VIEW_NOTE] }) },
  };
}
