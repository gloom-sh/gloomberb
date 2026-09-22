import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { Tabs } from "./tabs";
import { testRender } from "../../renderers/opentui/test-utils";
import { Box, type ScrollBoxRenderable } from "../../ui";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (testSetup) await act(async () => testSetup!.renderer.destroy());
  testSetup = undefined;
});

const TAB_LABELS = [
  "Overview", "Chart", "Financials", "Estimates", "Filings", "Insider",
  "Holders", "Options", "Hiring", "Peers", "News", "Notes",
];

let rerender: (() => void) | undefined;
let selectTab: ((value: string) => void) | undefined;
let resizeTabs: ((width: number) => void) | undefined;

/**
 * Rebuilds the tab array on every render, the way a pane does: its props are
 * derived from the ticker and its quote, so a tick hands `Tabs` a new array
 * with identical content.
 */
function TabsHarness({ initialWidth }: { initialWidth?: number } = {}) {
  const [, setTick] = useState(0);
  const [width, setWidth] = useState<number | "100%">(initialWidth ?? "100%");
  const [activeValue, setActiveValue] = useState("overview");
  rerender = () => setTick((tick) => tick + 1);
  selectTab = setActiveValue;
  resizeTabs = setWidth;
  return (
    <Box width={width} height={1}>
    <Tabs
      tabs={TAB_LABELS.map((label) => ({ label, value: label.toLowerCase() }))}
      activeValue={activeValue}
      onSelect={setActiveValue}
      scrollId="test-tabs-scroll"
      focused
    />
    </Box>
  );
}

function tabsScroll(): ScrollBoxRenderable {
  return testSetup!.renderer.root.findDescendantById("test-tabs-scroll") as ScrollBoxRenderable;
}

// The strip used to snap back to the active tab on every render. A ticker pane
// re-renders on every quote tick, so scrolling the strip to look for a tab
// yanked the view back before it could be read.
test("scrolling the tab strip survives renders that do not change the tabs", async () => {
  await act(async () => {
    testSetup = await testRender(<TabsHarness />, { width: 30, height: 4 });
  });
  await testSetup!.renderOnce();

  await act(async () => {
    tabsScroll().scrollTo({ x: 24, y: 0 });
    await testSetup!.renderOnce();
  });
  expect(tabsScroll().scrollLeft).toBe(24);

  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      rerender?.();
      await testSetup!.renderOnce();
    });
  }

  expect(tabsScroll().scrollLeft).toBe(24);
});

test("selecting a tab outside the viewport still reveals it", async () => {
  await act(async () => {
    testSetup = await testRender(<TabsHarness />, { width: 30, height: 4 });
  });
  await testSetup!.renderOnce();
  expect(tabsScroll().scrollLeft).toBe(0);

  await act(async () => {
    selectTab?.("notes");
    await testSetup!.renderOnce();
  });
  await testSetup!.renderOnce();

  expect(tabsScroll().scrollLeft).toBeGreaterThan(0);
  expect(testSetup!.captureCharFrame()).toContain("Notes");
});

test("resizing a floating viewport keeps the selected tab visible without snapping ordinary scrolls", async () => {
  await act(async () => {
    testSetup = await testRender(<TabsHarness initialWidth={112} />, { width: 130, height: 4 });
  });
  await act(async () => { selectTab?.("notes"); });
  await testSetup!.renderOnce();
  expect(testSetup!.captureCharFrame()).toContain("Notes");
  const originalScroll = tabsScroll();
  for (const width of [80, 48, 112, 30]) {
    await act(async () => { resizeTabs?.(width); });
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
    expect(tabsScroll()).toBe(originalScroll);
    expect(tabsScroll().viewport?.width).toBe(width);
    expect(testSetup!.captureCharFrame()).toContain("Notes");
  }
  await act(async () => { tabsScroll().scrollTo({ x: 0, y: 0 }); });
  await act(async () => { rerender?.(); });
  await testSetup!.renderOnce();
  expect(tabsScroll().scrollLeft).toBe(0);
});
