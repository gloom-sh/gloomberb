import { act, useReducer } from "react";
import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { ExposurePayload } from "../../../api-client/exposure";
import { ExposurePane } from "./pane";
import audited from "./fixtures/taiwan.fixture.json";

const tui = createOpenTuiTestHarness();
async function mount(width = 110, height = 25, tab = "table", view = "stress", snapshot = audited as ExposurePayload) {
  const id = "exposure:test";
  const state = createInitialState(createTestPaneConfig("/tmp/exposure-pane-test", {
    paneId: "exposure", instanceId: id, params: { input: "NVDA AAPL AMD FANG LIN" }, settings: { exposureSnapshot: snapshot, tab, view },
  }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
      {body => <ExposurePane paneId={id} paneType="exposure" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
}
test("real disclosure snapshot shows the actual scenario and evidence stack retains the filed quote", async () => {
  await mount();
  const frame = await tui.waitForFrameToContain("19.6%");
  expect(frame).toContain("Taiwan disruption");
  expect(frame).not.toContain("taiwan-disruption");
  expect(frame).toContain("15.5%");
  await tui.emitKeypress({ name: "e" });
  const evidence = await tui.waitForFrameToContain("Period / units");
  expect(evidence).toContain("2026-01-25");
  expect(evidence).toContain("primary");
  await tui.emitKeypress({ name: "escape" });
  expect(await tui.waitForFrameToContain("HOLDING")).toContain("NVDA");
  await tui.emitKeypress({ name: "v" });
  expect(await tui.waitForFrameToContain("What we could not see")).toContain("NVDA");
});
test("narrow paths retain their unknown classification without a fabricated number", async () => {
  await mount(90, 20, "paths");
  const frame = await tui.waitForFrameToContain("EVIDENCE PATH");
  expect(frame).toContain("Unknown");
  expect(frame).not.toContain("Unknown unknown");
});

test("evidence displays a zero numeric chain estimate and concentrations keep their signed-exposure meaning", async () => {
  const data = structuredClone(audited) as ExposurePayload;
  data.holdings[0]!.components[0]!.proportionalEstimatePct = 0;
  await mount(110, 32, "table", "stress", data);
  await tui.waitForFrameToContain("19.6%");
  await tui.emitKeypress({ name: "e" });
  expect(await tui.waitForFrameToContain("Proportional chain")).toContain("0.00%");
  await tui.destroy();
  await mount(110, 30, "portfolio", "country");
  await tui.waitForFrameToContain("United States");
  await tui.emitKeypress({ name: "e" });
  const frame = await tui.waitForFrameToContain("Signed exposure");
  expect(frame).toContain("Gross exposure");
  expect(frame).not.toContain("Operating stress");
});
