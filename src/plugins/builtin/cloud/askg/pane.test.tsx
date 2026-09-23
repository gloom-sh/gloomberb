import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../../api-client";
import { PaneFooterProvider } from "../../../../components/layout/pane/footer";
import { emitKeypress, TestDialogProvider, testRender } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../registry";
import { Box, Text } from "../../../../ui";
import { askgConversationListStore } from "./conversation-store";
import { resetASKGClientManifestCache } from "./host";
import { ASKGPane } from "./pane";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

const PANE_ID = "askg-test-pane";
/** Narrow enough that the failure cannot fit on one line, and no sidebar. */
const PANE_WIDTH = 64;
/** Past the sidebar breakpoint, so the conversation list has room. */
const WIDE_PANE_WIDTH = 96;

const requests: string[] = [];
let sessionStatus = 200;
let storedConversations: Array<Record<string, unknown>> = [];
let storedTranscripts: Record<string, Record<string, unknown>> = {};

function Harness({ paneWidth = PANE_WIDTH }: { paneWidth?: number }) {
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(createTestPaneConfig("/tmp/gloomberb-askg-pane", {
      instanceId: PANE_ID,
      paneId: "askg",
    }));
    initial.focusedPaneId = PANE_ID;
    return initial;
  });
  return (
    <TestDialogProvider>
      <Box flexDirection="column" width={paneWidth} height={24}>
        <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <>
                <ASKGPane paneId={PANE_ID} paneType="askg" focused width={paneWidth} height={20} />
                <Text>{`footer: ${footer.hints.map((hint) => `[${hint.key}]${hint.label}`).join(" ")}`}</Text>
              </>
            )}
          </PaneFooterProvider>
        </TestPaneProvider>
      </Box>
    </TestDialogProvider>
  );
}

const tick = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await tick();
}

