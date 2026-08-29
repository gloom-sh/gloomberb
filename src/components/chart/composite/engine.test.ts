import { expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { CompositeChartEngine } from "./engine";
import { buildCompositeChartScene } from "./scene";
import type { CompositeViewportRange } from "./interactions";

const DAY_MS = 24 * 60 * 60 * 1000;

function viewport(startDay: number, endDay: number): CompositeViewportRange {
  return {
    start: new Date(Date.UTC(2025, 0, startDay)),
    end: new Date(Date.UTC(2025, 0, endDay)),
  };
}

function priceSeries(): ResolvedSeries {
  const points: TimeSeriesPoint[] = Array.from({ length: 11 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, index + 1));
    return { date, observedAt: date, value: 100 + index };
  });
  return {
    id: "price",
    label: "Price",
    color: "#00ff66",
    unit: "USD",
    unitGroup: "currency",
    nativeFrequency: "daily",
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points,
  };
}

test("one CSS pixel of dragging moves chart geometry by one CSS pixel", () => {
  const data = priceSeries();
  const initialViewport = viewport(3, 9);
  const commits: Array<CompositeViewportRange | null> = [];
  const engine = new CompositeChartEngine();
  engine.configure({
    resetKey: "price:1D",
    initialViewport,
    navigationBounds: viewport(1, 11),
    series: [data],
    allowHistoricalBackfill: false,
    buildScene: (next, axisDomains) => buildCompositeChartScene(
      [data],
      [{ id: "main" }],
      { width: 401, height: 20, viewport: next, axisDomains },
    ),
    onCommit: (next) => commits.push(next),
  });

  let semanticUpdates = 0;
  engine.subscribeState(() => semanticUpdates += 1);

  expect(engine.beginPixelPan(200, 401)).toBe(true);
  const startOffset = engine.getPaintState(401).offsetX;
  engine.movePixelPan(201);

  expect(engine.getPaintState(401).offsetX - startOffset).toBeCloseTo(1, 6);
  expect(commits).toHaveLength(0);
  expect(semanticUpdates).toBe(0);

  engine.endPixelPan();
  expect(commits).toHaveLength(1);
  expect(semanticUpdates).toBe(1);
  expect(commits[0]!.end.getTime() - commits[0]!.start.getTime()).toBe(6 * DAY_MS);
});

test("drag frames always derive from the pointer-down viewport", () => {
  const data = priceSeries();
  const engine = new CompositeChartEngine();
  engine.configure({
    resetKey: "price:1D",
    initialViewport: viewport(3, 9),
    navigationBounds: viewport(1, 11),
    series: [data],
    allowHistoricalBackfill: false,
    buildScene: (next, axisDomains) => buildCompositeChartScene(
      [data],
      [{ id: "main" }],
      { width: 401, height: 20, viewport: next, axisDomains },
    ),
    onCommit: () => {},
  });
  const offsets: number[] = [];
  engine.beginPixelPan(200, 401);
  engine.subscribeFrame(() => offsets.push(engine.getPaintState(401).offsetX));
  engine.movePixelPan(201);
  engine.movePixelPan(202);
  engine.movePixelPan(203);

  expect(offsets).toHaveLength(3);
  expect(offsets[0]!).toBeLessThan(offsets[1]!);
  expect(offsets[1]!).toBeLessThan(offsets[2]!);
});

test("reverses immediately after overscrolling the newest boundary", () => {
  const data = priceSeries();
  const commits: Array<CompositeViewportRange | null> = [];
  const engine = new CompositeChartEngine();
  engine.configure({
    resetKey: "price:1D",
    initialViewport: viewport(3, 9),
    navigationBounds: viewport(1, 11),
    series: [data],
    allowHistoricalBackfill: false,
    buildScene: (next, axisDomains) => buildCompositeChartScene(
      [data],
      [{ id: "main" }],
      { width: 101, height: 20, viewport: next, axisDomains },
    ),
    onCommit: (next) => commits.push(next),
  });

  engine.beginPixelPan(100, 101);
  engine.movePixelPan(0);
  const boundaryOffset = engine.getPaintState(101).offsetX;
  engine.movePixelPan(-100);
  expect(engine.getPaintState(101).offsetX).toBe(boundaryOffset);

  engine.movePixelPan(-99);
  expect(engine.getPaintState(101).offsetX - boundaryOffset).toBeCloseTo(1, 6);

  engine.endPixelPan();
  expect(commits).toHaveLength(1);
});

test("data refreshes stay outside an active pixel drag", () => {
  const data = priceSeries();
  const engine = new CompositeChartEngine();
  const builds: string[] = [];
  const commits: string[] = [];
  const config = (label: string) => ({
    resetKey: "price:1D",
    initialViewport: viewport(3, 9),
    navigationBounds: viewport(1, 11),
    series: [data],
    allowHistoricalBackfill: false,
    buildScene: (
      next: CompositeViewportRange,
      axisDomains: Parameters<typeof buildCompositeChartScene>[2]["axisDomains"],
    ) => {
      builds.push(label);
      return buildCompositeChartScene(
        [data],
        [{ id: "main" }],
        { width: 401, height: 20, viewport: next, axisDomains },
      );
    },
    onCommit: () => commits.push(label),
  });
  engine.configure(config("initial"));
  engine.beginPixelPan(200, 401);
  const startOffset = engine.getPaintState(401).offsetX;
  engine.movePixelPan(201);
  engine.configure(config("refresh"));

  expect(engine.isDragging()).toBe(true);
  expect(builds.at(-1)).toBe("initial");
  const buildCount = builds.length;
  engine.movePixelPan(202);
  expect(builds).toHaveLength(buildCount);
  expect(engine.getPaintState(401).offsetX - startOffset).toBeCloseTo(2, 6);

  engine.endPixelPan();
  expect(builds.at(-1)).toBe("refresh");
  expect(commits).toEqual(["refresh"]);
});
