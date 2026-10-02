import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { commandBarBg, getThemeColors, paneBg, syncTheme } from "./colors";
import { ThemeProvider, useThemeColors } from "./theme-context";
import { DEFAULT_THEME } from "./themes";

const tui = createOpenTuiTestHarness({ width: 120, height: 2 });

function ThemeProbe() {
  const colors = useThemeColors();
  return <text>{`${colors.bg}|${commandBarBg(colors)}|${paneBg(true, colors)}`}</text>;
}

afterEach(() => {
  syncTheme(DEFAULT_THEME);
});

describe("ThemeProvider", () => {
  test("render helpers switch with the context palette in the same render", async () => {
    const { setup, root } = await tui.createRoot();

    act(() => {
      root.render(
        <ThemeProvider themeId={DEFAULT_THEME}>
          <ThemeProbe />
        </ThemeProvider>,
      );
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });

    const nextThemeId = "midnight";
    const nextColors = getThemeColors(nextThemeId);
    act(() => {
      root.render(
        <ThemeProvider themeId={nextThemeId}>
          <ThemeProbe />
        </ThemeProvider>,
      );
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });

    expect(setup.captureCharFrame()).toContain(
      `${nextColors.bg}|${commandBarBg(nextColors)}|${paneBg(true, nextColors)}`,
    );
  });
});
