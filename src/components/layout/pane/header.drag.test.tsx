/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { UiHostProvider, type UiHost } from "../../../ui";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { WebBox } from "../../../renderers/dom/host/box";
import { WebSpan, WebText } from "../../../renderers/dom/host/text";
import { WebIcon, WebIconButton } from "../../../renderers/dom/desktop/icons";
import { WebTabs } from "../../../renderers/dom/host/tabs";
import { WebButton } from "../../../renderers/dom/desktop/controls";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { findTitleTicker, PaneHeader } from "./header";

const { window: testWindow, render: renderDom } = createDomTestHarness({ withUi: false });

function desktopUi(): UiHost {
  return {
    kind: "desktop-web",
    capabilities: {
      nativePaneChrome: true,
      titleBarOverlay: true,
      nativeWindowChrome: true,
      cellWidthPx: 8,
      cellHeightPx: 18,
    },
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

function press(target: HTMLElement) {
  target.dispatchEvent(new testWindow.MouseEvent("mousedown", {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: 8,
    clientY: 8,
  }));
}

test("a docked pane moves from its grip and its title, and a fullscreen one moves the window", async () => {
  const paneDrags: string[] = [];
  let windowDrags = 0;
  const host = { ...noopRendererHost, startWindowDrag() { windowDrags += 1; } };
  const container = await renderDom(
    <UiHostProvider ui={desktopUi()} renderer={host}>
      <PaneHeader title="Portfolio" width={80} focused onHeaderMouseDown={() => paneDrags.push("pane")} />
    </UiHostProvider>,
  );
  const release = () => testWindow.document.dispatchEvent(new testWindow.MouseEvent("mouseup", { bubbles: true, button: 0, buttons: 0 }));
  const grip = container.querySelector("[data-gloom-role='pane-grip']") as HTMLElement;
  const title = () => container.querySelector("[data-gloom-role='pane-title']") as HTMLElement;

  await act(async () => press(grip));
  await act(async () => { release(); press(title()); });
  expect(paneDrags).toEqual(["pane", "pane"]);
  expect(windowDrags).toBe(0);

  await act(async () => { release(); });
  const fullscreen = await renderDom(
    <UiHostProvider ui={desktopUi()} renderer={host}>
      <PaneHeader title="Portfolio" width={80} focused fullscreen onHeaderMouseDown={() => paneDrags.push("pane")} />
    </UiHostProvider>,
  );
  await act(async () => press(fullscreen.querySelector("[data-gloom-role='pane-title']") as HTMLElement));
  expect(paneDrags).toEqual(["pane", "pane"]);
  expect(windowDrags).toBe(1);
});

test("a press anywhere on the bar outside its controls drags the pane to the release", async () => {
  const seen: string[] = [];
  const container = await renderDom(
    <UiHostProvider ui={desktopUi()} renderer={noopRendererHost}><WebInputHostProvider>
      <PaneHeader
        title="Sectors"
        width={80}
        focused
        floating
        showActions
        tabs={{ tabs: [{ value: "a", label: "Sectors" }, { value: "b", label: "Industries" }], activeValue: "a", onSelect: () => seen.push("select") }}
        onHeaderMouseDown={() => seen.push("down")}
        onHeaderMouseDrag={(event: { type: string }) => seen.push(event.type)}
        onHeaderMouseDragEnd={(event: { type: string }) => seen.push(event.type)}
        onActionMouseDown={() => seen.push("menu")}
        onHelpMouseDown={() => seen.push("docs")}
      />
    </WebInputHostProvider></UiHostProvider>,
  );
  const header = container.querySelector("[data-gloom-role='pane-header']") as HTMLElement;
  const mouse = (type: string, target: { dispatchEvent: (event: unknown) => unknown }, clientX: number) => {
    target.dispatchEvent(new testWindow.MouseEvent(type, { bubbles: true, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX, clientY: 8 }));
  };
  const dragFrom = async (target: HTMLElement) => {
    await act(async () => mouse("mousedown", target, 300));
    await act(async () => {
      mouse("mousemove", testWindow.document as never, 360);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => mouse("mouseup", testWindow.document as never, 360));
  };

  // The browser hands a press on the bar's empty space or padding to the bar
  // itself, not to the title or the grip.
  await dragFrom(header);
  expect(seen).toEqual(["down", "drag", "drag-end"]);

  seen.length = 0;
  await dragFrom(container.querySelector("[data-gloom-role='tab-button']") as HTMLElement);
  await dragFrom(container.querySelector("[data-gloom-role='pane-action'] button") as HTMLElement);
  const docs = container.querySelector("[data-gloom-role='pane-help'] button") as HTMLButtonElement;
  await dragFrom(docs);
  expect(seen).not.toContain("down");

  // The ? is a button with a name, and a click asks for the pane's docs.
  expect(docs.getAttribute("aria-label")).toBe("Docs for this pane");
  await act(async () => {
    docs.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  expect(seen.filter((event) => event === "docs")).toEqual(["docs"]);
});

test("the ticker in a pane's title opens ticker search and never drags the pane", async () => {
  const seen: string[] = [];
  const container = await renderDom(
    <UiHostProvider ui={desktopUi()} renderer={noopRendererHost}><WebInputHostProvider>
      <PaneHeader
        title={"Chart: NVDA  \u29c9 Linked to Ticker Research"}
        titleTicker="NVDA"
        onTitleTickerPress={() => seen.push("search")}
        width={80}
        focused
        onHeaderMouseDown={() => seen.push("drag")}
      />
    </WebInputHostProvider></UiHostProvider>,
  );
  const title = container.querySelector("[data-gloom-role='pane-title']") as HTMLElement;
  const ticker = container.querySelector("[data-gloom-role='pane-title-ticker'] button") as HTMLButtonElement;
  // One title, read as it was: the ticker sits in its line.
  expect(title.textContent).toBe("Chart: NVDA  \u29c9 Linked to Ticker Research");
  expect(ticker.textContent).toBe("NVDA");
  await act(async () => press(ticker));
  await act(async () => { ticker.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, button: 0 })); });
  expect(seen).toEqual(["search"]);
  // The rest of the title still moves the pane.
  await act(async () => press(title));
  expect(seen).toEqual(["search", "drag"]);
});

test("a title's ticker is found only as a word of its own", () => {
  expect(findTitleTicker("OMON SPY", "SPY")).toEqual({ start: 5, end: 8 });
  expect(findTitleTicker("NVDA", "NVDA")).toEqual({ start: 0, end: 4 });
  // A longer symbol that starts with it, and a series name that contains it, are not the ticker.
  expect(findTitleTicker("OMON SPYG", "SPY")).toBeNull();
  expect(findTitleTicker("Chart: NVDA.Revenue NVDA", "NVDA")).toEqual({ start: 20, end: 24 });
  expect(findTitleTicker("Top News", "AAPL")).toBeNull();
});

test("a floating pane still moves from its title", async () => {
  const paneDrags: string[] = [];
  let windowDrags = 0;
  const container = await renderDom(
    <UiHostProvider
      ui={desktopUi()}
      renderer={{ ...noopRendererHost, startWindowDrag() { windowDrags += 1; } }}
    >
      <PaneHeader title="Portfolio" width={80} focused floating onHeaderMouseDown={() => paneDrags.push("pane")} />
    </UiHostProvider>,
  );
  const title = container.querySelector("[data-gloom-role='pane-title']") as HTMLElement;

  await act(async () => press(title));
  expect(paneDrags).toEqual(["pane"]);
  expect(windowDrags).toBe(0);
});

test("a fullscreen pane's corner is a dash that leaves fullscreen", async () => {
  const restores: string[] = [];
  const closes: string[] = [];
  const container = await renderDom(
    <UiHostProvider ui={desktopUi()} renderer={noopRendererHost}>
      <PaneHeader
        title="Portfolio"
        width={80}
        focused
        fullscreen
        onRestoreMouseDown={() => restores.push("restore")}
        onCloseMouseDown={() => closes.push("close")}
      />
    </UiHostProvider>,
  );
  const restore = container.querySelector("[data-gloom-role='pane-restore']") as HTMLElement;
  const button = restore.querySelector("button") as HTMLButtonElement;

  expect(container.querySelector("[data-gloom-role='pane-close']")).toBeNull();
  expect(button.getAttribute("data-icon")).toBe("minimize");
  expect(button.getAttribute("aria-label")).toBe("Exit fullscreen");

  await act(async () => {
    button.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  expect(restores).toEqual(["restore"]);
  expect(closes).toEqual([]);
});
