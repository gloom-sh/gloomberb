/** @jsxImportSource react */
import { expect, jest, test } from "bun:test";
import { act, useLayoutEffect, useState } from "react";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { beginLiveResize } from "../../ui/live-resize";
import { RESIZE_SETTLE_MS } from "../../ui/resize-settle";
import { buildHeatTreemapScene, heatTreemapCanvas, HeatTreemapSurface, useHeatTreemapScene, type MetricTreemapItem } from ".";
import type { MetricTreemapScene } from "./scene";

const dom = createDomTestHarness();
const DESKTOP = { nativePaneChrome: true, cellWidthPx: 8, cellHeightPx: 18 };

function board(weights: readonly number[], move: number): Array<MetricTreemapItem<null>> {
  return weights.map((weight, index) => ({
    id: `t${index}`, label: `T${index}`, weight, colorValue: index === 0 ? move : 1, primaryText: `${move}%`, data: null,
  }));
}

interface Shown { scene: MetricTreemapScene<null>; items: Array<MetricTreemapItem<null>>; resizing: boolean }

test("a large drag holds the heat scene through refreshes and commits the final layout once after release", async () => {
  jest.useFakeTimers();
  const before = board([6, 5, 4, 3, 2, 1], 2);
  const after = board([1, 2, 3, 4, 5, 6], -2);
  let show: (width: number, items: Array<MetricTreemapItem<null>>) => void = () => {};
  const seen: { scene: MetricTreemapScene<null> | null; builds: number } = { scene: null, builds: 0 };
  function Harness() {
    const [shown, setShown] = useState({ width: 80, items: before });
    show = (width, items) => setShown({ width, items });
    const layout = useHeatTreemapScene(shown.items, shown.width, 24);
    useLayoutEffect(() => { seen.scene = layout.scene; seen.builds += 1; }, [layout.scene]);
    return null;
  }
  let end: (() => void) | null = null;
  try {
    await dom.render(<Harness />);
    const initial = seen.scene;
    end = beginLiveResize();
    // Both directions cross the old 1.5x stretch limit.
    await act(async () => show(48, after));
    await act(async () => { jest.advanceTimersByTime(RESIZE_SETTLE_MS * 3); });
    await act(async () => show(136, after));
    await act(async () => { jest.advanceTimersByTime(RESIZE_SETTLE_MS * 3); });
    expect(seen.scene).toBe(initial);
    expect(seen.builds).toBe(1);
    end();
    await act(async () => { jest.advanceTimersByTime(RESIZE_SETTLE_MS); });
    expect(seen.builds).toBe(2);
    expect(seen.scene!.width).toBe(136 * DESKTOP.cellWidthPx);
    expect(seen.scene!.tiles.find((tile) => tile.item.id === "t0")!.item.weight).toBe(1);
  } finally {
    end?.();
    jest.useRealTimers();
  }
});

test("tiles hold still while their box resizes: a slide under way stops, colour changes snap, and no slide replays after the resize or into the layout it settles on", async () => {
  const before = board([6, 5, 4, 3, 2, 1], 2);
  const after = board([1, 2, 3, 4, 5, 6], 2);
  const canvas = heatTreemapCanvas(60, 12, DESKTOP);
  const sceneA = buildHeatTreemapScene(before, canvas);
  const sceneB = buildHeatTreemapScene(after, canvas, sceneA);
  let show: (next: Partial<Shown>) => void = () => {};
  function Harness() {
    const [shown, setShown] = useState<Shown>({ scene: sceneA, items: before, resizing: false });
    show = (next) => setShown((current) => ({ ...current, ...next }));
    return <HeatTreemapSurface {...shown} width={60} height={12} selectedId={null} onSelect={() => {}} />;
  }
  const container = await dom.render(<Harness />);
  const animations = (name: string) => [...container.querySelectorAll<HTMLElement>("[data-gloom-role=heat-tile], [data-gloom-role=heat-tile] *")]
    .filter((element) => element.style.animation.includes(name)).length;

  // At rest a relayout slides the tiles it moved.
  await act(async () => show({ scene: sceneB, items: after }));
  expect(animations("gloom-heat-glide")).toBeGreaterThan(0);

  // The box starts resizing: the slides stop, and a tick's colour lands without a fade.
  await act(async () => show({ resizing: true }));
  expect(animations("gloom-heat-glide")).toBe(0);
  await act(async () => show({ items: board([1, 2, 3, 4, 5, 6], -2) }));
  expect(animations("gloom-heat-fade")).toBe(0);

  // It stops: a tick recolours with a fade again, and nothing slides from where it was before the resize.
  await act(async () => show({ resizing: false }));
  await act(async () => show({ items: board([1, 2, 3, 4, 5, 6], 2) }));
  expect(animations("gloom-heat-fade")).toBe(1);
  expect(animations("gloom-heat-glide")).toBe(0);

  // The layout a resize settles on, at the new size, comes in at once.
  await act(async () => show({ resizing: true }));
  const settled = buildHeatTreemapScene(before, heatTreemapCanvas(80, 16, DESKTOP), sceneB);
  await act(async () => show({ scene: settled, items: before, resizing: false }));
  expect(animations("gloom-heat-glide")).toBe(0);
});
