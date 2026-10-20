import { refusedLock } from "../../plugins/builtin/shared/cloud-denied";
import { lockNoteReason } from "../../plugins/builtin/shared/pro-lock-note";
import { cliTerminalWidth, wrapText } from "../../utils/cli-output";
import { reportFooterLines } from "../report-tables";
import type { HeadlessPaneContext } from "../../types/headless";
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

/**
 * What a headless report prints when the server refused its read behind a
 * wall, as the rendered view of the same pane prints that wall: the pane's
 * `reportLockNote`, no source line and `locked` in JSON. The refusal may be
 * the error itself or the cause of the one a headless read wrote for it
 * (`explainRefusal`). Null when the error is no such refusal or the pane has
 * no note, and the error stands. The context lets the note check the free
 * route it names.
 */
export async function lockedHeadlessReport(
  resolved: ResolvedPaneFunction,
  error: unknown,
  /** The symbols the report was asked for, read once the error is known to be a refusal. */
  symbolsOf: () => string[],
  context?: HeadlessPaneContext,
): Promise<PaneFunctionReport | null> {
  const refused = refusedLock(error);
  if (!refused || !resolved.pane.reportLockNote) return null;
  const gate = refused.gate;
  const symbols = symbolsOf();
  const note = await resolved.pane.reportLockNote({ ...refused, symbol: symbols[0] ?? null, token: resolved.token, ...context ? { context } : {} });
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
