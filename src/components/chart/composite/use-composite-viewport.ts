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
  const navigationFrame = useMemo(
    () => buildCompositeNavigationFrame(visibleSeries, marketTimelineSeries, {
      historicalPaddingRatio: allowHistoricalBackfill ? HISTORICAL_PADDING_RATIO : 0,
    }),
    [allowHistoricalBackfill, marketTimelineSeries, visibleSeries],
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

  useEffect(() => {
    previousAuthoredViewportRef.current = viewport ?? null;
    previousViewportResetKeyRef.current = viewportResetKey;
    if (authoredViewportChanged && userViewport) {
      viewportInteractionRef.current = "reset";
      setUserViewport(null);
    }
  }, [authoredViewportChanged, userViewport, viewport, viewportResetKey]);

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
  const zoomViewport = useCallback((zoomFactor: number, anchorRatio = 1) => {
    navigate("zoom", (base, frame) => zoomCompositeViewport(frame, base, zoomFactor, anchorRatio));
  }, [navigate]);
  const setViewportRange = useCallback((range: CompositeViewportRange) => {
    navigate("zoom", (_base, frame) => fitCompositeViewport(frame, range));
  }, [navigate]);
  const resetViewport = useCallback(() => {
    viewportInteractionRef.current = "reset";
    setUserViewport(null);
  }, []);
  return {
    navigationFrame, activeUserViewport, effectiveViewport,
    panViewport, panViewportByRatio, zoomViewport, setViewportRange, resetViewport,
  };
}
