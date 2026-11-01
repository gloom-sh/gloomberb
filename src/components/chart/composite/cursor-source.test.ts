import { describe, expect, test } from "bun:test";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../../test-support/time-series";
import { createCompositeCursorSource, createValueStore } from "./cursor-source";
import { buildCompositeChartScene } from "./scene";

const DAYS = ["2025-01-01", "2025-01-02", "2025-01-03"].map((day) => Date.parse(`${day}T00:00:00.000Z`));

function baseScene() {
  const scene = buildCompositeChartScene([createTestResolvedSeries({
    id: "price",
    points: DAYS.map((time, index) => createTestSeriesPoint(new Date(time), 100 + index)),
  })], [{ id: "main" }], { width: 40, height: 10 });
  if (!scene) throw new Error("expected a scene");
  return scene;
}

function sharedCursor() {
  const time = createValueStore<number | null>(null);
  return { store: time, link: { subscribe: time.subscribe, time: time.get } };
}

describe("a chart's cursor source", () => {
  test("hands out one scene per bar under the cursor, and tells its readers when that changes", () => {
    const base = baseScene();
    const own = createValueStore<number | null>(null);
    const source = createCompositeCursorSource({ baseScene: base, own, fallback: null });
    let told = 0;
    source.subscribe(() => {
      told += 1;
    });
    expect(source.scene()).toBe(base);
    own.set(DAYS[1]!);
    expect(told).toBe(1);
    const atSecond = source.scene();
    expect(atSecond.cursorDate?.getTime()).toBe(DAYS[1]);
    expect(atSecond.cursorValues[0]?.value).toBe(101);
    expect(source.scene()).toBe(atSecond);
    own.set(DAYS[1]!);
    expect(told).toBe(1);
    own.set(null);
    expect(source.scene()).toBe(base);
  });

  test("shows another chart's cursor over its own, and the owner's when it has none", () => {
    const base = baseScene();
    const own = createValueStore<number | null>(DAYS[0]!);
    const { store: shared, link } = sharedCursor();
    const source = createCompositeCursorSource({ baseScene: base, own, fallback: DAYS[2]!, link });
    const cursorAt = () => source.scene().cursorDate?.getTime() ?? null;
    expect(cursorAt()).toBe(DAYS[0]);
    // Another chart's cursor, partway through the second day, lands on its bar.
    shared.set(DAYS[1]! + 6 * 60 * 60 * 1000);
    expect(cursorAt()).toBe(DAYS[1]);
    shared.set(null);
    expect(cursorAt()).toBe(DAYS[0]);
    own.set(null);
    expect(cursorAt()).toBe(DAYS[2]);
  });
});
