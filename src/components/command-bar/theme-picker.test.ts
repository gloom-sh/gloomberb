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

  test("while one style ships, the theme list is the scheme list", () => {
    // The style half is not selectable yet, so a theme is a scheme again and
    // the picker must not show a column with one repeated value in it.
    expect(stylesAreSelectable()).toBe(false);
    const options = matchThemeOptions("", "theme");
    expect(options.length).toBe(getSchemeIds().length);
    expect(options.every((option) => option.styleId === DEFAULT_STYLE)).toBe(true);
    expect(options.map((option) => option.name))
      .toEqual(matchThemeOptions("", "colors").map((option) => option.name));
  });

  test("a filter matches a scheme by name or id", () => {
    expect(matchThemeOptions("amber", "theme").every((option) => option.schemeId === "amber")).toBe(true);
    expect(matchThemeOptions("nord", "theme").map((option) => option.schemeId).sort())
      .toEqual(["nord", "nord-light"]);
  });

  test("a filter with no match returns nothing rather than everything", () => {
    expect(matchThemeOptions("zzzz", "theme")).toEqual([]);
    expect(matchThemeOptions("zzzz", "colors")).toEqual([]);
  });

  test("the list is sorted by the name shown, so it can be read to find one", () => {
    const names = matchThemeOptions("", "theme").map((option) => option.name);
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

  // "paper" is both a scheme and an experimental style. While the style is not
  // offered, the scheme is what a user means by it.
  test("an ambiguous name resolves to the scheme while the style is not offered", () => {
    expect(resolvePresetSelection("paper", "terminal")).toEqual({ styleId: "terminal", schemeId: "paper" });
  });

  // The dev tooling still has to reach an experimental style by composite id,
  // which is how the shot CLI keeps capturing them for review.
  test("a composite id reaches an experimental style", () => {
    expect(resolvePresetSelection("modern-catppuccin")).toEqual({ styleId: "modern", schemeId: "catppuccin" });
    expect(resolvePresetSelection("phosphor-amber")).toEqual({ styleId: "phosphor", schemeId: "amber" });
  });
});
