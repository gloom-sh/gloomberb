import { afterEach, describe, expect, test } from "bun:test";
import {
  applyTheme,
  commandBarAccentText,
  commandBarBg,
  commandBarHeadingText,
  commandBarPanelBg,
  commandBarSelectedBg,
  commandBarSelectedText,
  commandBarSubtleText,
  commandBarText,
  colors,
  floatingPaneTitleBg,
  getChartIndicatorColor,
  inactiveSelectedBg,
  inactiveSelectedText,
  paneTitleBg,
  paneTitleText,
} from "./colors";
import { readsAtBodyContrast, selectedCellColor } from "./tone-contrast";
import { contrastRatio } from "./color-utils";
import { INACTIVE_SELECTION_MIN, INACTIVE_SELECTION_TEXT_MIN } from "./ui-tokens";
import { DEFAULT_THEME, getThemeIds, isDarkTheme, listThemes, resolveThemeId, themes, TONE_TEXT_MIN } from "./themes";

const BODY_TEXT_MIN = 4.5;
const SUBTLE_TEXT_MIN = 3.6;
const CHROME_TEXT_MIN = 4.5;
const SELECTED_SURFACE_MIN = 1.75;

function assertMinContrast(themeId: string, label: string, fg: string, bg: string, min: number): void {
  const ratio = contrastRatio(fg, bg);
  if (ratio < min) {
    throw new Error(`${themeId} ${label} contrast ${ratio.toFixed(2)} is below ${min}`);
  }
}

afterEach(() => {
  applyTheme(DEFAULT_THEME);
});

/**
 * The theme picker marks the dark half of its list with a moon, so a palette
 * that lands on the wrong side of this shows the wrong glyph, and the whole
 * gutter stops meaning anything. Pinning the light set catches a palette drifting
 * across the line when someone retunes its colours.
 */
describe("theme appearance", () => {
  test("reads every light theme as light and everything else as dark", () => {
    const light = getThemeIds().filter((id) => !isDarkTheme(id)).sort();
    expect(light).toEqual(["colorblind-light", "github-light", "gruvbox-light", "nord-light", "paper", "solarized-light"]);
  });
});

/**
 * One lookup for `config set theme`, `shot --theme` and the picker's
 * vocabulary: what the picker shows (the name) has to work where the id does.
 */
describe("theme lookup", () => {
  test("takes an id or a display name in any case and spelling of spaces", () => {
    for (const input of ["paper", "Paper", " PAPER ", "White Phosphor", "white_phosphor", "solarized light", "Tokyo Night"]) {
      expect(resolveThemeId(input).ok).toBe(true);
    }
    expect(resolveThemeId("White Phosphor")).toEqual({ ok: true, id: "white" });
    expect(resolveThemeId("Solarized Dark")).toEqual({ ok: true, id: "solarized" });
  });

  test("suggests the closest id for a typo, and nothing for a guess", () => {
    expect(resolveThemeId("colourblind")).toEqual({ ok: false, suggestion: "colorblind" });
    expect(resolveThemeId("solarised-light")).toEqual({ ok: false, suggestion: "solarized-light" });
    expect(resolveThemeId("Catppucin Mocha")).toEqual({ ok: false, suggestion: "catppuccin" });
    // Part of exactly one name, but not of several.
    expect(resolveThemeId("contrast")).toEqual({ ok: false, suggestion: "high-contrast" });
    expect(resolveThemeId("phosphor")).toEqual({ ok: false, suggestion: null });
    expect(resolveThemeId("nosuchtheme")).toEqual({ ok: false, suggestion: null });
    expect(resolveThemeId("")).toEqual({ ok: false, suggestion: null });
  });
});

