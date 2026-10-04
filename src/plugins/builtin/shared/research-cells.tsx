import type { DataTableCell, DataTableColumn } from "../../../components";
import { SplitBar } from "../../../components/ui/split-bar";
import { blendHex } from "../../../theme/colors";
import type { ThemeColors } from "../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../ui";
import { displayWidth } from "../../../utils/format";

/**
 * Cells the research data panes share, so attention, hiring, awards, power and
 * the rest read the same way: one muted placeholder, moves coloured by sign,
 * a listing as its symbol with the venue quiet beside it, and a share as a
 * length next to its number.
 */

/** The one placeholder for a value the source does not give. */
const NO_VALUE = "--";

export const missingCell = (colors: ThemeColors): DataTableCell => ({ text: NO_VALUE, value: null, color: colors.textMuted });

/** A move or a change: green up, red down, quiet at zero. */
export function signedColor(value: number | null | undefined, colors: ThemeColors): string {
  return value == null || value === 0 ? colors.textMuted : value > 0 ? colors.positive : colors.negative;
}

/** `6758:JPX` reads as the symbol, with the venue after it in a quieter colour. */
export function listingCell(key: string | null | undefined, colors: ThemeColors, selected: boolean): DataTableCell {
  if (!key) return missingCell(colors);
  const at = key.indexOf(":");
  const symbol = at > 0 ? key.slice(0, at) : key;
  const venue = at > 0 ? key.slice(at + 1) : "";
  return { text: key, content: <Box flexDirection="row" height={1} overflow="hidden">
    <Text fg={selected ? colors.selectedText : colors.textBright} attributes={TextAttributes.BOLD}>{symbol}</Text>
    {venue ? <Text fg={selected ? colors.selectedText : colors.textDim}>{` ${venue}`}</Text> : null}
  </Box> };
}

/**
 * A share of a whole as its number and a bar measured against the largest row,
 * so the eye compares lengths down the column. The bar gives way first in a
 * narrow column; the number never does.
 */
export function shareCell(text: string, ratio: number | null, width: number, colors: ThemeColors, selected: boolean, desktop: boolean,
  color = blendHex(colors.bg, colors.borderFocused, 0.6)): DataTableCell {
  const textCells = displayWidth(text);
  const barCells = width - textCells - 1;
  if (ratio == null || !(ratio > 0) || barCells < 4) return { text, color: selected ? colors.selectedText : colors.text };
  const fill = Math.max(0, Math.min(1, ratio));
  const ink = selected ? colors.selectedText : color;
  // The desktop draws the bar on a faint track; terminal cells draw the length alone, at half-cell steps,
  // since a track of block cells would join the rows above and below into one wall.
  const units = Math.max(1, Math.round(fill * barCells * 2));
  return { text, content: <Box flexDirection="row" height={1} width={width} overflow="hidden" alignItems="center">
    <Box width={barCells} flexShrink={0} alignItems="center">
      {desktop ? <SplitBar width={barCells} parts={[{ id: "share", value: fill, color: ink }, { id: "rest", value: 1 - fill, color: blendHex(colors.bg, color, 0.2) }]} />
        : <Text fg={ink}>{`${"█".repeat(Math.floor(units / 2))}${units % 2 ? "▌" : ""}`}</Text>}
    </Box>
    <Box flexGrow={1} justifyContent="flex-end"><Text fg={selected ? colors.selectedText : colors.text}>{` ${text}`}</Text></Box>
  </Box> };
}

/**
 * Parts of a whole as one bar, strongest part first. The desktop uses the kit
 * bar; terminal cells step down from solid to light shade, so neighbouring
 * rows read as separate bars rather than one block.
 */
export function PartsBar({ parts, width, desktop }: { parts: Array<{ id: string; value: number; color: string }>; width: number; desktop: boolean }) {
  if (desktop) return <Box width={width} height={1} alignItems="center"><SplitBar width={width} parts={parts} /></Box>;
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
  if (!(total > 0) || width <= 0) return <Text>{""}</Text>;
  const glyphs = ["█", "▓", "▒", "░"];
  let used = 0;
  return <Box flexDirection="row" width={width} height={1} overflow="hidden">
    {parts.map((part, index) => {
      const cells = index === parts.length - 1 ? Math.max(0, width - used) : Math.round(Math.max(0, part.value) / total * width);
      used += cells;
      return part.value > 0 && cells > 0 ? <Text key={part.id} fg={part.color}>{(glyphs[index] ?? "░").repeat(cells)}</Text> : null;
    })}
  </Box>;
}

/** A state word in its tone: the same status reads the same in every pane. */
export type StateTone = "positive" | "negative" | "warning" | "accent" | "muted" | "text";
export function toneColor(tone: StateTone, colors: ThemeColors): string {
  return tone === "accent" ? colors.borderFocused : tone === "muted" ? colors.textMuted : tone === "text" ? colors.text : colors[tone];
}

/** `ACTIVE_NOT_RECRUITING`, `active not recruiting` and `deadlineDate` all read as words. */
export function humanLabel(value: string): string {
  const spaced = value.trim().replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  return spaced.replace(/^./, (first) => first.toUpperCase()).replace(/\b(ai|us|uk|eu|fda|ema|sec|ftc|doj|ofac|usa)\b/gi, (word) => word.toUpperCase());
}

/**
 * Drops the columns whose cells read the same default on every row: a scope
 * that is always "Project", a missing count that is always zero. A row that
 * differs brings the column back; a uniform value that is not a default stays.
 */
export function withoutQuietColumns<T>(columns: DataTableColumn[], rows: readonly T[], read: (row: T, columnId: string) => unknown,
  quiet: Readonly<Record<string, readonly string[]>>): DataTableColumn[] {
  if (!rows.length) return columns;
  return columns.filter((column) => {
    const defaults = quiet[column.id];
    if (!defaults) return true;
    const first = String(read(rows[0]!, column.id) ?? "");
    return !defaults.includes(first) || rows.some((row) => String(read(row, column.id) ?? "") !== first);
  });
}
