import { latestTradingSessionOpen } from "../../../market-data/market/trading-sessions";
import { zonedDateKey, zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

const NEW_YORK = "America/New_York";

export interface EsChartMarker {
  id: string;
  at: number;
  label: "Pre" | "Open";
}

function dateParts(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

function weekday(key: string): number {
  const { year, month, day } = dateParts(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function cashDay(key: string): boolean {
  const day = weekday(key);
  return day >= 1 && day <= 5;
}

function nyClock(key: string, hour: number, minute: number): number {
  const { year, month, day } = dateParts(key);
  return zonedWallClockToUtcMs(NEW_YORK, year, month, day, hour, minute, 0);
}

function addDay(key: string): string {
  const { year, month, day } = dateParts(key);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Where the ES chart starts. On a weekday at or after 04:00 New York, that
 * premarket open. Overnight and on the weekend the cash open is still ahead
 * or already over, and the session that is trading opened at 17:00 Chicago.
 */
export function esChartStart(now: number): number {
  const key = zonedDateKey(now, NEW_YORK);
  const premarket = nyClock(key, 4, 0);
  if (cashDay(key) && now >= premarket) return premarket;
  return latestTradingSessionOpen("ES=F", "CME", now) ?? premarket;
}

/** 04:00 "Pre" and 09:30 "Open" when that instant sits inside the window and has already happened. */
export function esChartMarkers(start: number, now: number): EsChartMarker[] {
  if (!(now > start)) return [];
  const markers: EsChartMarker[] = [];
  for (let key = zonedDateKey(start, NEW_YORK); key <= zonedDateKey(now, NEW_YORK); key = addDay(key)) {
    if (!cashDay(key)) continue;
    const premarket = nyClock(key, 4, 0);
    const open = nyClock(key, 9, 30);
    if (start < premarket && premarket <= now) markers.push({ id: `pre-${key}`, at: premarket, label: "Pre" });
    if (start < open && open <= now) markers.push({ id: `open-${key}`, at: open, label: "Open" });
  }
  return markers;
}

/**
 * Fraction across the plot for an instant inside the loaded bars.
 * `rightOffset` is the empty margin after the last bar, so a marker on the
 * last bar does not sit on the axis.
 */
export function esMarkerRatio(at: number, first: number, last: number, rightOffset = 0): number | null {
  if (!(last > first) || at < first || at > last) return null;
  const keep = rightOffset > 0 && rightOffset < 1 ? 1 - rightOffset : 1;
  const ratio = ((at - first) / (last - first)) * keep;
  return ratio >= 0 && ratio <= 1 ? ratio : null;
}

/** Rows the session chart takes. A short pane still gets a chart; a tall one does not give the tables away. */
export function esChartHeight(paneHeight: number): number {
  return Math.max(8, Math.min(16, Math.floor(paneHeight * 0.42)));
}
