import { blendForContrast, higherContrast } from "./color-utils";
import { colors, floatingPaneTitleBg, paneTitleBg } from "./colors";
import type { ThemeColors } from "./colors";

/**
 * Whether the theme reads its text at body contrast on every surface, its
 * tones and hints included: the light and colour-blind themes
 * (Theme.readableTones). Dark themes draw as they always have.
 */
export function readsAtBodyContrast(palette: ThemeColors = colors): boolean {
  return palette.readableTones === true;
}

/**
 * A cell's colour in a selected row: an up, down, warning or neutral tone as the
 * theme lifts it to read on the selection (Theme.selectedNegative), any other
 * colour as it is. Data tables draw every coloured cell of the selected row
 * through it, in the terminal and on the desktop alike.
 */
export function selectedCellColor<T extends string | undefined>(color: T, palette: ThemeColors = colors): T | string {
  if (color === undefined) return color;
  if (color === palette.positive) return palette.selectedPositive ?? color;
  if (color === palette.negative) return palette.selectedNegative ?? color;
  if (color === palette.warning) return palette.selectedWarning ?? color;
  if (color === palette.neutral) return palette.selectedNeutral ?? color;
  return color;
}

/** Whether a colour is the theme's up or down tone, which a selected row keeps (selectedRowCellColor). */
function isDirectionTone(color: string, palette: ThemeColors): boolean {
  return color === palette.positive || color === palette.negative;
}

/**
 * The colour a cell of the selected row is drawn in, null for the
 * selection's own text colour: a cell with no colour of its own takes it,
 * and so does every other cell of a table that sets
 * `selectedTextOverridesCellColor`, except an up or down figure, which keeps
 * its direction (lifted by selectedCellColor) in every table, and a cell
 * that asks to keep its colour. The band shows the selection; the -6.31% on
 * it stays red. Both table renderers draw through it.
 */
export function selectedRowCellColor(
  color: string | undefined,
  overrides: boolean,
  keep: boolean | undefined,
  palette: ThemeColors = colors,
): string | null {
  if (color === undefined) return null;
  if (overrides && !keep && !isDirectionTone(color, palette)) return null;
  return selectedCellColor(color, palette);
}

/**
 * A tone on the pane title bar, such as a quick setting that is on (the live
 * ⚡): lifted to body contrast on the bar in a theme that reads its tones so
 * (Theme.readableTones), since the bar sits darker than the page
 * its tokens are checked on; as it is in any other theme.
 */
export function paneTitleTone(tone: string, focused: boolean, floating = false, palette: ThemeColors = colors): string {
  if (!readsAtBodyContrast(palette)) return tone;
  const bar = floating ? floatingPaneTitleBg(focused, palette) : paneTitleBg(focused, palette);
  return blendForContrast(tone, bar, higherContrast("#000000", "#ffffff", bar), 4.5);
}
