/** @jsxImportSource react */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, Profiler, useState } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../../api-client";
import { Shell } from "../../../../components/layout/shell";
import { WebDialogHostProvider } from "../../../../renderers/dom/dialog-host";
import { createDomUiHost } from "../../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../../renderers/dom/input-host";
import { WebToastHostProvider } from "../../../../renderers/dom/toast-host";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import { AppContext, createInitialState, type AppState } from "../../../../state/app/context";
import { createStaticAppStore } from "../../../../test-support/app-store";
import { resetPaneSessionsForTests } from "../../../../state/pane-session";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { noopRendererHost } from "../../../../test-support/renderer-host";
import { cloneLayout, createDefaultConfig } from "../../../../types/config";
import { Text, UiHostProvider } from "../../../../ui";
import { PluginRenderProvider } from "../../../runtime";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../registry";
import { askgConversationListStore } from "./conversation-store";
import { resetASKGClientManifestCache } from "./host";
import { askGloomQuestion } from "./pending-question";
import { ASKGPane } from "./pane";

const dom = createDomTestHarness({ withUi: false });
const AT = "2026-09-20T10:00:00.000Z";
const ASKG = "askg:main";
const ANSWER = "Holding above 70%.";

const summary = (id: string, title: string) => ({ id, title, messageCount: 2, lastMessageAt: AT, createdAt: AT, updatedAt: AT });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Loading a conversation takes a round trip; a pane that must fetch it again shows nothing meanwhile. */
const LOAD_MS = 40;

function registry(): PluginRegistry {
  const askg = (props: Parameters<typeof ASKGPane>[0]) => (
    <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
      <ASKGPane {...props} />
    </PluginRenderProvider>
  );
  return {
    panes: new Map([
      ["portfolio-list", { id: "portfolio-list", name: "Portfolio List", component: () => <Text>Portfolio Body</Text>, defaultPosition: "left" }],
      ["askg", { id: "askg", name: "Ask Gloom", component: askg, defaultPosition: "right" }],
    ]),
    paneTemplates: new Map(),
    commands: new Map(),
    getEnabledTickerActions: () => [],
    tickerActions: new Map(),
    brokers: new Map(),
    allPlugins: new Map(),
    getPluginPaneIds: () => [],
    getPluginPaneTemplateIds: () => [],
    hasPaneSettings: () => false,
    notify: () => {},
    openPaneSettings: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    openWindowMode: () => {},
    updateLayout: () => {},
    hidePane: () => {},
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as unknown as PluginRegistry;
}

type Placement = "docked right" | "floating" | "docked left";

/** Portfolio List docked, with Ask Gloom docked beside it, floating over it, or docked on its other side. */
function stateFor(placement: Placement): AppState {
  const config = createDefaultConfig("/tmp/gloomberb-askg-dock-test");
  const layout = cloneLayout(config.layout);
  const main = layout.instances.find((entry) => entry.instanceId === "portfolio-list:main")!;
  const portfolio = { kind: "pane" as const, instanceId: main.instanceId };
  const askg = { kind: "pane" as const, instanceId: ASKG };
  layout.instances = [main, { ...main, instanceId: ASKG, paneId: "askg", title: "Ask Gloom" }];
  layout.detached = [];
  layout.floating = [];
  layout.dockRoot = { kind: "pane", instanceId: main.instanceId };
  if (placement === "floating") {
    layout.floating = [{ instanceId: ASKG, x: 10, y: 4, width: 60, height: 20, zIndex: 60 }];
  } else {
    layout.dockRoot = {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: placement === "docked right" ? portfolio : askg,
      second: placement === "docked right" ? askg : portfolio,
    };
  }
  const state = createInitialState({ ...config, layout, layouts: [{ name: "Default", layout: cloneLayout(layout) }] });
  return { ...state, focusedPaneId: ASKG };
}

beforeEach(() => {
  askgConversationListStore.reset();
  resetPaneSessionsForTests();
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/askg/session") {
      return json({
        protocolVersion: 1,
        sessionId: "s1",
        manifestHash: "sha256:test",
        serverTools: [],
        acceptedTools: [],
        rejectedTools: [],
        limits: { requestsPerMinute: 20, turnsPerDay: 300, turnsRemainingToday: 300, maxToolCallsPerTurn: 8, turnWallClockMs: 60_000, clientToolTimeoutMs: 10_000 },
        tier: "pro",
        model: "gloom-1",
        promptVersion: "v1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (path === "/askg/conversations") {
      return json({ count: 2, items: [summary("conv-1", "Bond returns"), summary("conv-2", "Nvidia margins")] });
    }
    if (path === "/askg/conversations/conv-2") {
      await new Promise((resolve) => setTimeout(resolve, LOAD_MS));
      return json({
        ...summary("conv-2", "Nvidia margins"),
        capabilities: { feedback: 1 },
        messages: [
          { seq: 1, role: "user", text: "how are Nvidia margins", tools: [], turnId: "turn-a", createdAt: AT },
          { seq: 2, role: "assistant", text: ANSWER, tools: [], turnId: "turn-a", createdAt: AT, feedback: null },
        ],
      });
    }
    return json({});
  });
  apiClient.setSessionToken("askg-dock-session");
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
  resetPaneSessionsForTests();
});

