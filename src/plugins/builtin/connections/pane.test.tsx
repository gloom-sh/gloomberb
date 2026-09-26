import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import { testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { ConnectionsPane } from "./pane";
import { TestPaneFrame } from "../../../test-support/pane";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (!testSetup) return;
  await act(async () => testSetup!.renderer.destroy());
  testSetup = undefined;
});

function harness() {
  const health = new ConnectionHealthRegistry();
  health.registerSource({ id: "quotes", name: "Quotes", kind: "asset-data" });
  health.reportRequest("quotes", { operation: "getQuote", success: true, latencyMs: 12 });
  const runtime = createTestPluginRuntime({ getConnectionHealth: () => health });
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-connections-pane-test"));

  function Harness() {
    // The selected source and the open detail are pane state, so the harness
    // needs a reducer.
    const [paneState, setPaneState] = useState<AppState["paneState"]>({});
    state.paneState = paneState;
    const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId="connections:test" pluginId="application" runtime={runtime} width={80} height={12}>
        {(body) => <ConnectionsPane paneId="connections:test" paneType="connections" focused {...body} />}
      </TestPaneFrame>
    );
  }

  return <Harness />;
}

async function renderSettled() {
  await act(async () => {
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

describe("ConnectionsPane", () => {
  test("hides the clickable sort hint while detail blocks the sort key", async () => {
    testSetup = await testRender(harness(), { width: 80, height: 12 });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("[s]ort");

    await act(async () => {
      testSetup!.renderer.keyInput.emit("keypress", {
        name: "enter",
        sequence: "\r",
        ctrl: false,
        meta: false,
        option: false,
        shift: false,
        eventType: "press",
        repeated: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as any);
      await testSetup!.renderOnce();
    });
    await renderSettled();

    expect(testSetup.captureCharFrame()).toContain("← Back Quotes");
    expect(testSetup.captureCharFrame()).not.toContain("[s]ort");
  });
});
