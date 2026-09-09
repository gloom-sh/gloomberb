import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterProvider } from "../../../../components/layout/pane/footer";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../state/app/context";
import { createStatefulTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createDefaultConfig, createPaneInstance } from "../../../../types/config";
import { Box } from "../../../../ui";
import type { PluginRuntimeAccess } from "../../../runtime";
import { setAiRuntimeCatalog } from "../runner";
import {
  LOCAL_AGENT_WORKSPACE_SCHEMA_VERSION,
  LOCAL_AGENT_WORKSPACE_STATE_KEY,
  LocalAgentWorkspacePane,
} from "./pane";
import {
  createLocalAgentThread,
  EMPTY_LOCAL_AGENT_WORKSPACE,
  type LocalAgentWorkspaceState,
} from "./model";
import { TestPaneProvider } from "../../../../test-support/pane";

const PANE_ID = "local-agent-workspace:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function AgentPaneHarness({
  existingWorkspace,
  newThreadId,
  onOpenSettings,
}: {
  existingWorkspace?: LocalAgentWorkspaceState;
  newThreadId?: string;
  onOpenSettings: PluginRuntimeAccess["openPaneSettings"];
}) {
  const [state] = useState(() => {
    const config = createDefaultConfig("/tmp/gloomberb-agent-pane");
    config.layout.instances.push(createPaneInstance("local-agent-workspace", {
      instanceId: PANE_ID,
      title: "AI Agent",
      ...(newThreadId ? { params: { newThreadId } } : {}),
    }));
    const initial = createInitialState(config);
    initial.focusedPaneId = PANE_ID;
    return initial;
  });
  const [runtime] = useState(() => {
    const nextRuntime = createStatefulTestPluginRuntime({
      openPaneSettings: onOpenSettings,
    });
    if (existingWorkspace) {
      nextRuntime.setResumeState(
        "ai",
        LOCAL_AGENT_WORKSPACE_STATE_KEY,
        existingWorkspace,
        LOCAL_AGENT_WORKSPACE_SCHEMA_VERSION,
      );
    }
    return nextRuntime;
  });

  return (
    <Box flexDirection="column" width={100} height={16}>
      <TestPaneProvider state={state} paneId={PANE_ID} pluginId="ai" runtime={runtime}>
        <PaneFooterProvider>
          {() => (
            <LocalAgentWorkspacePane
              paneId={PANE_ID}
              paneType="local-agent-workspace"
              focused
              width={100}
              height={16}
            />
          )}
        </PaneFooterProvider>
      </TestPaneProvider>
    </Box>
  );
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup?.renderer.destroy();
    });
    testSetup = undefined;
  }
  setAiRuntimeCatalog({ providers: [], accounts: [], models: [] });
});

describe("LocalAgentWorkspacePane provider setup", () => {
  test("shows disconnected providers, prefers a ready account, and opens shared pane settings", async () => {
    setAiRuntimeCatalog({
      providers: [
        {
          providerId: "anthropic",
          label: "Claude",
          status: "not_authenticated",
          unavailableReason: "Claude is not connected.",
          outputModes: ["plain", "structured", "screener"],
        },
        {
          providerId: "openai-codex",
          label: "OpenAI (ChatGPT)",
          status: "ready",
          outputModes: ["plain", "structured", "screener"],
        },
      ],
      accounts: [],
      models: [],
    });

    const openedSettings: string[] = [];
    testSetup = await testRender(
      <AgentPaneHarness
        existingWorkspace={createLocalAgentThread(
          EMPTY_LOCAL_AGENT_WORKSPACE,
          "openai-codex",
          { id: "existing-thread", now: 1 },
        )}
        newThreadId="new-pane-thread"
        onOpenSettings={(paneId) => {
          if (paneId) openedSettings.push(paneId);
        }}
      />,
      { width: 100, height: 16 },
    );
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const readyFrame = testSetup.captureCharFrame();
    expect(readyFrame).toContain("OpenAI (ChatGPT)");
    expect(readyFrame).toContain("OpenAI (ChatGPT) is ready.");
    const providerRow = readyFrame.split("\n").findIndex((line) => (
      line.trim() === "OpenAI (ChatGPT)"
    ));
    const providerColumn = readyFrame.split("\n")[providerRow]?.indexOf("OpenAI (ChatGPT)") ?? -1;
    expect(providerRow).toBeGreaterThanOrEqual(0);
    expect(providerColumn).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(providerColumn + 1, providerRow);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    const providerPickerFrame = testSetup.captureCharFrame();
    expect(providerPickerFrame).toContain("Choose AI provider");
    expect(providerPickerFrame).toContain("Claude · sign in");

    await act(async () => {
      testSetup?.renderer.destroy();
    });
    testSetup = undefined;
    setAiRuntimeCatalog({
      providers: [{
        providerId: "anthropic",
        label: "Claude",
        status: "not_authenticated",
        unavailableReason: "Claude is not connected.",
        outputModes: ["plain", "structured", "screener"],
      }],
      accounts: [],
      models: [],
    });

    testSetup = await testRender(
      <AgentPaneHarness onOpenSettings={(paneId) => {
        if (paneId) openedSettings.push(paneId);
      }} />,
      { width: 100, height: 16 },
    );
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const disconnectedFrame = testSetup.captureCharFrame();
    expect(disconnectedFrame).toContain("Claude is not connected.");
    expect(disconnectedFrame).toContain("Configure Claude");

    await act(async () => {
      testSetup!.mockInput.pressKey("s");
      await testSetup!.renderOnce();
    });

    expect(openedSettings).toEqual([PANE_ID]);
  });
});
