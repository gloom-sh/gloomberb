/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { UiHostProvider, type UiHost } from "../../../ui";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { WebBox } from "../../../renderers/dom/host/box";
import { WebSpan, WebText } from "../../../renderers/dom/host/text";
import { WebIcon, WebIconButton } from "../../../renderers/dom/desktop/icons";
import { WebTabs } from "../../../renderers/dom/host/tabs";
import { WebButton } from "../../../renderers/dom/desktop/controls";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { PANE_HEADER_TWO_STRIPS_MIN_WIDTH, paneHeaderHoldsOneStrip } from "./header";
import { PaneWrapper } from "./index";
import { paneTitleWithoutLink } from "./link-note";
import { usePaneTabs } from "./pane-tabs";

const { window: testWindow, render: renderDom } = createDomTestHarness({ withUi: false });

// A title-bar strip watches the pane under it; the test DOM lays nothing out.
const observers = { ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: testWindow.MutationObserver };
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(observers)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function desktopUi(): UiHost {
  return {
    kind: "desktop-web",
    capabilities: { nativePaneChrome: true, cellWidthPx: 8, cellHeightPx: 18 },
    Box: WebBox,
    Text: WebText,
    Span: WebSpan,
    Icon: WebIcon,
    IconButton: WebIconButton,
    Tabs: WebTabs,
    Button: WebButton,
    SpinnerMark: () => null,
  } as unknown as UiHost;
}

const LINKED_CHART = "Chart: NVDA  \u29c9 Linked to Ticker Research";
const STACK = {
  tabs: [{ id: "research", title: "NVDA" }, { id: "chart", title: LINKED_CHART }],
  active: "research",
  onSelect: () => {},
};

/** A pane with a strip of its own, as Ticker Research has its views. */
function Research() {
  const { strip } = usePaneTabs({
    tabs: [{ value: "overview", label: "Overview" }, { value: "financials", label: "Financials" }],
    activeValue: "overview",
    onSelect: () => {},
  });
  return <>{strip}<WebText>body</WebText></>;
}

async function mount(width: number, stack: typeof STACK | null = STACK) {
  const container = await renderDom(
    <UiHostProvider ui={desktopUi()} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <PaneWrapper paneId="research" title="NVDA" focused width={width} height={20} stack={stack}>
          <Research />
        </PaneWrapper>
      </WebInputHostProvider>
    </UiHostProvider>,
  );
  const labels = (selector: string) => [...container.querySelectorAll(`${selector} [role='tab']`)].map((tab) => tab.textContent);
  return {
    stackTabs: labels("[data-gloom-role='pane-stack-tabs']"),
    headerTabs: labels("[data-gloom-role='pane-header-tabs']"),
    bodyTabs: labels("[data-gloom-role='pane-body']"),
    allTabs: labels("[data-gloom-role='pane-window']"),
  };
}

test("a stacked pane in a phone-wide header draws its own strip in its body, and the stack's tabs go by name", async () => {
  const narrow = await mount(46);
  expect(narrow.stackTabs).toEqual(["NVDA", "Chart: NVDA"]);
  expect(narrow.headerTabs).toEqual([]);
  expect(narrow.bodyTabs).toEqual(["Overview", "Financials"]);
  // Once: never in both places, never in neither.
  expect(narrow.allTabs).toEqual(["NVDA", "Chart: NVDA", "Overview", "Financials"]);
});

test("a header with room keeps both strips, and a pane that is not stacked keeps its strip at any width", async () => {
  const wide = await mount(PANE_HEADER_TWO_STRIPS_MIN_WIDTH);
  expect(wide.stackTabs).toEqual(["NVDA", LINKED_CHART]);
  expect(wide.headerTabs).toEqual(["Overview", "Financials"]);
  expect(wide.bodyTabs).toEqual([]);
  expect(wide.allTabs).toHaveLength(4);

  const alone = await mount(46, null);
  expect(alone.headerTabs).toEqual(["Overview", "Financials"]);
  expect(alone.allTabs).toHaveLength(2);
});

test("which headers keep one strip, and what a tab says without its link note", () => {
  expect(paneHeaderHoldsOneStrip(STACK, PANE_HEADER_TWO_STRIPS_MIN_WIDTH - 1)).toBe(true);
  expect(paneHeaderHoldsOneStrip(STACK, PANE_HEADER_TWO_STRIPS_MIN_WIDTH)).toBe(false);
  // A width not known yet is not a narrow one.
  expect(paneHeaderHoldsOneStrip(STACK, 0)).toBe(false);
  expect(paneHeaderHoldsOneStrip(null, 40)).toBe(false);
  expect(paneHeaderHoldsOneStrip({ ...STACK, tabs: STACK.tabs.slice(0, 1) }, 40)).toBe(false);

  expect(paneTitleWithoutLink(LINKED_CHART)).toBe("Chart: NVDA");
  expect(paneTitleWithoutLink("OMON SPY  \u29c9 Unlinked")).toBe("OMON SPY");
  expect(paneTitleWithoutLink("World Indices")).toBe("World Indices");
});
