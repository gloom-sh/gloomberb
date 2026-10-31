import type { SeriesDefinition } from "../../../series/types";
import { fetchAttention } from "./client";
import { emptyAttention, historyPoints } from "./model";

/**
 * The hourly research attention ATTN charts for one ticker. A Pro reading
 * served per account: the free preview carries no history, so it fails with
 * the pane's own words instead of drawing an empty chart.
 */
export const ATTENTION_SERIES: readonly SeriesDefinition[] = [{
  id: "attention:research-hours",
  name: "Research attention",
  unit: "hours",
  frequency: "intraday",
  group: "Alternative data",
  tags: ["attention", "research", "trending", "researcher-hours"],
  description: "Rounded researcher-hours Gloom users spent on the ticker in each published hour, as ATTN charts them; an hour below the privacy threshold is a gap. Needs Pro.",
  input: "ticker",
  load: async ({ ticker }) => {
    const data = await fetchAttention("now", ticker!);
    if (data.entitlement === "preview") throw new Error("Pro unlocks published history.");
    if (data.status === "disabled") throw new Error(emptyAttention(data));
    if (!data.history?.length) throw new Error("No privacy-qualified hours for this ticker.");
    return historyPoints(data.history).map((point) => ({ date: point.date, value: point.value }));
  },
}];
