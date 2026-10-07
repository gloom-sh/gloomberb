import { RatioBar } from "../../../components/ui/ratio-bar";
import { Box, Text, TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { ScannerHiloPayload } from "../../../api-client";
import {
  buildHiloBarRows,
  hiloBarLayout,
  hiloWindowLabel,
  HILO_LABEL_WIDTH,
  type HiloBarRow,
} from "./hilo-model";

export interface HiloBarsProps {
  windows: ScannerHiloPayload["windows"] | null | undefined;
  width: number;
}

function RowLabel({ row }: { row: HiloBarRow }) {
  return (
    <Box width={HILO_LABEL_WIDTH} flexShrink={0}>
      <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>{hiloWindowLabel(row.label)}</Text>
    </Box>
  );
}

/** Names the side at an end of the top row; the other rows keep the cells so every bar shares one scale. */
function SideName({ name, width, align }: { name: string | null; width: number; align: "left" | "right" }) {
  if (width <= 0) return null;
  return (
    <Box width={width} flexShrink={0} flexDirection="row" justifyContent={align === "left" ? "flex-start" : "flex-end"}>
      {name ? <Text fg={colors.textMuted}>{name}</Text> : null}
    </Box>
  );
}

/** Counts sit beside the label, so an empty window reads as zero rather than a missing bar. */
function countWidthFor(rows: readonly HiloBarRow[]): number {
  return Math.max(...rows.flatMap((row) => [String(row.lows).length, String(row.highs).length]), 1) + 1;
}

/** Lows grow left from the window label and highs grow right, on one scale for every bar. */
export function HiloBars({ windows, width }: HiloBarsProps) {
  const rows = buildHiloBarRows(windows);
  const countWidth = countWidthFor(rows);
  const { halfWidth, barWidth, sideNameWidth } = hiloBarLayout(width, countWidth);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {rows.map((row, index) => (
        <Box key={row.key} flexDirection="row" height={1} paddingX={1} alignItems="center">
          <SideName name={index === 0 ? "LOWS" : null} width={sideNameWidth} align="left" />
          <Box width={halfWidth} flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center">
            <RatioBar ratio={row.lowRatio} width={barWidth} color={colors.negative} align="end" thickness={11} />
            <Text fg={colors.textDim}>{String(row.lows).padStart(countWidth)}</Text>
          </Box>
          <RowLabel row={row} />
          <Box width={halfWidth} flexShrink={0} flexDirection="row" alignItems="center">
            <Text fg={colors.textDim}>{String(row.highs).padEnd(countWidth)}</Text>
            <RatioBar ratio={row.highRatio} width={barWidth} color={colors.positive} thickness={11} />
          </Box>
          <SideName name={index === 0 ? "HIGHS" : null} width={sideNameWidth} align="right" />
        </Box>
      ))}
    </Box>
  );
}
