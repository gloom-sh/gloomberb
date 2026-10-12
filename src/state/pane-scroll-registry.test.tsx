/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { WebInputHostProvider } from "../renderers/dom/input-host";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { createStaticAppStore } from "../test-support/app-store";
import { createTestPaneConfig } from "../test-support/pane";
import { Box, ScrollBox, Text } from "../ui";
import { AppContext, PaneInstanceProvider, createInitialState } from "./app/context";
import { PaneKeyboardScrollController } from "./pane-scroll-registry";

const PANE_ID = "scroll-keys:test";
const ROWS = 40;

/** What a pane author can write for a ScrollBox, and whether it then scrolls vertically. */
const CASES: Array<{ name: string; props: Record<string, unknown>; scrolls: boolean }> = [
  { name: "scrollY omitted", props: {}, scrolls: true },
  { name: "scrollY", props: { scrollY: true }, scrolls: true },
  { name: "scrollY={false}", props: { scrollY: false }, scrolls: false },
  { name: "a one-row horizontal strip", props: { scrollX: true, height: 1 }, scrolls: false },
  { name: "a one-row strip that asks for scrollY", props: { scrollX: true, scrollY: true, height: 1 }, scrolls: true },
  { name: "a taller box that scrolls both ways", props: { scrollX: true, height: 8 }, scrolls: true },
];

function Lines({ count = ROWS }: { count?: number }) {
  return <>{Array.from({ length: count }, (_, index) => <Text key={index}>{`line ${index + 1}`}</Text>)}</>;
}

function PaneHarness({ children }: { children: ReactNode }) {
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-scroll-keys-test", {
    instanceId: PANE_ID, paneId: "scroll-keys", binding: { kind: "none" },
  }));
  state.focusedPaneId = PANE_ID;
  return <AppContext value={createStaticAppStore(state)}>
    <PaneInstanceProvider paneId={PANE_ID}>
      <PaneKeyboardScrollController paneId={PANE_ID} focused />
      {children}
    </PaneInstanceProvider>
  </AppContext>;
}

describe("terminal", () => {
  const tui = createOpenTuiTestHarness();

  async function mount(props: Record<string, unknown>) {
    let scrollBox: { scrollTop: number; scrollHeight: number; viewport?: { height: number } } | null = null;
    await act(async () => {
      await tui.render(<PaneHarness>
        <Box width={30} height={10}>
          <ScrollBox ref={(node: typeof scrollBox) => { scrollBox = node; }} width={30} height={8} {...props}><Lines /></ScrollBox>
        </Box>
      </PaneHarness>, { width: 30, height: 10 });
    });
    await tui.renderFrames(2);
    return () => scrollBox!;
  }

  test.each(CASES)("keys scroll $name only where the box itself scrolls", async ({ props, scrolls }) => {
    const scrollBox = await mount(props);
    const hostScrolls = scrollBox().scrollHeight > (scrollBox().viewport?.height ?? 0);
    expect(hostScrolls).toBe(scrolls);

    await tui.emitKeypress({ name: "down" });
    await tui.renderFrames(1);
    expect(scrollBox().scrollTop > 0).toBe(hostScrolls);
  });

  test("a ScrollBox without scrollY takes Down, PageDown, End, PageUp and Home", async () => {
    const scrollBox = await mount({});
    const visible = scrollBox().viewport!.height;
    const max = scrollBox().scrollHeight - visible;
    expect(max).toBeGreaterThan(visible);

    await tui.emitKeypress({ name: "down" });
    expect(scrollBox().scrollTop).toBeGreaterThan(0);
    const afterDown = scrollBox().scrollTop;
    await tui.emitKeypress({ name: "pagedown" });
    expect(scrollBox().scrollTop).toBe(afterDown + visible - 1);
    await tui.emitKeypress({ name: "end" });
    expect(scrollBox().scrollTop).toBe(max);
    await tui.emitKeypress({ name: "pageup" });
    expect(scrollBox().scrollTop).toBe(max - (visible - 1));
    await tui.emitKeypress({ name: "home" });
    expect(scrollBox().scrollTop).toBe(0);
    await tui.renderFrames(1);
    expect(tui.frame()).toContain("line 1");
  });

  test("a hidden box does not take the keys from the one on screen", async () => {
    let hidden: { scrollTop: number } | null = null;
    let shown: { scrollTop: number } | null = null;
    await act(async () => {
      await tui.render(<PaneHarness>
        <Box width={30} height={12} flexDirection="column">
          <ScrollBox ref={(node: typeof hidden) => { hidden = node; }} visible={false} width={30} height={8}><Lines /></ScrollBox>
          <ScrollBox ref={(node: typeof shown) => { shown = node; }} width={30} height={4}><Lines /></ScrollBox>
        </Box>
      </PaneHarness>, { width: 30, height: 12 });
    });
    await tui.renderFrames(2);

    await tui.emitKeypress({ name: "pagedown" });
    expect(shown!.scrollTop).toBeGreaterThan(0);
    expect(hidden!.scrollTop).toBe(0);
  });
});

