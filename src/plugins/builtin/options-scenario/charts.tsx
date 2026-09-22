import { useMemo } from "react";
import { StaticChartSurface, type StaticChartOverlay } from "../../../components";
import { Box, Text } from "../../../ui";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useThemeColors } from "../../../theme/theme-context";
import type { buildScenario } from "./model";

export function ScenarioPayoffChart({ scenario, width, height }: {
  scenario: ReturnType<typeof buildScenario>; width: number; height: number;
}) {
  const colors = useThemeColors();
  const { points, overlays, ticks, first, span } = useMemo(() => {
    const points = scenario.payoff.map((row) => ({ date: new Date(Math.round(row.spot * 1000)),
      open: row.expiry, high: row.expiry, low: row.expiry, close: row.expiry, volume: 0 }));
    const first = scenario.payoff[0]?.spot ?? 0;
    const span = Math.max(1e-9, (scenario.payoff.at(-1)?.spot ?? 1) - first);
    const overlays: StaticChartOverlay[] = [
      { id: "Selected date", color: colors.borderFocused,
        points: scenario.payoff.map((row, index) => ({ index, value: row.selected })) },
      { id: "Breakeven", color: colors.textDim,
        points: [{ index: 0, value: 0 }, { index: points.length - 1, value: 0 }] },
    ];
    const ticks = [0, .25, .5, .75, 1].map((ratio) => ({ ratio, label: (first + ratio * span).toFixed(2) }));
    return { points, overlays, ticks, first, span };
  }, [scenario, colors]);
  const date = (value: number) => new Date(value).toISOString().slice(0, 10);
  return <Box flexDirection="column" width={width} height={height}>
    <Box height={1} paddingX={1} flexDirection="row" gap={3}>
      <Text fg={colors.warning}>{`${scenario.expiryRisk.reason ? "First expiry" : "Expiry"} ${date(scenario.expiryDate)}`}</Text>
      <Text fg={colors.borderFocused}>{`Selected ${date(scenario.controls.date)}`}</Text>
      <Text fg={colors.textDim}>{`P&L ${scenario.position.currency}`}</Text>
    </Box>
    <StaticChartSurface points={points} overlays={overlays} calendarSpaced
      width={width} height={Math.max(2, height - 1)} colors={{ ...resolveChartPalette(colors), lineColor: colors.warning }}
      xAxisTicks={ticks} formatXAxisCursorValue={(ratio) => `Spot ${(first + ratio * span).toFixed(2)}`}
      formatYAxisValue={(value) => value.toFixed(0)} />
  </Box>;
}
