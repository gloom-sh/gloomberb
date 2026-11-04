import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../../test-support/time-series";
import type { ResolvedSeries } from "../../../time-series/types";
import { compositeViewportPositions, type CompositeNavigationFrame, type CompositeViewportRange } from "./interactions";
import { useCompositeViewport } from "./use-composite-viewport";

const tui = createOpenTuiTestHarness();
const DAY_MS = 86_400_000;
const FIRST_BAR = Date.UTC(2025, 0, 10);
const AUTHORED = { start: new Date(Date.UTC(2025, 1, 1)), end: new Date(Date.UTC(2025, 1, 28)) };

function bars(historyStart?: Date): ResolvedSeries[] {
  const points = Array.from({ length: 50 }, (_, day) => createTestSeriesPoint(new Date(FIRST_BAR + day * DAY_MS), 100 + day));
  return [createTestResolvedSeries({ id: "price", points, observationKind: "market", ...(historyStart ? { historyStart } : {}) })];
}

type Rendered = { frame: CompositeNavigationFrame; view: CompositeViewportRange };

test("a drag that goes on after the source says nothing older exists leaves the view on the first bar", async () => {
  const renders: Rendered[] = [];
  let viewport!: ReturnType<typeof useCompositeViewport>;
  let answer!: (series: ResolvedSeries[]) => void;
  function Probe() {
    const [series, setSeries] = useState(() => bars());
    answer = setSeries;
    viewport = useCompositeViewport({
      viewport: AUTHORED, viewportResetKey: undefined, visibleSeries: series, marketTimelineSeries: series,
      allowHistoricalBackfill: true, onViewportChange: undefined,
    });
    renders.push({ frame: viewport.navigationFrame!, view: viewport.effectiveViewport! });
    return null;
  }
  await act(async () => { await tui.render(<Probe />, { width: 20, height: 5 }); });

  // A drag back while the older bars are still being asked for runs into the
  // space before the first bar the chart has.
  const opened = renders.at(-1)!;
  const positions = compositeViewportPositions(opened.frame, opened.view)!;
  const span = positions.end - positions.start;
  await act(async () => viewport.panViewport(span * 1.1, { frame: opened.frame, from: opened.view }));
  expect(viewport.effectiveViewport!.start.getTime()).toBeLessThan(FIRST_BAR);

  // The source answers that nothing older exists, and the pointer moves on
  // before the view is stored again: the plot restarts the drag from the view
  // the render with the new frame showed, as it does whenever the frame changes.
  const seen = renders.length;
  await act(async () => answer(bars(new Date(FIRST_BAR))));
  const answered = renders.slice(seen).find((render) => render.frame !== opened.frame)!;
  await act(async () => viewport.panViewport(span * 0.05, { frame: answered.frame, from: answered.view }));

  const frame = viewport.navigationFrame!;
  const rest = compositeViewportPositions(frame, viewport.effectiveViewport!)!;
  expect(rest.start).toBeGreaterThanOrEqual(frame.dataStartPosition - (rest.end - rest.start) * 0.05);
});
