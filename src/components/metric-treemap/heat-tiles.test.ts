import { describe, expect, test } from "bun:test";
import type { MetricTreemapItem } from "./layout";
import {
  HeatPulseTracker,
  heatTileLabelCells,
  heatTileLabelPx,
  heatTileMotion,
  settleTreemapLayoutItems,
} from "./heat-tiles";

describe("heat tile labels", () => {
  test("a tile shows the ticker and move, then the ticker, then nothing as it shrinks, and text grows with the tile", () => {
    const big = heatTileLabelPx(240, 180, "NVDA", "-2.7%");
    const medium = heatTileLabelPx(70, 44, "NVDA", "-2.7%");
    const small = heatTileLabelPx(38, 16, "NVDA", "-2.7%");
    const tiny = heatTileLabelPx(14, 10, "NVDA", "-2.7%");

    expect(big.tier).toBe("full");
    expect(medium.tier).toBe("full");
    expect(small.tier).toBe("ticker");
    expect(tiny.tier).toBe("none");
    expect(big.tickerPx).toBeGreaterThan(medium.tickerPx);
    expect(big.valuePx).toBeLessThan(big.tickerPx);
    // A long thin tile does not get a headline-sized ticker.
    expect(heatTileLabelPx(600, 40, "NVDA", "-2.7%").tickerPx).toBeLessThan(big.tickerPx);
  });

  test("a missing move leaves the ticker alone", () => {
    expect(heatTileLabelPx(240, 180, "NVDA", null).tier).toBe("ticker");
  });

  test("on cells a ticker is whole or absent, and the move needs a second row", () => {
    expect(heatTileLabelCells(6, 2, "GOOGL", "-0.6%")).toBe("full");
    expect(heatTileLabelCells(6, 1, "GOOGL", "-0.6%")).toBe("ticker");
    expect(heatTileLabelCells(5, 2, "GOOGL", "-10.6%")).toBe("ticker");
    expect(heatTileLabelCells(4, 3, "GOOGL", "-0.6%")).toBe("none");
  });
});

function layoutItem(id: string, weight: number, group = "Tech"): MetricTreemapItem<null> {
  return { id, label: id, weight, group, data: null };
}

describe("layout settling", () => {
  test("ticks inside the tolerance keep the previous layout input; a real move or a new name replaces it", () => {
    const first = [layoutItem("A", 100), layoutItem("B", 50)];
    const nudged = [layoutItem("A", 100.3), layoutItem("B", 49.9)];
    const moved = [layoutItem("A", 101), layoutItem("B", 50)];
    const regrouped = [layoutItem("A", 100), layoutItem("B", 50, "Banks")];

    expect(settleTreemapLayoutItems(first, nudged, 0.005)).toBe(first);
    expect(settleTreemapLayoutItems(first, moved, 0.005)).toBe(moved);
    expect(settleTreemapLayoutItems(first, regrouped, 0.005)).toBe(regrouped);
    expect(settleTreemapLayoutItems(first, [layoutItem("A", 100)], 0.005)).toHaveLength(1);
    // Drift is measured from the layout on screen, so slow creep still lands.
    let settled: readonly MetricTreemapItem<null>[] = first;
    for (let step = 1; step <= 10; step += 1) {
      settled = settleTreemapLayoutItems(settled, [layoutItem("A", 100 + step * 0.1), layoutItem("B", 50)], 0.005);
    }
    expect(settled[0]!.weight).toBeGreaterThan(100.5);
  });
});

describe("heat pulses", () => {
  const options = { threshold: 0.15, minIntervalMs: 3_000, maxPerSecond: 2 };

  test("a tile pulses once when its move travels past the threshold, and not again too soon", () => {
    const tracker = new HeatPulseTracker(options);
    expect(tracker.update([["A", 1]], 0).get("A")).toBeUndefined();
    expect(tracker.update([["A", 1.1]], 1_000).get("A")).toBeUndefined();
    expect(tracker.update([["A", 1.2]], 2_000).get("A")).toBe(1);
    expect(tracker.update([["A", 1.6]], 2_500).get("A")).toBe(1);
    expect(tracker.update([["A", 1.6]], 5_500).get("A")).toBe(2);
    expect(tracker.update([["A", null]], 9_000).get("A")).toBe(2);
  });

  test("a busy board pulses only its largest changes, a few a second", () => {
    const tracker = new HeatPulseTracker(options);
    tracker.update([["A", 0], ["B", 0], ["C", 0]], 0);
    const counts = tracker.update([["A", 0.2], ["B", 1], ["C", 0.5]], 5_000);
    expect([...counts.keys()].sort()).toEqual(["B", "C"]);
    // The budget is spent: A waits for it to refill rather than flashing on the next frame.
    expect(tracker.update([["A", 0.2], ["B", 1], ["C", 0.5]], 5_100).has("A")).toBe(false);
    expect(tracker.update([["A", 0.2], ["B", 1], ["C", 0.5]], 5_700).get("A")).toBe(1);
  });

  test("reduced motion drops the fade, the glide and the pulse", () => {
    expect(heatTileMotion({ reducedMotion: true, glide: true, glideCount: 2, pulseCount: 3 })).toEqual({});
    const full = heatTileMotion({ reducedMotion: false, glide: true, glideCount: 1, pulseCount: 3 });
    expect(full.glideAnimation).toContain("gloom-heat-glide-a");
    expect(full.fadeAnimation).toContain("gloom-heat-fade");
    expect(full.pulseAnimation).toContain("gloom-heat-pulse");
    expect(heatTileMotion({ reducedMotion: false, glide: true, glideCount: 2, pulseCount: 0 }).glideAnimation).toContain("gloom-heat-glide-b");
    // A resize does not glide, and a tile that never moved or pulsed has neither.
    expect(heatTileMotion({ reducedMotion: false, glide: false, glideCount: 2, pulseCount: 0 }).glideAnimation).toBeUndefined();
    const resting = heatTileMotion({ reducedMotion: false, glide: true, glideCount: 0, pulseCount: 0 });
    expect(resting.glideAnimation).toBeUndefined();
    expect(resting.pulseAnimation).toBeUndefined();
  });

});
