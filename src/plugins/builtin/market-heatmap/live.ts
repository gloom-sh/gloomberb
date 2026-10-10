import { useEffect, useState } from "react";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { HeatmapBoardAsset } from "./portfolio";

/** The board never asks to stream more than this; the server caps lower for most tiers. */
export const HEATMAP_MAX_QUOTE_TARGETS = 500;

/**
 * Stream priority by market-cap rank. A connection over its tier's symbol cap
 * keeps its highest-priority targets (the cloud realtime service ranks by
 * weight plus selected and visible bonuses and breaks ties alphabetically), so
 * every rank gets its own weight and the largest names stay live whatever the
 * cap. The weights stay at or under the client's off-screen ceiling of 10
 * (`OFFSCREEN_QUOTE_WEIGHT`), so covering the pane rewrites no weight and the
 * server evicts and admits nothing.
 */
function heatmapQuoteWeight(rank: number): number {
  return Math.max(0.02, Math.round((10 - rank * 0.02) * 100) / 100);
}

function sizeOf(asset: HeatmapBoardAsset): number {
  return asset.weight ?? asset.size ?? 0;
}

/**
 * Weights for this load of a board. A name keeps the weight it was first
 * given, so a snapshot refresh that reorders two neighbours re-sends nothing;
 * a new name takes the weight of its rank.
 */
export function rankHeatmapQuoteWeights(
  assets: readonly HeatmapBoardAsset[],
  previous: ReadonlyMap<string, number> | null,
): Map<string, number> {
  const ranked = [...assets].sort((left, right) => sizeOf(right) - sizeOf(left) || left.symbol.localeCompare(right.symbol));
  const weights = new Map<string, number>();
  ranked.forEach((asset, rank) => {
    weights.set(asset.symbol, previous?.get(asset.symbol) ?? heatmapQuoteWeight(rank));
  });
  return weights;
}

/**
 * The board's stream targets: the largest names first, at most
 * `HEATMAP_MAX_QUOTE_TARGETS`. No `visible` hint: a treemap shows every tile
 * at once, the hint would only add a bonus that changes when the pane is
 * covered, and a tile without it is paced at about once a second, which is
 * all a colour needs. Only the settled selection is marked selected.
 */
export function buildHeatmapQuoteTargets(
  assets: readonly HeatmapBoardAsset[],
  weights: ReadonlyMap<string, number>,
  selectedSymbol: string | null,
): QuoteSubscriptionTarget[] {
  return [...assets]
    .sort((left, right) => (weights.get(right.symbol) ?? 0) - (weights.get(left.symbol) ?? 0)
      || left.symbol.localeCompare(right.symbol))
    .slice(0, HEATMAP_MAX_QUOTE_TARGETS)
    .map((asset) => ({
      symbol: asset.symbol,
      exchange: asset.exchange,
      surface: "screener",
      weight: weights.get(asset.symbol) ?? 0,
      ...(asset.symbol === selectedSymbol ? { selected: true } : {}),
    }));
}

/**
 * The tile area follows the live price: market cap scales with it until the
 * next snapshot brings a fresh cap. Boards sized by something else (a
 * position's value) already move with their own data.
 */
export function liveHeatmapWeight(snapshot: HeatmapBoardAsset, live: HeatmapBoardAsset): number {
  const base = sizeOf(snapshot);
  if (snapshot.weight != null || live === snapshot) return base;
  if (!(snapshot.price > 0) || !(typeof live.price === "number" && live.price > 0)) return base;
  return base * live.price / snapshot.price;
}

/** Selection as the stream sees it: only once it rests, so sweeping the pointer across tiles does not churn subscriptions. */
export function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, settled, value]);
  return settled;
}
