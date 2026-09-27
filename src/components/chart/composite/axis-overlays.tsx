import { Box, Text, useUiCapabilities } from "../../../ui";
import type { CompositeChartXMarker } from "./types";

export interface StaticChartXAxisLabel {
  label: string;
  ratio: number;
  /** Cells the label covers in the fixed-width axis text, end inclusive. */
  start?: number;
  end?: number;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function markerColumn(xRatio: number, width: number): number {
  return Math.round(clampRatio(xRatio) * Math.max(0, width - 1));
}

function alignAxisLabel(label: string, width: number, index: number, count: number): string {
  const clipped = label.length > width ? label.slice(0, width) : label;
  const padding = Math.max(0, width - clipped.length);
  if (index === 0) return clipped.padEnd(width);
  if (index === count - 1) return clipped.padStart(width);
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
}

interface LabelPlacement {
  start: number;
  end: number;
}

/**
 * Terminal ticks sit on whole cells, so neighbours that land within a cell of
 * each other would print as one word ("930D"). Keep the first tick, then each
 * one clear of the last kept by a blank cell, holding room for the final tick.
 */
function dropCollidingLabels<T extends LabelPlacement>(placements: readonly T[]): T[] {
  const sorted = [...placements].sort((left, right) => left.start - right.start);
  const final = sorted[sorted.length - 1];
  const kept: T[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const placement of sorted) {
    if (placement.start <= lastEnd + 1) continue;
    if (placement !== final && kept.length > 0 && final && final.start <= placement.end + 1) continue;
    kept.push(placement);
    lastEnd = placement.end;
  }
  return kept;
}

/**
 * The cursor and anchor badges print over the flow text, so every label they
 * touch, with a blank cell either side, is blanked whole rather than leaving
 * its ends around the badge. A single fixed-width axis text is split by its
 * tick spans; evenly spread labels each count as one.
 */
function blankLabelsUnderBadges(
  segments: readonly string[],
  ticks: readonly StaticChartXAxisLabel[],
  clearOfBadges: (start: number, end: number) => boolean,
): string[] {
  const cells = segments.join("").split("");
  const spans: LabelPlacement[] = [];
  const tickSpans = ticks.filter((tick) => Number.isFinite(tick.start) && Number.isFinite(tick.end));
  if (segments.length === 1 && tickSpans.length > 0) {
    for (const tick of tickSpans) spans.push({ start: tick.start!, end: tick.end! });
  } else {
    let offset = 0;
    for (const segment of segments) {
      const first = segment.search(/\S/);
      if (first >= 0) spans.push({ start: offset + first, end: offset + segment.trimEnd().length - 1 });
      offset += segment.length;
    }
  }
  for (const { start, end } of spans) {
    if (clearOfBadges(start, end + 1)) continue;
    for (let cell = Math.max(0, start); cell <= end && cell < cells.length; cell += 1) cells[cell] = " ";
  }
  let offset = 0;
  return segments.map((segment) => {
    const text = cells.slice(offset, offset + segment.length).join("");
    offset += segment.length;
    return text;
  });
}

export interface StaticXAxisMarker {
  ratio: number;
  label: string;
  color: string;
}

export function StaticXAxisLabels({
  labels,
  positionedLabels,
  width,
  color,
  cursorColumn,
  cursorPixelX,
  cursorLabel,
  cursorColor,
  cursorBackgroundColor,
  extraMarkers,
}: {
  labels: string[];
  positionedLabels?: readonly StaticChartXAxisLabel[];
  width: number;
  color?: string;
  cursorColumn?: number | null;
  cursorPixelX?: number | null;
  cursorLabel?: string | null;
  cursorColor?: string;
  cursorBackgroundColor?: string;
  /** Anchors that stay put while the cursor moves, such as a measure start. */
  extraMarkers?: readonly StaticXAxisMarker[];
}) {
  const { cellWidthPx = 8, fractionalViewport = false, nativePaneChrome } = useUiCapabilities();
  const visibleLabels = labels.filter(Boolean);
  const visiblePositionedLabels = positionedLabels?.filter((entry) => (
    entry.label.length > 0 && Number.isFinite(entry.ratio)
  )) ?? [];
  if (visibleLabels.length === 0 && visiblePositionedLabels.length === 0) return null;
  if (width <= 0) return null;
  const segmentCount = Math.max(visibleLabels.length, 1);
  const baseWidth = Math.floor(width / segmentCount);
  const remainder = width - baseWidth * segmentCount;
  const clippedCursorLabel = cursorLabel ? cursorLabel.slice(0, width) : null;
  const cursorLabelWidth = clippedCursorLabel?.length ?? 0;
  const usePixelOverlay = fractionalViewport
    && clippedCursorLabel !== null
    && cursorPixelX !== null
    && cursorPixelX !== undefined
    && Number.isFinite(cursorPixelX)
    && cursorLabelWidth > 0;
  const pixelWidth = Math.max(width * cellWidthPx, 1);
  const halfCursorLabelWidthPx = Math.min((cursorLabelWidth * cellWidthPx) / 2, (pixelWidth - 1) / 2);
  const cursorLeftPercent = usePixelOverlay
    ? (
      Math.max(
        halfCursorLabelWidthPx,
        Math.min(cursorPixelX!, Math.max(pixelWidth - halfCursorLabelWidthPx, halfCursorLabelWidthPx)),
      ) / Math.max(pixelWidth - 1, 1)
    ) * 100
    : null;
  const cursorLeft = cursorColumn !== null
    && cursorColumn !== undefined
    && Number.isFinite(cursorColumn)
    && cursorLabelWidth > 0
    ? Math.max(0, Math.min(Math.max(0, width - cursorLabelWidth), Math.round(cursorColumn) - Math.floor(cursorLabelWidth / 2)))
    : null;
  const isDesktop = nativePaneChrome === true;
  const extraMarkerLeft = (label: string, ratio: number) => (
    Math.max(0, Math.min(width - label.length, Math.round(ratio * (width - 1)) - Math.floor(label.length / 2)))
  );
  // Where the cursor and anchor badges sit, in cells. A tick label under one
  // steps aside instead of showing its ends around the badge.
  const badgeSpans: Array<readonly [number, number]> = [];
  if (clippedCursorLabel && cursorLeftPercent !== null) {
    const center = (cursorLeftPercent / 100) * width;
    badgeSpans.push([center - cursorLabelWidth / 2, center + cursorLabelWidth / 2]);
  } else if (clippedCursorLabel && cursorLeft !== null) {
    badgeSpans.push([cursorLeft, cursorLeft + cursorLabelWidth]);
  }
  for (const marker of extraMarkers ?? []) {
    const label = marker.label.slice(0, width);
    if (label.length === 0) continue;
    const ratio = clampRatio(marker.ratio);
    const left = fractionalViewport ? ratio * width - label.length / 2 : extraMarkerLeft(label, ratio);
    badgeSpans.push([left, left + label.length]);
  }
  const clearOfBadges = (start: number, end: number) => badgeSpans.every(([badgeStart, badgeEnd]) => (
    end + 1 <= badgeStart || start >= badgeEnd + 1
  ));
  const placedPositionedLabels = visiblePositionedLabels.flatMap((entry, index) => {
    const ratio = clampRatio(entry.ratio);
    const labelWidth = entry.label.length;
    const halfLabel = labelWidth / 2;
    let start: number;
    let edgeStyle: Record<string, number | string>;
    if (!isDesktop) {
      start = Math.max(0, Math.min(width - labelWidth, markerColumn(ratio, width) - Math.floor(labelWidth / 2)));
      edgeStyle = { left: start };
    } else if (ratio * width <= halfLabel + 1) {
      // A centered label that would reach the left border sits one cell in,
      // on the same inset as the legend above the plot.
      start = 1;
      edgeStyle = { left: "var(--cell-w)" };
    } else if (ratio * width >= width - halfLabel) {
      start = width - labelWidth;
      edgeStyle = { right: 0 };
    } else {
      start = ratio * width - halfLabel;
      edgeStyle = { left: `${ratio * 100}%`, transform: "translateX(-50%)" };
    }
    if (!clearOfBadges(start, start + labelWidth)) return [];
    return [{ entry, index, edgeStyle, start, end: start + labelWidth - 1 }];
  });
  const positionedPlacements = isDesktop
    ? placedPositionedLabels
    : dropCollidingLabels(placedPositionedLabels);
  const segmentWidths = visibleLabels.map((_, index) => baseWidth + (index < remainder ? 1 : 0));
  const flowText = blankLabelsUnderBadges(
    visibleLabels.map((label, index) => alignAxisLabel(label, segmentWidths[index]!, index, visibleLabels.length)),
    visibleLabels.length === 1 ? visiblePositionedLabels : [],
    clearOfBadges,
  );

  return (
    <Box
      width={width}
      height={1}
      flexDirection="row"
      position="relative"
      overflow="hidden"
      data-gloom-role="chart-time-axis"
      data-gloom-label={(visiblePositionedLabels.length > 0
        ? visiblePositionedLabels.map((entry) => entry.label)
        : visibleLabels).join(" ")}
    >
      {visiblePositionedLabels.length > 0 && (isDesktop || visibleLabels.length === 0) ? (
        <Box position="absolute" left={0} top={0} width={width} height={1}>
          {positionedPlacements.map(({ entry, index, edgeStyle }) => {
            return (
              <Text
                key={`${entry.label}:${entry.ratio}:${index}`}
                fg={color}
                selectable={false}
                style={{
                  position: "absolute",
                  top: 0,
                  whiteSpace: "pre",
                  pointerEvents: "none",
                  ...edgeStyle,
                }}
              >
                {entry.label}
              </Text>
            );
          })}
        </Box>
      ) : (
        <Box width={width} height={1} flexDirection="row">
          {visibleLabels.map((label, index) => (
            <Box key={`${label}:${index}`} width={segmentWidths[index]} overflow="hidden">
              <Text fg={color}>{flowText[index]}</Text>
            </Box>
          ))}
        </Box>
      )}
      {extraMarkers?.map((marker) => {
        const label = marker.label.slice(0, width);
        const ratio = clampRatio(marker.ratio);
        if (label.length === 0) return null;
        return (
          <Text
            key={`${marker.label}:${marker.ratio}`}
            fg={marker.color}
            bg={cursorBackgroundColor}
            selectable={false}
            style={fractionalViewport
              ? {
                position: "absolute",
                left: `${ratio * 100}%`,
                top: 0,
                transform: "translateX(-50%)",
                whiteSpace: "pre",
                pointerEvents: "none",
                zIndex: 2,
              }
              : {
                position: "absolute",
                left: extraMarkerLeft(label, ratio),
                top: 0,
                whiteSpace: "pre",
                pointerEvents: "none",
                zIndex: 2,
              }}
          >
            {label}
          </Text>
        );
      })}
      {clippedCursorLabel && (cursorLeftPercent !== null || cursorLeft !== null) ? (
        <Text
          fg={cursorColor}
          bg={cursorBackgroundColor}
          selectable={false}
          style={cursorLeftPercent !== null
            ? {
              position: "absolute",
              left: `${cursorLeftPercent}%`,
              top: 0,
              transform: "translateX(-50%)",
              whiteSpace: "pre",
              pointerEvents: "none",
              zIndex: 3,
            }
            : {
              position: "absolute",
              left: cursorLeft ?? 0,
              top: 0,
              whiteSpace: "pre",
              pointerEvents: "none",
              zIndex: 3,
            }}
        >
          {clippedCursorLabel}
        </Text>
      ) : null}
    </Box>
  );
}

export function StaticXMarkerOverlay({
  markers,
  width,
  height,
  fallbackColor,
}: {
  markers: readonly CompositeChartXMarker[];
  width: number;
  height: number;
  fallbackColor?: string;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const visibleMarkers = markers.filter((marker) => Number.isFinite(marker.xRatio));
  if (visibleMarkers.length === 0 || width <= 0 || height <= 0) return null;

  if (nativePaneChrome) {
    return (
      <Box position="absolute" left={0} top={0} width={width} height={height}>
        {visibleMarkers.map((marker) => (
          <Box
            key={marker.id}
            position="absolute"
            left={`${clampRatio(marker.xRatio) * 100}%`}
            top={0}
            bottom={0}
            width={0}
            zIndex={2}
            style={{
              width: 1,
              transform: "translateX(-0.5px)",
              backgroundColor: marker.color ?? fallbackColor ?? "currentColor",
              opacity: 0.85,
              pointerEvents: "none",
            }}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box position="absolute" left={0} top={0} width={width} height={height}>
      {visibleMarkers.map((marker) => {
        const left = markerColumn(marker.xRatio, width);
        return (
          <Box
            key={marker.id}
            position="absolute"
            left={left}
            top={0}
            width={1}
            height={height}
            flexDirection="column"
            zIndex={2}
          >
            {Array.from({ length: height }, (_, row) => (
              <Text key={row} fg={marker.color}>
                {marker.lineChar ?? "│"}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

export function StaticXMarkerLabels({
  markers,
  width,
  fallbackColor,
}: {
  markers: readonly CompositeChartXMarker[];
  width: number;
  fallbackColor?: string;
}) {
  const visibleMarkers = markers
    .filter((marker) => marker.label && Number.isFinite(marker.xRatio))
    .sort((left, right) => markerColumn(left.xRatio, width) - markerColumn(right.xRatio, width));
  if (visibleMarkers.length === 0 || width <= 0) return null;

  let nextAvailableLeft = 0;
  const placements = visibleMarkers.map((marker) => {
    const label = marker.label ?? "";
    const labelWidth = Math.min(label.length, width);
    const centeredLeft = markerColumn(marker.xRatio, width) - Math.floor(labelWidth / 2);
    let left = Math.max(0, Math.min(Math.max(0, width - labelWidth), centeredLeft));
    left = Math.max(left, nextAvailableLeft);
    if (left + labelWidth > width) {
      left = Math.max(nextAvailableLeft, width - labelWidth);
    }
    nextAvailableLeft = Math.min(width, left + labelWidth + 1);
    return { marker, label, labelWidth, left };
  }).filter((placement) => placement.labelWidth > 0 && placement.left < width);

  return (
    <Box position="relative" width={width} height={1}>
      {placements.map(({ marker, label, labelWidth, left }) => {
        return (
          <Box
            key={marker.id}
            position="absolute"
            left={left}
            top={0}
            width={labelWidth}
            height={1}
            overflow="hidden"
            zIndex={2}
          >
            <Text fg={marker.color ?? fallbackColor}>{label.slice(0, labelWidth)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
