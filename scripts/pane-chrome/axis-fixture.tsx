/** Synthetic observations for the shared composite-axis pointer regression. */
import { useMemo } from "react";
import { CompositeChart } from "../../src/components/chart/composite";
import { buildCompositeChartScene, applyCompositeChartCursor, projectCompositeValue, resizeCompositePanel } from "../../src/components/chart/composite/scene";
import { formatCompositeCursorValue } from "../../src/components/chart/composite/format";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../src/test-support/time-series";
import { themedSeriesColor } from "../../src/theme/series-colors";
import { useThemeId } from "../../src/theme/theme-context";
import type { PaneProps } from "../../src/types/plugin";
import type { ChartPanelSpec, ResolvedSeries } from "../../src/time-series/types";

const dates = Array.from({ length: 9 }, (_, index) => new Date(Date.UTC(2025, 0, index + 1)));
const colors = ["#4fb3ff", "#f2b84b", "#ce7bda", "#53c6ac", "#df7c77", "#99adff"];
const points = (values: Array<number | null>) => values.map((value, index) => createTestSeriesPoint(dates[index]!, value));

function data(kind: string): { series: ResolvedSeries[]; panels: ChartPanelSpec[] } {
  const series = [
    createTestResolvedSeries({ id: "alfa", label: "ALFA", color: colors[0]!, points: points([10, 25, 40, 60, 80, 98, 60, 20, 10]) }),
    createTestResolvedSeries({ id: "brvo", label: "BRVO", color: colors[1]!, points: points([10, 26, 40, 60.1, 80.1, 98, 60.1, 21, 11]) }),
    createTestResolvedSeries({ id: "chrl", label: "CHRL", color: colors[2]!, points: points([10, 27, 40, 60.2, 80.2, 98, 60.2, 22, 12]) }),
  ];
  const panels: ChartPanelSpec[] = [{ id: "main", scale: "linear", height: 3 }];
  if (kind === "two") series.pop();
  if (kind === "percent") for (const entry of series) { entry.unit = "%"; entry.unitGroup = "percent"; }
  if (kind === "missing") {
    series[1]!.points = series[1]!.points.filter((_, index) => index !== 3 && index !== 4);
    series[2]!.points = points([null, null, 40, null, null, 98, 60.2, 22, 12]);
    series.push(createTestResolvedSeries({ id: "hidden", hidden: true, points: points([99, 99, 99, 99, 99, 99, 99, 99, 99]) }));
  }
  if (kind === "mixed" || kind === "stacked") {
    series[2] = { ...series[2]!, unit: "%", unitGroup: "percent", axis: "right", points: points([1, 2, 3, 4, 5, 6, 7, 8, 9]) };
  }
  if (kind === "stacked") {
    panels.push({ id: "volume", scale: "linear", height: 1 }, { id: "rsi", scale: "linear", height: 1 });
    series.push(
      createTestResolvedSeries({ id: "volume", label: "Volume", panelId: "volume", color: colors[3]!, style: "columns", unit: "shares", unitGroup: "volume", points: points([1200, 3600, 5600, 2300, 4800, 6400, 4900, 3100, 4200]) }),
      createTestResolvedSeries({ id: "rsi", label: "RSI", panelId: "rsi", color: colors[4]!, unit: "", unitGroup: "ratio", points: points([22, 39, 55, 60, 80, 85, 67, 59, 43]) }),
    );
  }
  return { series, panels };
}

export function AxisFixturePane({ width, height, focused }: PaneProps) {
  const kind = new URLSearchParams(location.search).get("axis") ?? "three";
  const theme = useThemeId();
  const { series, panels } = useMemo(() => data(kind), [kind]);
  // An independent oracle, before downsampling. It reads the scene rather
  // than the DOM readout or its label/placement helpers.
  const scene = useMemo(() => buildCompositeChartScene(series.filter((entry) => !entry.hidden).map((entry) => ({ ...entry, color: themedSeriesColor(entry.color, theme) })), panels, {
    width, height: Math.max(1, height - 2),
  }), [height, panels, series, theme, width]);
  const inspect = (date: Date | null) => {
    if (!scene) return;
    const cursor = applyCompositeChartCursor(scene, date);
    (window as any).__axisReadout = {
      date: cursor.cursorDate?.toISOString() ?? null,
      expected: cursor.cursorXRatio === null ? [] : cursor.panels.map((panel) => resizeCompositePanel(panel, panel.height, false)).flatMap((panel) => panel.series.flatMap(({ source }) => {
        const observation = cursor.cursorValues.find((entry) => entry.seriesId === source.id);
        const domain = panel.axes[source.axis];
        if (!domain || observation?.value == null) return [];
        const ratio = projectCompositeValue(observation.value, domain);
        if (ratio === null) return [];
        return [{ id: source.id, panel: panel.id, side: source.axis, value: observation.value, label: formatCompositeCursorValue(observation.value, domain), ratio, color: source.color, carried: !!observation.carried }];
      })),
    };
  };
  return <CompositeChart series={series} panels={panels} width={width} height={height} focused={focused} onCursorDateChange={inspect} />;
}