describe("theme contrast", () => {
  test("keeps shared text roles readable on body surfaces", () => {
    for (const [id, theme] of Object.entries(themes)) {
      for (const [surfaceLabel, surface] of [["bg", theme.bg], ["panel", theme.panel]] as const) {
        assertMinContrast(id, `text/${surfaceLabel}`, theme.text, surface, BODY_TEXT_MIN);
        assertMinContrast(id, `textDim/${surfaceLabel}`, theme.textDim, surface, BODY_TEXT_MIN);
        assertMinContrast(id, `textMuted/${surfaceLabel}`, theme.textMuted, surface, SUBTLE_TEXT_MIN);
        assertMinContrast(id, `positive/${surfaceLabel}`, theme.positive, surface, SUBTLE_TEXT_MIN);
        assertMinContrast(id, `negative/${surfaceLabel}`, theme.negative, surface, SUBTLE_TEXT_MIN);
        assertMinContrast(id, `neutral/${surfaceLabel}`, theme.neutral, surface, SUBTLE_TEXT_MIN);
        assertMinContrast(id, `selected/${surfaceLabel}`, theme.selected, surface, SELECTED_SURFACE_MIN);
      }

      assertMinContrast(id, "headerText/header", theme.headerText, theme.header, BODY_TEXT_MIN);
      assertMinContrast(id, "selectedText/selected", theme.selectedText, theme.selected, BODY_TEXT_MIN);
    }
  });

  // colorblind-light read a loss on a selected row at 3.16:1 and its warning amber at 3.85:1 on the panel; on the
  // selection a loss read 2.99:1 in the default theme and 1.92:1 in nord, a gain 1.91:1 in rosepine.
  test("keeps up, down, warning and neutral at body contrast in a selected row in every theme, and on the page in every light and colour-blind one", () => {
    const tones = [["positive", "selectedPositive"], ["negative", "selectedNegative"], ["warning", "selectedWarning"], ["neutral", "selectedNeutral"]] as const;
    for (const { id } of listThemes()) {
      applyTheme(id);
      for (const [role, inRow] of tones) {
        // A data table draws the tone through the theme's token for the selection.
        expect(selectedCellColor(colors[role], colors)).toBe(colors[inRow]!);
        assertMinContrast(id, `${role}/selected`, colors[inRow]!, colors.selected, TONE_TEXT_MIN);
      }
      // Any other colour is the cell's own.
      expect(selectedCellColor("#123456", colors)).toBe("#123456");
    }
    const readable = listThemes().filter((theme) => theme.appearance === "light" || theme.traits.includes("colorblind-safe"));
    expect(readable.map((theme) => theme.id)).toContain("colorblind");
    for (const { id } of readable) {
      applyTheme(id);
      expect(readsAtBodyContrast(colors)).toBe(true);
      for (const [role] of tones) {
        for (const [surface, background] of [["bg", colors.bg], ["panel", colors.panel]] as const) {
          assertMinContrast(id, `${role}/${surface}`, colors[role], background, TONE_TEXT_MIN);
        }
      }
    }
    // A dark theme draws its tones and hints on the page as it always has.
    applyTheme("amber");
    expect(readsAtBodyContrast(colors)).toBe(false);
  });

  // The chosen row of a pane without the keyboard read 1.15:1 on the page in
  // high contrast, blue and midnight, near enough to vanish, and a loss on it
  // 2.89:1 in nord, a gain 2.99:1 in rosepine and muted text 2.92:1 in solarized.
  test("keeps the inactive selection apart from the page, a panel and the selection, and every text on it readable", () => {
    const roles = ["text", "textDim", "textMuted", "textBright", "positive", "negative", "warning", "neutral"] as const;
    for (const [id, theme] of Object.entries(themes)) {
      const fill = inactiveSelectedBg(theme);
      assertMinContrast(id, "inactiveSelected/bg", fill, theme.bg, INACTIVE_SELECTION_MIN);
      assertMinContrast(id, "inactiveSelected/panel", fill, theme.panel, INACTIVE_SELECTION_MIN);
      // Still the quieter of the two: the focused pane's selection reads apart from it.
      assertMinContrast(id, "selected/inactiveSelected", theme.selected, fill, 1.25);
      for (const role of roles) {
        assertMinContrast(id, `${role}/inactiveSelected`, inactiveSelectedText(theme[role], theme), fill, INACTIVE_SELECTION_TEXT_MIN);
      }
      // A colour that reads already is drawn as it is: a row's body text keeps its colour in every theme.
      expect(inactiveSelectedText(theme.text, theme)).toBe(theme.text);
    }
  });

  test("keeps unfocused pane chrome readable", () => {
    for (const id of Object.keys(themes)) {
      applyTheme(id);
      assertMinContrast(id, "paneTitleText/unfocused", paneTitleText(false), paneTitleBg(false), CHROME_TEXT_MIN);
      assertMinContrast(id, "floatingPaneTitleText/unfocused", paneTitleText(false, true), floatingPaneTitleBg(false), CHROME_TEXT_MIN);
    }
  });

  test("keeps command bar text readable", () => {
    for (const id of Object.keys(themes)) {
      applyTheme(id);
      assertMinContrast(id, "commandBarText/bg", commandBarText(), commandBarBg(), BODY_TEXT_MIN);
      assertMinContrast(id, "commandBarHeadingText/bg", commandBarHeadingText(), commandBarBg(), SUBTLE_TEXT_MIN);
      assertMinContrast(id, "commandBarSubtleText/panel", commandBarSubtleText(), commandBarPanelBg(), SUBTLE_TEXT_MIN);
      assertMinContrast(id, "commandBarAccentText/bg", commandBarAccentText(), commandBarBg(), SUBTLE_TEXT_MIN);
      assertMinContrast(id, "commandBarAccentText/panel", commandBarAccentText(), commandBarPanelBg(), SUBTLE_TEXT_MIN);
      assertMinContrast(id, "commandBarSelectedText/selected", commandBarSelectedText(), commandBarSelectedBg(), BODY_TEXT_MIN);
    }
  });

  test("keeps chart indicator colors readable and separate from price line colors", () => {
    for (const id of Object.keys(themes)) {
      applyTheme(id);
      for (const indicatorIndex of [0, 1, 2]) {
        const color = getChartIndicatorColor(indicatorIndex);
        assertMinContrast(id, `chartIndicator${indicatorIndex}/bg`, color, colors.bg, SUBTLE_TEXT_MIN);
        if ([colors.positive, colors.negative, colors.text].includes(color)) {
          throw new Error(`${id} chartIndicator${indicatorIndex} reuses a price line color`);
        }
      }
    }
  });
});
