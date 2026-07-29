import { describe, expect, test } from "bun:test";
import type { CompositeChartScene } from "./types";
import {
  buildCompositeTimeAxisLayout,
  buildCompositeViewportTimeAxisLayout,
  type CompositeTimeAxisLayout,
} from "./time-axis";

function viewport(start: string, end: string, width: number): CompositeTimeAxisLayout {
  return buildCompositeViewportTimeAxisLayout({
    start: new Date(start),
    end: new Date(end),
  }, width);
}

function expectValidLayout(layout: CompositeTimeAxisLayout, width: number): void {
  expect(layout.text).toHaveLength(width);
  layout.ticks.forEach((tick, index) => {
    expect(tick.start).toBeGreaterThanOrEqual(0);
    expect(tick.end).toBeLessThan(width);
    expect(tick.end).toBeGreaterThanOrEqual(tick.start);
    expect(layout.text.slice(tick.start, tick.end + 1)).toBe(tick.label);
    if (index > 0) {
      expect(tick.start).toBeGreaterThan(layout.ticks[index - 1]!.end);
    }
  });
}

function marketScene(
  dates: string[],
  dateRatios: number[],
): CompositeChartScene {
  const timestamps = dates.map((date) => Date.parse(date));
  const startTime = timestamps[0]!;
  const endTime = timestamps.at(-1)!;
  return {
    width: 80,
    height: 10,
    startTime,
    endTime,
    timeScale: {
      kind: "market",
      startTime,
      endTime,
      anchorSeriesId: "price",
      cadenceMs: 24 * 60 * 60 * 1_000,
      anchors: timestamps.map((timestamp, index) => ({
        timestamp,
        position: index,
      })),
      startPosition: 0,
      endPosition: Math.max(timestamps.length - 1, 1),
    },
    dates: timestamps.map((timestamp) => new Date(timestamp)),
    dateRatios,
    panels: [],
    cursorDate: null,
    cursorXRatio: null,
    cursorValues: [],
  };
}

