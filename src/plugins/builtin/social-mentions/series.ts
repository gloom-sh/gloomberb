import type { SeriesDefinition } from "../../../series/types";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadSocialMentions } from "./client";

/** How often a ticker is posted about each day, over the last year. */
export const SOCIAL_MENTION_SERIES: readonly SeriesDefinition[] = [{
  id: "social-mentions:posts",
  name: "Social media mentions",
  unit: "posts",
  frequency: "daily",
  group: "Alternative data",
  tags: ["social", "mentions", "posts", "retail attention"],
  input: "ticker",
  style: "columns",
  load: async ({ ticker }) => {
    const resource = await loadSocialMentions(ticker!, "1y");
    return {
      points: resource.payload.x.days.map((row) => ({ date: row.day, value: row.mentions })),
      ...cachedSeriesNote(resource),
    };
  },
}];
