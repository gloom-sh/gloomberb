import { useMemo } from "react";
import { CompositeChart, staticSeries } from "../../../../components";
import { formatChangePercentAxis } from "../../../../components/chart-table/axis";
import type { CompositeChartLevel, CompositeChartLevels } from "../../../../components/chart/composite/levels";
import { BAR_INTERVAL_LABELS } from "../../../../cli/history-rows";
import { useThemeColors } from "../../../../theme/theme-context";
import { CHART_RESOLUTION_STEP_MS, isIntradayResolution, type ManualChartResolution } from "../../../../time-series/resolution";
import type { ChartPanelSpec, ResolvedSeries } from "../../../../time-series/types";
import { formatPercentRaw } from "../../../../utils/format";
import { useRemoteUiNode } from "../../../../remote/semantic-tree";
import { returnClockZone } from "./returns-model";
import type { ReturnBar, ReturnBars } from "./returns-chart-model";

const SERIES_ID = "return";
const PANELS: ChartPanelSpec[] = [{ id: "main" }];
const NO_SERIES: ResolvedSeries[] = [];

/** What the table marks a bar still trading with: `2026-10 MTD`, `2026-10-16 DTD`. */
const FORMING_MARK: Partial<Record<ManualChartResolution, string>> = { "1d": "DTD", "1wk": "WTD", "1mo": "MTD" };

export interface ReturnsChartProps {
  bars: ReturnBars;
  /** The interval the bars are. */
  resolution: ManualChartResolution;
  venue: string | undefined;
  width: number;
  height: number;
  focused: boolean;
  emptyMessage: string;
  emptyDetail?: string;
}

/**
 * RETURN's chart: every interval of the window as a bar from zero, up in the
 * rising colour and down in the falling one, on the composite chart the
 * Chart pane draws with. The best and worst interval and the newest one are
 * levels across the plot with their returns on the axis, and the cursor rests
 * on the newest bar, so the chart reads its date and return until the pointer
 * or the arrows move it.
 */
export function ReturnsChart({ bars, resolution, venue, width, height, focused, emptyMessage, emptyDetail }: ReturnsChartProps) {
  const colors = useThemeColors();
  const series = useMemo<ResolvedSeries[]>(() => {
    if (!bars.latest) return NO_SERIES;
    // Intraday bars read on the venue's clock, as the table's times do; dates stay in UTC.
    const timeZone = (isIntradayResolution(resolution) ? returnClockZone(venue) : null) ?? "UTC";
    return [{
      ...staticSeries(bars.bars.map((bar) => {
        const date = new Date(bar.time);
        return { date, observedAt: date, value: bar.move === null ? null : bar.move * 100 };
      }), {
        id: SERIES_ID,
        label: `${BAR_INTERVAL_LABELS[resolution].replace(/^./, (first) => first.toUpperCase())} return`,
        color: colors.positive,
        negativeColor: colors.negative,
        style: "columns",
      }),
      unit: "%",
      unitGroup: "return",
      historyResolution: resolution,
      // One slot per bar: nights, weekends and holidays take no room.
      timeBasis: { kind: "market", timeZone, cadenceMs: CHART_RESOLUTION_STEP_MS[resolution] },
    }];
  }, [bars, colors.negative, colors.positive, resolution, venue]);

  const levels = useMemo<CompositeChartLevels | null>(() => {
    const { best, worst, latest } = bars;
    const formingMark = bars.forming ? FORMING_MARK[resolution] : undefined;
    const level = (id: string, bar: ReturnBar, label: string | undefined, color: string): CompositeChartLevel => ({
      id,
      value: bar.move! * 100,
      color,
      editable: false,
      actionable: false,
      dashed: true,
      axisLabel: formatChangePercentAxis(bar.move! * 100),
      prioritizeAxisLabel: true,
      ...(label ? { label } : {}),
    });
    const markFor = (bar: ReturnBar, name?: string) => [name, bar.key === latest?.key ? formingMark : undefined].filter(Boolean).join(" ") || undefined;
    const items: CompositeChartLevel[] = [];
    if (best) items.push(level("best", best, markFor(best, "Best"), colors.positive));
    if (worst) items.push(level("worst", worst, markFor(worst, "Worst"), colors.negative));
    if (latest && latest.key !== best?.key && latest.key !== worst?.key) {
      const move = latest.move!;
      items.push(level("latest", latest, markFor(latest), move > 0 ? colors.positive : move < 0 ? colors.negative : colors.textDim));
    }
    return items.length ? { seriesId: SERIES_ID, items } : null;
  }, [bars, colors.negative, colors.positive, colors.textDim, resolution]);

  const latestDate = useMemo(() => bars.latest ? new Date(bars.latest.time) : null, [bars.latest]);
  // A capture counts the bars drawn, as a chart pane's does, not the figures above them.
  const plottedValueCount = useMemo(() => bars.bars.filter((bar) => bar.move !== null).length, [bars.bars]);
  useRemoteUiNode({ role: "chart-data", label: "Rendered returns chart", metadata: { kind: "returns", version: 1, plottedValueCount } });

  return (
    <CompositeChart
      series={series}
      panels={PANELS}
      width={width}
      height={height}
      focused={focused}
      navigable={false}
      // The tab strip keeps the arrows until Down, Enter or a press moves into
      // the chart; then they step the cursor through the bars.
      enterable
      showLegend
      showTimeAxis
      cursorDate={latestDate}
      levels={levels}
      formatAxisValue={formatChangePercentAxis}
      formatValue={(value) => formatPercentRaw(value)}
      emptyMessage={emptyMessage}
      emptyDetail={emptyDetail}
      remoteKind="returns"
    />
  );
}
