import { Box, Text } from "../ui";
import { colors, priceColor } from "../theme/colors";
import { displayWidth, formatPercent } from "../utils/format";
import type { PriceReturnField } from "../market-data/performance";

/** Cells between one horizon's pair and the next. */
const PAIR_GAP = 3;

function formatReturnValue(value: number | null): string {
  return value == null ? "-" : formatPercent(value);
}

function returnValueColor(value: number | null): string {
  return value == null ? colors.textMuted : priceColor(value);
}

function hasAnyReturn(fields: readonly PriceReturnField[]): boolean {
  return fields.some((field) => field.value != null || field.unavailableReason);
}

interface ReturnPair {
  field: PriceReturnField;
  value: string;
}

/** Pairs fill a row left to right and wrap whole, never splitting a label from its value. */
function packPairs(pairs: readonly ReturnPair[], width: number): ReturnPair[][] {
  const rows: ReturnPair[][] = [];
  let rowWidth = 0;
  for (const pair of pairs) {
    const pairWidth = displayWidth(pair.field.label) + 1 + displayWidth(pair.value);
    const row = rows.at(-1);
    if (row && rowWidth + PAIR_GAP + pairWidth <= width) {
      row.push(pair);
      rowWidth += PAIR_GAP + pairWidth;
    } else {
      rows.push([pair]);
      rowWidth = pairWidth;
    }
  }
  return rows;
}

/** Each horizon's label with its return beside it: `1M +3.29%   3M +6.99%`. */
export function PriceReturnStrip({
  fields,
  width,
}: {
  fields: PriceReturnField[];
  width: number;
}) {
  if (!hasAnyReturn(fields)) return null;
  const rows = packPairs(fields.map((field) => ({ field, value: formatReturnValue(field.value) })), width);

  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} flexDirection="row" height={1} gap={PAIR_GAP} overflow="hidden">
          {row.map(({ field, value }) => (
            <Box key={field.id} flexDirection="row" gap={1} flexShrink={0}>
              <Text fg={colors.textDim}>{field.label}</Text>
              <Text fg={returnValueColor(field.value)}>{value}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
