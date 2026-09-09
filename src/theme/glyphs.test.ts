import { describe, expect, test } from "bun:test";
import { displayWidth } from "../utils/format";
import { BORDER_KINDS, resolveGlyphs, sparklineBlock } from "./glyphs";
import { getStyleIds, getStyle, type GlyphMode } from "./styles";

const MODES: GlyphMode[] = ["unicode", "ascii", "nerd"];
/** Not marks: the repertoire's own name and a multi-character string. */
const NON_GLYPH_SLOTS = new Set(["mode", "ellipsis"]);
/**
 * The one mark allowed to be East Asian Wide, because its callers measure it
 * instead of assuming a column. Everything else is used in fixed-width
 * arithmetic, so a two-cell glyph there would shift the row.
 */
const MAY_BE_WIDE = new Set(["bolt"]);
/** Private-use marks are easy to lose in tooling, and an empty one collapses a column. */
const PRIVATE_USE_RE = /[\ue000-\uf8ff]/u;

/**
 * Every leaf in the table, so a new repertoire cannot ship with a hole that
 * only shows up as an empty cell in one pane. Array indices collapse to `[]`:
 * a spinner is a cycle, so its length is the repertoire's business, but the
 * slot itself has to exist.
 */
function collectGlyphs(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((entry) => collectGlyphs(entry, `${path}[]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => collectGlyphs(entry, path ? `${path}.${key}` : key));
  }
  return [];
}

describe("glyph table", () => {
  test("every repertoire fills every slot the unicode one does", () => {
    const slots = (mode: GlyphMode) => [
      ...new Set(collectGlyphs(resolveGlyphs(mode, "line")).map(([path]) => path)),
    ].sort();
    const reference = slots("unicode");
    for (const mode of MODES) {
      expect(slots(mode)).toEqual(reference);
    }
  });

  test("every glyph occupies exactly one cell", () => {
    for (const mode of MODES) {
      for (const border of BORDER_KINDS) {
        for (const [path, glyph] of collectGlyphs(resolveGlyphs(mode, border))) {
          if (NON_GLYPH_SLOTS.has(path)) continue;
          const width = displayWidth(glyph);
          const label = `${mode}/${border} ${path} = ${JSON.stringify(glyph)}`;
          expect(width, label).toBeGreaterThan(0);
          if (!MAY_BE_WIDE.has(path)) expect(width, label).toBe(1);
        }
      }
    }
  });

  test("the nerd repertoire keeps its private-use marks", () => {
    const nerd = collectGlyphs(resolveGlyphs("nerd", "line"));
    const patched = nerd.filter(([, glyph]) => PRIVATE_USE_RE.test(glyph));
    expect(patched.length).toBeGreaterThan(4);
    for (const [path, glyph] of patched) {
      expect(displayWidth(glyph), `nerd ${path}`).toBe(1);
    }
  });

  test("an ascii repertoire stays inside ascii, borders included", () => {
    for (const border of BORDER_KINDS) {
      for (const [path, glyph] of collectGlyphs(resolveGlyphs("ascii", border))) {
        if (path === "mode") continue;
        for (const character of glyph) {
          expect(character.codePointAt(0)!).toBeLessThan(128);
        }
      }
    }
  });

  test("border kinds keep their own corners", () => {
    expect(resolveGlyphs("unicode", "line").border.topLeft).toBe("┌");
    expect(resolveGlyphs("unicode", "double").border.topLeft).toBe("╔");
    expect(resolveGlyphs("unicode", "rounded").border.topLeft).toBe("╭");
    expect(resolveGlyphs("unicode", "heavy").border.topLeft).toBe("┏");
    expect(resolveGlyphs("unicode", "none").borderless).toBe(true);
  });

  test("every shipped style resolves a usable set", () => {
    for (const styleId of getStyleIds()) {
      const style = getStyle(styleId);
      const set = resolveGlyphs(style.glyphs, style.chrome.paneBorder);
      expect(set.mode).toBe(style.glyphs);
      expect(set.borderless).toBe(style.chrome.paneBorder === "none");
      expect(set.spinner.length).toBeGreaterThan(0);
      expect(set.sparkline.length).toBe(9);
    }
  });

  test("sparkline blocks clamp to the available steps", () => {
    const set = resolveGlyphs("unicode", "line");
    expect(sparklineBlock(set, 0)).toBe(set.sparkline[0]);
    expect(sparklineBlock(set, 1)).toBe(set.sparkline.at(-1));
    expect(sparklineBlock(set, 5)).toBe(set.sparkline.at(-1));
    expect(sparklineBlock(set, -1)).toBe(set.sparkline[0]);
  });
});
