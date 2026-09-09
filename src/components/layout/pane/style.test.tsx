import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { ThemeProvider } from "../../../theme/theme-context";
import { Text } from "../../../ui";
import { PaneWrapper } from "./index";

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

  test("phosphor boxes in ascii and shouts the title", async () => {
    const frame = await frameFor("phosphor");
    expect(frame).toContain("+-POSITIONS");
    expect(frame).not.toContain("┌");
    expect(frame).not.toContain("::");
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

  test("a border-focus style boxes only the focused pane; a header-focus style boxes both", async () => {
    expect(await frameFor("terminal", true)).toContain("┌");
    expect(await frameFor("terminal", false)).not.toContain("┌");
    expect(await frameFor("paper", true)).toContain("┌");
    expect(await frameFor("paper", false)).toContain("┌");
  });
});
