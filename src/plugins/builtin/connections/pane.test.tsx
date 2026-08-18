import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { PluginRenderProvider } from "../../runtime";
import { ConnectionsPane } from "./pane";

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

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId="connections:test">
        <PluginRenderProvider pluginId="application" runtime={runtime}>
          <PaneFooterProvider>
            {(footer) => (
              <Box flexDirection="column" width={80} height={12}>
                <ConnectionsPane paneId="connections:test" paneType="connections" focused width={80} height={11} />
                <PaneFooterBar footer={footer} focused width={80} />
              </Box>
            )}
          </PaneFooterProvider>
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
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
