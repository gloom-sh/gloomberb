import { formatDay, isoDay, type DayCellForm } from "../../utils/day-format";
import { MISSING_VALUE } from "../../utils/format";
import type { DataTableCell } from "./data-table/types";

export { formatDay, formatDayTime, isoDay, type DayCellForm } from "../../utils/day-format";

/**
 * A table cell for a calendar day, as every table writes one (docs/pane-conventions.md,
 * "One date format"): day first (`21 Aug 2026`, `formatFilingDate`), with
 * the ISO day as its `value`, so an export keeps `2026-08-21`. A missing day
 * is the dash; text that names no day (`TBD`) is shown as given, with no value.
 */
export function dayCell(value: unknown, form: DayCellForm = "full"): Pick<DataTableCell, "text" | "value"> {
  const day = isoDay(value);
  if (!day) return { text: typeof value === "string" && value.trim() ? value : MISSING_VALUE };
  return { text: formatDay(day, form), value: day };
}