describe("adaptive composite time axis", () => {
  test("increases intraday density with width while keeping concise UTC clock labels", () => {
    const narrow = viewport(
      "2026-07-29T09:30:00.000Z",
      "2026-07-29T16:00:00.000Z",
      40,
    );
    const medium = viewport(
      "2026-07-29T09:30:00.000Z",
      "2026-07-29T16:00:00.000Z",
      80,
    );
    const wide = viewport(
      "2026-07-29T09:30:00.000Z",
      "2026-07-29T16:00:00.000Z",
      165,
    );

    expect(narrow.text).toContain("09:30 UTC");
    expect(narrow.text).toContain("16:00 UTC");
    expect(narrow.text).not.toContain("2026-07-29");
    expect(medium.ticks.length).toBeGreaterThan(narrow.ticks.length);
    expect(wide.ticks.length).toBeGreaterThan(medium.ticks.length);
    expectValidLayout(narrow, 40);
    expectValidLayout(medium, 80);
    expectValidLayout(wide, 165);
  });

  test("uses day, month, and year context appropriate to the visible span", () => {
    const month = viewport(
      "2026-06-29T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      80,
    );
    const year = viewport(
      "2025-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      80,
    );
    const multiyear = viewport(
      "2021-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      40,
    );

    expect(month.text).toContain("Jun 29");
    expect(month.text).toContain("Jul 29");
    expect(month.text).not.toContain("2026-06-29");
    expect(month.ticks.length).toBeGreaterThan(3);
    expect(year.text).toContain("Jul 29 2025");
    expect(year.text).toContain("Jan 2026");
    expect(year.text).toContain("Jul 29 2026");
    expect(year.ticks.length).toBeGreaterThan(3);
    expect(multiyear.text).toContain("2021");
    expect(multiyear.text).toContain("2026");
    expect(multiyear.text).not.toContain("Jul 29");
    expectValidLayout(month, 80);
    expectValidLayout(year, 80);
    expectValidLayout(multiyear, 40);
  });

  test("gives a wide NBIS-length chart useful bimonthly density", () => {
    const narrow = viewport(
      "2024-10-21T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      40,
    );
    const wide = viewport(
      "2024-10-21T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      165,
    );

    expect(narrow.ticks.length).toBeGreaterThanOrEqual(2);
    expect(wide.ticks.length).toBeGreaterThanOrEqual(8);
    expect(wide.ticks.length).toBeGreaterThan(narrow.ticks.length);
    expect(wide.text).toContain("Oct 21 2024");
    expect(wide.text).toContain("Jan 2025");
    expect(wide.text).toContain("Jan 2026");
    expect(wide.text).toContain("Jul 29 2026");
    expectValidLayout(narrow, 40);
    expectValidLayout(wide, 165);
  });

  test("keeps very narrow layouts in bounds without overlapping labels", () => {
    for (const width of [18, 24]) {
      const layout = viewport(
        "2024-10-21T00:00:00.000Z",
        "2026-07-29T00:00:00.000Z",
        width,
      );
      expect(layout.ticks.length).toBeGreaterThanOrEqual(2);
      expectValidLayout(layout, width);
    }
  });

  test("snaps calendar boundaries to supplied market ratios instead of inventing weekend ticks", () => {
    const scene = marketScene([
      "2025-01-03T00:00:00.000Z",
      "2025-01-06T00:00:00.000Z",
      "2025-01-07T00:00:00.000Z",
    ], [0, 0.25, 1]);
    const layout = buildCompositeTimeAxisLayout(scene, 80);
    const monday = layout.ticks.find((tick) => (
      tick.timestamp === Date.parse("2025-01-06T00:00:00.000Z")
    ));

    expect(monday?.ratio).toBe(0.25);
    expect(monday?.start).toBeLessThan(30);
    expect(layout.ticks.some((tick) => tick.label.includes("4"))).toBe(false);
    expect(layout.ticks.some((tick) => tick.label.includes("5"))).toBe(false);
    expectValidLayout(layout, 80);
  });

  test("keeps the final month tick and an exact viewport endpoint distinct", () => {
    const layout = viewport(
      "2025-11-03T00:00:00.000Z",
      "2026-07-29T00:00:00.000Z",
      217,
    );
    const july = layout.ticks.find((tick) => (
      tick.timestamp === Date.parse("2026-07-01T00:00:00.000Z")
    ));
    const endpoint = layout.ticks.at(-1);

    expect(july?.label).toBe("Jul");
    expect(july?.ratio).toBeCloseTo(240 / 268);
    expect(endpoint).toMatchObject({
      timestamp: Date.parse("2026-07-29T00:00:00.000Z"),
      ratio: 1,
      label: "Jul 29 2026",
    });
    expectValidLayout(layout, 217);
  });

  test("keeps viewport edges distinct from market observations between those edges", () => {
    const scene = marketScene([
      "2025-01-03T10:00:00.000Z",
      "2025-01-03T16:00:00.000Z",
    ], [0.25, 0.9]);
    scene.startTime = Date.parse("2025-01-03T09:30:00.000Z");
    scene.endTime = Date.parse("2025-01-03T16:30:00.000Z");
    const layout = buildCompositeTimeAxisLayout(scene, 80);
    const tenOClock = layout.ticks.find((tick) => (
      tick.timestamp === Date.parse("2025-01-03T10:00:00.000Z")
    ));

    expect(layout.ticks[0]?.timestamp).toBe(scene.startTime);
    expect(layout.ticks[0]?.ratio).toBe(0);
    expect(tenOClock?.ratio).toBe(0.25);
    expect(layout.ticks.at(-1)?.timestamp).toBe(scene.endTime);
    expect(layout.ticks.at(-1)?.ratio).toBe(1);
    expectValidLayout(layout, 80);
  });

  test("compacts cross-year endpoints before dropping either side", () => {
    const layout = viewport(
      "2025-12-31T23:30:00.000Z",
      "2026-01-01T00:30:00.000Z",
      30,
    );

    expect(layout.text).toContain("Dec 31 23:30");
    expect(layout.text).toContain("Jan 1 00:30");
    expect(layout.ticks).toHaveLength(2);
    expectValidLayout(layout, 30);
  });

  test("keeps fixed UTC progression across a local daylight-saving transition", () => {
    const layout = viewport(
      "2025-03-30T00:30:00.000Z",
      "2025-03-30T04:30:00.000Z",
      165,
    );

    expect(layout.text).toContain("01:00");
    expect(layout.text).toContain("02:00");
    expect(layout.text).toContain("03:00");
    expectValidLayout(layout, 165);
  });
});
