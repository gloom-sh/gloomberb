import { expect, test } from "bun:test";
import { formatShortDate } from "../../../utils/datetime-format";
import { fiscalMonth } from "./format";
import { chartAxis, type HistoryRow } from "./history-model";

// INTU's reports as ERN charts them, oldest first: Thursday 29 Oct 2026 is a day whose
// number, cut from "29 Oct", once read as the month under its bar.
const bars = ["2024-02-22", "2024-05-23", "2024-08-22", "2024-11-21", "2026-10-29", "2026-11-19"]
  .map((date) => ({ date }) as HistoryRow);

test("ERN's bars read as month and year, whichever order the shared formatter writes a day in", () => {
  // The shared formatter writes the day first; the axis must not depend on it either way.
  expect(formatShortDate("2026-10-29", { year: false, utc: true })).toBe("29 Oct");
  const axis = chartAxis(bars);
  // Not "22 24" (the day of "22 Feb" and the year), nor "Feb 24", which reads as the 24th of February.
  expect(axis.ticks.map((tick) => tick.label)).toEqual(["Feb '24", "May '24", "Aug '24", "Nov '24", "Oct '26", "Nov '26"]);
  // One slot per bar, with an empty one at each end so the outer bars sit inside the plot.
  expect(axis.ticks.map((tick) => tick.ratio)).toEqual([1, 2, 3, 4, 5, 6].map((slot) => slot / 7));
  // The cursor names the report's day.
  expect(axis.formatCursor(5 / 7)).toBe("29 Oct '26");
  // A fiscal period's end month is written the same way, and an unknown one is missing, not "undefined '26".
  expect([fiscalMonth("2026-09-30"), fiscalMonth("2026-13-01"), fiscalMonth(null)]).toEqual(["Sep '26", "—", "—"]);
});
