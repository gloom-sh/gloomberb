import { memo, useMemo } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { colors } from "../../../theme/colors";
import { clamp } from "../../../utils/math";
import type { SeriesAxisTag } from "./panel-labels";
import { placeSeriesAxisTags, SeriesAxisTags } from "./series-axis-tags";
import type { ChartMouseEvent } from "../core/pointer";

function formatAxisCell(label: string | null, width: number): string {
  if (width <= 0) return "";
  if (!label) return " ".repeat(width);
  // A clipped numeric prefix can change both magnitude and currency. If a
  // constrained chart cannot fit the complete label, show no partial value.
  return ([...label].length > width ? "…" : label).padStart(width);
}

interface PriceAxisMarker {
  row: number;
  pixelY: number;
  label: string;
  color: string;
}

interface PriceAxisLabelsProps {
  axisLabels: ReadonlyMap<number, string>;
  /** Tick labels at their exact heights, where the host can place text between rows. */
  axisTicks?: readonly { ratio: number; label: string }[];
  axisWidth: number;
  axisSectionWidth: number;
  side?: "left" | "right";
  height: number;
  cursorRow: number | null;
  cursorPixelY?: number | null;
  cursorLabel: string | null;
  cursorColor: string;
  cursorBackgroundColor?: string;
  axisColor?: string;
  /** Anchors that stay put while the cursor moves, such as a measure start. */
  extraMarkers?: readonly PriceAxisMarker[];
  /** Desktop/web observations, separate from a drawing tool's endpoint. */
  seriesTags?: readonly SeriesAxisTag[];
  measuredPixelHeight?: number;
  /** A value axis the pointer stretches and squeezes: a drag or the wheel on it, a double click back. */
  gestures?: PriceAxisGestures;
  /** A button sits at the foot of the axis (Auto, while scaled by hand): tick labels make room for it. */
  footButton?: boolean;
}

/** The button at the foot of an axis sits this far above its bottom edge (`--gloom-space-xs`). */
const FOOT_BUTTON_INSET_PX = 4;

interface PriceAxisGestures {
  onMouseDown: (event: ChartMouseEvent) => void;
  onMouseDrag: (event: ChartMouseEvent) => void;
  onMouseUp: (event: ChartMouseEvent) => void;
  onMouseDragEnd: (event: ChartMouseEvent) => void;
  onMouseScroll: (event: ChartMouseEvent) => void;
}

interface CursorPriceAxisOverlay {
  labelText: string | null;
  topPercent: number | null;
}

export function buildCursorPriceAxisOverlay({
  axisWidth,
  height,
  cursorPixelY,
  cursorLabel,
  cellHeightPx,
}: {
  axisWidth: number;
  axisSectionWidth: number;
  height: number;
  cursorPixelY: number | null | undefined;
  cursorLabel: string | null;
  cellHeightPx: number;
}): CursorPriceAxisOverlay {
  const labelText = cursorLabel === null
    ? null
    : formatAxisCell(cursorLabel, axisWidth).trimStart();
  const pixelHeight = Math.max(height * cellHeightPx, 1);
  let topPercent: number | null = null;

  if (labelText && cursorPixelY !== null && cursorPixelY !== undefined && Number.isFinite(cursorPixelY) && pixelHeight > 1) {
    const halfLabelHeight = Math.min(cellHeightPx / 2, (pixelHeight - 1) / 2);
    const topPx = clamp(cursorPixelY, halfLabelHeight, Math.max(pixelHeight - halfLabelHeight, halfLabelHeight));
    topPercent = (topPx / Math.max(pixelHeight - 1, 1)) * 100;
  }

  return { labelText, topPercent };
}

interface PlacedAxisTick {
  label: string;
  ratio: number;
  topPercent: number;
}

/**
 * Tick labels at their exact heights, a line apart. Hosts that do not snap to
 * rows can squeeze ticks closer than the text is tall in a short panel, so the
 * inner ones thin out while the top and bottom stay; any left within a line of
 * the cursor or an anchor badge give way to it.
 */
export function placeAxisTicks({
  ticks,
  height,
  cellHeightPx,
  badgeCentersPx = [],
}: {
  ticks: readonly { ratio: number; label: string }[];
  height: number;
  cellHeightPx: number;
  badgeCentersPx?: readonly number[];
}): PlacedAxisTick[] {
  const pixelHeight = Math.max(height * cellHeightPx, 1);
  const halfLabel = Math.min(cellHeightPx / 2, (pixelHeight - 1) / 2);
  const placed = ticks
    .map((tick) => ({
      label: tick.label,
      ratio: tick.ratio,
      topPx: clamp(tick.ratio * (pixelHeight - 1), halfLabel, Math.max(pixelHeight - halfLabel, halfLabel)),
    }))
    .sort((left, right) => left.topPx - right.topPx);
  const first = placed[0];
  const last = placed[placed.length - 1];
  const kept = first ? [first] : [];
  for (const tick of placed.slice(1, -1)) {
    if (tick.topPx - kept[kept.length - 1]!.topPx >= cellHeightPx && last!.topPx - tick.topPx >= cellHeightPx) {
      kept.push(tick);
    }
  }
  if (last && last !== first && last.topPx - kept[kept.length - 1]!.topPx >= cellHeightPx) kept.push(last);
  return kept
    .filter((tick) => badgeCentersPx.every((center) => Math.abs(tick.topPx - center) >= cellHeightPx))
    .map((tick) => ({
      label: tick.label,
      ratio: tick.ratio,
      topPercent: (tick.topPx / Math.max(pixelHeight - 1, 1)) * 100,
    }));
}

