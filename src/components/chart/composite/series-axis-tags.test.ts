import { describe, expect, test } from "bun:test";
import { AppPersistence } from "../../../data/app-persistence";
import { TickerRepository } from "../../../data/ticker-repository";
import { PluginRegistry } from "../../../plugins/registry";
import { createChartSeriesResolver } from "../../../capabilities";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../../test-support/time-series";
import { applyCompositeChartCursor, buildCompositeChartScene, projectCompositeValue } from "./scene";
import { resolveSeriesAxisTags, type SeriesAxisTag } from "./panel-labels";
import { placeSeriesAxisTags } from "./series-axis-tags";
import { formatCompositeCursorValue } from "./format";

const point = createTestSeriesPoint;

describe("series axis observations", () => {
  test("desktop capability resolution with local handlers disabled reaches the same scene readout", async () => {
    const persistence = new AppPersistence(":memory:");
    const calls: string[] = [];
    const remote = createTestResolvedSeries({ id: "remote", unit: "%", unitGroup: "percent", axis: "right", points: [point("2025-01-01", 3), point("2025-01-02", 4)] });
    const registry = new PluginRegistry(createTestDataProvider(), new TickerRepository(persistence.tickers), persistence, {
      enableCapabilityHandlers: false,
      remoteCapabilityInvoke: async <T,>(id: string, operation: string) => {
        calls.push(`${id}.${operation}`);
        return remote as T;
      },
    });
    try {
      const source = { kind: "capability", capabilityId: "fixture", seriesId: "remote" } as const;
      const resolved = await createChartSeriesResolver(registry)(source, { range: "1Y", resolution: "auto" }, {
        id: "remote", source, style: "line", transform: "raw", axis: "right", panelId: "main", interpolation: "none",
      });
      const base = buildCompositeChartScene([resolved], [{ id: "main", scale: "linear" }], { width: 80, height: 20 })!;
      const scene = applyCompositeChartCursor(base, new Date("2025-01-01"));
      expect(calls).toEqual(["fixture.resolve"]);
      expect(resolveSeriesAxisTags(scene.panels[0]!, scene)).toMatchObject([{
        value: 3, side: "right", label: formatCompositeCursorValue(3, scene.panels[0]!.axes.right!), carried: false,
      }]);
    } finally {
      registry.destroy();
      persistence.close();
    }
  });

  test("keeps axis ownership, carried dates and explicit gaps without substituting the pointer or last price", () => {
    const series = [
      createTestResolvedSeries({ id: "price", points: [point("2025-01-01", 80), point("2025-01-02", 120), point("2025-01-03", 90)] }),
      createTestResolvedSeries({ id: "rate", axis: "right", unit: "%", unitGroup: "percent", points: [point("2025-01-01", 3), point("2025-01-03", 4)] }),
      createTestResolvedSeries({ id: "gap", points: [point("2025-01-01", 85), point("2025-01-02", null), point("2025-01-03", 95)] }),
      createTestResolvedSeries({ id: "volume", panelId: "volume", style: "columns", unit: "shares", unitGroup: "volume", points: [point("2025-01-01", 1200), point("2025-01-02", 2300)] }),
    ];
    const base = buildCompositeChartScene(series, [{ id: "main", scale: "linear" }, { id: "volume", scale: "linear" }], { width: 100, height: 20 })!;
    const scene = applyCompositeChartCursor(base, new Date("2025-01-02"));
    const tags = scene.panels.flatMap((panel) => resolveSeriesAxisTags(panel, scene));
    expect(tags.map(({ seriesId, value, side, carried }) => ({ seriesId, value, side, carried }))).toEqual([
      { seriesId: "price", value: 120, side: "left", carried: false },
      { seriesId: "rate", value: 3, side: "right", carried: true },
      { seriesId: "volume", value: 2300, side: "left", carried: false },
    ]);
    for (const tag of tags) {
      const panel = scene.panels.find((panel) => panel.series.some(({ source }) => source.id === tag.seriesId))!;
      expect(tag.yRatio).toBe(projectCompositeValue(tag.value, panel.axes[tag.side]!));
      expect(resolveSeriesAxisTags(panel, scene, (value, domain) => `${value} ${domain.unit}`).find((entry) => entry.seriesId === tag.seriesId)!.label).toBe(`${tag.value} ${panel.axes[tag.side]!.unit}`);
    }
    expect(base.panels.flatMap((panel) => resolveSeriesAxisTags(panel, base))).toEqual([]);
  });
});

const tag = (seriesId: string, yRatio: number): SeriesAxisTag => ({ seriesId, seriesLabel: seriesId, yRatio, side: "left", value: 1, label: "1", color: "#abcdef", carried: false });

describe("series axis collision layout", () => {
  test("equal values, both edges and undersized panels retain every series and its exact anchor", () => {
    for (const height of [36, 72, 240]) {
      const tags = [tag("top-a", 0), tag("top-b", 0), tag("middle", 0.5), tag("bottom-a", 1), tag("bottom-b", 1)];
      const result = placeSeriesAxisTags(tags, height, 18);
      expect(result.map((tag) => tag.seriesId)).toEqual(tags.map((tag) => tag.seriesId));
      for (const item of result) {
        expect(item.anchorY).toBe(item.yRatio * (height - 1));
        expect(item.centerY).toBeGreaterThanOrEqual(9);
        expect(item.centerY).toBeLessThanOrEqual(height - 9);
        for (const other of result) if (other !== item && other.lane === item.lane) expect(Math.abs(item.centerY - other.centerY)).toBeGreaterThanOrEqual(18);
      }
      expect(placeSeriesAxisTags(tags, height, 18)).toEqual(result);
    }
  });
});
