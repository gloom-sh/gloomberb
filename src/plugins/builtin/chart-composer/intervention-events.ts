import { isIntradaySeries } from "../../../components/chart/composite/session-shading";
import type { CompositeChartEvent } from "../../../components/chart/composite/types";
import type { FxInterventionsPayload } from "../../../api-client/fx-interventions";
import {
  fxInterventionMarkers, fxInterventionPair, fxInterventionSharedCaptions, type FxInterventionMarker, type FxInterventionPair,
} from "../../../market-data/fx-interventions";
import type { ChartSpec, ResolvedSeries } from "../../../time-series/types";

const DAY_MS = 86_400_000;
/** A bar further than this before the day is not its bar (a gap in the bars): the event goes at the day itself. */
const LONGEST_BAR_MS = 32 * DAY_MS;

type PriceEntry = ChartSpec["series"][number] & { source: Extract<ChartSpec["series"][number]["source"], { kind: "security" }> };

/** The chart's first price series shown in its own values: the one price levels and interventions belong to. */
export function rawPriceEntry(spec: ChartSpec): PriceEntry | undefined {
  return spec.series.find((candidate): candidate is PriceEntry => (
    candidate.visible !== false
    && candidate.transform === "raw"
    && candidate.source.kind === "security"
    && (candidate.source.fieldId === "market.ohlcv" || candidate.source.fieldId === "market.close")
  ));
}

/** The yen pair a chart's price series is, or null: a future (6J=F), a transformed series or another pair gets no markers. */
export function chartInterventionPair(spec: ChartSpec): FxInterventionPair | null {
  const entry = rawPriceEntry(spec);
  return entry ? fxInterventionPair(entry.source.instrument.symbol, entry.source.instrument.exchange) : null;
}

/**
 * Japan's interventions as chart events, each on the bar that holds its day:
 * the day's first bar (its daily bar, or its first intraday one), else the bar
 * before it, which a weekly or monthly bar starting earlier is. A total with
 * no day yet is dotted from its first day's bar to its last day's. `barTimes`
 * are the pair's bar times, oldest first; a daily or longer bar counts as the
 * nearest UTC day, since one is stamped at a venue's midnight (23:00Z for
 * London's in summer).
 */
export function interventionChartEvents(
  markers: readonly FxInterventionMarker[],
  barTimes: readonly number[],
  daily = true,
): CompositeChartEvent[] {
  const keys = daily ? barTimes.map((time) => Math.round(time / DAY_MS) * DAY_MS) : barTimes;
  // The first bar at or after `time`.
  const firstFrom = (time: number) => {
    let low = 0, high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (keys[middle]! < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const firstBarOf = (date: string) => {
    const day = Date.parse(`${date}T00:00:00Z`);
    const index = firstFrom(day);
    if (index < keys.length && keys[index]! < day + DAY_MS) return barTimes[index]!;
    return index > 0 && day - keys[index - 1]! < LONGEST_BAR_MS ? barTimes[index - 1]! : day;
  };
  const lastBarOf = (date: string) => {
    const end = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
    const index = firstFrom(end) - 1;
    return index >= 0 && end - keys[index]! < LONGEST_BAR_MS + DAY_MS ? barTimes[index]! : end - DAY_MS;
  };
  return markers.map((marker) => {
    const time = firstBarOf(marker.date);
    return {
      id: marker.id,
      time,
      ...(marker.endDate ? { endTime: Math.max(time, lastBarOf(marker.endDate)) } : {}),
      captions: marker.captions,
      ...(marker.undated ? { dotted: true } : {}),
    };
  });
}

/** What a chart draws for Japan's interventions: the events, and one caption for those too close to caption apart. */
export interface ChartInterventions {
  events: CompositeChartEvent[];
  merge: (events: readonly CompositeChartEvent[]) => readonly string[];
}

/**
 * The interventions a chart marks: in its raw price series' yen pair, on that
 * series' bars; none for any other chart.
 */
export function chartInterventions(
  spec: ChartSpec,
  series: readonly ResolvedSeries[],
  payload: FxInterventionsPayload | null,
): ChartInterventions | null {
  const entry = rawPriceEntry(spec);
  const pair = chartInterventionPair(spec);
  const bars = entry ? series.find((candidate) => candidate.id === entry.id) : undefined;
  if (!payload || !pair || !bars) return null;
  const markers = fxInterventionMarkers(payload, pair);
  if (markers.length === 0) return null;
  const byId = new Map(markers.map((marker) => [marker.id, marker]));
  return {
    events: interventionChartEvents(markers, bars.points.map((point) => point.date.getTime()), !isIntradaySeries(bars)),
    merge: (events) => fxInterventionSharedCaptions(events.flatMap((event) => byId.get(event.id) ?? [])),
  };
}
