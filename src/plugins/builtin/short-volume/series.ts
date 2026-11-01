import type { SeriesDefinition } from "../../../series/types";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadShortVolume } from "./client";

/** The share of a ticker's daily on-exchange volume reported as short sales. */
export const SHORT_VOLUME_SERIES: readonly SeriesDefinition[] = [{
  id: "short-volume:ratio",
  name: "Daily short volume ratio",
  unit: "%",
  frequency: "daily",
  group: "Positioning",
  tags: ["short volume", "short sales", "shorts"],
  publisher: "FINRA",
  input: "ticker",
  load: async ({ ticker }) => {
    const resource = await loadShortVolume(ticker!, "nms");
    return {
      points: resource.payload.history.map((point) => ({ date: point.date, value: point.ratioPercent })),
      ...cachedSeriesNote(resource),
    };
  },
}];
