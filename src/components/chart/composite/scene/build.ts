// Builds a composite chart scene from resolved series and panel specs: the
// time scale, the panels with their axes and projected series, and the cursor.
import type { ChartPanelSpec, ResolvedSeries } from "../../../../time-series/types";
import type {
  BuildCompositeChartSceneOptions,
  CompositeAxisDomain,
  CompositeAxisSide,
  CompositePanelScene,
  CompositeChartScene,
} from "../types";
import {
  buildCompositeTimeScale,
  COMPOSITE_RIGHT_OFFSET_RATIO,
  compositeTimeProjector,
  projectCompositeTimestamp,
  unprojectCompositeTimestamp,
} from "../time-scale";
import { extendedHoursSpans, isIntradaySeries } from "../session-shading";
import { listingTimeZone } from "../../../../market-data/market/trading-sessions";
import { valueScaleSlot } from "../value-scale";
import { buildCursorValues, nearestDate } from "./cursor";
import { buildAxisDomain } from "./domain";
import { attachLastPriceMarker, attachPriorClose, attachVolumeProfile } from "./markers";
import { allocateCompositePanelHeights, panelSpecsForSeries } from "./panels";
import {
  hasDrawableValue,
  heikinAshiPoints,
  isMarketObservationSeries,
  normalizedSourcePoints,
} from "./points";
import { projectSeries } from "./projection";
import { explicitViewport, mergeSortedTimestamps, scopeSeriesToViewport, timestampsOf } from "./timeline";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The zone intraday market bars read in: the venue's own clock, as the tape
 * does. Daily and longer bars carry dates, which stay in UTC.
 */
function sceneTimeZone(anchor: ResolvedSeries | undefined, series: readonly ResolvedSeries[]): string | undefined {
  const market = anchor ?? series.find((entry) => entry.observationKind === "market");
  if (!market || !isIntradaySeries(market)) return undefined;
  const zone = market.timeBasis?.timeZone
    ?? (market.listing ? listingTimeZone(market.listing.symbol, market.listing.exchange) : null);
  return zone && zone !== "UTC" ? zone : undefined;
}

