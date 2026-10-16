/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
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
import { cleanupChatTest, createController, installChatApiTestDefaults, makeMessage } from "../test-harness";
import { ChatContent } from "../content";

const { window: testWindow, render: renderDom } = createDomTestHarness({ withUi: false });

beforeEach(installChatApiTestDefaults);
afterEach(cleanupChatTest);

const LINK = `https://term.gloom.sh/api/shares/${"0".repeat(32)}/open`;

async function key(target: unknown, init: { key: string; repeat?: boolean }) {
  await act(async () => {
    (target as { dispatchEvent: (event: unknown) => void }).dispatchEvent(new testWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test("on the desktop a chip's x takes out that chip, even beside the same link, and each new Backspace one more", async () => {
  const controller = createController({ messages: [makeMessage(1)], sessionToken: "token-123" });
  // An older app could save the same link more than once.
  controller.setDraft([LINK, LINK, LINK].join("\n\n"));
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
  const container = await renderDom(
    <AppContext value={createStaticAppStore(state)}>
      <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
        <UiHostProvider ui={{ ...createDomUiHost(), WindowedList: undefined }} renderer={noopRendererHost}>
          <WebInputHostProvider>
            <ChatContent controller={controller} width={80} height={24} focused />
          </WebInputHostProvider>
        </UiHostProvider>
      </PluginRenderProvider>
    </AppContext>,
  );
  const chips = () => container.querySelectorAll("[data-gloom-role=\"chat-draft-links\"] [data-gloom-role=\"chat-pane-chip\"]");
  const draft = () => controller.getSnapshot().draft;
  expect(chips()).toHaveLength(3);

  const remove = chips()[1]!.querySelector("button[aria-label^=\"Remove\"]")!;
  await act(async () => {
    remove.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  expect(chips()).toHaveLength(2);
  expect(draft()).toBe(`${LINK}\n\n${LINK}`);

  await key(testWindow.document.body, { key: "Enter" });
  const field = container.querySelector("textarea")!;
  await key(field, { key: "Backspace" });
  expect(chips()).toHaveLength(1);
  // Held on, the browser marks every press after the first a repeat.
  for (let index = 0; index < 3; index += 1) await key(field, { key: "Backspace", repeat: true });
  expect(chips()).toHaveLength(1);
  await key(field, { key: "Backspace" });
  expect(chips()).toHaveLength(0);
  expect(draft()).toBe("");
});
