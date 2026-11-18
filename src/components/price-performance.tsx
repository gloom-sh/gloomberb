import { Box, Text, useUiCapabilities } from "../ui";
import { colors, priceColor } from "../theme/colors";
import { MISSING_VALUE, displayWidth, formatPercent } from "../utils/format";
import type { PriceReturnField } from "../market-data/performance";

/** Cells between one horizon's pair and the next. */
const PAIR_GAP = 3;

function formatReturnValue(value: number | null): string {
  return value == null ? MISSING_VALUE : formatPercent(value);
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
  /** `from 17 Oct`: the day of the close the return is measured from. */
  base: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `from 17 Oct`, with the year when it is not this one's: `from 17 Nov 2025`. Empty without a base. */
function priceReturnBaseText(day: string | undefined, now = Date.now()): string {
  const date = day ? new Date(`${day.slice(0, 10)}T00:00:00Z`) : null;
  if (!date || !Number.isFinite(date.getTime())) return "";
  const year = date.getUTCFullYear() === new Date(now).getUTCFullYear() ? "" : ` ${date.getUTCFullYear()}`;
  return `from ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}${year}`;
}

function pairWidth(pair: ReturnPair): number {
  return displayWidth(pair.field.label) + 1 + displayWidth(pair.value) + (pair.base ? 1 + displayWidth(pair.base) : 0);
}

/** Pairs fill a row left to right and wrap whole, never splitting a label from its value. */
function packPairs(pairs: readonly ReturnPair[], width: number): ReturnPair[][] {
  const rows: ReturnPair[][] = [];
  let rowWidth = 0;
  for (const pair of pairs) {
    const cells = pairWidth(pair);
    const row = rows.at(-1);
    if (row && rowWidth + PAIR_GAP + cells <= width) {
      row.push(pair);
      rowWidth += PAIR_GAP + cells;
    } else {
      rows.push([pair]);
      rowWidth = cells;
    }
  }
  return rows;
}

/** Each horizon's label with its return and the close it runs from beside it: `1M +3.29% from 17 Oct   3M +6.99% from 17 Aug`. */
export function PriceReturnStrip({
  fields,
  width,
}: {
  fields: PriceReturnField[];
  width: number;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  if (!hasAnyReturn(fields)) return null;
  const pairs = fields.map((field) => ({ field, value: formatReturnValue(field.value), base: field.value == null ? "" : priceReturnBaseText(field.baseDay) }));
  if (nativePaneChrome) {
    // The desktop and the web wrap the pairs where the pane's own edge is, whole, so a resize re-wraps them
    // on every frame instead of in the steps of the cells the terminal counts.
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={PAIR_GAP} data-gloom-role="price-return-strip">
        {pairs.map(({ field, value, base }) => (
          <Box key={field.id} flexDirection="row" gap={1} flexShrink={0}>
            <Text fg={colors.textDim}>{field.label}</Text>
            <Text fg={returnValueColor(field.value)}>{value}</Text>
            {base ? <Text fg={colors.textMuted}>{base}</Text> : null}
          </Box>
        ))}
      </Box>
    );
  }
  const rows = packPairs(pairs, width);

  return (
    <Box flexDirection="column" width={width}>
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} flexDirection="row" height={1} gap={PAIR_GAP} overflow="hidden">
          {row.map(({ field, value, base }) => (
            <Box key={field.id} flexDirection="row" gap={1} flexShrink={0}>
              <Text fg={colors.textDim}>{field.label}</Text>
              <Text fg={returnValueColor(field.value)}>{value}</Text>
              {base ? <Text fg={colors.textMuted}>{base}</Text> : null}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