describe("desktop and web", () => {
  const { window: testWindow, render: renderDom } = createDomTestHarness({ capabilities: { nativePaneChrome: true } });
  const CELL = 18;
  const VIEWPORT_ROWS = 8;

  /** happy-dom lays nothing out, so the scroller reports the size a browser would give it. */
  function layOut(element: HTMLElement, contentPx: number, viewportPx: number) {
    let scrollTop = 0;
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, get: () => contentPx },
      clientHeight: { configurable: true, get: () => viewportPx },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = Math.max(0, Math.min(contentPx - viewportPx, value)); },
      },
    });
    element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: viewportPx, width: 300, height: viewportPx, toJSON() {} });
  }

  async function mount(props: Record<string, unknown>, contentPx = ROWS * CELL, viewportPx = VIEWPORT_ROWS * CELL) {
    const container = await renderDom(<WebInputHostProvider>
      <PaneHarness><ScrollBox width={30} height={VIEWPORT_ROWS} {...props}><Lines /></ScrollBox></PaneHarness>
    </WebInputHostProvider>);
    const element = container.querySelector("div[style*='overflow']") as HTMLElement;
    layOut(element, contentPx, viewportPx);
    return element;
  }

  async function press(key: string) {
    const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      testWindow.document.body.dispatchEvent(event);
      await Promise.resolve();
    });
  }

  test.each(CASES)("keys scroll $name only where the box itself scrolls", async ({ props, scrolls }) => {
    const element = await mount(props);
    expect(element.style.overflowY === "auto").toBe(scrolls);

    await press("ArrowDown");
    expect(element.scrollTop > 0).toBe(scrolls);
  });

  test("a ScrollBox without scrollY takes Down, PageDown, End, PageUp and Home", async () => {
    const element = await mount({});
    const max = ROWS * CELL - VIEWPORT_ROWS * CELL;

    await press("ArrowDown");
    expect(element.scrollTop).toBeGreaterThan(0);
    const afterDown = element.scrollTop;
    await press("PageDown");
    expect(element.scrollTop).toBe(afterDown + (VIEWPORT_ROWS - 1) * CELL);
    await press("End");
    expect(element.scrollTop).toBe(max);
    await press("PageUp");
    expect(element.scrollTop).toBe(max - (VIEWPORT_ROWS - 1) * CELL);
    await press("Home");
    expect(element.scrollTop).toBe(0);
  });

  test("a hidden box does not take the keys from the one on screen", async () => {
    const container = await renderDom(<WebInputHostProvider>
      <PaneHarness>
        <ScrollBox visible={false} width={30} height={VIEWPORT_ROWS}><Lines /></ScrollBox>
        <ScrollBox width={30} height={VIEWPORT_ROWS / 2}><Lines /></ScrollBox>
      </PaneHarness>
    </WebInputHostProvider>);
    const [hidden, shown] = [...container.querySelectorAll("div[style*='overflow']")] as HTMLElement[];
    // The hidden one keeps the size it had; display: none gives it no box.
    layOut(hidden!, ROWS * CELL, VIEWPORT_ROWS * CELL);
    hidden!.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
    layOut(shown!, ROWS * CELL, (VIEWPORT_ROWS / 2) * CELL);

    await press("PageDown");
    expect(shown!.scrollTop).toBeGreaterThan(0);
    expect(hidden!.scrollTop).toBe(0);
  });

  test("End reaches the last pixel of a body that ends part way into a row", async () => {
    // 35.4 rows in a 7.6 row viewport: the host rounds them to 35 and 8, so
    // by rows alone the last 13 pixels would stay out of reach.
    const element = await mount({}, 35.4 * CELL, 7.6 * CELL);
    await press("End");
    expect(element.scrollTop).toBeCloseTo(35.4 * CELL - 7.6 * CELL, 5);
    await press("Home");
    expect(element.scrollTop).toBe(0);
  });
});
