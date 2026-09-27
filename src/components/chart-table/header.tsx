import { useMemo, type ReactNode } from "react";
import { useThemeColors } from "../../theme/theme-context";
import type { PricePoint } from "../../types/financials";
import type { ChartPanelSpec, ResolvedSeries } from "../../time-series/types";
import { Box, Text } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { CompositeChart } from "../chart/composite";
import type { CompositeAxisDomain } from "../chart/composite/types";
import { PriceSparkline } from "../price-sparkline/view";
import { StatGrid, type StatItem } from "../ui/stat-grid";
import { chartTableLayout, type ChartTableLayout } from "./layout";

const DAY_MS = 86_400_000;
/** Daily series shorter than this still span two weeks, so the axis reads days, not hours. */
const MIN_SPAN_MS = 14 * DAY_MS;
const MAIN_PANEL: ChartPanelSpec[] = [{ id: "main" }];
const STRIP_MIN_SPARKLINE = 8;

/** The one-row stand-in for a chart in a short pane: what it plots, its shape, its latest value. */
export interface ChartStripSpec {
  label: string;
  /** Oldest first. */
  values: readonly number[];
  value: string;
  color?: string;
}

export interface ChartTableChart {
  /** Series the kit chart draws. Their labels are the chart's caption, so name what is plotted. */
  series?: readonly ResolvedSeries[];
  panels?: ChartPanelSpec[];
  /** A chart the kit does not draw itself (a curve, a scatter), given the band's size. */
  render?: (size: { width: number; height: number }) => ReactNode;
  /** Rows a custom chart needs to be readable; below them the band drops to the strip. */
  minRows?: number;
  /** The strip for a custom chart; kit series derive their own. Null keeps no strip. */
  strip?: ChartStripSpec | null;
  /** The legend value, in the table's units. */
  formatValue?: (value: number) => string;
  formatAxisValue?: (value: number, domain: CompositeAxisDomain) => string;
  /** From `useChartTableSelection`, so the table and the chart share one selection. */
  cursorDate?: Date | null;
  onCursorDateChange?: (date: Date | null) => void;
  onActivate?: () => void;
  viewport?: { start: Date; end: Date };
  /** Muted context at the end of the legend row: a window or an as-of date. */
  legendAccessory?: ReactNode;
  legendAccessoryWidth?: number;
  remoteKind?: string;
  /** The history is still loading: the band keeps its rows so the table does not jump. */
  loading?: boolean;
}

export interface ChartTableHeaderProps {
  width: number;
  /** Rows the header and the table share: the same value as the table's `rootHeight`. */
  height: number;
  /** Body rows the table holds. */
  tableRows: number;
  /** Table header rows, plus one when its columns overflow into a scrollbar. */
  tableChromeRows?: number;
  /** A one-row `QueryBar`. */
  query?: ReactNode;
  figures?: readonly StatItem[];
  chart?: ChartTableChart | null;
}

function plottedValues(series: readonly ResolvedSeries[] | undefined): number[] {
  const first = series?.find((entry) => !entry.hidden);
  return (first?.points ?? []).flatMap((point) => (
    point.value != null && Number.isFinite(point.value) ? [point.value] : []
  ));
}

function seriesSpan(series: readonly ResolvedSeries[]): { first: number; last: number } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    for (const point of entry.points) {
      if (point.value == null) continue;
      const time = point.date.getTime();
      if (time < first) first = time;
      if (time > last) last = time;
    }
  }
  return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null;
}

function stripFromSeries(chart: ChartTableChart): ChartStripSpec | null {
  const first = chart.series?.find((entry) => !entry.hidden);
  const values = plottedValues(chart.series);
  const latest = values.at(-1);
  if (!first || latest == null || values.length < 2) return null;
  return {
    label: first.label,
    values,
    value: chart.formatValue ? chart.formatValue(latest) : String(latest),
    color: first.color,
  };
}

/**
 * Label, sparkline and value on one row; the label shortens before the value
 * does. Whatever the figures above already say (the same label, the same
 * value) is left out, so a short pane does not read the latest level twice.
 */
