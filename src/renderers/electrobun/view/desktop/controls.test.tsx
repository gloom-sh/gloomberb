/** @jsxImportSource react */
import { Window } from "happy-dom";

const testWindow = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  KeyboardEvent: testWindow.KeyboardEvent,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
});

import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UiHostProvider, type RendererHost, type UiHost } from "../../../../ui";
import { WebBox } from "../host/box";
import { WebText } from "../host/text";
import { WebSegmentedControl } from "./controls";

const renderer: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() { return ""; },
  notify() {},
};

const ui = {
  kind: "desktop-web",
  capabilities: { cellWidthPx: 8, fractionalViewport: true },
  Box: WebBox,
  Text: WebText,
} as unknown as UiHost;

test("desktop segmented controls expose radio semantics and keyboard selection", async () => {
  const selected: string[] = [];
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <UiHostProvider ui={ui} renderer={renderer}>
        <WebSegmentedControl
          options={[{ label: "Call", value: "call" }, { label: "Put", value: "put" }]}
          value="call"
          onChange={(value) => selected.push(value)}
        />
      </UiHostProvider>,
    );
  });

  const group = container.querySelector('[role="radiogroup"]');
  const radios = [...container.querySelectorAll('[role="radio"]')] as unknown as HTMLElement[];
  expect(group).not.toBeNull();
  expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);

  await act(async () => {
    radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    radios[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(selected).toEqual(["put", "put"]);

  await act(async () => root.unmount());
  container.remove();
});
