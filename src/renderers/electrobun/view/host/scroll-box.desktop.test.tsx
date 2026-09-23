import { expect, test } from "bun:test";
import { createDomTestHarness } from "../test-utils";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../input-host";
import { WebScrollBox } from "./scroll-box";

const { render } = createDomTestHarness();

/**
 * OpenTUI's ScrollBox scrolls vertically unless told otherwise. When the web
 * one did not, a pane that rendered a bare ScrollBox came out unscrollable in
 * the desktop app and only its own arrow-key handler could move it.
 */
test("scrolls vertically by default and only sideways for a one-row strip", async () => {
  const container = await render(
    <>
      <WebScrollBox data-testid="body"><span>body</span></WebScrollBox>
      <WebScrollBox data-testid="off" scrollY={false}><span>clipped</span></WebScrollBox>
      <WebScrollBox data-testid="strip" scrollX height={1}><span>tabs</span></WebScrollBox>
    </>,
  );
  const styleOf = (id: string) => (container.querySelector(`[data-testid="${id}"]`) as HTMLElement).style;

  expect(styleOf("body").overflowY).toBe("auto");
  expect(styleOf("off").overflowY).toBe("hidden");
  expect(styleOf("strip").overflowX).toBe("auto");
  expect(styleOf("strip").overflowY).toBe("hidden");
});

/**
 * OpenTUI applies `contentOptions` to the box inside the viewport. The web
 * scroller dropped it, so padded panes drew their first glyph under the pane
 * border.
 */
test("insets scrolled content by contentOptions on top of its own padding", async () => {
  const container = await render(
    <WebScrollBox data-testid="body" paddingLeft={1} contentOptions={{ paddingX: 1, marginTop: 1 }}>
      <span>body</span>
    </WebScrollBox>,
  );
  const element = container.querySelector(`[data-testid="body"]`) as HTMLElement;

  expect(element.style.paddingLeft).toBe(`${2 * WEB_CELL_WIDTH}px`);
  expect(element.style.paddingRight).toBe(`${WEB_CELL_WIDTH}px`);
  expect(element.style.paddingTop).toBe(`${WEB_CELL_HEIGHT}px`);
  expect(element.hasAttribute("contentOptions")).toBe(false);
});
