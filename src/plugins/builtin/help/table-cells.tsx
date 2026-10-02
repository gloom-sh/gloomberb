/**
 * Key and prefix cells for the Help tables.
 *
 * The badge is what these lists have always used for a key or a typed prefix,
 * so it stays in the cell: `DataTableCell.content` takes a node, the same way
 * ticker chips ride in a table cell elsewhere. `text` is kept in step for CSV
 * export, which only sees the text.
 */
import type { DataTableCell } from "../../../components";
import { Badge } from "../../../components";
import { t } from "../../../i18n";
import { Box, Text } from "../../../ui";
import { displayWidth } from "../../../utils/format";

/** A badge is its label plus one cell of padding on each side. */
const BADGE_CHROME_WIDTH = 2;
const BADGE_GAP = 1;

function badgeGroupWidth(labels: readonly string[]): number {
  if (labels.length === 0) return 0;
  return labels.reduce((total, label) => total + displayWidth(label) + BADGE_CHROME_WIDTH, 0)
    + BADGE_GAP * (labels.length - 1);
}

/** Widest badge group in a set of rows, clamped so one long chord cannot take the row. */
export function badgeColumnWidth(
  groups: ReadonlyArray<readonly string[]>,
  { min = 6, max = 24 }: { min?: number; max?: number } = {},
): number {
  const widest = groups.reduce((width, labels) => Math.max(width, badgeGroupWidth(labels)), 0);
  return Math.max(min, Math.min(max, widest));
}

export function badgeCell(
  labels: readonly string[],
  width: number,
  options: { tone?: "neutral" | "accent"; emptyLabel?: string; emptyColor?: string } = {},
): DataTableCell {
  if (labels.length === 0) {
    return options.emptyLabel
      ? { text: options.emptyLabel, color: options.emptyColor }
      : { text: "" };
  }
  return {
    text: labels.join(" "),
    content: (
      <Box flexDirection="row" gap={BADGE_GAP} width={width} height={1} overflow="hidden">
        {labels.map((label, index) => (
          <Badge key={`${label}:${index}`} label={label} variant="solid" tone={options.tone ?? "neutral"} />
        ))}
      </Box>
    ),
  };
}

/** Muted placeholder text that still lines up with a badge cell. */
export function mutedCell(text: string, color: string): DataTableCell {
  return {
    text,
    content: (
      <Box flexDirection="row" height={1} paddingX={1} overflow="hidden">
        <Text fg={color}>{t(text)}</Text>
      </Box>
    ),
  };
}
