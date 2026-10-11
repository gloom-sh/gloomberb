import type { AppAttentionPayload } from "../../../api-client/app-attention";
import type { HiringPayload } from "../../../api-client/hiring";
import type { SeriesDefinition } from "../../../series/types";
import { fetchAttention } from "./client";

const DAY_MS = 86_400_000;

/** The app history window a chart asks for, in the days the server takes (7 to 730). */
function appHistoryDays(start: Date | undefined): number {
  if (!start) return 730;
  return Math.min(730, Math.max(7, Math.ceil((Date.now() - start.getTime()) / DAY_MS)));
}

/**
 * The company signals HIRE and APPS chart: observed open roles each week and
 * the app attention score each day. Pro readings: the free preview carries no
 * history, so they fail with the pane's own words.
 */
export const COMPANY_ATTENTION_SERIES: readonly SeriesDefinition[] = [
  {
    id: "hiring:open-roles",
    name: "Observed open roles",
    unit: "jobs",
    frequency: "weekly",
    group: "Alternative data",
    tags: ["hiring", "hiring momentum", "roles", "requisitions", "careers"],
    description: "Requisitions observed on public career boards each week, subsidiaries rolled up through evidenced ownership, as HIRE charts them. Needs Pro.",
    input: "ticker",
    load: async ({ ticker, signal }) => {
      const data = await fetchAttention("hiring", ticker!, {}, undefined, signal) as HiringPayload;
      if (data.preview) throw new Error("Full hiring history requires Pro.");
      if (!data.series.length) throw new Error("History is accumulating from the first capture.");
      return data.series.map((point) => ({ date: point.week, value: point.openCount }));
    },
  },
  {
    id: "app-attention:score",
    name: "App attention score",
    unit: "score",
    frequency: "daily",
    group: "Alternative data",
    tags: ["apps", "app attention", "mobile", "app ranks", "ratings"],
    description: "A 0 to 100 summary of the public chart ranks of the company's apps across countries, as APPS charts it. Needs Pro.",
    input: "ticker",
    load: async ({ ticker, start, signal }) => {
      const data = await fetchAttention("apps", ticker!, { days: appHistoryDays(start) }, undefined, signal) as AppAttentionPayload;
      if (data.access === "preview") throw new Error("Full app history requires Pro.");
      if (!data.history.length) throw new Error("History is accumulating from the first capture.");
      return data.history.map((point) => ({ date: point.date, value: point.attentionScore }));
    },
  },
];
