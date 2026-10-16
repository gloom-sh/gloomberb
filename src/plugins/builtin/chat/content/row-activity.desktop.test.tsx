/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import { createDomUiHost } from "../../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../../renderers/dom/input-host";
import { UiHostProvider } from "../../../../ui";
import { AppContext, createInitialState } from "../../../../state/app/context";
import { createStaticAppStore } from "../../../../test-support/app-store";
import { noopRendererHost } from "../../../../test-support/renderer-host";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../../types/config";
import { PluginRenderProvider } from "../../../runtime";
import {
  cleanupChatTest,
  createController,
  installChatApiTestDefaults,
  makeMessage,
} from "../test-harness";
import { ChatContent } from ".";

const { window: testWindow, render: renderDom } = createDomTestHarness({ withUi: false });

beforeEach(installChatApiTestDefaults);
afterEach(cleanupChatTest);

type Controller = ReturnType<typeof createController>;

/** The chat as the desktop draws it, with the pane's focus in the test's hands. */
function Pane({ controller, targetMessageId, focus }: {
  controller: Controller;
  targetMessageId?: string;
  focus: { set?: (focused: boolean) => void };
}) {
  const [focused, setFocused] = useState(true);
  focus.set = setFocused;
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
  return (
    <AppContext value={createStaticAppStore(state)}>
      <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
        {/* This DOM has no layout. Real measured windowing is covered by the pointer checks. */}
        <UiHostProvider ui={{ ...createDomUiHost(), WindowedList: undefined }} renderer={noopRendererHost}>
          <WebInputHostProvider>
            <ChatContent controller={controller} width={80} height={24} focused={focused} targetMessageId={targetMessageId} />
          </WebInputHostProvider>
        </UiHostProvider>
      </PluginRenderProvider>
    </AppContext>
  );
}

async function settle(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(controller: Controller, targetMessageId?: string) {
  const focus: { set?: (focused: boolean) => void } = {};
  const container = await renderDom(<Pane controller={controller} targetMessageId={targetMessageId} focus={focus} />);
  await settle();
  const rows = () => [...container.querySelectorAll("[data-gloom-chat-message-id]")] as unknown as HTMLElement[];
  const row = (id: string) => rows().find((element) => element.dataset.gloomChatMessageId === id)!;
  const transcript = container.querySelector("[data-gloom-role=\"chat-transcript\"]") as unknown as HTMLElement;
  /** The rows that carry a mark: hovered, highlighted or selected. */
  const marked = () => rows()
    .filter((element) => element.dataset.hovered === "true" || element.dataset.highlighted === "true" || element.dataset.selected === "true")
    .map((element) => element.dataset.gloomChatMessageId);
  const loseFocus = () => act(async () => { focus.set?.(false); });
  return { row, transcript, marked, loseFocus };
}

let pointerX = 100;
/** A real move: the pointer's position changes each time. */
async function movePointerOver(element: Element) {
  pointerX += 3;
  await act(async () => {
    element.dispatchEvent(new testWindow.MouseEvent("mousemove", { bubbles: true, clientX: pointerX, clientY: 40 }) as unknown as Event);
  });
  await settle(10);
}

async function dispatch(target: Element, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  // The list reacts to a scroll or a wheel turn a frame later.
  await settle(20);
}

const press = (key: string) => dispatch(
  testWindow.document.body as unknown as Element,
  new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event,
);

const threeMessages = () => createController({ messages: [makeMessage(1), makeMessage(2), makeMessage(3)] });

test("a message a notification opened on is marked, not selected, and a key press lets it go", async () => {
  const { row, marked } = await mount(threeMessages(), "m2");
  expect(row("m2").dataset.highlighted).toBe("true");
  expect(row("m2").dataset.selected).toBe("false");
  expect(marked()).toEqual(["m2"]);

  await press("x");
  expect(marked()).toEqual([]);
});

test("a click or a wheel turn lets go of the message a notification opened on", async () => {
  const clicked = await mount(threeMessages(), "m2");
  await dispatch(clicked.row("m3"), new testWindow.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
  expect(clicked.marked()).toEqual([]);

  const scrolled = await mount(threeMessages(), "m2");
  expect(scrolled.marked()).toEqual(["m2"]);
  await dispatch(scrolled.transcript, new testWindow.WheelEvent("wheel", { bubbles: true, deltaY: 40 }) as unknown as Event);
  expect(scrolled.marked()).toEqual([]);
});

test("the row under the pointer is marked one at a time, and let go when the pointer leaves the list", async () => {
  const { row, marked } = await mount(threeMessages());

  await movePointerOver(row("m1"));
  expect(marked()).toEqual(["m1"]);
  await movePointerOver(row("m3"));
  expect(marked()).toEqual(["m3"]);

  await movePointerOver(testWindow.document.body as unknown as Element);
  expect(marked()).toEqual([]);
});

test("a row under a pointer that stays still is let go when the list scrolls, and is not marked again until the pointer moves", async () => {
  const { row, marked, transcript } = await mount(threeMessages());
  await movePointerOver(row("m2"));
  expect(marked()).toEqual(["m2"]);

  await dispatch(transcript, new testWindow.Event("scroll") as unknown as Event);
  await settle(60);
  expect(marked()).toEqual([]);

  // The browser's own hover update after a scroll repeats the last position: not a move.
  await dispatch(row("m2"), new testWindow.MouseEvent("mousemove", { bubbles: true, clientX: pointerX, clientY: 40 }) as unknown as Event);
  expect(marked()).toEqual([]);

  await movePointerOver(row("m2"));
  expect(marked()).toEqual(["m2"]);
});

test("a row under a pointer that stays still is let go when a message arrives, a key is pressed or the window loses focus", async () => {
  const controller = threeMessages();
  const { row, marked } = await mount(controller);

  await movePointerOver(row("m2"));
  expect(marked()).toEqual(["m2"]);
  await act(async () => {
    (controller as unknown as { mergeMessages(messages: unknown[]): void }).mergeMessages([makeMessage(4)]);
  });
  await settle(60);
  expect(marked()).toEqual([]);

  await movePointerOver(row("m2"));
  expect(marked()).toEqual(["m2"]);
  await press("x");
  expect(marked()).toEqual([]);

  await movePointerOver(row("m2"));
  expect(marked()).toEqual(["m2"]);
  await act(async () => {
    testWindow.dispatchEvent(new testWindow.Event("blur"));
  });
  await settle(10);
  expect(marked()).toEqual([]);
});

test("a pane that loses the keyboard keeps no selected row, and none survives a channel it was left in", async () => {
  const { marked, loseFocus } = await mount(threeMessages());
  await press("ArrowUp");
  await settle();
  expect(marked()).toEqual(["m3"]);

  await loseFocus();
  await settle();
  expect(marked()).toEqual([]);
});
