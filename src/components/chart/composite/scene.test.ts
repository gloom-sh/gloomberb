import { describe, expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  allocateCompositePanelHeights,
  applyCompositeChartCursor,
  buildCompositeChartScene,
  projectCompositeValue,
  resolveCompositeCursorDate,
  unprojectCompositeValue,
} from "./scene";
import { buildCompositeColumnLayout } from "./column-layout";
import { COMPOSITE_RIGHT_OFFSET_RATIO } from "./time-scale";

/** Ratio the newest observation lands on once the right offset is reserved. */
const NEWEST_X_RATIO = 1 / (1 + COMPOSITE_RIGHT_OFFSET_RATIO);

function point(date: string, value: number): TimeSeriesPoint {
  const observedAt = new Date(`${date}T00:00:00.000Z`);
  return { date: observedAt, observedAt, value };
}

function series(overrides: Partial<ResolvedSeries> & Pick<ResolvedSeries, "id" | "points">): ResolvedSeries {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    color: overrides.color ?? "#00ff66",
    unit: overrides.unit ?? "USD",
    unitGroup: overrides.unitGroup ?? "currency",
    nativeFrequency: overrides.nativeFrequency ?? "daily",
    dataShape: overrides.dataShape ?? "scalar",
    style: overrides.style ?? "line",
    transform: overrides.transform ?? "raw",
    axis: overrides.axis ?? "left",
    panelId: overrides.panelId ?? "main",
    interpolation: overrides.interpolation ?? "none",
    timestampMode: overrides.timestampMode,
    timeBasis: overrides.timeBasis,
    points: overrides.points,
    warning: overrides.warning,
  };
}

