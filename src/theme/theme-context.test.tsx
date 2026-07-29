import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createOpenTuiTestRoot as createRoot } from "../renderers/opentui/test-utils";
import { commandBarBg, getThemeColors, paneBg, syncTheme } from "./colors";
import { ThemeProvider, useThemeColors } from "./theme-context";
import { DEFAULT_THEME } from "./themes";

let testSetup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function ThemeProbe() {
  const colors = useThemeColors();
  return <text>{`${colors.bg}|${commandBarBg(colors)}|${paneBg(true, colors)}`}</text>;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    root = undefined;
  }
  testSetup?.renderer.destroy();
  testSetup = undefined;
  syncTheme(DEFAULT_THEME);
});

describe("ThemeProvider", () => {
  test("render helpers switch with the context palette in the same render", async () => {
    testSetup = await createTestRenderer({ width: 120, height: 2 });
    root = createRoot(testSetup.renderer);

    act(() => {
      root?.render(
        <ThemeProvider themeId={DEFAULT_THEME}>
          <ThemeProbe />
        </ThemeProvider>,
      );
    });
    await act(async () => {
      await testSetup?.renderOnce();
      await testSetup?.renderOnce();
    });

    const nextThemeId = "midnight";
    const nextColors = getThemeColors(nextThemeId);
    act(() => {
      root?.render(
        <ThemeProvider themeId={nextThemeId}>
          <ThemeProbe />
        </ThemeProvider>,
      );
    });
    await act(async () => {
      await testSetup?.renderOnce();
      await testSetup?.renderOnce();
    });

    expect(testSetup.captureCharFrame()).toContain(
      `${nextColors.bg}|${commandBarBg(nextColors)}|${paneBg(true, nextColors)}`,
    );
  });
});
