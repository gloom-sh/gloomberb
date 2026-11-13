import { useMemo } from "react";
import { compositeAxisTagFormatter } from "../format";
import { fitAxisLabels, type ProjectedLevel } from "../levels";
import { axisLabelRows } from "../panel-labels";
import { placeAxisTicks } from "../price-axis-labels";
import { compositeAxisTickLabels, renderCompositeAxisText } from "../text-renderer";
import type { CompositeAxisDomain } from "../types";
import type { CompositePanelSurfaceProps } from "./props";
import type { ToolAnchorMarker } from "./tool-readout";

/**
 * Each value axis' grid labels, and the values tagged on it: the last price,
 * the prior close, the levels and a measure's anchor, fitted around each
 * other so no two labels share a row.
 */
export function usePanelAxisMarkers({
  panel,
  colors,
  formatAxisValue,
  leftAxisWidth,
  rightAxisWidth,
  selectedLevelId,
  levelDomain,
  projectedLevels,
  anchorMarker,
  cellHeightPx,
  fractionalViewport,
}: Pick<CompositePanelSurfaceProps, "panel" | "colors" | "formatAxisValue" | "leftAxisWidth" | "rightAxisWidth" | "selectedLevelId"> & {
  levelDomain: CompositeAxisDomain | null;
  projectedLevels: readonly ProjectedLevel[];
  anchorMarker: ToolAnchorMarker | null;
  cellHeightPx: number;
  fractionalViewport: boolean;
}) {
  const leftAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.left, panel.height, leftAxisWidth, "left", formatAxisValue),
    ),
    [formatAxisValue, leftAxisWidth, panel],
  );
  const rightAxisLabels = useMemo(
    () => axisLabelRows(
      renderCompositeAxisText(panel.axes.right, panel.height, rightAxisWidth, "right", formatAxisValue),
    ),
    [formatAxisValue, panel, rightAxisWidth],
  );
  const leftAxisTicks = useMemo(
    () => compositeAxisTickLabels(panel.axes.left, leftAxisWidth, formatAxisValue),
    [formatAxisValue, leftAxisWidth, panel],
  );
  const rightAxisTicks = useMemo(
    () => compositeAxisTickLabels(panel.axes.right, rightAxisWidth, formatAxisValue),
    [formatAxisValue, panel, rightAxisWidth],
  );
  const lastPriceMarker = useMemo(() => {
    const marker = panel.lastPrice;
    const domain = marker ? panel.axes[marker.axis] : undefined;
    if (!marker || !domain) return null;
    return {
      side: marker.axis,
      yRatio: marker.yRatio,
      label: compositeAxisTagFormatter(formatAxisValue)(marker.value, domain),
      color: marker.color,
    };
  }, [formatAxisValue, panel]);
  const priorCloseMarker = useMemo(() => {
    const marker = panel.priorClose;
    const domain = marker ? panel.axes[marker.axis] : undefined;
    if (!marker || !domain) return null;
    return {
      side: marker.axis,
      yRatio: marker.yRatio,
      label: compositeAxisTagFormatter(formatAxisValue)(marker.value, domain),
      color: colors.textDim,
    };
  }, [colors.textDim, formatAxisValue, panel]);
  const levelMarkers = useMemo(() => levelDomain ? [...projectedLevels]
    // The picked level's label first, then alerts', when they compete for room.
    .sort((left, right) => Number(right.level.id === selectedLevelId) - Number(left.level.id === selectedLevelId)
      || Number(left.level.editable) - Number(right.level.editable))
    .map(({ level, yRatio }) => ({
      id: level.id,
      side: levelDomain.side,
      yRatio,
      label: level.axisLabel ?? compositeAxisTagFormatter(formatAxisValue)(level.value, levelDomain),
      color: level.color,
      prioritizeAxisLabel: level.prioritizeAxisLabel,
    })) : [], [formatAxisValue, levelDomain, projectedLevels, selectedLevelId]);
  const buildAxisMarkers = (side: "left" | "right") => {
    if (!panel.axes[side]) return undefined;
    const toAxisMarker = (marker: { id?: string; yRatio: number; label: string; color: string }) => ({
      id: marker.id,
      row: Math.round(marker.yRatio * Math.max(panel.height - 1, 0)),
      pixelY: marker.yRatio * Math.max(panel.height * cellHeightPx - 1, 0),
      label: marker.label,
      color: marker.color,
    });
    const onSide = <T extends { side: string | null }>(marker: T | null): marker is T => (
      !!marker && (marker.side === null || marker.side === side)
    );
    const fixed = [lastPriceMarker, anchorMarker].filter(onSide).map(toAxisMarker);
    // The prior close's label yields to every level's.
    const referenceLabels = levelMarkers.filter((marker) => marker.prioritizeAxisLabel && onSide(marker)).map(toAxisMarker);
    const levelLabels = [...levelMarkers.filter((marker) => !marker.prioritizeAxisLabel), priorCloseMarker].filter(onSide).map(toAxisMarker);
    // A label is a row tall, so close levels would stack into an unreadable
    // pile and hide the last price: each keeps its line, and only the labels
    // with a row to themselves show. Desktop badges sit between rows.
    const grid = fractionalViewport
      ? placeAxisTicks({ ticks: side === "left" ? leftAxisTicks : rightAxisTicks, height: panel.height, cellHeightPx }).map((tick) => ({
        ...toAxisMarker({ yRatio: tick.ratio, label: tick.label, color: colors.textDim }),
        pixelY: tick.topPercent / 100 * Math.max(panel.height * cellHeightPx - 1, 1),
      }))
      : [...(side === "left" ? leftAxisLabels : rightAxisLabels)].map(([row, label]) => ({ id: undefined, row, pixelY: row * cellHeightPx, label, color: colors.textDim }));
    const rowOf = (marker: ReturnType<typeof toAxisMarker>) => fractionalViewport ? marker.pixelY / cellHeightPx : marker.row;
    // Named guides are part of the chart's readout: ordinary ticks yield to
    // them, while a live price or cursor still keeps its place.
    const references = fitAxisLabels(referenceLabels, fixed, rowOf);
    const markers = [
      ...references,
      ...fitAxisLabels(levelLabels, [...references, ...fixed, ...grid], rowOf),
      ...fixed,
    ];
    return markers.length > 0 ? markers : undefined;
  };
  return {
    leftAxisLabels,
    rightAxisLabels,
    leftAxisTicks,
    rightAxisTicks,
    leftAxisMarkers: buildAxisMarkers("left"),
    rightAxisMarkers: buildAxisMarkers("right"),
  };
}
