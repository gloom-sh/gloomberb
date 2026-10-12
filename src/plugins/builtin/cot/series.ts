import type { SeriesDefinition } from "../../../series/types";
import { fetchCotContract } from "./client";
import { COT_ROOT_OPTIONS, cotContractCode, cotNetPoints } from "./model";

/**
 * Speculative (noncommercial) net positioning for each market the COT pane
 * names by root, from the legacy report every market is in. The pane's other
 * trader classes and markets stay in the pane.
 */
export const COT_SERIES: readonly SeriesDefinition[] = COT_ROOT_OPTIONS.flatMap((option): SeriesDefinition[] => {
  const code = cotContractCode(option.value);
  if (!code) return [];
  const market = option.label.startsWith(`${option.value} `) ? option.label.slice(option.value.length + 1) : option.label;
  return [{
    id: `cot:${option.value.toLowerCase()}-noncommercial-net`,
    name: `${market}: noncommercial net position`,
    unit: "contracts",
    frequency: "weekly",
    group: "Positioning",
    tags: ["COT", "commitments of traders", "speculators", "net spec", option.value],
    publisher: "CFTC",
    load: async () => {
      const payload = await fetchCotContract(code, "legacy");
      return { points: cotNetPoints(payload.history, "noncommercial").map((point) => ({ date: point.date, value: point.value })) };
    },
  }];
});