describe("composite chart scene", () => {
  test("keeps a panel and its height while its series has no observations in view", () => {
    const price = series({
      id: "price",
      points: [point("2025-01-01", 90), point("2025-01-02", 95), point("2025-01-03", 110)],
    });
    const volume = series({
      id: "volume",
      panelId: "volume",
      style: "columns",
      unit: "shares",
      unitGroup: "volume",
      points: [point("2025-01-01", 1_000), point("2025-01-02", 1_200), point("2025-01-03", 1_400)],
    });
    const panels = [{ id: "main" }, { id: "volume", height: 0.25 }];
    const options = { width: 10, height: 8 };

    const loaded = buildCompositeChartScene([price, volume], panels, {
      ...options,
      viewport: { start: new Date("2025-01-01T00:00:00.000Z"), end: new Date("2025-01-03T00:00:00.000Z") },
    });
    // The same window, with the lower panel's data not yet loaded.
    const loading = buildCompositeChartScene([price, { ...volume, points: [] }], panels, {
      ...options,
      viewport: { start: new Date("2025-01-01T00:00:00.000Z"), end: new Date("2025-01-03T00:00:00.000Z") },
    });
    // A window the upper panel covers and the lower panel has no bars in.
    const partial = buildCompositeChartScene([price, {
      ...volume,
      points: [point("2025-01-01", 1_000)],
    }], panels, {
      ...options,
      viewport: { start: new Date("2025-01-02T00:00:00.000Z"), end: new Date("2025-01-03T00:00:00.000Z") },
    });

    const layout = (scene: typeof loaded) => scene?.panels.map((panel) => [panel.id, panel.height]);
    expect(layout(loaded)).toEqual([["main", 6], ["volume", 2]]);
    expect(layout(loading)).toEqual(layout(loaded));
    expect(layout(partial)).toEqual(layout(loaded));
    expect(loading?.panels[1]?.series).toEqual([]);
    // The axis still reads the loaded history, so the gutter does not jump either.
    expect(partial?.panels[1]?.axes.left?.max).toBeGreaterThan(0);
  });

  test("keeps panels synchronized while preserving independent dual-axis domains", () => {
    const price = series({
      id: "price",
      points: [point("2025-01-01", 90), point("2025-01-03", 110)],
    });
    const revenue = series({
      id: "revenue",
      axis: "right",
      style: "step",
      interpolation: "step-after",
      points: [point("2024-12-31", 1_000_000), point("2025-01-03", 1_500_000)],
    });
    const macro = series({
      id: "macro",
      panelId: "macro",
      unit: "%",
      unitGroup: "percent",
      points: [point("2025-01-02", 3.5), point("2025-01-04", 4.1)],
    });

    const scene = buildCompositeChartScene(
      [price, revenue, macro],
      [{ id: "main", height: 2 }, { id: "macro", height: 1 }],
      { width: 81, height: 18, cursorDate: new Date("2025-01-02T12:00:00.000Z") },
    );

    expect(scene).not.toBeNull();
    expect(scene!.panels.map((panel) => panel.height)).toEqual([12, 6]);
    expect(scene!.startTime).toBe(new Date("2024-12-31T00:00:00.000Z").getTime());
    expect(scene!.endTime).toBe(new Date("2025-01-04T00:00:00.000Z").getTime());

    const main = scene!.panels[0]!;
    expect(main.axes.left!.seriesIds).toEqual(["price"]);
    expect(main.axes.right!.seriesIds).toEqual(["revenue"]);
    expect(main.axes.left!.max).toBeLessThan(1_000);
    expect(main.axes.right!.min).toBeGreaterThan(900_000);
    expect(main.series[0]!.points.at(-1)!.xRatio).toBeLessThan(1);

    expect(scene!.cursorDate?.toISOString()).toBe("2025-01-02T00:00:00.000Z");
    expect(scene!.cursorValues.find((value) => value.seriesId === "price")?.value).toBe(90);
    expect(scene!.cursorValues.find((value) => value.seriesId === "revenue")?.value).toBe(1_000_000);
    expect(scene!.cursorValues.find((value) => value.seriesId === "macro")?.value).toBe(3.5);
  });

  test("projects logarithmic axes safely and snaps pointers to the shared date set", () => {
    const logarithmic = series({
      id: "log",
      points: [point("2025-01-01", -2), point("2025-01-02", 10), point("2025-01-05", 1_000)],
    });
    const scene = buildCompositeChartScene(
      [logarithmic],
      [{ id: "main", scale: "log" }],
      { width: 101, height: 10 },
    );

    expect(scene).not.toBeNull();
    const domain = scene!.panels[0]!.axes.left!;
    expect(domain.scale).toBe("log");
    expect(projectCompositeValue(0, domain)).toBeNull();
    expect(scene!.panels[0]!.series[0]!.points).toHaveLength(2);
    expect(resolveCompositeCursorDate(scene!, 70)?.toISOString()).toBe("2025-01-05T00:00:00.000Z");
  });

  test("inverts one crosshair level through linear and logarithmic axis domains", () => {
    const linear = {
      side: "left" as const,
      min: 0,
      max: 200,
      scale: "linear" as const,
      unit: "USD",
      unitGroup: "currency",
      seriesIds: ["price"],
    };
    const logarithmic = {
      ...linear,
      min: 1,
      max: 100,
      scale: "log" as const,
    };

    expect(unprojectCompositeValue(0.25, linear)).toBe(150);
    expect(unprojectCompositeValue(0.5, logarithmic)).toBeCloseTo(10);
    expect(unprojectCompositeValue(projectCompositeValue(25, linear)!, linear)).toBeCloseTo(25);
    expect(unprojectCompositeValue(Number.NaN, linear)).toBeNull();
  });

  test("starts a new rendered segment after null and logarithmically hidden observations", () => {
    const withNull = series({
      id: "null-gap",
      points: [
        point("2025-01-01", 1),
        { ...point("2025-01-02", 2), value: null },
        point("2025-01-03", 3),
      ],
    });
    const linearScene = buildCompositeChartScene([withNull], [{ id: "main" }], { width: 40, height: 8 });
    expect(linearScene?.panels[0]?.series[0]?.points.map((entry) => entry.breakBefore)).toEqual([true, true]);

    const withHiddenLogValue = series({
      id: "log-gap",
      points: [point("2025-01-01", 10), point("2025-01-02", -1), point("2025-01-03", 1_000)],
    });
    const logScene = buildCompositeChartScene(
      [withHiddenLogValue],
      [{ id: "main", scale: "log" }],
      { width: 40, height: 8 },
    );
    expect(logScene?.panels[0]?.series[0]?.points.map((entry) => entry.breakBefore)).toEqual([true, true]);
  });

  test("allocates every available row without starving a panel", () => {
    expect(allocateCompositePanelHeights(
      [{ id: "one", height: 3 }, { id: "two", height: 1 }, { id: "three", height: 1 }],
      4,
    )).toEqual(new Map([["one", 2], ["two", 1], ["three", 1]]));
    expect(allocateCompositePanelHeights(
      [{ id: "primary", height: 2 }, { id: "secondary", height: 1 }],
      4,
    )).toEqual(new Map([["primary", 3], ["secondary", 1]]));
  });

  test("uses one last-write-wins policy for duplicate timestamps", () => {
    const duplicate = series({
      id: "duplicate",
      points: [
        point("2025-01-01", 10),
        { ...point("2025-01-01", 10), value: null, close: null },
      ],
    });

    expect(buildCompositeChartScene(
      [duplicate],
      [{ id: "main" }],
      { width: 40, height: 8 },
    )).toBeNull();
  });

  test("preserves explicit viewport bounds when observations are sparse", () => {
    const sparse = series({
      id: "sparse",
      points: [point("2025-03-01", 10), point("2025-09-01", 12)],
    });
    const scene = buildCompositeChartScene(
      [sparse],
      [{ id: "main" }],
      {
        width: 101,
        height: 10,
        viewport: {
          start: new Date("2025-01-01T00:00:00.000Z"),
          end: new Date("2025-12-31T23:59:59.999Z"),
        },
      },
    );

    expect(scene?.startTime).toBe(new Date("2025-01-01T00:00:00.000Z").getTime());
    expect(scene?.endTime).toBe(new Date("2025-12-31T23:59:59.999Z").getTime());
    expect(scene?.panels[0]?.series[0]?.points[0]?.xRatio).toBeGreaterThan(0);
    expect(scene?.panels[0]?.series[0]?.points.at(-1)?.xRatio).toBeLessThan(1);
  });

  test("keeps positive column axes anchored at zero without negative padding", () => {
    const columns = series({
      id: "revenue",
      style: "columns",
      points: [point("2025-01-01", 100), point("2025-04-01", 140)],
    });
    const scene = buildCompositeChartScene(
      [columns],
      [{ id: "main" }],
      { width: 40, height: 8 },
    );

    expect(scene?.panels[0]?.axes.left?.min).toBe(0);
    expect(scene?.panels[0]?.axes.left?.max).toBeGreaterThan(140);
  });

  test("extends a prior step anchor across an otherwise empty viewport", () => {
    const step = series({
      id: "step",
      style: "step",
      interpolation: "step-after",
      points: [point("2024-12-15", 90)],
    });
    const scene = buildCompositeChartScene(
      [step],
      [{ id: "main" }],
      {
        width: 101,
        height: 10,
        viewport: {
          start: new Date("2025-01-01T00:00:00.000Z"),
          end: new Date("2025-01-31T23:59:59.999Z"),
        },
      },
    );

    expect(scene).not.toBeNull();
    const stepPoints = scene?.panels[0]?.series[0]?.points ?? [];
    expect(stepPoints).toHaveLength(2);
    expect(stepPoints[0]?.xRatio).toBe(0);
    // The level runs to the viewport end and stops: the reserved right offset
    // never carries a projected value.
    expect(stepPoints[1]?.xRatio).toBeCloseTo(NEWEST_X_RATIO, 10);
    expect(scene?.cursorValues[0]?.value).toBe(90);
  });

  test("reserves empty space after the newest observation on both time scales", () => {
    const calendar = series({
      id: "calendar",
      points: [point("2025-01-01", 10), point("2025-01-11", 20), point("2025-01-21", 30)],
    });
    const market = series({
      ...calendar,
      id: "market",
      timeBasis: { kind: "market", timeZone: "America/New_York" },
    });

    for (const entry of [calendar, market]) {
      const scene = buildCompositeChartScene([entry], [{ id: "main" }], { width: 101, height: 10 })!;
      const points = scene.panels[0]!.series[0]!.points;

      expect(points.at(-1)?.xRatio).toBeCloseTo(NEWEST_X_RATIO, 10);
      // The empty tail is the plot's, not the viewport's: navigation still ends
      // on the newest observation.
      expect(scene.endTime).toBe(new Date("2025-01-21T00:00:00.000Z").getTime());
      // A pointer over the reserved space still reads the newest bar.
      expect(resolveCompositeCursorDate(scene, 100)?.toISOString())
        .toBe("2025-01-21T00:00:00.000Z");
    }
  });

  test("marks the newest close of the primary price series, skipping studies and volume", () => {
    const timeBasis = { kind: "market", timeZone: "America/New_York" } as const;
    const price = series({
      id: "price",
      unitGroup: "price:USD",
      dataShape: "ohlcv",
      style: "candles",
      timeBasis,
      points: ["2025-01-02", "2025-01-03"].map((date, index) => ({
        ...point(date, 100 + index),
        open: 90 + index,
        high: 110 + index,
        low: 80 + index,
        close: 101 + index,
      })),
    });
    const average = series({
      id: "sma",
      unitGroup: "price:USD",
      timeBasis,
      points: [point("2025-01-02", 40), point("2025-01-03", 41)],
    });
    const volume = series({
      id: "volume",
      unitGroup: "volume",
      style: "columns",
      panelId: "volume",
      timeBasis,
      points: [point("2025-01-02", 5_000), point("2025-01-03", 6_000)],
    });
    const scene = buildCompositeChartScene(
      [price, average, volume],
      [{ id: "main" }, { id: "volume" }],
      { width: 101, height: 12 },
    )!;
    const [main, volumePanel] = scene.panels;

    expect(main?.lastPrice?.seriesId).toBe("price");
    expect(main?.lastPrice?.value).toBe(102);
    expect(main?.lastPrice?.color).toBe(price.color);
    expect(main?.lastPrice?.yRatio)
      .toBe(projectCompositeValue(102, main!.axes.left!));
    expect(volumePanel?.lastPrice).toBeUndefined();
  });

  test("uses as-of values across mixed-frequency dates without looking ahead", () => {
    const daily = series({
      id: "daily",
      points: [point("2025-01-02", 20), point("2025-01-04", 40)],
    });
    const quarterly = series({
      id: "quarterly",
      style: "step",
      interpolation: "step-after",
      points: [point("2025-01-01", 100), point("2025-04-01", 140)],
    });

    const beforeDaily = buildCompositeChartScene(
      [daily, quarterly],
      [{ id: "main" }],
      { width: 80, height: 10, cursorDate: new Date("2025-01-01T00:00:00.000Z") },
    );
    expect(beforeDaily?.cursorValues.find((entry) => entry.seriesId === "daily")?.value).toBeNull();

    const betweenDaily = buildCompositeChartScene(
      [daily, quarterly],
      [{ id: "main" }],
      { width: 80, height: 10, cursorDate: new Date("2025-01-03T00:00:00.000Z") },
    );
    expect(betweenDaily?.cursorDate?.toISOString()).toBe("2025-01-02T00:00:00.000Z");
    expect(betweenDaily?.cursorValues.find((entry) => entry.seriesId === "daily")?.value).toBe(20);
    expect(betweenDaily?.cursorValues.find((entry) => entry.seriesId === "quarterly")?.value).toBe(100);
  });

  test("places a filing on its first eligible market slot without changing source timestamps", () => {
    const price = series({
      id: "price",
      dataShape: "ohlcv",
      timeBasis: {
        kind: "market",
        timeZone: "America/New_York",
        cadenceMs: 60 * 60 * 1_000,
      },
      points: [
        point("2025-01-03", 100),
        { ...point("2025-01-03", 101), date: new Date("2025-01-03T16:00:00.000Z"), observedAt: new Date("2025-01-03T16:00:00.000Z") },
        { ...point("2025-01-06", 102), date: new Date("2025-01-06T14:00:00.000Z"), observedAt: new Date("2025-01-06T14:00:00.000Z") },
        { ...point("2025-01-06", 103), date: new Date("2025-01-06T15:00:00.000Z"), observedAt: new Date("2025-01-06T15:00:00.000Z") },
      ],
    });
    const observedAt = new Date("2024-12-31T00:00:00.000Z");
    const availableAt = new Date("2025-01-04T12:05:00.000Z");
    const filingPoint: TimeSeriesPoint = {
      date: observedAt,
      observedAt,
      availableAt,
      value: 500,
      periodLabel: "2024 Q4",
    };
    const filing = series({
      id: "filing",
      style: "columns",
      nativeFrequency: "quarterly",
      timestampMode: "period-end",
      points: [filingPoint],
    });
    const viewport = {
      start: new Date("2025-01-03T00:00:00.000Z"),
      end: new Date("2025-01-06T15:00:00.000Z"),
    };
    const friday = buildCompositeChartScene(
      [price, filing],
      [{ id: "main" }],
      { width: 101, height: 10, viewport, cursorDate: new Date("2025-01-03T16:00:00.000Z") },
    )!;

    const pricePoints = friday.panels[0]!.series.find((entry) => entry.source.id === "price")!.points;
    const filingProjected = friday.panels[0]!.series.find((entry) => entry.source.id === "filing")!.points[0]!;
    const mondayPrice = pricePoints.find((entry) => entry.timestamp === Date.parse("2025-01-06T14:00:00.000Z"))!;
    expect(filingProjected.xRatio).toBe(mondayPrice.xRatio);
    expect(filingProjected.xSlot).toBe(mondayPrice.xSlot);
    expect(filingProjected.point.date).toBe(observedAt);
    expect(filingProjected.point.observedAt).toBe(observedAt);
    expect(filingProjected.point.availableAt).toBe(availableAt);
    expect(friday.cursorValues.find((entry) => entry.seriesId === "filing")?.value).toBeNull();

    const monday = applyCompositeChartCursor(friday, new Date("2025-01-06T14:00:00.000Z"));
    expect(monday.cursorValues.find((entry) => entry.seriesId === "filing")?.value).toBe(500);
    expect(monday.dates.map((date) => date.getUTCDay())).not.toContain(6);
  });

  test("does not expose a filing whose availability is after the market viewport", () => {
    const price = series({
      id: "price",
      timeBasis: {
        kind: "market",
        timeZone: "America/New_York",
        cadenceMs: 24 * 60 * 60 * 1_000,
      },
      points: [point("2025-01-03", 100), point("2025-01-06", 102)],
    });
    const filing = series({
      id: "filing",
      style: "columns",
      points: [{
        ...point("2025-01-03", 500),
        availableAt: new Date("2025-01-07T12:00:00.000Z"),
      }],
    });
    const scene = buildCompositeChartScene(
      [price, filing],
      [{ id: "main" }],
      {
        width: 80,
        height: 10,
        viewport: {
          start: new Date("2025-01-03T00:00:00.000Z"),
          end: new Date("2025-01-06T23:59:59.999Z"),
        },
      },
    );

    expect(scene?.panels[0]?.series.some((entry) => entry.source.id === "filing")).toBe(false);
  });

  test("groups publications that snap to the same market slot into adjacent lanes", () => {
    const price = series({
      id: "price",
      timeBasis: {
        kind: "market",
        timeZone: "America/New_York",
        cadenceMs: 24 * 60 * 60 * 1_000,
      },
      points: [point("2025-01-03", 100), point("2025-01-06", 102), point("2025-01-07", 104)],
    });
    const filing = (id: string, availableAt: string) => series({
      id,
      style: "columns",
      nativeFrequency: "quarterly",
      timestampMode: "period-end",
      unitGroup: "currency-total",
      points: [{
        ...point("2024-12-31", id === "revenue" ? 500 : 100),
        availableAt: new Date(availableAt),
        periodLabel: "2024 Q4",
      }],
    });
    const scene = buildCompositeChartScene(
      [price, filing("revenue", "2025-01-04T12:00:00.000Z"), filing("income", "2025-01-05T12:00:00.000Z")],
      [{ id: "main" }],
      { width: 80, height: 10 },
    )!;
    const panel = scene.panels[0]!;
    const columns = panel.series.filter((entry) => entry.source.style === "columns");
    const first = columns[0]!.points[0]!;
    const second = columns[1]!.points[0]!;
    const layout = buildCompositeColumnLayout(panel);

    expect(first.xSlot).toBe(second.xSlot);
    expect(layout.groupByPoint.get(first)).toMatchObject({ index: 0, count: 2 });
    expect(layout.groupByPoint.get(second)).toMatchObject({ index: 1, count: 2 });
  });

  test("uses plotted market data when the legend timeline is empty", () => {
    const timestamps = [
      "2025-01-03T15:00:00.000Z",
      "2025-01-03T16:00:00.000Z",
      "2025-01-06T14:00:00.000Z",
    ];
    const price = series({
      id: "price",
      timeBasis: {
        kind: "market",
        timeZone: "America/New_York",
        cadenceMs: 60 * 60 * 1_000,
      },
      points: timestamps.map((timestamp, index) => {
        const date = new Date(timestamp);
        return { date, observedAt: date, value: 100 + index };
      }),
    });
    const scene = buildCompositeChartScene(
      [price],
      [{ id: "main" }],
      {
        width: 80,
        height: 10,
        viewport: {
          start: new Date(timestamps[0]!),
          end: new Date(timestamps.at(-1)!),
        },
        timelineSeries: [],
      },
    );

    expect(scene?.timeScale).toMatchObject({ kind: "market", anchorSeriesId: "price" });
    const ratios = scene?.panels[0]?.series[0]?.points.map(({ xRatio }) => xRatio) ?? [];
    expect(ratios).toHaveLength(3);
    expect(ratios[0]).toBe(0);
    expect(ratios[1]).toBeCloseTo(0.5 * NEWEST_X_RATIO, 10);
    expect(ratios[2]).toBeCloseTo(NEWEST_X_RATIO, 10);
  });

  test("retains the authored primary market scale when its plotted series is hidden", () => {
    const anchor = series({
      id: "primary-price",
      timeBasis: {
        kind: "market",
        timeZone: "America/New_York",
        cadenceMs: 60 * 60 * 1_000,
      },
      points: [
        { ...point("2025-01-03", 100), date: new Date("2025-01-03T16:00:00.000Z") },
        { ...point("2025-01-06", 101), date: new Date("2025-01-06T14:00:00.000Z") },
      ],
    });
    const filing = series({
      id: "filing",
      style: "columns",
      points: [{
        ...point("2024-12-31", 500),
        availableAt: new Date("2025-01-04T12:00:00.000Z"),
      }],
    });
    const scene = buildCompositeChartScene(
      [filing],
      [{ id: "main" }],
      {
        width: 80,
        height: 10,
        viewport: {
          start: new Date("2025-01-03T00:00:00.000Z"),
          end: new Date("2025-01-06T23:59:59.999Z"),
        },
        timelineSeries: [anchor, filing],
      },
    );

    expect(scene?.timeScale).toMatchObject({
      kind: "market",
      anchorSeriesId: "primary-price",
    });
    expect(scene?.panels[0]?.series[0]?.points[0]?.xSlot).toBe(1);
  });

  test("hydrates cursor values without rebuilding projected panels", () => {
    const base = buildCompositeChartScene(
      [series({
        id: "price",
        points: [point("2025-01-01", 10), point("2025-01-02", 12)],
      })],
      [{ id: "main" }],
      { width: 80, height: 10 },
    )!;

    const withCursor = applyCompositeChartCursor(
      base,
      new Date("2025-01-01T12:00:00.000Z"),
    );

    expect(withCursor).not.toBe(base);
    expect(withCursor.panels).toBe(base.panels);
    expect(withCursor.panels[0]?.series).toBe(base.panels[0]?.series);
    expect(withCursor.cursorDate?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(withCursor.cursorValues[0]?.value).toBe(10);
    expect(applyCompositeChartCursor(withCursor, new Date("2025-01-01T00:00:00.000Z"))).toBe(withCursor);
  });
});
