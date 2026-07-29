import { Box, Text } from "../ui";
import { colors, priceColor } from "../theme/colors";
import { displayWidth, formatPercent, padTo } from "../utils/format";
import type { PriceReturnField } from "../market-data/performance";

const STRIP_COLUMN_GAP = 1;
const RETURN_CELL_MIN_WIDTH = 7;

function formatReturnValue(value: number | null): string {
  return value == null ? "-" : formatPercent(value);
}

function returnValueColor(value: number | null): string {
  return value == null ? colors.textMuted : priceColor(value);
}

function hasAnyReturn(fields: readonly PriceReturnField[]): boolean {
  return fields.some((field) => field.value != null);
}

function chunkFields<T>(fields: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < fields.length; index += size) {
    rows.push(fields.slice(index, index + size));
  }
  return rows;
}

export function PriceReturnStrip({
  fields,
  width,
}: {
  fields: PriceReturnField[];
  width: number;
}) {
  if (!hasAnyReturn(fields)) return null;

  const columnCount = width >= 72
    ? Math.min(6, fields.length)
    : width >= 54
      ? Math.min(4, fields.length)
      : width >= 36
        ? Math.min(3, fields.length)
        : Math.min(2, fields.length);
  const availableWidth = Math.max(width - STRIP_COLUMN_GAP * Math.max(columnCount - 1, 0), columnCount);
  const cellWidth = Math.max(RETURN_CELL_MIN_WIDTH, Math.floor(availableWidth / columnCount));
  const rows = chunkFields(fields, columnCount);

  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} flexDirection="row" height={1}>
          {row.map((field, columnIndex) => {
            const labelWidth = Math.min(3, Math.max(2, displayWidth(field.label)));
            const valueWidth = Math.max(1, cellWidth - labelWidth);
            return (
              <Box key={field.id} flexDirection="row">
                {columnIndex > 0 && <Box width={STRIP_COLUMN_GAP} />}
                <Box flexDirection="row" width={cellWidth}>
                  <Text fg={colors.textDim}>{padTo(field.label, labelWidth)}</Text>
                  <Box width={valueWidth} overflow="hidden">
                    <Text fg={returnValueColor(field.value)}>{padTo(formatReturnValue(field.value), valueWidth, "right")}</Text>
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
