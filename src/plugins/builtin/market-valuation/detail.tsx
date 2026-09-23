import { useMemo, useState } from "react";
import { CompositeChart } from "../../../components/chart/composite";
import { blendHex, colors } from "../../../theme/colors";
import { StatGrid, statGridRows, type StatItem } from "../../../components/ui";
import { Box, Text } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { markerSeries, zoneSeriesFor } from "./chart-projection";
import type { IndicatorViewModel } from "./view";
import { ZoneColorScale } from "./zone-scale";

function formatTrillions(billions: number): string {
  return `${formatNumber(billions / 1000, 1)}T`;
}

const PANELS = [{ id: "main" }];
const AXIS_WIDTH = 8;
const MIN_CHART_ROWS = 8;
/** Zone words, the bar, and its ticks. */
const ZONE_SCALE_ROWS = 3;

/**
 * The selected indicator: its levels and range figures, the zone scale, and a
 * chart filling the rest of the column. The mean is in the chart legend, so it
 * does not repeat among the figures.
 */
export function IndicatorDetail({
  view,
  width,
  height,
  focused = false,
}: {
  view: IndicatorViewModel;
  width: number;
  height: number;
  focused?: boolean;
}) {
  const indicator = view.indicator;
  const levels = indicator.input.kind === "ratio" ? indicator.input.levels : undefined;
  const [userViewport, setUserViewport] = useState<{ start: Date; end: Date } | null>(null);
  const chartWidth = Math.max(24, width);

  const stats = useMemo<StatItem[]>(() => [
    ...(levels && view.current.numeratorBillions != null && view.current.denominatorBillions != null
      ? [
        { id: "numerator", label: levels.numeratorLabel, value: formatTrillions(view.current.numeratorBillions) },
        {
          id: "denominator",
          label: levels.denominatorLabel,
          value: formatTrillions(view.current.denominatorBillions),
          // "GDP as of 2026Q2" sits on the GDP cell, so the label is not said twice.
          detail: view.vintageLabel?.replace(`${levels.denominatorLabel} `, "") || undefined,
        },
      ]
      : []),
    { id: "year-ago", label: "1Y ago", value: view.ratioOneYearAgo == null ? "--" : indicator.formatValue(view.ratioOneYearAgo) },
    { id: "ath", label: "ATH", value: indicator.formatValue(view.allTimeHigh.ratio), detail: view.allTimeHigh.date },
    { id: "atl", label: "ATL", value: indicator.formatValue(view.allTimeLow.ratio), detail: view.allTimeLow.date },
  ], [indicator, levels, view]);
  const statRows = statGridRows(stats, width);
  const showZoneScale = view.current.ratio != null && !!view.zone;
  const chartHeight = Math.max(
    MIN_CHART_ROWS,
    height - statRows - (showZoneScale ? ZONE_SCALE_ROWS : 0),
  );

  const visible = view.chart.sourcePoints;
  const series = useMemo(() => {
    const zones = zoneSeriesFor(indicator, visible);
    const markers = [
      indicator.reference
        ? markerSeries(
          indicator,
          "reference",
          indicator.reference.label,
          indicator.reference.value,
          colors.textDim,
          visible,
        )
        : null,
      markerSeries(
        indicator,
        "mean",
        "mean",
        view.mean,
        blendHex(colors.textDim, colors.bg, 0.35),
        visible,
      ),
    ].filter((entry) => entry != null);
    return [...markers, ...zones];
  }, [indicator, view.mean, visible]);

  // One clean entry instead of a row per valuation band.
  const legendSeries = useMemo(
    () => series.filter((entry) => entry.id === "reference" || entry.id === "mean"),
    [series],
  );

  const viewport = useMemo(() => {
    if (userViewport) return userViewport;
    if (visible.length < 2) return undefined;
    return { start: new Date(visible[0]!.date), end: new Date(visible.at(-1)!.date) };
  }, [userViewport, visible]);

  return (
    <Box flexDirection="column" width={width}>
      <StatGrid items={stats} width={width} />
      {view.chart.points.length >= 2 ? (
        <>
          {showZoneScale ? (
            // A value scale, not the chart's time axis: it takes the pane inset
            // like the legend under it rather than guessing the axis width.
            <Box width={chartWidth} paddingX={1} overflow="hidden">
              <ZoneColorScale
                indicator={indicator}
                value={view.current.ratio!}
                width={Math.max(1, chartWidth - 2)}
                markerColor={view.zone!.color}
              />
            </Box>
          ) : null}
          <CompositeChart
            series={series}
            legendSeries={legendSeries}
            panels={PANELS}
            width={chartWidth}
            height={chartHeight}
            focused={focused}
            interactive
            axisWidth={AXIS_WIDTH}
            showLegend
            viewport={viewport}
            viewportResetKey={`${indicator.id}:${view.range}`}
            onViewportChange={setUserViewport}
            formatValue={(value) => indicator.formatValue(value)}
            emptyMessage="Not enough chart data"
          />
        </>
      ) : (
        <Box height={chartHeight} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>Not enough chart data</Text>
        </Box>
      )}
    </Box>
  );
}
