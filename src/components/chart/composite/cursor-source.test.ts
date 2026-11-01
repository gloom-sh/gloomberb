import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../../test-support/time-series";
import { createCompositeCursorSource, createValueStore, useCursorScene, type CompositeCursorSource } from "./cursor-source";
import { buildCompositeChartScene } from "./scene";

const tui = createOpenTuiTestHarness();
const HOUR = 60 * 60 * 1000;
const DAYS = ["2025-01-01", "2025-01-02", "2025-01-03"].map((day) => Date.parse(`${day}T00:00:00.000Z`));

function baseScene() {
  const scene = buildCompositeChartScene([createTestResolvedSeries({
    id: "price",
    points: DAYS.map((time, index) => createTestSeriesPoint(new Date(time), 100 + index)),
  })], [{ id: "main" }], { width: 40, height: 10 });
  if (!scene) throw new Error("expected a scene");
  return scene;
}

/** Another chart's cursor, and how many readers it has. */
function sharedCursor() {
  const time = createValueStore<number | null>(null);
  let listeners = 0;
  const link = {
    subscribe(listener: () => void) {
      listeners += 1;
      const stop = time.subscribe(listener);
      return () => {
        listeners -= 1;
        stop();
      };
    },
    time: time.get,
  };
  return { store: time, link, listeners: () => listeners };
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
    shared.set(DAYS[1]! + 6 * HOUR);
    expect(cursorAt()).toBe(DAYS[1]);
    shared.set(null);
    expect(cursorAt()).toBe(DAYS[0]);
    own.set(null);
    expect(cursorAt()).toBe(DAYS[2]);
  });

  // Another chart's cursor moves with its pointer, often within one of this
  // chart's bars: every move is told, and the scene changes with the bar.
  test("tells its readers of every move of another chart's cursor, and lets go of both cursors when they stop", () => {
    const base = baseScene();
    const own = createValueStore<number | null>(null);
    const shared = sharedCursor();
    const source = createCompositeCursorSource({ baseScene: base, own, fallback: null, link: shared.link });
    let told = 0;
    const stop = source.subscribe(() => {
      told += 1;
    });
    expect(shared.listeners()).toBe(1);
    shared.store.set(DAYS[1]! + HOUR);
    const onSecond = source.scene();
    expect(onSecond.cursorDate?.getTime()).toBe(DAYS[1]);
    shared.store.set(DAYS[1]! + 2 * HOUR);
    expect(told).toBe(2);
    expect(source.scene()).toBe(onSecond);
    shared.store.set(DAYS[2]! + HOUR);
    expect(told).toBe(3);
    expect(source.scene().cursorDate?.getTime()).toBe(DAYS[2]);

    stop();
    expect(shared.listeners()).toBe(0);
    shared.store.set(DAYS[0]! + HOUR);
    own.set(DAYS[1]!);
    expect(told).toBe(3);
  });

  test("renders a reader again when the cursor moves to another bar, not on every move, and lets go when it unmounts", async () => {
    const own = createValueStore<number | null>(null);
    const shared = sharedCursor();
    const source = createCompositeCursorSource({ baseScene: baseScene(), own, fallback: null, link: shared.link });
    const seen: Array<number | null> = [];
    function Reader({ cursor }: { cursor: CompositeCursorSource }) {
      seen.push(useCursorScene(cursor).cursorDate?.getTime() ?? null);
      return null;
    }
    const { root } = await tui.createRoot();
    await act(async () => root.render(createElement(Reader, { cursor: source })));
    expect(seen).toEqual([null]);

    await act(async () => own.set(DAYS[0]!));
    // Another chart's cursor shows in place of this one's, moving within a bar and then to the next.
    await act(async () => shared.store.set(DAYS[1]! + HOUR));
    await act(async () => shared.store.set(DAYS[1]! + 2 * HOUR));
    await act(async () => shared.store.set(DAYS[2]! + HOUR));
    expect(seen).toEqual([null, DAYS[0], DAYS[1], DAYS[2]]);

    expect(shared.listeners()).toBe(1);
    await act(async () => root.unmount());
    expect(shared.listeners()).toBe(0);
    await act(async () => own.set(DAYS[1]!));
    expect(seen).toHaveLength(4);
  });
});
