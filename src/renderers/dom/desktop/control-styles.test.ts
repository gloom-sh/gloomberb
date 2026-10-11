import { expect, test } from "bun:test";
import { getThemeColors } from "../../../theme/colors";
import { getThemeIds } from "../../../theme/themes";
import { buttonShadow } from "./control-styles";

const SOLID = [
  { variant: "primary" },
  { variant: "danger" },
  { variant: "secondary", active: true },
] as const;

test("a solid button takes no top highlight mixed from the page background, in any theme", () => {
  for (const id of getThemeIds()) {
    const palette = getThemeColors(id);
    for (const props of SOLID) {
      // The fill is an accent, not a surface: an inset line mixed from the page
      // background is a dark rim on a light fill and a pale one on a saturated fill.
      expect(buttonShadow(props, palette)).not.toContain("inset");
    }
  }
});

test("buttons on a surface keep their highlight, a selected one keeps its halo, a plain one has no shadow", () => {
  const palette = getThemeColors("white");
  for (const props of [{ variant: "secondary" }, { variant: "ghost" }, { variant: "primary", disabled: true }] as const) {
    expect(buttonShadow(props, palette)).toMatch(/^inset 0 1px 0 #[0-9a-f]{6}$/i);
  }
  expect(buttonShadow({ variant: "secondary", active: true }, palette)).toMatch(/^0 0 0 1px #[0-9a-f]{6}$/i);
  expect(buttonShadow({ variant: "plain" }, palette)).toBe("none");
});
