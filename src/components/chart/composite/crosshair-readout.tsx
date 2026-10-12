import { Box, Text } from "../../../ui";
import { colors as themeColors } from "../../../theme/colors";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import type { ResolvedSeries } from "../../../time-series/types";
import { formatCompositeCarriedStamp } from "./format";
import { CompositeSeriesSwatch, formatLegendSeriesValue, withoutListingExchange } from "./legend";
import type { SeriesLineCue } from "./series-cues";
import type { CompositeChartColors, CompositeChartProps, CompositeChartScene } from "./types";

/** A label this long or longer is cut; the legend above keeps the whole name. */
const MAX_LABEL_CELLS = 24;
/** Past this share of the plot the readout sits left of the crosshair, so it stays inside it. */
const FLIP_RATIO = 0.55;
const NO_LINE_CUES: ReadonlyMap<string, SeriesLineCue> = new Map();

interface ReadoutRow {
  series: ResolvedSeries;
  label: string;
  value: string;
  carried: string | null;
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
  /** The plot's inset from the chart's edges, in cells. */
  left: number;
  right: number;
  top: number;
}) {
  const cursorDate = scene.cursorDate;
  const cursorXRatio = scene.cursorXRatio;
  if (!cursorDate || cursorXRatio === null) return null;
  const values = new Map(scene.cursorValues.map((entry) => [entry.seriesId, entry] as const));
  const rows: ReadoutRow[] = series.flatMap((entry) => {
    const cursor = values.get(entry.id);
    if (!cursor || entry.hidden || !visibleSeriesIds.has(entry.id)) return [];
    const label = withoutListingExchange(entry.label);
    return [{
      series: entry,
      label: displayWidth(label) > MAX_LABEL_CELLS ? truncateToDisplayWidth(label, MAX_LABEL_CELLS) : label,
      value: formatLegendSeriesValue(entry, cursor.value, formatValue, scene),
      carried: cursor.carried && cursor.value != null && cursor.point
        ? formatCompositeCarriedStamp(cursor.point.date, cursorDate, scene.timeZone)
        : null,
    }];
  });
  if (rows.length === 0) return null;
  const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label)));
  const flip = cursorXRatio > FLIP_RATIO;
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
        style={{
          left: `${Math.max(0, Math.min(1, cursorXRatio)) * 100}%`,
          top: 6,
          width: "max-content",
          height: "auto",
          padding: "4px 8px",
          gap: 1,
          borderRadius: 4,
          border: `1px solid ${colors.grid}`,
          backgroundColor: `color-mix(in srgb, ${colors.background} 94%, transparent)`,
          transform: flip ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
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
