import { expect, test } from "bun:test";
import { relativeLuminance } from "../../../theme/color-utils";
import { getThemeColors } from "../../../theme/colors";
import { getThemeIds } from "../../../theme/themes";
import { buttonPalette, buttonRelief } from "./control-styles";

const SOLID = [
  { variant: "primary" },
  { variant: "danger" },
  { variant: "secondary", active: true },
] as const;

const THEMES = getThemeIds().map((id) => ({ id, palette: getThemeColors(id) }));

test("a solid button's relief comes from its own fill, never from the page behind it", () => {
  for (const { palette } of THEMES) {
    const otherPage = { ...palette, bg: "#3a1f5c", panel: "#5c3a1f", border: "#1f5c3a", textBright: "#808080" };
    for (const props of SOLID) {
      expect(buttonRelief(props, otherPage)).toEqual(buttonRelief(props, palette));
    }
  }
});

test("a solid button is lit from above in every theme, with no line along its top edge", () => {
  for (const { id, palette } of THEMES) {
    for (const props of SOLID) {
      const fill = buttonPalette(props, palette).bg;
      const relief = buttonRelief(props, palette);
      const [top, shade, edge] = relief.backgroundImage?.match(/#[0-9a-f]{6}/gi) ?? [];
      const label = `${id} ${props.variant}${"active" in props ? " active" : ""}`;
      expect(relativeLuminance(top!), label).toBeGreaterThanOrEqual(relativeLuminance(fill));
      expect(relativeLuminance(shade!), label).toBeLessThan(relativeLuminance(fill));
      expect(relativeLuminance(edge!), label).toBeLessThan(relativeLuminance(shade!));
      // An inset shadow is drawn inside the border, which is the rim this replaced.
      expect(relief.boxShadow, label).not.toContain("inset");
      expect(relief.boxShadow, label).toContain("0 1px 2px");
    }
  }
});

test("one recipe: the same fill gets the same relief, whatever the theme or variant", () => {
  const reference = getThemeColors("white");
  for (const { palette } of THEMES) {
    expect(buttonRelief({ variant: "primary" }, palette))
      .toEqual(buttonRelief({ variant: "danger" }, { ...reference, negative: palette.borderFocused }));
  }
});

test("disabled, ghost and plain buttons stay flat", () => {
  for (const { palette } of THEMES) {
    for (const props of [{ variant: "primary", disabled: true }, { variant: "secondary", active: true, disabled: true }, { variant: "ghost" }, { variant: "plain" }] as const) {
      expect(buttonRelief(props, palette)).toEqual({ boxShadow: "none" });
    }
  }
});
