import type { KeyEventLike } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";

export type ChartComposerShortcut =
  | "series"
  | "resolution"
  | "reload"
  | { type: "range"; index: number };

export function resolveChartComposerShortcut(
  event: KeyEventLike,
  rangeCount: number,
): ChartComposerShortcut | null {
  if (event.defaultPrevented || event.propagationStopped || event.targetEditable) return null;

  // `r` is the app-wide refresh key, so it reloads here too and the resolution
  // picker moved to its own mnemonic, [t]imeframe.
  if (isPlainKey(event, "s")) return "series";
  if (isPlainKey(event, "r")) return "reload";
  if (isPlainKey(event, "t")) return "resolution";
  if (!isPlainKey(event, event.name ?? "")) return null;

  const rangeIndex = Number(event.name) - 1;
  return Number.isInteger(rangeIndex) && rangeIndex >= 0 && rangeIndex < rangeCount
    ? { type: "range", index: rangeIndex }
    : null;
}
