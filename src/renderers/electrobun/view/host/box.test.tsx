/** @jsxImportSource react */
import { Window } from "happy-dom";

// The desktop host is the only renderer with a real DOM underneath it, so its
// mouse contract needs a DOM to be tested against.
const testWindow = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  MouseEvent: testWindow.MouseEvent,
  Event: testWindow.Event,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 8),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { WebChartSurface } from "./chart-surface";

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test("reports a drag as a drag, never as a move, and keeps its modifiers", async () => {
  const seen: string[] = [];
  const modifiers: Array<{ shift: boolean; alt: boolean }> = [];
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <WebChartSurface
        width={40}
        height={10}
        onMouseMove={() => seen.push("move")}
        onMouseDown={(event: { modifiers: { shift: boolean; alt: boolean } }) => {
          seen.push("down");
          modifiers.push(event.modifiers);
        }}
        onMouseDrag={(event: { modifiers: { shift: boolean; alt: boolean } }) => {
          seen.push("drag");
          modifiers.push(event.modifiers);
        }}
        onMouseUp={() => seen.push("up")}
      />,
    );
  });
  const surface = container.firstElementChild as unknown as HTMLElement;
  const mouse = (type: string, target: { dispatchEvent: (event: unknown) => unknown }, clientX: number) => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY: 24, shiftKey: true }));
  };

  await act(async () => {
    mouse("mousemove", surface, 10);
    await settle();
  });
  await act(async () => mouse("mousedown", surface, 10));
  await act(async () => {
    // The DOM delivers both while a button is held; only the drag may surface.
    mouse("mousemove", surface, 80);
    mouse("mousemove", testWindow.document as never, 80);
    await settle();
  });
  await act(async () => mouse("mouseup", testWindow.document as never, 80));

  expect(seen).toEqual(["move", "down", "drag", "up"]);
  expect(modifiers.every((entry) => entry.shift)).toBe(true);
});

test("a tab bar occupies exactly the one row panes reserve for it", async () => {
  const { WebTabs } = await import("./tabs");
  const { WEB_CELL_HEIGHT } = await import("../input-host");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <WebTabs
        tabs={[{ label: "Overview", value: "overview" }, { label: "Chart", value: "chart" }]}
        activeValue="chart"
        onSelect={() => {}}
        palette={{} as never}
      />,
    );
  });
  await settle();
  const list = container.querySelector('[data-gloom-role="tab-list"]') as unknown as HTMLElement;
  // Panes size their content as `height - 1` for the tab bar. Any extra pixel
  // here is a pixel the content is told it owns and the pane then clips.
  expect(list.style.height).toBe(`${WEB_CELL_HEIGHT}px`);
  expect(list.style.marginBottom === "" || list.style.marginBottom === "0px").toBe(true);
  await act(async () => root.unmount());
});

test("desktop tabs reorder through mouse dragging", async () => {
  const { WebTabs } = await import("./tabs");
  const reordered: Array<[string, string]> = [];
  const selected: string[] = [];
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <WebTabs
        tabs={[
          { label: "Home", value: "home" },
          { label: "Research", value: "research" },
          { label: "News", value: "news" },
        ]}
        activeValue="home"
        onSelect={(value) => selected.push(value)}
        onReorder={(fromValue, toValue) => reordered.push([fromValue, toValue])}
        palette={{} as never}
      />,
    );
  });

  const buttons = [...container.querySelectorAll('[data-gloom-role="tab-button"]')] as unknown as HTMLElement[];
  buttons.forEach((button, index) => {
    button.getBoundingClientRect = () => ({ left: index * 100, right: index * 100 + 80, width: 80 }) as DOMRect;
  });
  const mouse = (type: string, target: { dispatchEvent: (event: unknown) => unknown }, clientX: number) => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX }));
  };

  expect(buttons).toHaveLength(3);
  expect(buttons[0]?.getAttribute("draggable")).toBe("false");
  await act(async () => {
    mouse("mousedown", buttons[0]!, 20);
    mouse("mousemove", testWindow.document as never, 220);
  });

  expect(buttons[0]?.style.transform).toBe("translateX(200px) scale(1.03)");
  expect(buttons[1]?.style.transform).toBe("translateX(-84px)");
  expect(buttons[2]?.style.transform).toBe("translateX(-84px)");

  await act(async () => {
    mouse("mouseup", testWindow.document as never, 220);
    mouse("click", buttons[0]!, 220);
  });

  expect(reordered).toEqual([["home", "news"]]);
  expect(selected).toEqual([]);
  expect(buttons.map((button) => button.style.transform)).toEqual([
    "translateX(0px)",
    "translateX(0px)",
    "translateX(0px)",
  ]);
  await act(async () => root.unmount());
});
