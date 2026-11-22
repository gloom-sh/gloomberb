import type { HeadlessPaneColumn, HeadlessPaneRow } from "../../../types/headless";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import { asOfClock } from "../../../market-data/quotes/time";
import { MISSING_VALUE } from "../../../utils/format";

/**
 * When a report row's pre-market, after-hours or overnight print was observed
 * (`extendedUpdatedAt`, epoch ms), as a card dates it: `Sat 00:34 UTC`. Empty
 * without one. The row's own as-of is its close's once the session is over.
 */
function extendedPrintTimeText(row: HeadlessPaneRow): string {
  const time = row.extendedUpdatedAt;
  return typeof time === "number" && Number.isFinite(time) && time > 0 ? asOfClock(Math.min(time, Date.now())) : "";
}

/**
 * An extended print column's text with its time after the figures
 * (`$70.60 +1.35% Sat 00:34 UTC`), as `quote` prints it; `figures` is what the
 * column draws for the print alone.
 */
export function withExtendedPrintTime(figures: string, row: HeadlessPaneRow): string {
  return [figures, extendedPrintTimeText(row)].filter(Boolean).join(" ");
}

/**
 * When each row's extended print was observed, as `quote --csv`'s `After Hours
 * Updated` dates it: XYZ:NYSE's close at 21:00 UTC, its after-hours print at
 * 00:34 UTC. Exported last, so a column read by position stays where it was;
 * a text report says the time beside the print instead.
 */
export function extendedPrintTimeColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedUpdatedAt", header: `${EXTENDED_SESSION_LABELS[session]} Updated`, exportLast: true,
    format: (value, row) => row.extendedSession === session && typeof value === "number" && Number.isFinite(value) && value > 0
      ? new Date(value).toISOString()
      : MISSING_VALUE,
  };
}
