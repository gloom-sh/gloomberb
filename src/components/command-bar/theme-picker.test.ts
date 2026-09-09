import { describe, expect, test } from "bun:test";
import { getPresets, resolvePresetSelection } from "../../theme/presets";
import { hasScheme } from "../../theme/schemes";
import { hasStyle } from "../../theme/styles";
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
    expect(options.length).toBeGreaterThan(getPresets().length);
    for (const option of options) {
      expect(option.styleId).toBe("");
      expect(hasScheme(option.schemeId)).toBe(true);
    }
  });

  test("a filter matches either half of a theme's name", () => {
    expect(matchThemeOptions("modern", "theme").every((option) => option.styleId === "modern")).toBe(true);
    expect(matchThemeOptions("amber", "theme").every((option) => option.schemeId === "amber")).toBe(true);
    expect(matchThemeOptions("phosphor amber", "theme").map((option) => option.id)).toEqual(["phosphor-amber"]);
  });

  test("a filter with no match returns nothing rather than everything", () => {
    expect(matchThemeOptions("zzzz", "theme")).toEqual([]);
    expect(matchThemeOptions("zzzz", "colors")).toEqual([]);
  });

  test("presets sort by style then scheme, so the list reads as groups", () => {
    const keys = matchThemeOptions("", "theme").map((option) => `${option.styleName}/${option.schemeName}`);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("preset selection", () => {
  test("resolves a preset id to its pair", () => {
    expect(resolvePresetSelection("modern-catppuccin")).toEqual({ styleId: "modern", schemeId: "catppuccin" });
    expect(resolvePresetSelection("Modern Catppuccin")).toEqual({ styleId: "modern", schemeId: "catppuccin" });
  });

  test("a bare scheme id keeps the caller's style, which is how old configs read", () => {
    expect(resolvePresetSelection("nord", "phosphor")).toEqual({ styleId: "phosphor", schemeId: "nord" });
  });

  test("a bare style id leaves the scheme to the caller", () => {
    expect(resolvePresetSelection("paper", "terminal")).toEqual({ styleId: "paper", schemeId: "" });
  });
});