export function buildCompositeChartScene(
  series: ResolvedSeries[],
  panels: ChartPanelSpec[],
  options: BuildCompositeChartSceneOptions,
): CompositeChartScene | null {
  const dataSeries = series
    .map((entry) => entry.style === "heikin-ashi" ? { ...entry, points: heikinAshiPoints(entry.points) } : entry)
    .filter(hasDrawableValue);
  if (dataSeries.length === 0) return null;

  // A known missing observation owns a date even though it has no drawable
  // value. Retain it in the window and cursor timeline, including trailing gaps.
  const uniqueTimes = mergeSortedTimestamps(dataSeries.map((entry) => timestampsOf(normalizedSourcePoints(entry))));
  if (uniqueTimes.length === 0) return null;
  const firstTime = uniqueTimes[0]!;
  const lastTime = uniqueTimes.at(-1)!;
  const viewport = explicitViewport(options);
  const startTime = viewport?.startTime ?? (firstTime === lastTime ? firstTime - DAY_MS / 2 : firstTime);
  const endTime = viewport?.endTime ?? (firstTime === lastTime ? lastTime + DAY_MS / 2 : lastTime);
  const timelineSeries = options.timelineSeries?.some((entry) => (
    entry.timeBasis?.kind === "market" && entry.points.length > 0
  )) ? options.timelineSeries : dataSeries;
  const timeScale = buildCompositeTimeScale(
    timelineSeries,
    startTime,
    endTime,
    options.rightOffsetRatio ?? COMPOSITE_RIGHT_OFFSET_RATIO,
  );
  // The plot reaches past the viewport by the reserved right offset. Panned
  // back into history that space holds real observations, so navigation and
  // the cursor follow the drawn edge rather than the viewport end.
  const plotEndTime = options.clipToViewport ? endTime : Math.max(endTime, unprojectCompositeTimestamp(timeScale, 1));
  // A step holds its level to the newest observation and no further: the space
  // reserved after it stays empty. With data still ahead of the window, the
  // level runs to the drawn edge instead.
  const stepTrailingTime = Math.min(plotEndTime, Math.max(lastTime, endTime));
  const scopedSeries = viewport
    ? dataSeries.flatMap((entry) => scopeSeriesToViewport(entry, startTime, endTime, timeScale, options.clipToViewport === true) ?? [])
    : dataSeries;
  // A range without observations still has a chart: keep the panels, axes and
  // grid and simply draw no points, instead of blanking the whole surface.
  const emptyRange = scopedSeries.length === 0;
  const usableSeries = emptyRange
    ? dataSeries.map((entry) => ({ ...entry, points: [] }))
    : scopedSeries;
  const visibleTimes = uniqueTimes.filter((time) => time >= startTime && time <= plotEndTime);
  const marketTimes = timeScale.kind === "market"
    // The first market controls session spacing, but every plotted market
    // observation must remain inspectable. Other exchanges can trade before
    // or after its anchors. Nonmarket source dates stay excluded: filings
    // retain their availability-based placement on eligible market slots.
    ? mergeSortedTimestamps([
      timeScale.anchors.map(({ timestamp }) => timestamp),
      ...scopedSeries.filter(isMarketObservationSeries)
        .map((entry) => timestampsOf(normalizedSourcePoints(entry)
          .filter(({ value, point }) => value !== null || point.provenance?.priceHistoryIntegrity))),
    ]).filter((time) => time >= startTime && time <= plotEndTime)
    : [];
  const cursorTimes = timeScale.kind === "market" ? marketTimes : visibleTimes;
  const dates = (cursorTimes.length > 0
    ? cursorTimes
    : viewport
      ? [...new Set([startTime, endTime])]
      : uniqueTimes
  ).map((time) => new Date(time));
  const projectDate = compositeTimeProjector(timeScale);
  const dateRatios = dates.map((date) => projectDate(date.getTime())?.ratio ?? 0);
  const requestedCursor = options.cursorDate ?? null;
  const cursorDate = requestedCursor ? nearestDate(dates, requestedCursor) : null;
  const cursorXRatio = cursorDate
    ? projectCompositeTimestamp(timeScale, cursorDate.getTime())?.ratio ?? null
    : null;
  // Panels belong to the authored series, not to whichever of them happen to
  // hold observations right now. A panel that disappears while its data loads
  // reflows every other panel, and the chart jumps again when it comes back.
  const anchor = timeScale.kind === "market"
    ? timelineSeries.find((entry) => entry.id === timeScale.anchorSeriesId)
    : timelineSeries.find((entry) => entry.timeBasis?.kind === "market");
  const extendedHours = extendedHoursSpans(anchor, dates, dateRatios);
  const orderedPanels = panelSpecsForSeries(series, panels);
  const panelHeights = allocateCompositePanelHeights(orderedPanels, options.height);

  const panelScenes: CompositePanelScene[] = orderedPanels.map((panel) => {
    const panelSeries = usableSeries.filter((entry) => entry.panelId === panel.id);
    const scale = panel.scale ?? "linear";
    // With no in-view values, scale the axes to the loaded history rather than
    // the meaningless 0..1 fallback, so the panel keeps its gutter and grid.
    const domainSeries = emptyRange || panelSeries.length === 0
      ? dataSeries.filter((entry) => entry.panelId === panel.id)
      : panelSeries;
    const rows = panelHeights.get(panel.id) ?? 1;
    const left = buildAxisDomain("left", domainSeries, scale, rows, options.valueScales?.[valueScaleSlot(panel.id, "left")], options.referenceLevels);
    const right = buildAxisDomain("right", domainSeries, scale, rows, options.valueScales?.[valueScaleSlot(panel.id, "right")], options.referenceLevels);
    const axes: Partial<Record<CompositeAxisSide, CompositeAxisDomain>> = { left, right };
    return {
      id: panel.id,
      label: panel.label,
      height: panelHeights.get(panel.id) ?? 1,
      scale,
      axes,
      ...(extendedHours.length > 0 ? { extendedHours } : {}),
      series: panelSeries.flatMap((entry) => {
        const domain = axes[entry.axis];
        return domain
          ? [{
            source: entry,
            points: projectSeries(entry, domain, startTime, stepTrailingTime, timeScale),
          }]
          : [];
      }),
    };
  });
  panelScenes.forEach(attachVolumeProfile);
  attachLastPriceMarker(panelScenes, usableSeries);
  attachPriorClose(panelScenes, usableSeries);
  const timeZone = sceneTimeZone(anchor, timelineSeries);

  return {
    width: Math.max(1, Math.floor(options.width)),
    height: panelScenes.reduce((sum, panel) => sum + panel.height, 0),
    startTime,
    endTime,
    timeScale,
    dates,
    dateRatios,
    panels: panelScenes,
    cursorDate,
    cursorXRatio,
    cursorValues: buildCursorValues(panelScenes, cursorDate, { startTime, endTime, timeScale }),
    newestTime: lastTime,
    ...(timeZone ? { timeZone } : {}),
  };
}
