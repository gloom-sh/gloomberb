import type { InsiderSignalSide } from "../../../api-client/insider-signals";
import type { DataTableCell } from "../../../components";
import type { ThemeColors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../../ui";
import { missingCell } from "../shared/research-cells";
import { INSIDER_BOTH_WAYS_MARK, type InsiderSignalFact } from "./signals-model";

/**
 * A fact's colour, the roles the why chips had: the side's tone for a fact
 * the ranking counts, a holding's change in its sign's tone, NEW and EXITED
 * too; plain text for a figure it does not count; the research panes' muted
 * placeholder for the dash.
 */
function factColor(fact: InsiderSignalFact, side: InsiderSignalSide, colors: ThemeColors): string {
  if (fact.weight === "none") return colors.textMuted;
  if (fact.weight === "plain") return colors.text;
  return (fact.sign ?? (side === "sell" ? -1 : 1)) < 0 ? colors.negative : colors.positive;
}

/**
 * A fact as figures right-aligned in their cell: NEW and EXITED bold, a stake
 * counted on the net with the both-ways mark after it, muted. `width` sets it
 * in that many cells (the terminal's table); without it the content grows to
 * its track.
 */
function FactFigures({ fact, side, selected, width }: { fact: InsiderSignalFact; side: InsiderSignalSide; selected: boolean; width?: number }) {
  const colors = useThemeColors();
  const figure = fact.bothWays ? fact.text.slice(0, -(INSIDER_BOTH_WAYS_MARK.length + 1)) : fact.text;
  return (
    <Box flexDirection="row" height={1} overflow="hidden" justifyContent="flex-end" flexGrow={1} width={width}>
      <Text fg={selected ? colors.selectedText : factColor(fact, side, colors)} attributes={fact.weight === "strong" ? TextAttributes.BOLD : TextAttributes.NONE}>{figure}</Text>
      {fact.bothWays ? <Text fg={selected ? colors.selectedText : colors.textMuted}>{` ${INSIDER_BOTH_WAYS_MARK}`}</Text> : null}
    </Box>
  );
}

/**
 * A fact's table cell, in the ranking and in an opened company's insiders:
 * plain text in its colour, or the figures with the both-ways mark. `width`
 * is the column's, in the terminal, where content is set in its own cells.
 */
export function factCell(fact: InsiderSignalFact, side: InsiderSignalSide, colors: ThemeColors, selected: boolean, width?: number): DataTableCell {
  if (fact.weight === "none" && !fact.bothWays) return missingCell(colors);
  const cell: DataTableCell = {
    text: fact.text,
    value: fact.value,
    color: factColor(fact, side, colors),
    ...(fact.weight === "strong" ? { attributes: TextAttributes.BOLD } : {}),
  };
  return fact.bothWays ? { ...cell, content: <FactFigures fact={fact} side={side} selected={selected} width={width} /> } : cell;
}