async function settle(ms = 150): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The desktop shell, and every frame its Ask Gloom pane drew: what the pane's text read after each commit. */
async function renderShell() {
  const frames: Array<{ placement: Placement; pane: string }> = [];
  let move: (placement: Placement) => void = () => {};
  let current: Placement = "docked right";
  let root: HTMLElement | null = null;
  const paneText = () => root?.querySelector(`[data-gloom-role=pane-window][data-gloom-pane-id='${ASKG}']`)?.textContent ?? "";
  function Host() {
    const [placement, setPlacement] = useState<Placement>(current);
    move = (next) => {
      current = next;
      setPlacement(next);
    };
    return (
      <Profiler id="shell" onRender={() => { frames.push({ placement: current, pane: paneText() }); }}>
        <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
          <WebInputHostProvider>
            <WebToastHostProvider>
              <WebDialogHostProvider>
                <AppContext value={createStaticAppStore(stateFor(placement))}>
                  <Shell pluginRegistry={registry()} />
                </AppContext>
              </WebDialogHostProvider>
            </WebToastHostProvider>
          </WebInputHostProvider>
        </UiHostProvider>
      </Profiler>
    );
  }
  root = await dom.render(<Host />);
  return {
    frames,
    paneText,
    pane: () => root?.querySelector(`[data-gloom-role=pane-window][data-gloom-pane-id='${ASKG}']`) ?? null,
    moveTo: async (placement: Placement) => {
      await act(async () => { move(placement); });
    },
  };
}

/** The question field of the Ask Gloom pane. */
const composer = (shell: { pane: () => Element | null }) => shell.pane()?.querySelector('[data-gloom-role="desktop-message-composer"] textarea') as HTMLTextAreaElement | null;

test("Ask Gloom keeps its open conversation and its draft on screen while the pane floats, docks again and moves", async () => {
  // The conversation this pane showed last: it opens with the pane.
  askgConversationListStore.rememberOpen("conv-2");
  const shell = await renderShell();
  await settle();
  expect(shell.paneText()).toContain(ANSWER);
  const field = composer(shell)!;
  await act(async () => {
    field.value = "and AMD?";
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
  });

  for (const placement of ["floating", "docked right", "docked left"] as const) {
    const before = shell.frames.length;
    await shell.moveTo(placement);
    // Not a frame of the move, nor of the settling after it, lost the conversation.
    await settle();
    const moved = shell.frames.slice(before).filter((frame) => frame.placement === placement);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.filter((frame) => !frame.pane.includes(ANSWER)).length).toBe(0);
    expect(shell.paneText()).toContain(ANSWER);
    expect(composer(shell)?.value).toBe("and AMD?");
  }
});

test("an answer still coming in when Ask Gloom floats goes on and finishes in the new window", async () => {
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  spyOn(apiClient.askg, "isStreamingSupported").mockReturnValue(true);
  const stream = spyOn(apiClient.askg, "streamTurn").mockImplementation(async (_session, request, options) => {
    const turnId = request.turnId;
    options.onEvent({ seq: 1, type: "session", sessionId: "s1", turnId, model: "gloom-1", promptVersion: "v1" });
    await finished;
    options.onEvent({ seq: 2, type: "text-delta", turnId, delta: "NVDA is up 2%." });
    options.onEvent({ seq: 3, type: "done", turnId, reason: "complete" });
    return "complete";
  });
  try {
    const shell = await renderShell();
    await settle();
    await act(async () => { askGloomQuestion("how is nvda doing"); });
    await settle();
    expect(shell.paneText()).toContain("Gloom is thinking");

    await shell.moveTo("floating");
    await settle();
    expect(shell.paneText()).toContain("how is nvda doing");
    expect(shell.paneText()).toContain("Gloom is thinking");

    await act(async () => { finish(); });
    await settle();
    expect(shell.paneText()).toContain("NVDA is up 2%.");
    expect(shell.paneText()).not.toContain("Gloom is thinking");
  } finally {
    stream.mockRestore();
  }
});
