import { Box, Text, useUiCapabilities } from "../../../ui";
import { colors as themeColors } from "../../../theme/colors";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import type { ResolvedSeries } from "../../../time-series/types";
import { formatCompositeCarriedStamp, formatCompositePointDetails } from "./format";
import { CompositeSeriesSwatch, formatLegendSeriesValue, withoutListingExchange } from "./legend";
import type { SeriesLineCue } from "./series-cues";
import type { CompositeChartColors, CompositeChartProps, CompositeChartScene } from "./types";

/** A label this long or longer is cut; the legend above keeps the whole name. */
const MAX_LABEL_CELLS = 24;
/** Clear space between the crosshair and the readout beside it, px. */
const CROSSHAIR_GAP_PX = 14;
/** A row's swatch and its margin, and the box's padding and border, px. */
const SWATCH_PX = 22;
const BOX_CHROME_PX = 18;
const NO_LINE_CUES: ReadonlyMap<string, SeriesLineCue> = new Map();

interface ReadoutRow {
  series: ResolvedSeries;
  label: string;
  value: string;
  carried: string | null;
  /** The row in full, with the observation's dates and source: what the legend's entry says for it. */
  detail: string;
}

/**
 * Every series' value at the crosshair, beside it: desktop and web, where the
 * legend keeps the latest values. One row per line in the legend's order, in
 * the line's own unit; a value carried from an earlier observation is dimmed
 * and says when it is from. The time is the time axis's, under the cursor.
 */
export function CompositeCrosshairReadout({
  scene,
  series,
  visibleSeriesIds,
  lineCues = NO_LINE_CUES,
  formatValue,
  colors,
  plotWidth,
  left,
  right,
  top,
}: {
  scene: CompositeChartScene;
  series: readonly ResolvedSeries[];
  visibleSeriesIds: ReadonlySet<string>;
  lineCues?: ReadonlyMap<string, SeriesLineCue>;
  formatValue: CompositeChartProps["formatValue"];
  colors: CompositeChartColors;
  /** The plot's width in cells; the box is placed by CSS in the width the plot has, a fraction of a cell more. */
  plotWidth: number;
  /** The plot's inset from the chart's edges, in cells. */
  left: number;
  right: number;
  top: number;
}) {
  const { cellWidthPx = 8 } = useUiCapabilities();
  const cursorDate = scene.cursorDate;
  const cursorXRatio = scene.cursorXRatio;
  if (!cursorDate || cursorXRatio === null) return null;
  const values = new Map(scene.cursorValues.map((entry) => [entry.seriesId, entry] as const));
  const rows: ReadoutRow[] = series.flatMap((entry) => {
    const cursor = values.get(entry.id);
    if (!cursor || entry.hidden || !visibleSeriesIds.has(entry.id)) return [];
    const label = withoutListingExchange(entry.label);
    const value = formatLegendSeriesValue(entry, cursor.value, formatValue, scene);
    const carried = cursor.carried && cursor.value != null && cursor.point
      ? formatCompositeCarriedStamp(cursor.point.date, cursorDate, scene.timeZone)
      : null;
    return [{
      series: entry,
      label: displayWidth(label) > MAX_LABEL_CELLS ? truncateToDisplayWidth(label, MAX_LABEL_CELLS) : label,
      value,
      carried,
      detail: [`${entry.label} ${value}${carried ? ` ${carried}` : ""}`, formatCompositePointDetails(cursor.point)].filter(Boolean).join(" · "),
    }];
  });
  if (rows.length === 0) return null;
  const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label)));
  // Beside the crosshair on the side with room for it, by the width its text
  // takes; where neither side has, flush with the plot's edge farthest from it.
  const tailCells = Math.max(...rows.map((row) => displayWidth(row.value) + (row.carried ? 1 + displayWidth(row.carried) : 0)));
  const boxPx = SWATCH_PX + BOX_CHROME_PX + (labelWidth + 1 + tailCells) * cellWidthPx;
  const plotPx = plotWidth * cellWidthPx;
  const cursorPx = Math.max(0, Math.min(1, cursorXRatio)) * plotPx;
  const placement = cursorPx + CROSSHAIR_GAP_PX + boxPx <= plotPx ? "right"
    : cursorPx - CROSSHAIR_GAP_PX - boxPx >= 0 ? "left"
    : cursorXRatio > 0.5 ? "start" : "end";
  const position = placement === "start" ? { left: 0 }
    : placement === "end" ? { right: 0 }
    : {
      left: `${Math.max(0, Math.min(1, cursorXRatio)) * 100}%`,
      transform: placement === "left" ? `translateX(calc(-100% - ${CROSSHAIR_GAP_PX}px))` : `translateX(${CROSSHAIR_GAP_PX}px)`,
    };
  return (
    <Box
      position="absolute"
      left={left}
      top={top}
      zIndex={30}
      style={{
        right: `calc(${right} * var(--cell-w))`,
        width: "auto",
        height: 0,
        pointerEvents: "none",
      }}
    >
      <Box
        flexDirection="column"
        position="absolute"
        data-placement={placement}
        style={{
          ...position,
          top: 6,
          width: "max-content",
          height: "auto",
          padding: "4px 8px",
          gap: 1,
          borderRadius: 4,
          border: `1px solid ${colors.grid}`,
          backgroundColor: `color-mix(in srgb, ${colors.background} 94%, transparent)`,
          whiteSpace: "pre",
        }}
        data-gloom-role="composite-chart-readout"
      >
        {rows.map((row) => (
          <Box
            key={row.series.id}
            flexDirection="row"
            alignItems="center"
            height={1}
            style={{ width: "auto" }}
            data-gloom-role="composite-chart-readout-row"
            data-gloom-label={row.detail}
            data-carried={row.carried ? "true" : undefined}
          >
            <CompositeSeriesSwatch series={row.series} cue={lineCues.get(row.series.id) ?? null} filled={!row.carried} />
            <Box width={labelWidth + 1} height={1} flexShrink={0}>
              <Text fg={colors.textDim}>{row.label}</Text>
            </Box>
            <Text fg={row.carried ? colors.textDim : colors.text}>{row.value}</Text>
            {row.carried ? <Text fg={themeColors.textMuted}>{` ${row.carried}`}</Text> : null}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
