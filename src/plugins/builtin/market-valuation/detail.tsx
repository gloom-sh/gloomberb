import { useMemo } from "react";
import type { StatItem } from "../../../components/ui";
import { Box } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { historySpanStat, sinceLabel } from "../shared/history-span";
import { SeriesDetailChart } from "../shared/series-detail-chart";
import { valuationAxis, zoneSeriesFor } from "./chart-projection";
import type { IndicatorViewModel } from "./view";
import { ZoneColorScale } from "./zone-scale";

function formatTrillions(billions: number): string {
  return `${formatNumber(billions / 1000, 1)}T`;
}

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
    // The whole history's, whatever the range the chart shows.
    { id: "ath", label: sinceLabel("High", view.historyStart), value: indicator.formatValue(view.allTimeHigh.ratio), detail: view.allTimeHigh.date },
    { id: "atl", label: sinceLabel("Low", view.historyStart), value: indicator.formatValue(view.allTimeLow.ratio), detail: view.allTimeLow.date },
    // A range longer than the history shows all of it, from where it starts.
    ...[historySpanStat(view.span)].filter((item): item is StatItem => item !== null),
  ], [indicator, levels, view]);
  const showZoneScale = view.current.ratio != null && !!view.zone;

  const visible = view.chart.sourcePoints;
  // One line per valuation band, so the chart carries the zone colours.
  const zones = useMemo(() => zoneSeriesFor(indicator, visible), [indicator, visible]);

  return (
    <SeriesDetailChart
      stats={stats}
      width={width}
      height={height}
      focused={focused}
      points={visible}
      drawable={view.chart.points.length >= 2}
      lines={zones}
      axis={valuationAxis(indicator)}
      mean={view.mean}
      meanLabel={sinceLabel("mean", view.historyStart)}
      reference={indicator.reference}
      resetKey={`${indicator.id}:${view.range}`}
      formatValue={indicator.formatValue}
      aboveChartRows={showZoneScale ? ZONE_SCALE_ROWS : 0}
      aboveChart={showZoneScale ? (chartWidth) => (
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
      ) : undefined}
    />
  );
}
