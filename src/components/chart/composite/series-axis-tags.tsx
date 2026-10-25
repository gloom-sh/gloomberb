import { Box, Text } from "../../../ui";
import { clamp } from "../../../utils/math";
import type { SeriesAxisTag } from "./panel-labels";

/**
 * Keep every tag. Order is by value height, then authored series order for
 * ties. A forward pass separates neighbours; a backward pass fits the bottom
 * edge. Panels shorter than the readout use parallel lanes, not dropped tags
 * or smaller type. The gutter reserves those lanes before the cursor moves.
 */
export function placeSeriesAxisTags(tags: readonly SeriesAxisTag[], pixelHeight: number, labelHeight: number) {
  const height = Math.max(pixelHeight, labelHeight);
  const capacity = Math.max(1, Math.floor(height / labelHeight));
  const sorted = tags.map((tag, order) => ({ ...tag, order, anchorY: clamp(tag.yRatio, 0, 1) * Math.max(pixelHeight - 1, 0) }))
    .sort((a, b) => a.anchorY - b.anchorY || a.order - b.order);
  const placed: Array<SeriesAxisTag & { anchorY: number; centerY: number; lane: number }> = [];
  for (let start = 0; start < sorted.length; start += capacity) {
    const lane = sorted.slice(start, start + capacity);
    const centers = lane.map((tag) => clamp(tag.anchorY, labelHeight / 2, height - labelHeight / 2));
    for (let i = 1; i < centers.length; i++) centers[i] = Math.max(centers[i]!, centers[i - 1]! + labelHeight);
    if (centers.length) centers[centers.length - 1] = Math.min(centers.at(-1)!, height - labelHeight / 2);
    for (let i = centers.length - 2; i >= 0; i--) centers[i] = Math.min(centers[i]!, centers[i + 1]! - labelHeight);
    lane.forEach((tag, index) => placed.push({ ...tag, centerY: centers[index]!, lane: Math.floor(start / capacity) }));
  }
  return placed;
}

export function SeriesAxisTags({ placed, pixelHeight, lanes, background }: {
  placed: ReturnType<typeof placeSeriesAxisTags>;
  pixelHeight: number;
  lanes: number;
  background: string;
}) {
  const percent = (y: number) => `${100 * y / Math.max(pixelHeight, 1)}%`;
  return placed.map((tag) => {
    const left = tag.side === "left";
    const edge = left ? "right" : "left";
    const inset = `${tag.lane * 100 / lanes}%`;
    return <Box key={tag.seriesId} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* The tick stays at the observation, even when the badge must move. */}
      <Box
        data-gloom-role="chart-series-axis-anchor"
        data-series-id={tag.seriesId}
        style={{ position: "absolute", [edge]: 0, top: percent(tag.anchorY), width: `calc(${inset} + .5em)`, height: 0, borderTop: `1px ${tag.carried ? "dashed" : "solid"} ${tag.color}` }}
      />
      <Box style={{ position: "absolute", [edge]: `calc(${inset} + .25em)`, top: percent(Math.min(tag.anchorY, tag.centerY)), height: percent(Math.abs(tag.centerY - tag.anchorY)), width: 0, borderLeft: `1px solid ${tag.color}` }} />
      <Box
        data-gloom-role="chart-series-axis-tag"
        data-series-id={tag.seriesId}
        data-side={tag.side}
        data-value={tag.value}
        data-carried={tag.carried ? "true" : undefined}
        aria-label={`${tag.seriesLabel}: ${tag.label}${tag.carried ? " (carried)" : ""}`}
        style={{
          position: "absolute", [edge]: inset, top: percent(tag.centerY), transform: "translateY(-50%)",
          // The value sits in a box in its series colour, as a chart level's label does, so nothing
          // beside it can read as the value's sign. A box wider than its lane is clipped, not wrapped.
          width: "max-content", maxWidth: `calc(${100 / lanes}% - ${lanes > 1 ? ".25em" : "0px"})`,
          boxSizing: "border-box", height: "1.5em", lineHeight: "1.5em", paddingInline: ".15em",
          alignItems: left ? "flex-end" : "flex-start", justifyContent: "center", overflow: "hidden",
          // Every badge paints above every leader, including another lane's.
          zIndex: 2, color: tag.color, backgroundColor: background, whiteSpace: "nowrap",
          border: `1px ${tag.carried ? "dashed" : "solid"} ${tag.color}`,
        }}
      >
        <Text fg={tag.color} selectable={false}>{tag.label}</Text>
      </Box>
    </Box>;
  });
}
