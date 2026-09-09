/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UiHostProvider, type RendererHost } from "../../../ui";
import type { UiHost } from "../../../ui/host";
import { WebBox } from "./host/box";
import { WebText, WebSpan } from "./host/text";
import { WebScrollBox } from "./host/scroll-box";
import { WebInput } from "./host/input";
import { WebButton, WebTextField } from "./desktop/controls";

const renderer: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() { return ""; },
  notify() {},
};

const ui = {
  kind: "desktop-web",
  capabilities: { cellWidthPx: 8, cellHeightPx: 18, fractionalViewport: true },
  Box: WebBox, Text: WebText, Span: WebSpan, ScrollBox: WebScrollBox,
  Button: WebButton, Input: WebInput, TextField: WebTextField,
  SpinnerMark: () => null,
} as unknown as UiHost;

/** Each suite owns its DOM, including roots and globals even when an assertion fails. */
export function createDomTestHarness({ withUi = true } = {}) {
  const window = new Window({ url: "http://localhost" });
  const roots = new Set<Root>();
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window, document: window.document, navigator: window.navigator,
    KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent,
    WheelEvent: window.WheelEvent, Event: window.Event,
    HTMLElement: window.HTMLElement, Node: window.Node,
    requestAnimationFrame: (callback: (time: number) => void) => window.setTimeout(() => callback(Date.now()), 8),
    cancelAnimationFrame: (id: NodeJS.Timeout) => window.clearTimeout(id),
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  beforeAll(() => {
    for (const [key, value] of Object.entries(globals)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
  });
  afterEach(async () => {
    await act(async () => {
      for (const root of roots) root.unmount();
      roots.clear();
    });
    window.document.body.replaceChildren();
    await window.happyDOM.abort();
  });
  afterAll(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function render(node: ReactNode): Promise<HTMLElement> {
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const root = createRoot(container as unknown as HTMLElement);
    roots.add(root);
    await act(async () => {
      root.render(withUi ? <UiHostProvider ui={ui} renderer={renderer}>{node}</UiHostProvider> : node);
    });
    return container as unknown as HTMLElement;
  }
  return { window, render };
}
