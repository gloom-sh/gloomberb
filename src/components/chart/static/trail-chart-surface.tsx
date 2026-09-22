import { useMemo } from "react";
import { Box, Text } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { CompositeChart } from "../composite/composite-chart";
import { buildTrailChart, type ScatterTrail } from "./trail-chart-model";

const PANELS = [{ id: "main" }];
export function ScatterTrailSurface({
  trails,
  width,
  height,
  center = 100,
  selectedId,
  xLabel = "Relative strength",
  observationLabel,
}: {
  trails: ScatterTrail[];
  width: number;
  height: number;
  center?: number;
  selectedId?: string | null;
  xLabel?: string;
  observationLabel?: string;
}) {
  const colors = useThemeColors();
  const model = useMemo(
    () =>
      buildTrailChart(
        trails.map((trail) => ({
          ...trail,
          color:
            selectedId && trail.id !== selectedId
              ? colors.textDim
              : trail.color,
        })),
        center,
        colors.textDim,
      ),
    [trails, center, colors.textDim, selectedId],
  );
  const xAxis = useMemo(
    () => ({
      ticks: [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
        ratio,
        label: (model.min + ratio * (model.max - model.min)).toFixed(1),
      })),
      formatCursor: (ratio: number) =>
        (model.min + ratio * (model.max - model.min)).toFixed(2),
    }),
    [model, colors.textDim],
  );
  const selected = trails
    .find((trail) => trail.id === selectedId)
    ?.points.at(-1);
  return (
    <Box width={width} height={height} flexDirection="column">
      <Box
        height={1}
        paddingX={1}
        justifyContent="space-between"
        flexDirection="row"
      >
        <Text fg={colors.textMuted}>Improving</Text>
        <Text fg={colors.positive}>Leading</Text>
      </Box>
      <CompositeChart
        series={model.series}
        panels={PANELS}
        width={width}
        height={Math.max(3, height - 3)}
        showLegend={false}
        showTimeAxis
        xAxis={xAxis}
        formatAxisValue={(value) => value.toFixed(1)}
        cursorDate={selected ? model.toDate(selected.x) : null}
        interactive={false}
        navigable={false}
        remoteKind="scatter-trails"
      />
      <Box
        height={1}
        paddingX={1}
        justifyContent="space-between"
        flexDirection="row"
      >
        <Text fg={colors.negative}>Lagging</Text>
        <Text fg={colors.warning}>Weakening</Text>
      </Box>
      <Box height={1} paddingX={1}>
        <Text fg={colors.textDim}>
          {xLabel} → · Momentum ↑
          {observationLabel ? ` · ${observationLabel}` : ""}
        </Text>
      </Box>
    </Box>
  );
}
