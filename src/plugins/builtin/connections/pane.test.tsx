import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { ConnectionsPane } from "./pane";
import { TestPaneFrame } from "../../../test-support/pane";

const tui = createOpenTuiTestHarness();

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

describe("ConnectionsPane", () => {
  test("hides the clickable sort hint while detail blocks the sort key", async () => {
    await tui.render(harness(), { width: 80, height: 12 });
    await tui.waitForFrameToContain("[s]ort");

    await tui.emitKeypress({ name: "enter", sequence: "\r" });
    const detail = await tui.waitForFrameToContain("← Back Quotes");
    expect(detail).not.toContain("[s]ort");
  });
});
