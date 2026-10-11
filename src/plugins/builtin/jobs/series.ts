import type { SeriesDefinition } from "../../../series/types";
import { fetchJobs } from "./client";

/** A company's open job postings each day, as the jobs pane charts them. */
export const JOBS_SERIES: readonly SeriesDefinition[] = [{
  id: "jobs:open-roles",
  name: "Open job postings",
  unit: "jobs",
  frequency: "daily",
  group: "Alternative data",
  tags: ["hiring", "jobs", "postings", "headcount"],
  input: "ticker",
  load: async ({ ticker }) => {
    const state = await fetchJobs(ticker!);
    if (state.kind === "pending") throw new Error(state.message || `Postings for ${ticker} are still being collected.`);
    if (state.kind !== "ready") throw new Error(state.message || `No postings for ${ticker}.`);
    return state.summary.series.map((point) => ({ date: point.day, value: point.open }));
  },
}];
