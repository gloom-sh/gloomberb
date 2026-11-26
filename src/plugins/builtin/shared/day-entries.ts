import type { HeadlessPaneEntry } from "../../../types/headless";
import { formatDaysInText, isoDaysInText } from "../../../utils/day-format";

type DayEntries = { entries: HeadlessPaneEntry[]; textEntries: HeadlessPaneEntry[] };

/**
 * A report section's figures, drawn with their days first as the pane writes
 * them (`26 Nov 2026 00:11 UTC`): the text report prints them so
 * (`textEntries`), while JSON and CSV keep each line's days in ISO
 * (`2026-11-26 00:11 UTC`), as they always wrote them. A day without its
 * year has none to read back and stays as drawn.
 */
export function dayFirstEntries(entries: HeadlessPaneEntry[]): DayEntries {
  return {
    entries: entries.map((entry) => entry.formatted ? { ...entry, formatted: isoDaysInText(entry.formatted) } : entry),
    textEntries: entries,
  };
}

/**
 * The other way round: figures written with ISO days, which JSON and CSV keep,
 * and the text report draws day first. `whole` names the keys whose line is a
 * link or an identifier, left as it is.
 */
export function isoDayEntries(entries: HeadlessPaneEntry[], whole: readonly string[] = []): DayEntries {
  return {
    entries,
    textEntries: entries.map((entry) => entry.formatted && !whole.includes(entry.key) ? { ...entry, formatted: formatDaysInText(entry.formatted) } : entry),
  };
}
