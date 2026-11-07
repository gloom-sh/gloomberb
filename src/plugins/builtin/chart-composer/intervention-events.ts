import type { CompositeChartEvent } from "../../../components/chart/composite/types";
import type { FxInterventionMarker } from "../../../market-data/fx-interventions";

/** A bar further than this before the day is not its bar (a gap in the bars): the event goes at the day itself. */
const LONGEST_BAR_MS = 32 * 86_400_000;

/**
 * Japan's interventions as chart events, each on the bar that holds its day:
 * the day's first bar (its daily bar, or its first intraday one), else the bar
 * before it, which a weekly or monthly bar starting earlier is. `barTimes` are
 * the pair's bar times, oldest first. A total with no day yet is dotted.
 */
export function interventionChartEvents(markers: readonly FxInterventionMarker[], barTimes: readonly number[]): CompositeChartEvent[] {
  return markers.map((marker) => {
    const day = Date.parse(`${marker.date}T00:00:00Z`);
    // The first bar at or after the day's start.
    let low = 0, high = barTimes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (barTimes[middle]! < day) low = middle + 1;
      else high = middle;
    }
    const within = low < barTimes.length && barTimes[low]! < day + 86_400_000 ? barTimes[low]! : null;
    const before = low > 0 && day - barTimes[low - 1]! < LONGEST_BAR_MS ? barTimes[low - 1]! : null;
    return {
      id: marker.id,
      time: within ?? before ?? day,
      label: marker.label,
      ...(marker.undated ? { dotted: true } : {}),
    };
  });
}
