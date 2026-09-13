import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { applyTheme } from "../../../theme/colors";
import { DEFAULT_THEME } from "../../../theme/schemes";
import { DEFAULT_STYLE } from "../../../theme/styles";
import { ThemeProvider } from "../../../theme/theme-context";
import { Text } from "../../../ui";
import { PaneWrapper } from "./index";

// The active theme is module-global, and a style now drives layout arithmetic
// as well as colour, so a test that switches style has to put it back or the
// next file lays out against the wrong column gap and row height.
afterEach(() => {
  applyTheme(DEFAULT_THEME, DEFAULT_STYLE);
});

const WIDTH = 34;
const HEIGHT = 6;

/**
 * A character frame is the honest test for a style: borders, header treatment,
 * glyph repertoire and case all land in the grid, so a recipe that failed to
 * reach the renderer shows up here rather than only in the token tree.
 */
async function frameFor(styleId: string, focused = true): Promise<string> {
  let renderer!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    renderer = await testRender(
      <ThemeProvider themeId="amber" styleId={styleId}>
        <PaneWrapper title="Positions" focused={focused} width={WIDTH} height={HEIGHT}>
          <Text>body</Text>
        </PaneWrapper>
      </ThemeProvider>,
      { width: WIDTH, height: HEIGHT },
    );
  });
  await act(async () => {
    await renderer.renderOnce();
  });
  const frame = renderer.captureCharFrame();
  renderer.renderer.destroy?.();
  return frame;
}

describe("pane chrome per style", () => {
  test("the terminal style keeps the light box and the grip", async () => {
    const frame = await frameFor("terminal");
    expect(frame).toContain("┌─:: Positions");
    expect(frame).toContain("└");
  });

  test("phosphor frames every pane in a double rule with the title set in it, in capitals", async () => {
    for (const focused of [true, false]) {
      const frame = await frameFor("phosphor", focused);
      expect(frame).toContain("╔═ POSITIONS ═");
      expect(frame).toContain("╚═");
      // The sides close the box on every body row.
      expect(frame.split("\n").filter((line) => line.startsWith("║") && line.endsWith("║")).length).toBe(HEIGHT - 2);
      expect(frame).not.toContain("::");
    }
  });

  test("rounded frames every pane in rounded corners, title as written", async () => {
    const frame = await frameFor("rounded", false);
    expect(frame).toContain("╭─ Positions ─");
    expect(frame).toContain("╰─");
    expect(frame).toContain("╯");
  });

  test("a borderless style draws no box at all", async () => {
    for (const styleId of ["modern", "minimal"]) {
      const frame = await frameFor(styleId);
      expect(frame, styleId).toContain("Positions");
      for (const character of ["┌", "└", "│", "─", "+", "|"]) {
        expect(frame, `${styleId} ${character}`).not.toContain(character);
      }
    }
  });

  test("a running head is the title and then a rule to the edge, boxed by nothing", async () => {
    for (const focused of [true, false]) {
      const frame = await frameFor("paper", focused);
      expect(frame).toMatch(/Positions ─+/);
      for (const character of ["┌", "└", "│"]) {
        expect(frame, character).not.toContain(character);
      }
    }
  });

  test("accent focus is a mark in the gutter of the focused pane only", async () => {
    expect(await frameFor("minimal", true)).toMatch(/^▌ Positions/);
    expect(await frameFor("minimal", false)).toMatch(/^  Positions/);
  });

  test("a border-focus style boxes only the focused pane", async () => {
    expect(await frameFor("terminal", true)).toContain("┌");
    expect(await frameFor("terminal", false)).not.toContain("┌");
  });
});
