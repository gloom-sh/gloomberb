import { useEffect, useState } from "react";
import type { ColumnConfig } from "../../../types/config";
import { columnUsesClock } from "./cell-version";

export const AGE_CLOCK_MS = 1_000;
const DAY_MS = 86_400_000;

function resolveColumnClock(columns: readonly ColumnConfig[]): "age" | "day" | null {
  let clock: "age" | "day" | null = null;
  for (const column of columns) {
    const uses = columnUsesClock(column.id);
    if (uses === "age") return "age";
    clock ??= uses;
  }
  return clock;
}

/**
 * The clock time-relative columns read. Quote ages tick once a second while
 * an AGE column is shown; held days and event dates only move at the UTC day
 * boundary. Nothing runs while the app is hidden or no such column is shown.
 */
export function useColumnClock(columns: readonly ColumnConfig[], active: boolean): number {
  const clock = active ? resolveColumnClock(columns) : null;
  const [now, setNow] = useState(Date.now);
  const day = Math.floor(now / DAY_MS);

  useEffect(() => {
    if (!clock) return;
    // Catch up at once when the pane becomes visible or the column appears.
    setNow(Date.now());
    if (clock === "age") {
      const timerId = setInterval(() => setNow(Date.now()), AGE_CLOCK_MS);
      return () => clearInterval(timerId);
    }
    const timerId = setTimeout(() => setNow(Date.now()), (day + 1) * DAY_MS - Date.now() + 1_000);
    return () => clearTimeout(timerId);
  }, [clock, clock === "day" ? day : 0]);

  return now;
}
