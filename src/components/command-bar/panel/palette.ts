import { useMemo } from "react";
import { useThemeTokens } from "../../../theme/theme-context";

/**
 * The command bar's surface, straight off the resolved tokens. `native` picks
 * the DOM's layered sheet, where the panel and the input sit on their own
 * surfaces, over the terminal's single flat one.
 */
export function useCommandBarPalette(native: boolean) {
  const tokens = useThemeTokens();
  return useMemo(() => {
    const { commandBar } = tokens;
    return {
      bg: commandBar.bg,
      panelBg: native ? commandBar.panelBg : commandBar.bg,
      inputBg: native ? commandBar.inputBg : commandBar.bg,
      accent: commandBar.accentText,
      heading: commandBar.headingText,
      hoverBg: commandBar.hoverBg,
      match: commandBar.matchText,
      selectedBg: commandBar.selectedBg,
      selectedText: commandBar.selectedText,
      subtle: commandBar.subtleText,
      text: commandBar.text,
      border: commandBar.border,
      borderFocused: commandBar.borderFocused,
      negative: tokens.text.negative,
      panel: tokens.surface.panel,
    };
  }, [native, tokens]);
}
