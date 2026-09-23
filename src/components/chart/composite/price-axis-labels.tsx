import { useMemo } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { colors } from "../../../theme/colors";

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
}

interface CursorPriceAxisOverlay {
  labelText: string | null;
  topPercent: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
}: PriceAxisLabelsProps) {
  const { cellHeightPx = 18, fractionalViewport = false } = useUiCapabilities();
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
  const pixelHeight = Math.max(height * cellHeightPx, 1);
  const placedTicks = usePixelTicks
    ? placeAxisTicks({
      ticks: axisTicks,
      height,
      cellHeightPx,
      badgeCentersPx: [
        ...(usePixelOverlay ? [(overlay.topPercent! / 100) * (pixelHeight - 1)] : []),
        ...(extraMarkers?.map((marker) => marker.pixelY) ?? []),
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
  const formatLabel = (label: string | null) => {
    const formatted = formatAxisCell(label, axisWidth);
    return side === "right" ? formatted.trimStart().padEnd(axisWidth) : formatted;
  };
  const renderAxisLabel = (label: string | null, fg: string) => (
    fractionalViewport ? (
      <Box flexDirection="row" width={axisSectionWidth} height={1}>
        <Box flexDirection="row" width={axisWidth} justifyContent={axisLabelJustify} overflow="hidden">
          {label ? <Text fg={fg} selectable={false}>{formatLabel(label).trim()}</Text> : null}
        </Box>
        {axisPaddingWidth > 0 ? <Box width={axisPaddingWidth} /> : null}
      </Box>
    ) : (
      <Text fg={fg} selectable={false}>{formatLabel(label).padEnd(axisSectionWidth)}</Text>
    )
  );

  return (
    <Box
      width={axisSectionWidth}
      height={height}
      flexDirection="column"
      overflow="hidden"
      style={usePixelOverlay || usePixelTicks ? { position: "relative" } : undefined}
    >
      {Array.from({ length: height }, (_, row) => {
        const isCursorRow = !usePixelOverlay && cursorLabel !== null && cursorRow === row;
        const marker = usePixelOverlay || usePixelTicks
          ? undefined
          : extraMarkers?.find((entry) => entry.row === row);
        const label = isCursorRow
          ? cursorLabel
          : marker?.label ?? (usePixelTicks ? null : axisLabels.get(row) ?? null);
        return (
          <Box key={row} height={1}>
            {renderAxisLabel(
              label,
              isCursorRow ? cursorColor : marker ? marker.color : axisColor,
            )}
          </Box>
        );
      })}
      {placedTicks ? placedTicks.map((tick) => {
        return (
          <Box
            key={`${tick.label}:${tick.ratio}`}
            width={axisSectionWidth}
            flexDirection="row"
            style={{
              position: "absolute",
              left: 0,
              top: `${tick.topPercent}%`,
              transform: "translateY(-50%)",
              whiteSpace: "pre",
              pointerEvents: "none",
            }}
          >
            <Box flexDirection="row" width={axisWidth} justifyContent={axisLabelJustify} overflow="hidden">
              <Text fg={axisColor} selectable={false}>{tick.label}</Text>
            </Box>
            {axisPaddingWidth > 0 ? <Box width={axisPaddingWidth} /> : null}
          </Box>
        );
      }) : null}
      {usePixelOverlay || usePixelTicks ? extraMarkers?.map((marker) => (
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
      {usePixelOverlay ? (
        <Box
          width={axisSectionWidth}
          bg={cursorBackgroundColor}
          flexDirection="row"
          style={{
            position: "absolute",
            left: 0,
            top: `${overlay.topPercent}%`,
            transform: "translateY(-50%)",
            whiteSpace: "pre",
            pointerEvents: "none",
            zIndex: 1,
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
