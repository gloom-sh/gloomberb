import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolvedSeries } from "../../../time-series/types";
import {
  buildCompositeNavigationFrame,
  compositeNavigationDataViewport,
  compositeViewportPositions,
  fitCompositeViewport,
  panCompositeViewport,
  sameCompositeViewport,
  shouldResetCompositeViewport,
  zoomCompositeViewport,
  type CompositeNavigationFrame,
  type CompositeViewportRange,
} from "./interactions";
import type { CompositeChartProps } from "./types";

/** How far past the first loaded observation a backfilling chart may pan, as a fraction of the view. */
const HISTORICAL_PADDING_RATIO = 0.5;
/**
 * Once the source has said its history starts at the first loaded bar, a pan
 * stops there, with this much air before it rather than half an empty view.
 */
const HISTORY_EDGE_PADDING_RATIO = 0.02;

/** True when every market listing on the chart has said nothing older exists. */
function reachesHistoryStart(series: readonly ResolvedSeries[]): boolean {
  const market = series.filter((entry) => entry.observationKind === "market" && entry.points.length > 0);
  return market.length > 0 && market.every((entry) => entry.historyStart !== undefined);
}

export function useCompositeViewport({
  viewport,
  viewportResetKey,
  visibleSeries,
  marketTimelineSeries,
  allowHistoricalBackfill,
  onViewportChange,
}: {
  viewport: CompositeChartProps["viewport"];
  viewportResetKey: CompositeChartProps["viewportResetKey"];
  visibleSeries: ResolvedSeries[];
  marketTimelineSeries: ResolvedSeries[];
  allowHistoricalBackfill: boolean;
  onViewportChange: CompositeChartProps["onViewportChange"];
}) {
  const previousAuthoredViewportRef = useRef<CompositeViewportRange | null>(viewport ?? null);
  const previousViewportResetKeyRef = useRef(viewportResetKey);
  // The user owns this once they navigate. Data refreshes never rewrite it;
  // only the authored viewport changing or an explicit reset clears it.
  const [userViewport, setUserViewport] = useState<CompositeViewportRange | null>(null);
  const hasViewportResetKey = viewportResetKey !== undefined
    || previousViewportResetKeyRef.current !== undefined;
  const authoredViewportChanged = hasViewportResetKey
    ? previousViewportResetKeyRef.current !== viewportResetKey
    : shouldResetCompositeViewport(
        previousAuthoredViewportRef.current,
        viewport ?? null,
      );
  const historyStartReached = allowHistoricalBackfill && reachesHistoryStart(visibleSeries);
  const navigationFrame = useMemo(
    () => buildCompositeNavigationFrame(visibleSeries, marketTimelineSeries, {
      historicalPaddingRatio: !allowHistoricalBackfill ? 0
        : historyStartReached ? HISTORY_EDGE_PADDING_RATIO : HISTORICAL_PADDING_RATIO,
    }),
    [allowHistoricalBackfill, historyStartReached, marketTimelineSeries, visibleSeries],
  );
  const authoredViewport = useMemo(() => {
    // The requested dates own the axis, including gaps in a cached or partial
    // response. Fitting them to available observations silently changes the
    // research period. User pan/zoom gestures retain their navigation limits.
    if (viewport && Number.isFinite(viewport.start.getTime())
      && Number.isFinite(viewport.end.getTime()) && viewport.start <= viewport.end) return viewport;
    return navigationFrame ? compositeNavigationDataViewport(navigationFrame) : null;
  }, [navigationFrame, viewport]);
  const activeUserViewport = authoredViewportChanged ? null : userViewport;
  const effectiveViewport = activeUserViewport ?? authoredViewport;
  const userViewportStart = activeUserViewport?.start.getTime() ?? null;
  const userViewportEnd = activeUserViewport?.end.getTime() ?? null;
  const lastReportedViewportRef = useRef<string | null>(null);
  const viewportInteractionRef = useRef<"pan" | "reset" | "zoom">("reset");
  useEffect(() => {
    if (!onViewportChange) return;
    const key = userViewportStart === null || userViewportEnd === null
      ? "none"
      : `${userViewportStart}:${userViewportEnd}`;
    // The callback drives adaptive data loading. Seed it from the authored
    // viewport without echoing that controlled value back into the loader.
    if (lastReportedViewportRef.current === null) {
      lastReportedViewportRef.current = key;
      return;
    }
    if (lastReportedViewportRef.current === key) return;
    lastReportedViewportRef.current = key;
    onViewportChange(
      userViewportStart === null || userViewportEnd === null
        ? null
        : { start: new Date(userViewportStart), end: new Date(userViewportEnd) },
      viewportInteractionRef.current,
    );
  }, [onViewportChange, userViewportEnd, userViewportStart]);

  // Counts authored views, so what belongs to one (values scaled by hand) can
  // go with it; `authoredViewportChanged` covers the render before it counts.
  const [authoredGeneration, setAuthoredGeneration] = useState(0);
  useEffect(() => {
    previousAuthoredViewportRef.current = viewport ?? null;
    previousViewportResetKeyRef.current = viewportResetKey;
    if (authoredViewportChanged) setAuthoredGeneration((generation) => generation + 1);
    if (authoredViewportChanged && userViewport) {
      viewportInteractionRef.current = "reset";
      setUserViewport(null);
    }
  }, [authoredViewportChanged, userViewport, viewport, viewportResetKey]);

  // Once the source says it has nothing older, a view left in the space
  // before the first bar (where a pan went while the answer was on its way)
  // settles onto it, as it would have stopped there had the answer come first.
  useEffect(() => {
    if (!historyStartReached || !navigationFrame) return;
    setUserViewport((current) => {
      if (!current) return current;
      const positions = compositeViewportPositions(navigationFrame, current);
      const span = positions ? positions.end - positions.start : 0;
      if (!positions || positions.start >= navigationFrame.dataStartPosition - span * HISTORY_EDGE_PADDING_RATIO - 1e-6) return current;
      viewportInteractionRef.current = "pan";
      return fitCompositeViewport(navigationFrame, current);
    });
  }, [historyStartReached, navigationFrame]);

  const navigate = useCallback((
    kind: "pan" | "zoom",
    compute: (base: CompositeViewportRange, frame: CompositeNavigationFrame) => CompositeViewportRange,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => {
    const frame = gesture?.frame ?? navigationFrame;
    if (!frame) return;
    viewportInteractionRef.current = kind;
    setUserViewport((current) => {
      const base = gesture?.from ?? current ?? authoredViewport;
      if (!base) return current;
      const next = compute(base, frame);
      // Once navigated, the window is the user's until they reset it, even if
      // a gesture happens to land back on the authored range: the owner may
      // echo a navigated range back as the authored one, and dropping to null
      // there would reload the original range under the pointer.
      return sameCompositeViewport(next, current ?? base) ? current : next;
    });
  }, [authoredViewport, navigationFrame]);
  const panViewport = useCallback((
    deltaPositions: number,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => {
    navigate("pan", (base, frame) => panCompositeViewport(frame, base, deltaPositions), gesture);
  }, [navigate]);
  const panViewportByRatio = useCallback((shiftRatio: number) => {
    if (!navigationFrame || !effectiveViewport) return;
    const positions = compositeViewportPositions(navigationFrame, effectiveViewport);
    if (!positions) return;
    panViewport(shiftRatio * Math.max(positions.end - positions.start, Number.EPSILON));
  }, [effectiveViewport, navigationFrame, panViewport]);
  /** A gesture (a drag on the time axis) zooms from the view and frame it started in, by its whole travel so far. */
  const zoomViewport = useCallback((
    zoomFactor: number,
    anchorRatio = 1,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => {
    navigate("zoom", (base, frame) => zoomCompositeViewport(frame, base, zoomFactor, anchorRatio), gesture);
  }, [navigate]);
  const setViewportRange = useCallback((range: CompositeViewportRange) => {
    navigate("zoom", (_base, frame) => fitCompositeViewport(frame, range));
  }, [navigate]);
  const resetViewport = useCallback(() => {
    viewportInteractionRef.current = "reset";
    setUserViewport(null);
  }, []);
  return {
    navigationFrame, activeUserViewport, effectiveViewport, authoredViewportChanged, authoredGeneration,
    panViewport, panViewportByRatio, zoomViewport, setViewportRange, resetViewport,
  };
}