export function PriceAxisLabels({
  axisLabels,
  axisTicks,
  axisWidth,
  axisSectionWidth,
  side,
  height,
  cursorRow,
  cursorPixelY = null,
  cursorLabel,
  cursorColor,
  cursorBackgroundColor = colors.bg,
  axisColor = colors.textDim,
  extraMarkers,
  seriesTags,
  measuredPixelHeight,
  gestures,
  footButton = false,
}: PriceAxisLabelsProps) {
  const { cellHeightPx = 18, fractionalViewport = false, nativePaneChrome } = useUiCapabilities();
  const overlay = useMemo(() => buildCursorPriceAxisOverlay({
    axisWidth,
    axisSectionWidth,
    height,
    cursorPixelY,
    cursorLabel,
    cellHeightPx,
  }), [axisSectionWidth, axisWidth, cellHeightPx, cursorLabel, cursorPixelY, height]);
  const usePixelOverlay = fractionalViewport && overlay.labelText !== null && overlay.topPercent !== null;
  // Row-snapped labels drift up to a row off the gridlines they name.
  const usePixelTicks = fractionalViewport && axisTicks !== undefined;
  const pixelHeight = Math.max(measuredPixelHeight ?? height * cellHeightPx, 1);
  const placedSeriesTags = useMemo(
    () => seriesTags ? placeSeriesAxisTags(seriesTags, pixelHeight, cellHeightPx) : [],
    [cellHeightPx, pixelHeight, seriesTags],
  );
  const lanes = Math.max(1, ...placedSeriesTags.map((tag) => tag.lane + 1));
  // Fixed reference labels yield to observations, never the other way round.
  const visibleMarkers = extraMarkers?.filter((marker) => placedSeriesTags.every((tag) => Math.abs(tag.centerY - marker.pixelY) >= cellHeightPx));
  const placedTicks = usePixelTicks
    ? placeAxisTicks({
      ticks: axisTicks,
      height,
      cellHeightPx,
      badgeCentersPx: [
        ...(usePixelOverlay ? [(overlay.topPercent! / 100) * (pixelHeight - 1)] : []),
        ...(visibleMarkers?.map((marker) => marker.pixelY) ?? []),
        ...placedSeriesTags.map((tag) => tag.centerY),
        ...(footButton ? [pixelHeight - FOOT_BUTTON_INSET_PX - cellHeightPx / 2] : []),
      ],
    })
    : null;
  const axisPaddingWidth = Math.max(0, axisSectionWidth - axisWidth);
  const axisLabelJustify = side === "left"
    ? "flex-end"
    : side === "right"
      ? "flex-start"
      : fractionalViewport
        ? "flex-start"
        : "flex-end";

  const placedStyle = usePixelOverlay || usePixelTicks ? { position: "relative", height: "auto", alignSelf: "stretch" } : undefined;
  return (
    <Box
      width={axisSectionWidth}
      height={height}
      flexDirection="column"
      overflow="hidden"
      // Labels placed in percentages follow the row's height as a resize
      // draws the chart at a new size between renders.
      style={gestures && nativePaneChrome ? { ...placedStyle, cursor: "ns-resize" } : placedStyle}
      {...gestures}
      data-gloom-interactive={gestures ? "true" : undefined}
      data-gloom-role={side ? "composite-chart-value-axis" : undefined}
      data-gloom-side={side}
    >
      {Array.from({ length: height }, (_, row) => {
        const isCursorRow = !usePixelOverlay && cursorLabel !== null && cursorRow === row;
        const marker = usePixelOverlay || usePixelTicks
          ? undefined
          : extraMarkers?.find((entry) => entry.row === row);
        const label = isCursorRow
          ? cursorLabel
          : marker?.label ?? (usePixelTicks || (footButton && row === height - 1) ? null : axisLabels.get(row) ?? null);
        return (
          <AxisRow
            key={row}
            label={label}
            fg={isCursorRow ? cursorColor : marker ? marker.color : axisColor}
            side={side}
            axisWidth={axisWidth}
            axisSectionWidth={axisSectionWidth}
            fractional={fractionalViewport}
            justify={axisLabelJustify}
          />
        );
      })}
      {placedTicks ? placedTicks.map((tick) => (
        <AxisTick
          key={`${tick.label}:${tick.ratio}`}
          label={tick.label}
          topPercent={tick.topPercent}
          color={axisColor}
          axisWidth={axisWidth}
          axisSectionWidth={axisSectionWidth}
          justify={axisLabelJustify}
        />
      )) : null}
      {usePixelOverlay || usePixelTicks ? visibleMarkers?.map((marker) => (
        <Box
          key={`${marker.label}:${marker.pixelY}`}
          width={axisSectionWidth}
          bg={cursorBackgroundColor}
          flexDirection="row"
          style={{
            position: "absolute",
            left: 0,
            top: `${(marker.pixelY / Math.max(height * cellHeightPx - 1, 1)) * 100}%`,
            transform: "translateY(-50%)",
            whiteSpace: "pre",
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          <Box flexDirection="row" width={axisWidth} justifyContent={axisLabelJustify} overflow="hidden">
            <Text fg={marker.color} selectable={false}>{formatAxisCell(marker.label, axisWidth).trimStart()}</Text>
          </Box>
          {axisPaddingWidth > 0 ? <Box width={axisPaddingWidth} /> : null}
        </Box>
      )) : null}
      {seriesTags ? <SeriesAxisTags placed={placedSeriesTags} pixelHeight={pixelHeight} lanes={lanes} background={cursorBackgroundColor} /> : null}
      {usePixelOverlay ? (
        <Box
          width={axisSectionWidth}
          bg={cursorBackgroundColor}
          flexDirection="row"
          data-gloom-role="chart-price-axis-cursor"
          style={{
            position: "absolute",
            left: 0,
            top: `${overlay.topPercent}%`,
            transform: "translateY(-50%)",
            whiteSpace: "pre",
            pointerEvents: "none",
            // The value under the pointer reads whole, over a series' tag at that height.
            zIndex: 3,
          }}
        >
          <Box flexDirection="row" width={axisWidth} justifyContent={axisLabelJustify} overflow="hidden">
            <Text fg={cursorColor} selectable={false}>{overlay.labelText}</Text>
          </Box>
          {axisPaddingWidth > 0 ? <Box width={axisPaddingWidth} /> : null}
        </Box>
      ) : null}
    </Box>
  );
}

type AxisLabelJustify = "flex-start" | "flex-end";

/**
 * One row of the axis, with its label or none. A row only renders when its
 * label does: the cursor's moving down the axis renders the rows it leaves
 * and lands on, not the column.
 */
const AxisRow = memo(function AxisRow({ label, fg, side, axisWidth, axisSectionWidth, fractional, justify }: {
  label: string | null;
  fg: string;
  side: "left" | "right" | undefined;
  axisWidth: number;
  axisSectionWidth: number;
  fractional: boolean;
  justify: AxisLabelJustify;
}) {
  const formatted = formatAxisCell(label, axisWidth);
  const text = side === "right" ? formatted.trimStart().padEnd(axisWidth) : formatted;
  const axisPaddingWidth = Math.max(0, axisSectionWidth - axisWidth);
  return (
    <Box height={1}>
      {fractional ? (
        <Box flexDirection="row" width={axisSectionWidth} height={1}>
          <Box flexDirection="row" width={axisWidth} justifyContent={justify} overflow="hidden">
            {label ? <Text fg={fg} selectable={false}>{text.trim()}</Text> : null}
          </Box>
          {axisPaddingWidth > 0 ? <Box width={axisPaddingWidth} /> : null}
        </Box>
      ) : (
        <Text fg={fg} selectable={false}>{text.padEnd(axisSectionWidth)}</Text>
      )}
    </Box>
  );
});

/** A tick label at its exact height, which holds still while the cursor moves past. */
const AxisTick = memo(function AxisTick({ label, topPercent, color, axisWidth, axisSectionWidth, justify }: {
  label: string;
  topPercent: number;
  color: string;
  axisWidth: number;
  axisSectionWidth: number;
  justify: AxisLabelJustify;
}) {
  const axisPaddingWidth = Math.max(0, axisSectionWidth - axisWidth);
  return (
    <Box
      width={axisSectionWidth}
      flexDirection="row"
      style={{
        position: "absolute",
        left: 0,
        top: `${topPercent}%`,
        transform: "translateY(-50%)",
        whiteSpace: "pre",
        pointerEvents: "none",
      }}
    >
      <Box flexDirection="row" width={axisWidth} justifyContent={justify} overflow="hidden">
        <Text fg={color} selectable={false}>{label}</Text>
      </Box>
      {axisPaddingWidth > 0 ? <Box width={axisPaddingWidth} /> : null}
    </Box>
  );
});
