import { useMemo, type ReactNode } from "react";
import { useThemeColors } from "../../theme/theme-context";
import type { PricePoint } from "../../types/financials";
import type { ChartPanelSpec, ResolvedSeries } from "../../time-series/types";
import { Box, Text } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { CompositeChart } from "../chart/composite";
import type { CompositeAxisDomain, CompositeChartProps } from "../chart/composite/types";
import { PriceSparkline } from "../price-sparkline/view";
import { StatGrid, type StatItem } from "../ui/stat-grid";
import type { TableWidthColumn } from "../ui/table-layout";
import { CHART_COMPACT_ROWS, chartTableChromeRows, chartTableLayout, type ChartTableLayout } from "./layout";

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
  /** Content with a natural height (a few bars): the band never takes more, the table gets the rest. */
  maxRows?: number;
  /** The strip for a custom chart; kit series derive their own. Null keeps no strip. */
  strip?: ChartStripSpec | null;
  /** The legend value, in the table's units; the series is passed when several share the chart. */
  formatValue?: (value: number, series?: ResolvedSeries) => string;
  formatAxisValue?: (value: number, domain: CompositeAxisDomain) => string;
  /** From `useChartTableSelection`, so the table and the chart share one selection. */
  cursorDate?: Date | null;
  onCursorDateChange?: (date: Date | null) => void;
  onActivate?: () => void;
  viewport?: { start: Date; end: Date };
  /** Ticks for an x axis that is not a calendar: one per bar, a tenor, a contract month. */
  xAxis?: CompositeChartProps["xAxis"];
  /** Muted context at the end of the legend row: a window or an as-of date. */
  legendAccessory?: ReactNode;
  legendAccessoryWidth?: number;
  remoteKind?: string;
  /** The history is still loading: the band keeps its rows so the table does not jump. */
  loading?: boolean;
  /**
   * Shown in the band when the series have nothing to draw, so a chart that
   * follows the selected row keeps its rows on a row without history instead
   * of the table jumping up and back.
   */
  empty?: string;
}

export interface ChartTableHeaderProps {
  width: number;
  /** Rows the header and the table share: the same value as the table's `rootHeight`. */
  height: number;
  /** Body rows the table holds. */
  tableRows: number;
  /** Table header rows, plus one when its columns overflow into a scrollbar. */
  tableChromeRows?: number;
  /** The table's columns, to count its scrollbar row when `tableChromeRows` is not given. */
  tableColumns?: readonly TableWidthColumn[];
  /** A one-row `QueryBar`. */
  query?: ReactNode;
  figures?: readonly StatItem[];
  chart?: ChartTableChart | null;
}

/** The first shown series with a line to draw, and its values. */
function plottable(series: readonly ResolvedSeries[] | undefined): { entry: ResolvedSeries; values: number[] } | null {
  for (const entry of series ?? []) {
    if (entry.hidden) continue;
    const values = entry.points.flatMap((point) => (
      point.value != null && Number.isFinite(point.value) ? [point.value] : []
    ));
    if (values.length >= 2) return { entry, values };
  }
  return null;
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
  const line = plottable(chart.series);
  const latest = line?.values.at(-1);
  if (!line || latest == null) return null;
  return {
    label: line.entry.label,
    values: line.values,
    value: chart.formatValue ? chart.formatValue(latest, line.entry) : String(latest),
    color: line.entry.color,
  };
}

/** A figure says the same value when it reads the same, with or without a unit after it. */
function sameValue(figure: string, value: string): boolean {
  return figure === value || figure.startsWith(`${value} `);
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
  const shownValue = figures.some((item) => sameValue(item.value, strip.value)) ? "" : strip.value;
  const shownLabel = figures.some((item) => item.label === strip.label) ? "" : strip.label;
  const valueWidth = shownValue ? displayWidth(shownValue) + 1 : 0;
  const labelWidth = displayWidth(shownLabel);
  // A label cut to a stub no longer says what is plotted: keep a readable
  // part of it, and give up the sparkline before the label.
  const readable = Math.min(labelWidth, 7);
  let labelRoom = Math.max(0, inner - valueWidth - STRIP_MIN_SPARKLINE - 3);
  if (labelRoom < readable) labelRoom = Math.max(0, inner - valueWidth - 2);
  const label = labelRoom >= readable ? truncateToDisplayWidth(shownLabel, Math.min(labelWidth, labelRoom)) : "";
  const sparkWidth = Math.max(0, inner - (label ? displayWidth(label) + 1 : 0) - valueWidth - 2);
  const history = useMemo<PricePoint[]>(
    () => strip.values.map((close, index) => ({ date: new Date(index * DAY_MS), close })),
    [strip.values],
  );
  return (
    <Box flexDirection="row" height={1} flexShrink={0} paddingX={1} gap={1} overflow="hidden">
      <Text fg={strip.color ?? colors.text}>●</Text>
      {label ? <Text fg={colors.text}>{label}</Text> : null}
      {sparkWidth >= STRIP_MIN_SPARKLINE ? (
        <Box width={sparkWidth} height={1} flexShrink={0}>
          <PriceSparkline priceHistory={history} width={sparkWidth} period="all" color={strip.color} />
        </Box>
      ) : null}
      {shownValue ? <Text fg={colors.textBright}>{shownValue}</Text> : null}
    </Box>
  );
}

/** Where a pane puts its chart when it wants the kit's layout without the kit's header. */
export function useChartTableLayout(props: ChartTableHeaderProps): ChartTableLayout {
  const { chart } = props;
  const hasChart = !!chart && (!!chart.render || !!plottable(chart.series) || !!chart.loading || !!chart.empty);
  return chartTableLayout({
    width: props.width,
    height: props.height,
    queryRows: props.query ? 1 : 0,
    figures: props.figures,
    tableRows: props.tableRows,
    tableChromeRows: props.tableChromeRows
      ?? (props.tableColumns ? chartTableChromeRows(props.tableColumns, props.width) : undefined),
    chart: hasChart
      ? {
        minRows: chart.minRows,
        // Kit charts can draw in fewer rows under a short table; custom ones say their own least.
        compactRows: chart.render ? undefined : CHART_COMPACT_ROWS,
        maxRows: chart.maxRows,
        strip: chart.strip !== null,
      }
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
    const ready = !!chart.render || !!plottable(series);
    band = (
      <Box height={layout.chartRows} flexShrink={0} overflow="hidden">
        {!ready ? (
          <Box width={size.width} height={size.height} justifyContent="center" alignItems="center">
            <Text fg={colors.textMuted}>{chart.loading ? "Loading history..." : chart.empty ?? ""}</Text>
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
            formatValue={formatValue ? (value, entry) => formatValue(value, entry) : undefined}
            formatAxisValue={chart.formatAxisValue}
            cursorDate={chart.cursorDate}
            onCursorDateChange={chart.onCursorDateChange}
            onActivate={chart.onActivate}
            viewport={viewport}
            xAxis={chart.xAxis}
            legendAccessory={chart.legendAccessory}
            legendAccessoryWidth={chart.legendAccessoryWidth}
            remoteKind={chart.remoteKind}
          />
        )}
      </Box>
    );
  } else if (layout.mode === "strip" && strip) {
    band = <ChartStrip strip={strip} width={width} figures={layout.figures} />;
  } else if (layout.mode === "strip" && chart && (chart.loading || chart.empty)) {
    // The strip's row is held while the history loads, and on a row without one.
    band = (
      <Box height={1} flexShrink={0} paddingX={1}>
        <Text fg={colors.textMuted}>{chart.loading ? "Loading history..." : chart.empty}</Text>
      </Box>
    );
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
