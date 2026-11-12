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
import { wrapTextLines } from "../../../utils/text-wrap";

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

/**
 * The chips of a group that fit a column whole, in order. A chip that would be
 * cut ("Ctrl+Hor") is left out instead, so what shows is always a real key; the
 * first chip stays whatever the width.
 */
export function wholeBadges(labels: readonly string[], width: number): readonly string[] {
  let count = Math.min(1, labels.length);
  while (count < labels.length && badgeGroupWidth(labels.slice(0, count + 1)) <= width) count += 1;
  return labels.slice(0, count);
}

export function badgeCell(
  labels: readonly string[],
  width: number,
  options: { tone?: "neutral" | "accent"; emptyLabel?: string; emptyColor?: string; wholeOnly?: boolean } = {},
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
        {(options.wholeOnly ? wholeBadges(labels, width) : labels).map((label, index) => (
          <Badge key={`${label}:${index}`} label={label} variant="solid" tone={options.tone ?? "neutral"} />
        ))}
      </Box>
    ),
  };
}

/** One line of a Help row in the terminal: the chips and the words that sit on it. */
export interface HelpRowLine {
  badges: readonly string[];
  /** The words of a column between the chips and the text (Functions' ARG). */
  middle?: string;
  text: string;
  /** A line under the row's first, which the cursor passes over. */
  continued: boolean;
}

/**
 * A Help row in the terminal as the lines it takes: its chips packed whole
 * into the key column and its words wrapped across the text column, each
 * going on under the first line, never cut. Help is where a key or a
 * description is read whole (review, 12 Nov 2026: "Alt+Enter   Ctrl+Shift+",
 * "what it shows, its ke…").
 */
export function helpRowLines(
  badges: readonly string[],
  text: string,
  keyWidth: number,
  textWidth: number,
  middle?: { text: string; width: number },
): HelpRowLine[] {
  const chipLines: string[][] = [];
  for (const badge of badges) {
    const line = chipLines.at(-1);
    if (line && badgeGroupWidth([...line, badge]) <= keyWidth) line.push(badge);
    else chipLines.push([badge]);
  }
  const textLines = text ? wrapTextLines(text, Math.max(1, textWidth)) : [];
  const middleLines = middle?.text ? wrapTextLines(middle.text, Math.max(1, middle.width)) : [];
  const count = Math.max(1, chipLines.length, textLines.length, middleLines.length);
  return Array.from({ length: count }, (_, index) => ({
    badges: chipLines[index] ?? [],
    ...(middle ? { middle: middleLines[index] ?? "" } : {}),
    text: textLines[index] ?? "",
    continued: index > 0,
  }));
}

/**
 * Cells a table's text column gets beside a key column `keyWidth` wide, in a
 * table `width` wide with `padding` on each side: one gap between the two,
 * the lane its scrollbar takes and the cell the last column keeps clear.
 */
export function helpTextWidth(width: number, keyWidths: number, padding: number, columns = 2): number {
  return width - padding * 2 - keyWidths - (columns - 1) - 2;
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
