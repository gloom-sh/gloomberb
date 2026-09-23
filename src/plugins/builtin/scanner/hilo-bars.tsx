import { Box, Text, TextAttributes, useUiHost } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { ScannerHiloPayload } from "../../../api-client";
import { buildHiloBarRows, terminalBarCells, type HiloBarRow } from "./hilo-model";

const LABEL_WIDTH = 8;
const MIN_HALF_WIDTH = 4;

export interface HiloBarsProps {
  windows: ScannerHiloPayload["windows"] | null | undefined;
  width: number;
}

function halfWidthFor(width: number): number {
  return Math.max(MIN_HALF_WIDTH, Math.floor((width - LABEL_WIDTH - 2) / 2));
}

/** Desktop gets a real swatch element; the terminal gets the densest glyph. */
function Swatch({ color, isDesktopWeb }: { color: string; isDesktopWeb: boolean }) {
  if (!isDesktopWeb) return <Text fg={color}>■</Text>;
  return (
    <Box
      backgroundColor={color}
      style={{ width: "9px", height: "9px", borderRadius: "2px", alignSelf: "center" }}
    />
  );
}

function Legend({ width, isDesktopWeb }: { width: number; isDesktopWeb: boolean }) {
  return (
    <Box flexDirection="row" height={1} paddingX={1} width={width} alignItems="center">
      <Swatch color={colors.negative} isDesktopWeb={isDesktopWeb} />
      <Text fg={colors.textDim}> New Lows</Text>
      <Box flexGrow={1} />
      <Text fg={colors.textDim}>New Highs </Text>
      <Swatch color={colors.positive} isDesktopWeb={isDesktopWeb} />
    </Box>
  );
}

function RowLabel({ row }: { row: HiloBarRow }) {
  return (
    <Box width={LABEL_WIDTH} flexShrink={0} justifyContent="center" alignItems="center">
      <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>{row.label}</Text>
    </Box>
  );
}

/** Terminal bars are block runs at half-cell resolution, the densest option in cells. */
/** Counts sit beside the label, so an empty window reads as zero rather than a missing bar. */
function countWidthFor(rows: readonly HiloBarRow[]): number {
  return Math.max(...rows.flatMap((row) => [String(row.lows).length, String(row.highs).length]), 1) + 1;
}

function TerminalHiloBars({ rows, halfWidth, width }: { rows: HiloBarRow[]; halfWidth: number; width: number }) {
  const countWidth = countWidthFor(rows);
  const barWidth = Math.max(0, halfWidth - countWidth);
  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row) => {
        const low = terminalBarCells(row.lowRatio, barWidth);
        const high = terminalBarCells(row.highRatio, barWidth);
        const lowBar = `${low.half ? "▐" : ""}${"█".repeat(low.full)}`;
        const highBar = `${"█".repeat(high.full)}${high.half ? "▌" : ""}`;
        return (
          <Box key={row.key} flexDirection="row" height={1} paddingX={1}>
            <Box width={halfWidth} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              <Text fg={colors.negative}>{lowBar}</Text>
              <Text fg={colors.textDim}>{String(row.lows).padStart(countWidth)}</Text>
            </Box>
            <RowLabel row={row} />
            <Box width={halfWidth} flexShrink={0} flexDirection="row">
              <Text fg={colors.textDim}>{String(row.highs).padEnd(countWidth)}</Text>
              <Text fg={colors.positive}>{highBar}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** Desktop bars are real flex-sized divs, so length is fractional instead of cell-quantized. */
function DesktopHiloBars({ rows, width }: { rows: HiloBarRow[]; width: number }) {
  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row) => (
        <Box key={row.key} flexDirection="row" height={1} paddingX={1} alignItems="center">
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
        </Box>
      ))}
    </Box>
  );
}

export function HiloBars({ windows, width }: HiloBarsProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const rows = buildHiloBarRows(windows);

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Legend width={width} isDesktopWeb={isDesktopWeb} />
      {isDesktopWeb
        ? <DesktopHiloBars rows={rows} width={width} />
        : <TerminalHiloBars rows={rows} halfWidth={halfWidthFor(width)} width={width} />}
    </Box>
  );
}
