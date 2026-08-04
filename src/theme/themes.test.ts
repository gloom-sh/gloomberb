import { afterEach, describe, test } from "bun:test";
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
  paneTitleBg,
  paneTitleText,
} from "./colors";
import { contrastRatio } from "./color-utils";
import { DEFAULT_THEME, themes } from "./themes";

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
