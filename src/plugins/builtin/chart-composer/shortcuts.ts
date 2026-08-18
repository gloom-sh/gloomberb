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

  const exactShiftReload = event.name === "r"
    && event.shift
    && !event.ctrl
    && !event.meta
    && !event.super
    && !event.alt;
  if (exactShiftReload) return "reload";
  if (isPlainKey(event, "s")) return "series";
  if (isPlainKey(event, "r")) return "resolution";
  if (!isPlainKey(event, event.name ?? "")) return null;

  const rangeIndex = Number(event.name) - 1;
  return Number.isInteger(rangeIndex) && rangeIndex >= 0 && rangeIndex < rangeCount
    ? { type: "range", index: rangeIndex }
    : null;
}