function conversation(id: string, title: string) {
  const at = "2026-09-20T10:00:00.000Z";
  return {
    id,
    title,
    messageCount: 2,
    lastMessageAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

function transcript(id: string, question: string, answer: string) {
  const at = "2026-09-20T10:00:00.000Z";
  return {
    ...conversation(id, question),
    messages: [
      { seq: 1, role: "user", text: question, tools: [], turnId: "turn-a", createdAt: at },
      { seq: 2, role: "assistant", text: answer, tools: [], turnId: "turn-a", createdAt: at },
    ],
  };
}

beforeEach(() => {
  requests.length = 0;
  sessionStatus = 200;
  storedConversations = [];
  storedTranscripts = {};
  askgConversationListStore.reset();
  // A transport that buffers whole responses, which is what the desktop had
  // before the streaming bridge: `isStreamingSupported` is false.
  setCloudApiFetchTransport(async (url, init) => {
    const parsed = new URL(url);
    requests.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.pathname === "/askg/session") {
      if (sessionStatus !== 200) {
        return new Response(JSON.stringify({ message: "Ask Gloom is unavailable." }), {
          status: sessionStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        protocolVersion: 1,
        sessionId: "s1",
        manifestHash: "sha256:test",
        serverTools: [],
        acceptedTools: [],
        rejectedTools: [],
        limits: {
          requestsPerMinute: 20,
          turnsPerDay: 300,
          turnsRemainingToday: 300,
          maxToolCallsPerTurn: 8,
          turnWallClockMs: 60_000,
          clientToolTimeoutMs: 10_000,
        },
        tier: "pro",
        model: "gloom-1",
        promptVersion: "v1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/askg/conversations") {
      return new Response(
        JSON.stringify({ count: storedConversations.length, items: storedConversations }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const stored = parsed.pathname.startsWith("/askg/conversations/")
      ? storedTranscripts[decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "")]
      : undefined;
    if (parsed.pathname.startsWith("/askg/conversations/")) {
      if (!stored) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(stored), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  apiClient.setSessionToken("askg-pane-session");
  apiClient.restoreCachedUser({ id: "u0", username: "vince", emailVerified: true, plan: "pro" });
  // The manifest only needs the pane catalog; no pane has to be registered for
  // the session to negotiate an empty tool set.
  resetASKGClientManifestCache();
  setSharedRegistryForTests({
    panes: new Map(),
    paneTemplates: new Map(),
  } as unknown as PluginRegistry);
});

afterEach(async () => {
  if (setup) {
    await act(async () => {
      setup!.renderer.destroy();
    });
    setup = undefined;
  }
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  resetASKGClientManifestCache();
  setSharedRegistryForTests(undefined);
  askgConversationListStore.reset();
});

async function renderPane(paneWidth: number): Promise<string> {
  await act(async () => {
    setup = await testRender(<Harness paneWidth={paneWidth} />, {
      width: paneWidth,
      height: 24,
    });
  });
  await flush();
  return setup!.captureCharFrame();
}

async function ask(question: string): Promise<string> {
  await act(async () => {
    setup = await testRender(<Harness />, { width: PANE_WIDTH, height: 24 });
  });
  await flush();
  await act(async () => {
    setup!.mockInput.pressEnter();
    await setup!.renderOnce();
  });
  await act(async () => {
    setup!.mockInput.typeText(question);
    await setup!.renderOnce();
  });
  await act(async () => {
    setup!.mockInput.pressEnter();
    await setup!.renderOnce();
  });
  await flush();
  return setup!.captureCharFrame();
}

describe("ASKGPane failures", () => {
  test("a failure too long for the pane keeps its tail instead of running off the edge", async () => {
    const frame = await ask("what does a 5y bond return");
    if (process.env.PRINT_FRAMES) console.log(frame);

    expect(frame).toContain("Streaming unavailable");
    // The tail is the part the old single-line render lost.
    expect(frame).toContain("cannot open");
    // Nothing to retry: asking again in the same window fails the same way.
    expect(frame).not.toContain("[r]etry");
  });

  test("a failure a new attempt could answer offers a retry that asks again", async () => {
    sessionStatus = 503;
    const frame = await ask("what does a 5y bond return");
    if (process.env.PRINT_FRAMES) console.log(frame);

    expect(frame).toContain("Ask Gloom is unavailable");
    expect(frame).toContain("Retry");
    expect(frame).toContain("[r]etry");
    expect(requests.filter((entry) => entry === "POST /askg/session")).toHaveLength(1);

    // Sending leaves the composer, so the answer's keys work straight away
    // instead of being typed into the next question.
    await emitKeypress(setup!, { name: "r" });
    await flush();

    expect(requests.filter((entry) => entry === "POST /askg/session")).toHaveLength(2);
    // The failed attempt is replaced, not stacked above the retry.
    const retried = setup!.captureCharFrame();
    expect(retried.split("what does a 5y bond return").length - 1).toBe(1);
  });
});

describe("ASKGPane conversations", () => {
  test("one conversation is the one on screen, so no list is drawn for it", async () => {
    storedConversations = [conversation("conv-1", "Bonds")];
    const frame = await renderPane(WIDE_PANE_WIDTH);
    if (process.env.PRINT_FRAMES) console.log(frame);

    expect(requests).toContain("GET /askg/conversations");
    expect(frame).not.toContain("Conversations");
    expect(frame).not.toContain("Bonds");
  });

  test("the list appears once there is something to switch between", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    const frame = await renderPane(WIDE_PANE_WIDTH);
    if (process.env.PRINT_FRAMES) console.log(frame);

    expect(frame).toContain("Conversations");
    expect(frame).toContain("Bond returns");
    expect(frame).toContain("Nvidia margins");
    // The transcript still owns the rest of the pane.
    expect(frame).toContain("Ask about anything on screen");
    expect(frame).toContain("conversations");
  });

  test("a narrow pane keeps the whole width for the answer", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    const frame = await renderPane(PANE_WIDTH);
    expect(frame).not.toContain("Bond returns");
  });

  test("walking the list loads nothing until a row is opened", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    storedTranscripts = {
      "conv-2": transcript("conv-2", "how are Nvidia margins", "Holding above 70%."),
    };
    await renderPane(WIDE_PANE_WIDTH);

    // Left hands the keyboard to the list; arrows only move the cursor.
    await emitKeypress(setup!, { name: "escape" });
    await emitKeypress(setup!, { name: "left" });
    await emitKeypress(setup!, { name: "down" });
    await emitKeypress(setup!, { name: "down" });
    await flush();
    expect(requests.filter((entry) => entry.startsWith("GET /askg/conversations/"))).toEqual([]);

    await emitKeypress(setup!, { name: "return" });
    await flush();

    expect(requests).toContain("GET /askg/conversations/conv-2");
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("how are Nvidia margins");
    expect(frame).toContain("Holding above 70%");
  });

  test("the open conversation is the one the list marks active", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    storedTranscripts = {
      "conv-2": transcript("conv-2", "how are Nvidia margins", "Holding above 70%."),
    };
    await renderPane(WIDE_PANE_WIDTH);
    expect(setup!.captureCharFrame()).not.toContain("\u203a");

    await emitKeypress(setup!, { name: "escape" });
    await emitKeypress(setup!, { name: "left" });
    await emitKeypress(setup!, { name: "down" });
    await emitKeypress(setup!, { name: "down" });
    await emitKeypress(setup!, { name: "return" });
    await flush();

    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("Holding above 70%");
    // The marker sits on the row that is open, and only on that row.
    const marked = frame
      .split("\n")
      .filter((line) => line.includes("\u203a"))
      .map((line) => line.trim());
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("Nvidia margins");
  });

  test("a new conversation clears the transcript without dropping the list", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    storedTranscripts = {
      "conv-1": transcript("conv-1", "what does a 5y bond return", "About 4.2%."),
    };
    await renderPane(WIDE_PANE_WIDTH);

    await emitKeypress(setup!, { name: "escape" });
    await emitKeypress(setup!, { name: "left" });
    await emitKeypress(setup!, { name: "down" });
    await emitKeypress(setup!, { name: "return" });
    await flush();
    expect(setup!.captureCharFrame()).toContain("About 4.2%");

    await emitKeypress(setup!, { name: "left" });
    await emitKeypress(setup!, { name: "n" });
    await flush();

    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).not.toContain("About 4.2%");
    expect(frame).toContain("Ask about anything on screen");
    expect(frame).toContain("Bond returns");
  });
});
