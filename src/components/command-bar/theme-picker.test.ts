import { describe, expect, test } from "bun:test";
import { getPresets, resolvePresetSelection, stylesAreSelectable } from "../../theme/presets";
import { getSchemeIds, hasScheme } from "../../theme/schemes";
import { DEFAULT_STYLE, hasStyle } from "../../theme/styles";
import { matchThemeOptions } from "./theme-picker";

describe("theme picker matching", () => {
  test("lists the curated presets, not the whole grid", () => {
    const options = matchThemeOptions("", "theme");
    expect(options.length).toBe(getPresets().length);
    for (const option of options) {
      expect(hasStyle(option.styleId)).toBe(true);
      expect(hasScheme(option.schemeId)).toBe(true);
    }
  });

  test("colors mode lists schemes and names no style, so the active one is kept", () => {
    const options = matchThemeOptions("", "colors");
    expect(options.length).toBe(getSchemeIds().length);
    for (const option of options) {
      expect(option.styleId).toBe("");
      expect(hasScheme(option.schemeId)).toBe(true);
    }
  });

  test("with several styles on offer, the list groups by style with the default first", () => {
    expect(stylesAreSelectable()).toBe(true);
    const options = matchThemeOptions("", "theme");
    expect(options[0]!.styleId).toBe(DEFAULT_STYLE);
    // Every option names both halves, so a row reads as one theme.
    for (const option of options) {
      expect(option.name).toBe(`${option.styleName} ${option.schemeName}`);
    }
    // Grouped: a style's entries are contiguous.
    const seen = new Set<string>();
    let previous = "";
    for (const option of options) {
      if (option.styleId !== previous) {
        expect(seen.has(option.styleId), option.styleId).toBe(false);
        seen.add(option.styleId);
        previous = option.styleId;
      }
    }
  });

  test("a filter matches a scheme or a style by name or id", () => {
    expect(matchThemeOptions("amber", "theme").every((option) => option.schemeId === "amber")).toBe(true);
    expect(matchThemeOptions("amber", "theme").length).toBeGreaterThan(1);
    expect(new Set(matchThemeOptions("nord", "theme").map((option) => option.schemeId)))
      .toEqual(new Set(["nord", "nord-light"]));
    // "Green Phosphor" is a scheme name too, so the style filter also finds
    // those; what matters is that every phosphor preset is in the result.
    expect(matchThemeOptions("rounded", "theme").every((option) => option.styleId === "rounded")).toBe(true);
    expect(matchThemeOptions("phosphor", "theme").filter((option) => option.styleId === "phosphor").length)
      .toBe(getPresets().filter((preset) => preset.styleId === "phosphor").length);
  });

  test("a filter with no match returns nothing rather than everything", () => {
    expect(matchThemeOptions("zzzz", "theme")).toEqual([]);
    expect(matchThemeOptions("zzzz", "colors")).toEqual([]);
  });

  test("the colors list is sorted by name, so it can be read to find one", () => {
    const names = matchThemeOptions("", "colors").map((option) => option.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

describe("preset selection", () => {
  test("resolves a preset id to its pair", () => {
    expect(resolvePresetSelection("terminal-catppuccin")).toEqual({ styleId: "terminal", schemeId: "catppuccin" });
    expect(resolvePresetSelection("Terminal Catppuccin")).toEqual({ styleId: "terminal", schemeId: "catppuccin" });
  });

  test("a bare scheme id keeps the caller's style, which is how old configs read", () => {
    expect(resolvePresetSelection("nord", "terminal")).toEqual({ styleId: "terminal", schemeId: "nord" });
  });

  // "paper" is both a scheme and a style. A bare name is read as the scheme,
  // which is what a pre-styles config meant by it; the style is reached by
  // its preset id.
  test("an ambiguous bare name resolves to the scheme", () => {
    expect(resolvePresetSelection("paper", "terminal")).toEqual({ styleId: "terminal", schemeId: "paper" });
    expect(resolvePresetSelection("paper-paper")).toEqual({ styleId: "paper", schemeId: "paper" });
  });

  test("a composite id reaches any style and scheme pair, curated or not", () => {
    expect(resolvePresetSelection("modern-catppuccin")).toEqual({ styleId: "modern", schemeId: "catppuccin" });
    expect(resolvePresetSelection("phosphor-amber")).toEqual({ styleId: "phosphor", schemeId: "amber" });
    expect(resolvePresetSelection("minimal-nord-light")).toEqual({ styleId: "minimal", schemeId: "nord-light" });
    // Not a curated pairing, still a valid one.
    expect(resolvePresetSelection("rounded-amber")).toEqual({ styleId: "rounded", schemeId: "amber" });
  });
});
