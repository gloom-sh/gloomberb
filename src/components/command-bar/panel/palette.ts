import { useMemo } from "react";
import {
  commandBarAccentText, commandBarBg, commandBarHeadingText, commandBarHoverBg,
  commandBarInputBg, commandBarMatchText, commandBarPanelBg, commandBarSelectedBg,
  commandBarSelectedText, commandBarSubtleText, commandBarText,
} from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";

export function useCommandBarPalette(native: boolean) {
  const colors = useThemeColors();
  return useMemo(() => ({
    bg: commandBarBg(colors),
    panelBg: native ? commandBarPanelBg(colors) : commandBarBg(colors),
    inputBg: native ? commandBarInputBg(colors) : commandBarBg(colors),
    accent: commandBarAccentText(colors),
    heading: commandBarHeadingText(colors),
    hoverBg: commandBarHoverBg(colors),
    match: commandBarMatchText(colors),
    selectedBg: commandBarSelectedBg(colors),
    selectedText: commandBarSelectedText(colors),
    subtle: commandBarSubtleText(colors),
    text: commandBarText(colors),
    border: colors.border,
    borderFocused: colors.borderFocused,
    negative: colors.negative,
    panel: colors.panel,
  }), [colors, native]);
}
