/** @jsxImportSource react */
import { Window } from "happy-dom";

// The desktop/browser host is the only renderer with a real DOM underneath it,
// so the keys the shared shortcut model depends on have to be proven here.
const testWindow = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  KeyboardEvent: testWindow.KeyboardEvent,
  Event: testWindow.Event,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 8),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useShortcut, type KeyEventLike } from "../../../react/input";
import { WebInputHostProvider } from "./input-host";

let cleanup: (() => void) | null = null;

afterEach(async () => {
  const teardown = cleanup;
  cleanup = null;
  if (!teardown) return;
  await act(async () => {
    teardown();
    await Promise.resolve();
  });
});

function Probe({ onKey }: { onKey: (event: KeyEventLike) => void }) {
  useShortcut(onKey, { phase: "before" });
  return null;
}

async function mountProbe(): Promise<KeyEventLike[]> {
  const seen: KeyEventLike[] = [];
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <WebInputHostProvider>
        <Probe onKey={(event) => seen.push(event)} />
      </WebInputHostProvider>,
    );
  });
  cleanup = () => {
    root.unmount();
    container.remove();
  };
  return seen;
}

async function pressKey(
  key: string,
  options: { target?: unknown; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
): Promise<{ defaultPrevented: boolean }> {
  const event = new testWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
  });
  const target = (options.target ?? testWindow.document.body) as { dispatchEvent: (event: unknown) => void };
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return { defaultPrevented: event.defaultPrevented };
}

test("delivers plain Tab and Shift-Tab outside editable controls", async () => {
  const seen = await mountProbe();

  await pressKey("Tab");
  await pressKey("Tab", { shiftKey: true });

  expect(seen.map((event) => ({ name: event.name, shift: event.shift, editable: event.targetEditable })))
    .toEqual([
      { name: "tab", shift: false, editable: false },
      { name: "tab", shift: true, editable: false },
    ]);
});

test("leaves Tab to the field when an editable control owns the focus", async () => {
  const seen = await mountProbe();
  const input = testWindow.document.createElement("input");
  testWindow.document.body.appendChild(input);

  const result = await pressKey("Tab", { target: input });

  // The event still reaches the registry, but the shared model refuses to
  // deliver an unmodified key to a handler while a field is focused, and the
  // host must not swallow the browser's own focus move either.
  expect(seen).toEqual([]);
  expect(result.defaultPrevented).toBe(false);
  input.remove();
});

test("reports Cmd-digit as a meta shortcut so layout switching can claim it", async () => {
  const seen = await mountProbe();

  await pressKey("2", { metaKey: true });
  await pressKey("3", { ctrlKey: true });

  expect(seen.map((event) => ({ name: event.name, ctrl: event.ctrl, meta: event.meta, super: event.super })))
    .toEqual([
      { name: "2", ctrl: false, meta: true, super: true },
      { name: "3", ctrl: true, meta: false, super: false },
    ]);
});
