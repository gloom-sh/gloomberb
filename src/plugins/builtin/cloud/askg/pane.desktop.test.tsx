/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../../api-client";
import { WebDialogHostProvider } from "../../../../renderers/dom/dialog-host";
import { createDomUiHost } from "../../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import { appReducer, createInitialState } from "../../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { noopRendererHost } from "../../../../test-support/renderer-host";
import { UiHostProvider } from "../../../../ui";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../registry";
import { askgConversationListStore } from "./conversation-store";
import { resetASKGClientManifestCache } from "./host";
import { ASKGPane } from "./pane";

const dom = createDomTestHarness({ withUi: false });
const PANE_ID = "askg-desktop-test";
const AT = "2026-09-20T10:00:00.000Z";

const feedbackBodies: Array<Record<string, unknown>> = [];

function Pane() {
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(createTestPaneConfig("/tmp/unused-askg-desktop-test", {
      instanceId: PANE_ID,
      paneId: "askg",
    }));
    initial.focusedPaneId = PANE_ID;
    return initial;
  });
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <WebDialogHostProvider>
          <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()} width={110} height={30}>
            {(body) => <ASKGPane paneId={PANE_ID} paneType="askg" focused width={body.width} height={body.height} />}
          </TestPaneFrame>
        </WebDialogHostProvider>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  feedbackBodies.length = 0;
  askgConversationListStore.reset();
  const summary = (id: string, title: string) => ({ id, title, messageCount: 2, lastMessageAt: AT, createdAt: AT, updatedAt: AT });
  setCloudApiFetchTransport(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/askg/conversations") {
      return json({ count: 2, items: [summary("conv-1", "Bond returns"), summary("conv-2", "Nvidia margins")] });
    }
    if (path === "/askg/conversations/conv-2") {
      return json({
        ...summary("conv-2", "Nvidia margins"),
        capabilities: { feedback: 1 },
        messages: [
          { seq: 1, role: "user", text: "how are Nvidia margins", tools: [], turnId: "turn-a", createdAt: AT },
          { seq: 2, role: "assistant", text: "Holding above 70%.", tools: [], turnId: "turn-a", createdAt: AT, feedback: null },
        ],
      });
    }
    if (path === "/askg/turns/turn-a/feedback" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      feedbackBodies.push(body);
      return json({ turnId: "turn-a", rating: body.rating, reason: body.reason ?? null, shared: body.share === true, updatedAt: AT });
    }
    return json({});
  });
  apiClient.setSessionToken("askg-desktop-session");
  apiClient.restoreCachedUser({ id: "u0", username: "ada", emailVerified: true, plan: "pro" });
  resetASKGClientManifestCache();
  setSharedRegistryForTests({ panes: new Map(), paneTemplates: new Map() } as unknown as PluginRegistry);
});

afterEach(() => {
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  resetASKGClientManifestCache();
  setSharedRegistryForTests(undefined);
  askgConversationListStore.reset();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 15; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

type Target = { dispatchEvent(event: unknown): boolean };

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error("Nothing to click.");
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      (element as unknown as Target).dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
  });
  await settle();
}

async function press(key: string): Promise<void> {
  await act(async () => {
    (dom.window.document.body as unknown as Target).dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

function buttonNamed(root: Element, name: string): Element | undefined {
  return [...root.querySelectorAll("button")].find((button) => (
    button.getAttribute("aria-label") === name || button.textContent?.trim().startsWith(name)
  ));
}

test("on the desktop and the web the thumbs, reasons and send answer the mouse and the keys", async () => {
  const container = await dom.render(<Pane />);
  await settle();
  await click(container.querySelector('[data-gloom-role="pane-sidebar-item"][aria-label="Nvidia margins"]'));
  expect(container.textContent).toContain("Holding above 70%.");

  const down = buttonNamed(container, "Bad answer");
  expect(down?.querySelector('[data-gloom-icon="thumbs-down"]')).toBeTruthy();
  expect(buttonNamed(container, "Send this answer to Gloom")).toBeUndefined();

  await click(down);
  expect(feedbackBodies).toEqual([{ rating: "down", reason: null }]);
  expect(buttonNamed(container, "Bad answer")?.getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("Sends your question, this answer as written (it can mention your holdings) and which tools ran, not the data they returned.");

  await press("2");
  expect(feedbackBodies.at(-1)).toEqual({ rating: "down", reason: "slow" });

  await click(buttonNamed(container, "Send this answer to Gloom"));
  expect(feedbackBodies.at(-1)).toEqual({ rating: "down", reason: "slow", share: true });
  expect(container.textContent).toContain("Sent to Gloom");

  await press("g");
  expect(feedbackBodies.at(-1)).toEqual({ rating: "up", reason: null });
  expect(buttonNamed(container, "Good answer")?.getAttribute("aria-pressed")).toBe("true");
});
