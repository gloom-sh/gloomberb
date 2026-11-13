import { colors, type ThemeColors } from "../../theme/colors";
import { NOT_MEANINGFUL_TEXT } from "../../utils/growth";

/**
 * The colour N/M is drawn in, in every pane (FA, KPIS, RV, ERN, EVTS, DVD, DES): the text's own, as RV has drawn a
 * P/E over a loss. Never dimmed as a figure that is missing, nor green or red as a gain or a loss: a change off a
 * base at or below zero, or a margin over revenue at or below zero, says nothing either way.
 */
export function notMeaningfulColor(palette: Pick<ThemeColors, "text"> = colors): string {
  return palette.text;
}

/** An N/M table cell, as every pane draws one (notMeaningfulColor). */
export function notMeaningfulCell(palette: Pick<ThemeColors, "text"> = colors): { text: string; color: string } {
  return { text: NOT_MEANINGFUL_TEXT, color: notMeaningfulColor(palette) };
}
