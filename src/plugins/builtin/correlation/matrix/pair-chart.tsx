import { useMemo } from "react";
import { CompositeChart } from "../../../../components";
import { scalarPoint, staticSeries } from "../../../../components/chart/static/series";
import { colors } from "../../../../theme/colors";
import { Box, Text } from "../../../../ui";
import type { buildMatrixPairHistory } from "./selection";
import { matrixPairRead } from "./selection";

const PANELS = [{ id: "main" }];
const formatValue = (value: number) => value.toFixed(2);

export function MatrixPairChart({ pair, history, fullPeriod, width, height }: {
  pair: [string, string];
  history: ReturnType<typeof buildMatrixPairHistory>;
  fullPeriod: number | null;
  width: number;
  height: number;
}) {
  const series = useMemo(() => [
    staticSeries(history.points.map(({ date, value }) => scalarPoint(date, value)), {
      id: "rolling", label: `${pair[0]}/${pair[1]} (${history.window} day)`, color: "#f6c85f",
    }),
    staticSeries(history.points.map(({ date }) => scalarPoint(date, fullPeriod)), {
      id: "full-period", label: "Full period", color: colors.textDim,
    }),
  ], [history, pair[0], pair[1], fullPeriod]);
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      <Box flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
        <CompositeChart
          series={series}
          panels={PANELS}
          width={width}
          height={height}
          focused={false}
          navigable={false}
          showTimeAxis
          formatAxisValue={formatValue}
          formatValue={formatValue}
          emptyMessage={history.unavailable ?? "No paired history"}
        />
      </Box>
      <Box paddingX={1} height={1} flexShrink={0} overflow="hidden">
        <Text fg={colors.textMuted} wrapMode="none">{matrixPairRead(pair, fullPeriod, history)}</Text>
      </Box>
    </Box>
  );
}
