import { describe, expect, test } from "bun:test";
import { contrastRatio } from "./color-utils";
import { getSchemeIds } from "./schemes";
import { getStyleIds, getStyle } from "./styles";
import { auditContrast, resolveTheme } from "./tokens";

/** One dark, one light, one mid-tone, so a recipe cannot pass by luck. */
const SAMPLE_SCHEMES = ["amber", "catppuccin", "paper", "github-light"];

describe("resolveTheme", () => {
  test("gives every style and scheme pair readable tokens", () => {
    const failures: string[] = [];
    for (const styleId of getStyleIds()) {
      for (const schemeId of getSchemeIds()) {
        for (const failure of auditContrast(resolveTheme(schemeId, styleId).tokens)) {
          failures.push(`${styleId}/${schemeId} ${failure.label} ${failure.ratio.toFixed(2)}:1 < ${failure.min}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("memoizes per scheme and style pair", () => {
    expect(resolveTheme("amber", "terminal")).toBe(resolveTheme("amber", "terminal"));
    expect(resolveTheme("amber", "terminal")).not.toBe(resolveTheme("amber", "phosphor"));
    expect(resolveTheme("amber", "terminal").id).toBe("terminal:amber");
  });

  test("keeps the scheme palette untouched by the style", () => {
    const terminal = resolveTheme("nord", "terminal");
    const modern = resolveTheme("nord", "modern");
    expect(terminal.palette).toEqual(modern.palette);
    expect(terminal.tokens.pane.body.bg.idle).not.toBe(modern.tokens.pane.body.bg.idle);
  });

  test("an inverted header swaps the title's ink and ground", () => {
    for (const schemeId of SAMPLE_SCHEMES) {
      const { tokens } = resolveTheme(schemeId, "phosphor");
      const { title, body } = tokens.pane;
      expect(tokens.pane.chrome.invertHeader).toBe(true);
      // The strip takes the ink, the words take the body it sits on.
      expect(contrastRatio(title.text.focused, title.bg.focused)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(title.bg.focused, body.bg.focused)).toBeGreaterThan(1.5);
    }
  });

  test("a plain header sits flush on the pane body", () => {
    for (const schemeId of SAMPLE_SCHEMES) {
      const { tokens } = resolveTheme(schemeId, "modern");
      expect(tokens.pane.title.bg.idle).toBe(tokens.pane.body.bg.idle);
      expect(tokens.pane.title.bg.focused).toBe(tokens.pane.body.bg.focused);
    }
  });

  test("a bar header keeps its own tinted strip", () => {
    for (const schemeId of SAMPLE_SCHEMES) {
      const { tokens } = resolveTheme(schemeId, "terminal");
      expect(tokens.pane.title.bg.focused).not.toBe(tokens.pane.body.bg.focused);
    }
  });

  test("header-carried focus leaves the border alone and vice versa", () => {
    const headerFocus = resolveTheme("paper", "paper").tokens.pane;
    expect(getStyle("paper").chrome.focus).toBe("header");
    expect(headerFocus.border.idle).toBe(headerFocus.border.focused);
    expect(headerFocus.title.text.idle).not.toBe(headerFocus.title.text.focused);

    const borderFocus = resolveTheme("amber", "terminal").tokens.pane;
    expect(borderFocus.border.idle).not.toBe(borderFocus.border.focused);
  });

  test("whitespace separators stripe tables instead of ruling them", () => {
    expect(resolveTheme("catppuccin", "modern").tokens.table.row.stripe).toBeString();
    expect(resolveTheme("amber", "terminal").tokens.table.row.stripe).toBeNull();
  });

  test("density and border kind land on the chrome tokens", () => {
    const modern = resolveTheme("catppuccin", "modern").tokens.pane.chrome;
    expect(modern.drawsBorder).toBe(false);
    expect(modern.padding).toEqual({ x: 2, y: 1 });

    const terminal = resolveTheme("amber", "terminal").tokens.pane.chrome;
    expect(terminal.drawsBorder).toBe(true);
    expect(terminal.padding).toEqual({ x: 1, y: 0 });
    expect(terminal.boxBorderStyle).toBe("single");
    expect(resolveTheme("amber", "phosphor").tokens.pane.chrome.boxBorderStyle).toBe("heavy");
  });

  test("chart indicators stay clear of the price line colours", () => {
    for (const schemeId of SAMPLE_SCHEMES) {
      const { palette, tokens } = resolveTheme(schemeId, "terminal");
      for (const indicator of tokens.chart.indicator) {
        expect(contrastRatio(indicator, palette.bg)).toBeGreaterThanOrEqual(3.0);
        expect(indicator).not.toBe(palette.positive);
        expect(indicator).not.toBe(palette.negative);
      }
    }
  });

  test("no two styles resolve to the same chrome on the same scheme", () => {
    // The point of the split: a style has to change something a user can see,
    // not just carry a different id.
    for (const schemeId of SAMPLE_SCHEMES) {
      const signatures = getStyleIds().map((styleId) => {
        const { tokens, glyphs } = resolveTheme(schemeId, styleId);
        return JSON.stringify([
          tokens.pane.chrome.borderKind,
          tokens.pane.chrome.headerMode,
          tokens.pane.chrome.focusMode,
          tokens.pane.chrome.density,
          tokens.pane.chrome.separators,
          glyphs.mode,
          tokens.pane.body.bg.idle,
          tokens.pane.title.bg.focused,
          tokens.pane.title.text.focused,
        ]);
      });
      expect(new Set(signatures).size, schemeId).toBe(getStyleIds().length);
    }
  });

  test("an unknown scheme or style falls back rather than throwing", () => {
    const resolved = resolveTheme("not-a-scheme", "not-a-style");
    expect(resolved.palette).toEqual(resolveTheme("amber", "terminal").palette);
    expect(resolved.style.id).toBe("terminal");
  });
});
