/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { ChartToolbar } from "./toolbar";

const { window: testWindow, render } = createDomTestHarness();

async function mountBar(onTogglePinned: () => void) {
  const container = await render(
    <ChartToolbar
      armedTool={null}
      isDesktopWeb
      left={0}
      top={0}
      drawColor="#ffffff"
      showColors={false}
      levelTool={false}
      pinned={false}
      onTogglePinned={onTogglePinned}
      onArmTool={() => {}}
      onPickColor={() => {}}
    />,
  );
  const handle = container.querySelector("[data-gloom-role=composite-chart-toolbar-toggle]") as unknown as HTMLElement;
  const bar = container.querySelector("[data-gloom-role=composite-chart-toolbar]") as unknown as HTMLElement;
  return { handle, bar, container };
}

const mouse = (type: string, target: HTMLElement) =>
  act(async () => {
    target.dispatchEvent(new testWindow.MouseEvent(type, { bubbles: true, button: 0, clientX: 90, clientY: 70 }) as never);
  });

test("the folded button keeps its width and its icon when the bar opens, so a press that lands as it opens still pins", async () => {
  let toggles = 0;
  const { handle, bar } = await mountBar(() => { toggles += 1; });
  expect(bar.dataset.folded).toBe("true");
  const icon = handle.firstElementChild as HTMLElement;
  const width = handle.style.width;
  expect(width).not.toBe("auto");

  await mouse("mouseover", icon);
  expect(bar.dataset.folded).toBeUndefined();
  // Open, the button is as wide as it was, so a pointer that came in at its edge is still on it,
  // and the icon under that pointer is hidden, not gone: a press on it still reaches the button.
  expect(handle.style.width).toBe(width);
  expect(handle.firstElementChild).toBe(icon);
  expect(icon.isConnected).toBe(true);
  expect(icon.style.display).toBe("none");
  await mouse("mousedown", icon);
  expect(toggles).toBe(1);
});
