import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { ScannerHiloPayload } from "../../../api-client";
import {
  buildHiloBarRows,
  hiloBarLayout,
  hiloWindowLabel,
  HILO_LABEL_WIDTH,
  terminalBarCells,
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

/** Terminal bars are block runs at half-cell resolution, the densest option in cells. */
/** Counts sit beside the label, so an empty window reads as zero rather than a missing bar. */
function countWidthFor(rows: readonly HiloBarRow[]): number {
  return Math.max(...rows.flatMap((row) => [String(row.lows).length, String(row.highs).length]), 1) + 1;
}

function TerminalHiloBars({ rows, width }: { rows: HiloBarRow[]; width: number }) {
  const countWidth = countWidthFor(rows);
  const { halfWidth, barWidth, sideNameWidth } = hiloBarLayout(width, countWidth);
  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row, index) => {
        const low = terminalBarCells(row.lowRatio, barWidth);
        const high = terminalBarCells(row.highRatio, barWidth);
        const lowBar = `${low.half ? "▐" : ""}${"█".repeat(low.full)}`;
        const highBar = `${"█".repeat(high.full)}${high.half ? "▌" : ""}`;
        return (
          <Box key={row.key} flexDirection="row" height={1} paddingX={1}>
            <SideName name={index === 0 ? "LOWS" : null} width={sideNameWidth} align="left" />
            <Box width={halfWidth} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              <Text fg={colors.negative}>{lowBar}</Text>
              <Text fg={colors.textDim}>{String(row.lows).padStart(countWidth)}</Text>
            </Box>
            <RowLabel row={row} />
            <Box width={halfWidth} flexShrink={0} flexDirection="row">
              <Text fg={colors.textDim}>{String(row.highs).padEnd(countWidth)}</Text>
              <Text fg={colors.positive}>{highBar}</Text>
            </Box>
            <SideName name={index === 0 ? "HIGHS" : null} width={sideNameWidth} align="right" />
          </Box>
        );
      })}
    </Box>
  );
}

/** Desktop bars are real flex-sized divs, so length is fractional instead of cell-quantized. */
function DesktopHiloBars({ rows, width }: { rows: HiloBarRow[]; width: number }) {
  const { sideNameWidth } = hiloBarLayout(width, countWidthFor(rows));
  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row, index) => (
        <Box key={row.key} flexDirection="row" height={1} paddingX={1} alignItems="center">
          <SideName name={index === 0 ? "LOWS" : null} width={sideNameWidth} align="left" />
          <Box flexGrow={1} flexDirection="row" justifyContent="flex-end" overflow="hidden" alignItems="center">
            <Box
              backgroundColor={colors.negative}
              style={{
                width: `${(row.lowRatio * 100).toFixed(2)}%`,
                height: "11px",
                borderRadius: "2px 0 0 2px",
                minWidth: row.lows > 0 ? "2px" : "0",
              }}
            />
            <Text fg={colors.textDim}>{` ${row.lows}`}</Text>
          </Box>
          <RowLabel row={row} />
          <Box flexGrow={1} flexDirection="row" overflow="hidden" alignItems="center">
            <Text fg={colors.textDim}>{`${row.highs} `}</Text>
            <Box
              backgroundColor={colors.positive}
              style={{
                width: `${(row.highRatio * 100).toFixed(2)}%`,
                height: "11px",
                borderRadius: "0 2px 2px 0",
                minWidth: row.highs > 0 ? "2px" : "0",
              }}
            />
          </Box>
          <SideName name={index === 0 ? "HIGHS" : null} width={sideNameWidth} align="right" />
        </Box>
      ))}
    </Box>
  );
}

export function HiloBars({ windows, width }: HiloBarsProps) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const rows = buildHiloBarRows(windows);

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {isDesktopWeb
        ? <DesktopHiloBars rows={rows} width={width} />
        : <TerminalHiloBars rows={rows} width={width} />}
    </Box>
  );
}
