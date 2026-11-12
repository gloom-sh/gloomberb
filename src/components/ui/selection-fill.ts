import { usePaneFocused } from "../../state/app/activity";
import { inactiveSelectedBg, inactiveSelectedText } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { useUiCapabilities } from "../../ui/host";

export interface SelectionFill {
  /** The chosen row's or tile's fill. */
  bg: string;
  /**
   * The keys move this selection: the selected text colour goes with the fill.
   * Off, the row keeps its own text colours on the quieter fill.
   */
  lit: boolean;
  /**
   * A colour of the chosen item's own drawn on the fill: as it is under the
   * lit selection (which draws its own text colour where it has one), lifted
   * where it would not read on the inactive fill.
   */
  ink(color: string): string;
}

/**
 * The fill of a list's, table's or grid's chosen item in the terminal: the
 * selection in the focused pane (and outside any pane, a dialog's list), the
 * inactive selection in a pane that does not have the keyboard, so only one
 * pane reads as the one the arrows move. The desktop marks focus its own way,
 * so it keeps the selection.
 */
export function useSelectionFill(): SelectionFill {
  const colors = useThemeColors();
  const paneFocused = usePaneFocused();
  const { nativePaneChrome } = useUiCapabilities();
  const lit = nativePaneChrome === true || paneFocused !== false;
  return {
    bg: lit ? colors.selected : inactiveSelectedBg(colors),
    lit,
    ink: (color) => (lit ? color : inactiveSelectedText(color, colors)),
  };
}