export function ChartStrip({ strip, width, figures = [] }: {
  strip: ChartStripSpec;
  width: number;
  figures?: readonly StatItem[];
}) {
  const colors = useThemeColors();
  const inner = Math.max(0, width - 2);
  const shownValue = figures.some((item) => item.value === strip.value) ? "" : strip.value;
  const shownLabel = figures.some((item) => item.label === strip.label) ? "" : strip.label;
  const valueWidth = shownValue ? displayWidth(shownValue) + 1 : 0;
  const labelRoom = Math.max(0, inner - valueWidth - STRIP_MIN_SPARKLINE - 3);
  const label = truncateToDisplayWidth(shownLabel, Math.min(displayWidth(shownLabel), labelRoom));
  const sparkWidth = Math.max(0, inner - (label ? displayWidth(label) + 1 : 0) - valueWidth - 2);
  const history = useMemo<PricePoint[]>(
    () => strip.values.map((close, index) => ({ date: new Date(index * DAY_MS), close })),
    [strip.values],
  );
  return (
    <Box flexDirection="row" height={1} flexShrink={0} paddingX={1} gap={1} overflow="hidden">
      <Text fg={strip.color ?? colors.text}>●</Text>
      {label ? <Text fg={colors.text}>{label}</Text> : null}
      <Box width={sparkWidth} height={1} flexShrink={0}>
        {sparkWidth >= STRIP_MIN_SPARKLINE
          ? <PriceSparkline priceHistory={history} width={sparkWidth} period="all" color={strip.color} />
          : null}
      </Box>
      {shownValue ? <Text fg={colors.textBright}>{shownValue}</Text> : null}
    </Box>
  );
}

/** Where a pane puts its chart when it wants the kit's layout without the kit's header. */
export function useChartTableLayout(props: ChartTableHeaderProps): ChartTableLayout {
  const { chart } = props;
  const hasChart = !!chart && (!!chart.render || plottedValues(chart.series).length >= 2 || !!chart.loading);
  return chartTableLayout({
    width: props.width,
    height: props.height,
    queryRows: props.query ? 1 : 0,
    figures: props.figures,
    tableRows: props.tableRows,
    tableChromeRows: props.tableChromeRows,
    chart: hasChart
      ? { minRows: chart.minRows, strip: chart.strip !== null && !chart.loading }
      : null,
  });
}

/**
 * The header zone of a pane that shows figures, a chart and a table: the
 * query bar, then the figures, then the chart band, sized by
 * `chartTableLayout` for the pane's current size. It goes in the table's
 * `rootBefore`, and the table takes the rows it leaves.
 */
export function ChartTableHeader(props: ChartTableHeaderProps) {
  const { width, query, chart } = props;
  const colors = useThemeColors();
  const layout = useChartTableLayout(props);
  const series = chart?.series;
  const viewport = useMemo(() => {
    if (chart?.viewport || !series?.length) return chart?.viewport;
    const span = seriesSpan(series);
    if (!span || span.last - span.first >= MIN_SPAN_MS) return undefined;
    return { start: new Date(span.last - MIN_SPAN_MS), end: new Date(span.last + DAY_MS) };
  }, [chart?.viewport, series]);
  const resolvedSeries = useMemo(() => (series ? [...series] : []), [series]);
  const strip = chart?.strip === undefined && chart ? stripFromSeries(chart) : chart?.strip ?? null;
  const formatValue = chart?.formatValue;

  let band: ReactNode = null;
  if (chart && layout.mode === "full") {
    // No padding: the legend's own one-cell inset lines it up with the figures and the table.
    const size = { width: Math.max(1, width), height: layout.chartRows };
    const ready = !!chart.render || plottedValues(series).length >= 2;
    band = (
      <Box height={layout.chartRows} flexShrink={0} overflow="hidden">
        {!ready ? (
          <Box width={size.width} height={size.height} justifyContent="center" alignItems="center">
            <Text fg={colors.textMuted}>Loading history...</Text>
          </Box>
        ) : chart.render ? chart.render(size) : (
          <CompositeChart
            series={resolvedSeries}
            panels={chart.panels ?? MAIN_PANEL}
            width={size.width}
            height={size.height}
            focused={false}
            navigable={false}
            showLegend
            showTimeAxis
            formatValue={formatValue ? (value) => formatValue(value) : undefined}
            formatAxisValue={chart.formatAxisValue}
            cursorDate={chart.cursorDate}
            onCursorDateChange={chart.onCursorDateChange}
            onActivate={chart.onActivate}
            viewport={viewport}
            legendAccessory={chart.legendAccessory}
            legendAccessoryWidth={chart.legendAccessoryWidth}
            remoteKind={chart.remoteKind}
          />
        )}
      </Box>
    );
  } else if (layout.mode === "strip" && strip) {
    band = <ChartStrip strip={strip} width={width} figures={layout.figures} />;
  }

  if (!query && !layout.figureRows && !band) return null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {query}
      {layout.figureRows ? <StatGrid items={layout.figures} width={width} /> : null}
      {band}
    </Box>
  );
}
