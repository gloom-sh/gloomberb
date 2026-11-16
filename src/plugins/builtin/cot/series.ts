import type { SeriesDefinition } from "../../../series/types";
import { fetchCotContract } from "./client";
import { COT_ROOT_OPTIONS, cotContractCode, cotDefaultFamily, cotNetPoints } from "./model";

/**
 * Speculative net positioning for each market the COT pane names by root:
 * CFTC noncommercial or ICE Europe's managed money. The pane's other
 * trader classes and markets stay in the pane.
 */
export const COT_SERIES: readonly SeriesDefinition[] = COT_ROOT_OPTIONS.flatMap((option): SeriesDefinition[] => {
  const code = cotContractCode(option.value);
  if (!code) return [];
  const family = cotDefaultFamily(code);
  const traderClass = family === "disaggregated" ? "managed-money" : "noncommercial";
  const className = family === "disaggregated" ? "managed money" : "noncommercial";
  const market = option.label.startsWith(`${option.value} `) ? option.label.slice(option.value.length + 1) : option.label;
  return [{
    id: `cot:${option.value.toLowerCase().replace(/\s+/g, "-")}-${traderClass}-net`,
    name: `${market}: ${className} net position`,
    unit: "contracts",
    frequency: "weekly",
    group: "Positioning",
    tags: ["COT", "commitments of traders", "speculators", "net spec", option.value],
    publisher: family === "disaggregated" ? "ICE Futures Europe" : "CFTC",
    load: async () => {
      const payload = await fetchCotContract(code, family);
      return { points: cotNetPoints(payload.history, traderClass).map((point) => ({ date: point.date, value: point.value })) };
    },
  }];
});
