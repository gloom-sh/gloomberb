import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setLanguage } from "../../i18n";
import { Tabs } from "./tabs";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { Box, type ScrollBoxRenderable } from "../../ui";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setLanguage("en");
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
  return tui.setup().renderer.root.findDescendantById("test-tabs-scroll") as ScrollBoxRenderable;
}

// The strip used to snap back to the active tab on every render. A ticker pane
// re-renders on every quote tick, so scrolling the strip to look for a tab
// yanked the view back before it could be read.
test("scrolling the tab strip survives renders that do not change the tabs", async () => {
  await act(async () => {
    await tui.render(<TabsHarness />, { width: 30, height: 4 });
  });
  await tui.setup().renderOnce();

  await act(async () => {
    tabsScroll().scrollTo({ x: 24, y: 0 });
    await tui.setup().renderOnce();
  });
  expect(tabsScroll().scrollLeft).toBe(24);

  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      rerender?.();
      await tui.setup().renderOnce();
    });
  }

  expect(tabsScroll().scrollLeft).toBe(24);
});

test("selecting a tab outside the viewport still reveals it", async () => {
  await act(async () => {
    await tui.render(<TabsHarness />, { width: 30, height: 4 });
  });
  await tui.setup().renderOnce();
  expect(tabsScroll().scrollLeft).toBe(0);

  await act(async () => {
    selectTab?.("notes");
    await tui.setup().renderOnce();
  });
  await tui.setup().renderOnce();

  expect(tabsScroll().scrollLeft).toBeGreaterThan(0);
  expect(tui.frame()).toContain("Notes");
});

test("resizing a floating viewport keeps the selected tab visible without snapping ordinary scrolls", async () => {
  await act(async () => {
    await tui.render(<TabsHarness initialWidth={112} />, { width: 130, height: 4 });
  });
  await act(async () => { selectTab?.("notes"); });
  await tui.setup().renderOnce();
  expect(tui.frame()).toContain("Notes");
  const originalScroll = tabsScroll();
  for (const width of [80, 48, 112, 30]) {
    await act(async () => { resizeTabs?.(width); });
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    expect(tabsScroll()).toBe(originalScroll);
    expect(tabsScroll().viewport?.width).toBe(width);
    expect(tui.frame()).toContain("Notes");
  }
  await act(async () => { tabsScroll().scrollTo({ x: 0, y: 0 }); });
  await act(async () => { rerender?.(); });
  await tui.setup().renderOnce();
  expect(tabsScroll().scrollLeft).toBe(0);
});

test("retranslates stable tab items when the app language changes", async () => {
  const tabs = [{ label: "Open", value: "open" }];
  await tui.render(
    <Tabs tabs={tabs} activeValue="open" onSelect={() => {}} />,
    { width: 20, height: 2 },
  );

  await act(async () => tui.setup().renderOnce());
  expect(tui.frame()).toContain("Open");

  await act(async () => {
    setLanguage("zh-CN");
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });

  expect(tui.frame()).toContain("打开");
});

test("scrolls overflowing tabs horizontally with the mouse wheel", async () => {
  await tui.render(
    <Tabs
      tabs={[
        { label: "Overview", value: "overview" },
        { label: "Financials", value: "financials" },
        { label: "Chart", value: "chart" },
        { label: "Options", value: "options" },
        { label: "Insider", value: "insider" },
      ]}
      activeValue="overview"
      onSelect={() => {}}
    />,
    { width: 24, height: 4 },
  );

  await act(async () => {
    await tui.setup().renderOnce();
  });

  let frame = tui.frame();
  expect(frame).toContain("Overview");
  expect(frame).not.toContain("Insider");

  await act(async () => {
    for (let i = 0; i < 40; i++) {
      await tui.setup().mockMouse.scroll(1, 0, "down");
    }
    await tui.setup().renderOnce();
  });

  frame = tui.frame();
  expect(frame).toContain("Options");
  expect(frame).toContain("Insider");
});

test("moves focused tabs with arrow keys and leaves Tab for pane focus", async () => {
  let lastSelected = "overview";
  const selectedValues: string[] = [];

  function KeyboardTabsHarness() {
    const [activeValue, setActiveValue] = useState("overview");
    return (
      <Tabs
        tabs={[
          { label: "Overview", value: "overview" },
          { label: "News", value: "news" },
          { label: "Chart", value: "chart" },
        ]}
        activeValue={activeValue}
        onSelect={(value) => {
          lastSelected = value;
          selectedValues.push(value);
          setActiveValue(value);
        }}
        focused
      />
    );
  }

  await tui.render(<KeyboardTabsHarness />, { width: 40, height: 4 });

  await act(async () => {
    await tui.setup().renderOnce();
    tui.setup().mockInput.pressArrow("right");
    tui.setup().mockInput.pressArrow("right");
    await tui.setup().renderOnce();
  });

  expect(selectedValues).toEqual(["news", "chart"]);
  expect(lastSelected).toBe("chart");

  await act(async () => {
    tui.setup().mockInput.pressTab();
    await tui.setup().renderOnce();
  });

  expect(lastSelected).toBe("chart");
});

test("selects tabs by clicking their text labels", async () => {
  let lastSelected = "overview";
  const selectedValues: string[] = [];

  function PointerTabsHarness() {
    const [activeValue, setActiveValue] = useState("overview");
    return (
      <Tabs
        tabs={[
          { label: "Overview", value: "overview" },
          { label: "News", value: "news" },
          { label: "Chart", value: "chart" },
        ]}
        activeValue={activeValue}
        onSelect={(value) => {
          lastSelected = value;
          selectedValues.push(value);
          setActiveValue(value);
        }}
        scrollable={false}
      />
    );
  }

  await tui.render(<PointerTabsHarness />, { width: 40, height: 4 });

  await act(async () => {
    await tui.setup().renderOnce();
  });

  let frame = tui.frame();
  const newsCol = frame.split("\n")[0]!.indexOf("News");
  expect(newsCol).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await tui.setup().mockMouse.click(newsCol + 1, 0);
    await tui.setup().renderOnce();
  });

  expect(lastSelected).toBe("news");

  frame = tui.frame();
  const chartCol = frame.split("\n")[0]!.indexOf("Chart");
  expect(chartCol).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await tui.setup().mockMouse.click(chartCol + 1, 0);
    await tui.setup().renderOnce();
  });

  expect(selectedValues).toEqual(["news", "chart"]);
  expect(lastSelected).toBe("chart");
});

test("renders tab actions for editable tab sets", async () => {
  let closedTab = null as string | null;
  let addedTab = false as boolean;
  await tui.render(
    <Tabs
      tabs={[
        { label: "One", value: "one", onClose: (value) => { closedTab = value; } },
        { label: "Two", value: "two" },
      ]}
      activeValue="one"
      onSelect={() => {}}
      compact
      variant="pill"
      closeMode="active"
      onAdd={() => { addedTab = true; }}
    />,
    { width: 24, height: 3 },
  );

  await act(async () => {
    await tui.setup().renderOnce();
  });

  const frame = tui.frame();
  expect(frame).toContain("One x");
  expect(frame).toContain("+");

  await act(async () => {
    await tui.setup().mockMouse.click(5, 0);
    await tui.setup().renderOnce();
  });
  expect(closedTab).toBe("one");

  await act(async () => {
    await tui.setup().mockMouse.click(14, 0);
    await tui.setup().renderOnce();
  });
  expect(addedTab).toBe(true);
});
