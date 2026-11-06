import type { DialogKeyHint } from "../ui/frame";
import type { ResultItem } from "./list/model";

/** Enter changes the focused pane; Shift+Enter opens a new one. */
const ENTER_HERE_HINTS: DialogKeyHint[] = [
  { key: "Enter", label: "here" },
  { key: "Shift+Enter", label: "new pane" },
];

/**
 * The keys the open prompt names for the selected row, or null where there is
 * nothing to tell apart.
 *
 * Only a row with a secondary action (a ticker, a typed DES) does something
 * else on Shift+Enter: it opens the ticker in a new pane, every time. Its
 * Enter changes the focused pane in place when `enterChangesFocusedPane`
 * (`resolveTickerEnterTarget`), and that is what the hint is for. Otherwise
 * Enter opens a pane as well, or goes to the one already open on the ticker,
 * and the hint stays out. A function, a command or an AI answer has no
 * secondary action: Shift+Enter runs what Enter runs.
 */
export function resolveSelectionKeyHints(
  item: ResultItem | null | undefined,
  enterChangesFocusedPane: boolean,
): DialogKeyHint[] | null {
  if (!item || item.disabled || !item.secondaryAction || !enterChangesFocusedPane) return null;
  return ENTER_HERE_HINTS;
}
