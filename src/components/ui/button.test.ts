import { expect, test } from "bun:test";
import { contrastRatio } from "../../theme/color-utils";
import { getThemeColors } from "../../theme/colors";
import { getThemeIds } from "../../theme/themes";
import { buttonShortcutColor, resolveButtonColors, type ButtonVariant } from "./button";

// colorblind-light's welcome card drew Connect's Alt+Enter in the page's dim text on the primary fill: 2.07:1.
test("a button's key reads on its own fill in every theme, and stays the quiet dim text beside an unfilled one", () => {
  for (const id of getThemeIds()) {
    const colors = getThemeColors(id);
    for (const [variant, active, tone] of [["primary", false], ["danger", false], ["secondary", true], ["primary", false, "positive"]] as const) {
      const palette = resolveButtonColors(variant as ButtonVariant, active, false, colors, tone);
      const key = buttonShortcutColor(palette, false, colors);
      expect(key).toBe(palette.fg);
      if (contrastRatio(key, palette.bg!) < contrastRatio(colors.textDim, palette.bg!)) {
        throw new Error(`${id} ${variant}: its key reads worse than the dim text did`);
      }
    }
    for (const variant of ["secondary", "ghost", "plain"] as const) {
      expect(buttonShortcutColor(resolveButtonColors(variant, false, false, colors), false, colors)).toBe(colors.textDim);
    }
    expect(buttonShortcutColor(resolveButtonColors("primary", false, true, colors), true, colors)).toBe(colors.textMuted);
  }
  const light = getThemeColors("colorblind-light");
  const connect = resolveButtonColors("primary", false, false, light);
  expect(contrastRatio(buttonShortcutColor(connect, false, light), connect.bg!)).toBeGreaterThanOrEqual(4.5);
});
