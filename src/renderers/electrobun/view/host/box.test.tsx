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
