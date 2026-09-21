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
import { resetASKGClientManifestCache } from "./host";
import { ASKGPane } from "./pane";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

const PANE_ID = "askg-test-pane";
/** Narrow enough that the failure cannot fit on one line. */
const PANE_WIDTH = 64;

const requests: string[] = [];
let sessionStatus = 200;

function Harness() {
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
      <Box flexDirection="column" width={PANE_WIDTH} height={24}>
        <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <>
                <ASKGPane paneId={PANE_ID} paneType="askg" focused width={PANE_WIDTH} height={20} />
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

beforeEach(() => {
  requests.length = 0;
  sessionStatus = 200;
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
});

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

    // Escape hands the keyboard back to the pane; `r` inside the composer is
    // a letter the user is typing.
    await emitKeypress(setup!, { name: "escape" });
    await emitKeypress(setup!, { name: "r" });
    await flush();

    expect(requests.filter((entry) => entry === "POST /askg/session")).toHaveLength(2);
    // The failed attempt is replaced, not stacked above the retry.
    const retried = setup!.captureCharFrame();
    expect(retried.split("what does a 5y bond return").length - 1).toBe(1);
  });
});
