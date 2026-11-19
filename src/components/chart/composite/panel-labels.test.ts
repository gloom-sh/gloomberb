import { expect, test } from "bun:test";
import { compositeAxisLabelColor } from "./panel-labels";
import type { CompositeAxisDomain, CompositePanelScene } from "./types";
import type { ResolvedSeries } from "../../../time-series/types";

const NEUTRAL = "#888888";
const line = (id: string, color: string, axis: "left" | "right", extra: Partial<ResolvedSeries> = {}) => ({
  source: { id, color, axis, style: "line", ...extra } as ResolvedSeries,
  points: [],
});
const axis = (side: "left" | "right", seriesIds: string[]) => ({ side, seriesIds } as CompositeAxisDomain);
const panel = (id: string, series: ReturnType<typeof line>[]): CompositePanelScene => {
  const on = (side: "left" | "right") => series.filter((entry) => entry.source.axis === side).map((entry) => entry.source.id);
  return {
    id, height: 10, scale: "linear", series,
    axes: { ...(on("left").length ? { left: axis("left", on("left")) } : {}), ...(on("right").length ? { right: axis("right", on("right")) } : {}) },
  } as CompositePanelScene;
};

// Two percent series on a lower panel's scale read as the main panel's: its labels were the same grey.
test("the chart's first axis stays neutral; every other is labelled in its lines' colour where they share one", () => {
  const main = panel("main", [line("us", "#ffa94d", "left"), line("ust", "#38d9a9", "left"), line("vix", "#9775fa", "right")]);
  const lower = panel("panel-2", [line("jgb", "#b197fc", "left")]);
  const scene = { panels: [main, lower] };
  expect(compositeAxisLabelColor(scene, main, "left", NEUTRAL)).toBe(NEUTRAL);
  expect(compositeAxisLabelColor(scene, main, "right", NEUTRAL)).toBe("#9775fa");
  expect(compositeAxisLabelColor(scene, lower, "left", NEUTRAL)).toBe("#b197fc");
  // Lines of several colours, or one drawn in two, share the neutral labels; the legend tells them apart.
  const shared = panel("panel-3", [line("a", "#ff0000", "left"), line("b", "#00ff00", "left")]);
  const histogram = panel("panel-4", [line("macd", "#00ff00", "left", { style: "columns", negativeColor: "#ff0000" })]);
  expect(compositeAxisLabelColor({ panels: [main, shared] }, shared, "left", NEUTRAL)).toBe(NEUTRAL);
  expect(compositeAxisLabelColor({ panels: [main, histogram] }, histogram, "left", NEUTRAL)).toBe(NEUTRAL);
  // A chart whose first panel has its scale on the right keeps that one neutral.
  const rightOnly = panel("main", [line("aapl", "#ffffff", "right")]);
  expect(compositeAxisLabelColor({ panels: [rightOnly] }, rightOnly, "right", NEUTRAL)).toBe(NEUTRAL);
});
