import type { HeadlessPaneEntry } from "../../../types/headless";
import { isoDaysInText } from "../../../utils/day-format";

/**
 * A report section's figures, drawn with their days first as the pane writes
 * them (`26 Nov 2026 00:11 UTC`): the text report prints them so
 * (`textEntries`), while JSON and CSV keep each line's days in ISO
 * (`2026-11-26 00:11 UTC`), as they always wrote them. A day without its
 * year has none to read back and stays as drawn.
 */
export function dayFirstEntries(entries: HeadlessPaneEntry[]): { entries: HeadlessPaneEntry[]; textEntries: HeadlessPaneEntry[] } {
  return {
    entries: entries.map((entry) => entry.formatted ? { ...entry, formatted: isoDaysInText(entry.formatted) } : entry),
    textEntries: entries,
  };
}
