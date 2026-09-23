import type { KeyEventLike } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { Box, Text } from "../../../ui";
import { formatCurrency, formatNumber, formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import type { SensitivityGrid } from "./model";

export function truncateText(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return value.slice(0, maxWidth);
  return `${value.slice(0, maxWidth - 1)}…`;
}

export function formatPct(value: number, decimals = 1): string {
  return `${formatNumber(value * 100, decimals)}%`;
}

export function formatSignedPct(value: number): string {
  return formatPercentRaw(value * 100);
}

export function isPlainShortcut(event: KeyEventLike, ...names: string[]): boolean {
  if (isPlainKey(event, ...names)) return true;
  const key = event.key?.toLowerCase();
  return !event.ctrl && !event.meta && !event.super && !event.alt && names.includes(key);
}

export function SensitivityGridView({
  width,
  grid,
}: {
  width: number;
  grid: SensitivityGrid;
}) {
  const labelWidth = 9;
  const cellWidth = Math.max(8, Math.floor((width - labelWidth) / Math.max(1, grid.columns.length)));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={1} flexDirection="row">
        <Box width={labelWidth}>
          <Text fg={colors.textDim}>{truncateText(grid.rowLabel, labelWidth)}</Text>
        </Box>
        {grid.columns.map((column) => (
          <Box key={column} width={cellWidth}>
            <Text fg={colors.textDim}>{truncateText(column, cellWidth - 1).padStart(cellWidth - 1)}</Text>
          </Box>
        ))}
      </Box>
      {grid.rows.map((row, rowIndex) => (
        <Box key={row} height={1} flexDirection="row">
          <Box width={labelWidth}>
            <Text fg={colors.textDim}>{truncateText(row, labelWidth)}</Text>
          </Box>
          {grid.cells[rowIndex]?.map((cell, cellIndex) => (
            <Box key={`${row}:${cellIndex}`} width={cellWidth}>
              <Text fg={colors.text}>{truncateText(cell.text, cellWidth - 1).padStart(cellWidth - 1)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function buildKellyCurveXAxisLabels(maxFraction: number): string[] {
  if (!Number.isFinite(maxFraction) || maxFraction <= 0) return [];
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => formatPct(maxFraction * ratio, 0));
}

export function KellyCurveDecisionView({
  width,
  currentFraction,
  targetFraction,
  fullKellyFraction,
  currentGrowth,
  targetGrowth,
  addTrimValue,
  currency,
  clipReasons,
}: {
  width: number;
  currentFraction: number;
  targetFraction: number;
  fullKellyFraction: number;
  currentGrowth: number;
  targetGrowth: number;
  addTrimValue: number;
  currency: string;
  clipReasons: string[];
}) {
  const moveLabel = addTrimValue >= 0 ? "add" : "trim";
  const capLabel = clipReasons.length > 0 ? `cap ${clipReasons.join(", ")}` : "cap none";
  const text = [
    `${formatPct(currentFraction, 1)} -> ${formatPct(targetFraction, 1)}`,
    `${moveLabel} ${formatCurrency(Math.abs(addTrimValue), currency)}`,
    `growth ${formatSignedPct(currentGrowth)} -> ${formatSignedPct(targetGrowth)}`,
    `full ${formatPct(fullKellyFraction, 0)}`,
    capLabel,
  ].join("  ");
  return (
    <Box height={1} paddingX={1}>
      <Text fg={colors.textDim}>{truncateText(text, Math.max(1, width - 2))}</Text>
    </Box>
  );
}
