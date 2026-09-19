import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createDomTestHarness } from "../../../renderers/electrobun/view/test-utils";
import { WEB_CELL_WIDTH } from "../../../renderers/electrobun/view/input-host";
import { Text } from "../../../ui";
import {
  getPaneSidebarWidth,
  getPaneSidebarWidthRange,
  PaneSidebar,
  PaneSidebarAction,
  PaneSidebarRow,
  shouldShowPaneSidebar,
} from "./sidebar";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  await act(async () => {
    testSetup?.renderer.destroy();
    testSetup = undefined;
  });
});

describe("pane sidebar metrics", () => {
  test("uses the shared responsive breakpoint and host-specific widths", () => {
    expect(shouldShowPaneSidebar(2, 72, 8)).toBe(true);
    expect(shouldShowPaneSidebar(1, 72, 8)).toBe(false);
    expect(shouldShowPaneSidebar(1, 72, 8, 1)).toBe(true);
    expect(shouldShowPaneSidebar(2, 71, 8)).toBe(false);
    expect(shouldShowPaneSidebar(2, 72, 7)).toBe(false);

    expect(getPaneSidebarWidth(72, false)).toBe(18);
    expect(getPaneSidebarWidth(100, false)).toBe(24);
    expect(getPaneSidebarWidth(72, true)).toBe(14);
    expect(getPaneSidebarWidth(90, true)).toBe(17);
    expect(getPaneSidebarWidth(200, true)).toBe(19);
  });

  test("a dragged width overrides the responsive one and stays inside the pane", () => {
    // The automatic width tops out at 19/24; dragging may go past that, but
    // never so far that the pane behind it is squeezed out.
    expect(getPaneSidebarWidth(100, true, 32)).toBe(32);
    expect(getPaneSidebarWidth(100, true, 80)).toBe(50);
    expect(getPaneSidebarWidth(100, true, 2)).toBe(10);
    expect(getPaneSidebarWidth(100, true, null)).toBe(19);
    expect(getPaneSidebarWidthRange(100)).toEqual({ min: 10, max: 50 });
  });
});

test("renders a terminal divider and keeps nested actions from selecting their row", async () => {
  let selections = 0;
  let actions = 0;

  await act(async () => {
    testSetup = await testRender(
      <PaneSidebar width={20} height={4} focused keyboardFocused>
        <PaneSidebarRow
          active={false}
          ariaLabel="Alpha conversation"
          onSelect={() => {
            selections += 1;
          }}
        >
          {({ foregroundColor, onMouseDown }) => (
            <>
              <Text fg={foregroundColor} onMouseDown={onMouseDown}> Alpha</Text>
              <PaneSidebarAction
                width={3}
                ariaLabel="New conversation"
                onPress={() => {
                  actions += 1;
                }}
              >
                {({ foregroundColor: actionColor, onMouseDown: onActionMouseDown }) => (
                  <Text fg={actionColor} onMouseDown={onActionMouseDown}>+</Text>
                )}
              </PaneSidebarAction>
            </>
          )}
        </PaneSidebarRow>
      </PaneSidebar>,
      { width: 24, height: 4 },
    );
  });
  await act(async () => {
    await testSetup!.renderOnce();
  });

  const frame = testSetup!.captureCharFrame();
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes("Alpha"));
  const labelColumn = lines[row]?.indexOf("Alpha") ?? -1;
  const actionColumn = lines[row]?.indexOf("+") ?? -1;
  expect(row).toBeGreaterThanOrEqual(0);
  expect(labelColumn).toBeGreaterThanOrEqual(0);
  expect(actionColumn).toBeGreaterThanOrEqual(0);
  expect(lines.slice(0, 4).every((line) => line[19] === "│")).toBe(true);

  await act(async () => {
    await testSetup!.mockMouse.click(labelColumn, row);
    await testSetup!.renderOnce();
  });
  expect(selections).toBe(1);
  expect(actions).toBe(0);

  await act(async () => {
    await testSetup!.mockMouse.click(actionColumn, row);
    await testSetup!.renderOnce();
  });
  expect(actions).toBe(1);
  expect(selections).toBe(1);
});

test("dragging the terminal divider reports a clamped width and commits once", async () => {
  const widths: number[] = [];
  const committed: number[] = [];

  await act(async () => {
    testSetup = await testRender(
      <PaneSidebar
        width={20}
        height={4}
        focused
        resize={{ min: 12, max: 26, onResize: (next) => widths.push(next), onResizeEnd: (next) => committed.push(next) }}
      >
        <PaneSidebarRow active={false} ariaLabel="Alpha conversation">
          {({ foregroundColor }) => <Text fg={foregroundColor}> Alpha</Text>}
        </PaneSidebarRow>
      </PaneSidebar>,
      { width: 40, height: 4 },
    );
  });
  await act(async () => {
    await testSetup!.renderOnce();
  });

  await act(async () => {
    await testSetup!.mockMouse.drag(19, 1, 25, 1);
    await testSetup!.renderOnce();
  });
  expect(widths.at(-1)).toBe(26);
  expect(committed).toEqual([26]);

  await act(async () => {
    await testSetup!.mockMouse.drag(19, 1, 2, 1);
    await testSetup!.renderOnce();
  });
  expect(committed).toEqual([26, 12]);
});

describe("desktop pane sidebar", () => {
  const { render, window: testWindow } = createDomTestHarness({ capabilities: { nativePaneChrome: true } });

  test("the divider handle straddles the line so the pointer can grab it", async () => {
    const widths: number[] = [];
    const committed: number[] = [];
    const container = await render(
      <PaneSidebar
        width={20}
        height={10}
        focused
        resize={{ min: 12, max: 26, onResize: (next) => widths.push(next), onResizeEnd: (next) => committed.push(next) }}
      >
        <PaneSidebarRow active={false} ariaLabel="Alpha conversation">
          {({ foregroundColor }) => <Text fg={foregroundColor}> Alpha</Text>}
        </PaneSidebarRow>
      </PaneSidebar>,
    );

    const handle = container.querySelector('[style*="col-resize"]') as HTMLElement;
    expect(handle).toBeTruthy();

    const mouse = (type: string, target: { dispatchEvent: (event: unknown) => unknown }, cells: number) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: cells * WEB_CELL_WIDTH, clientY: 40 }));
    };
    await act(async () => mouse("mousedown", handle, 20));
    await act(async () => {
      mouse("mousemove", testWindow.document as never, 24);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => mouse("mouseup", testWindow.document as never, 24));

    expect(widths.at(-1)).toBe(24);
    expect(committed).toEqual([24]);
  });
});
