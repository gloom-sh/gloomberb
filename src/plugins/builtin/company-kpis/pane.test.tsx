import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { companyKpisCache } from "./client";
import { CompanyGuidancePane, CompanyKpisPane } from "./pane";
import { guidancePayload, kpisPayload } from "./test-fixture";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); companyKpisCache.reset(); });
async function mount({ guidance = false, tab = "table", width = 120, height = 26 } = {}) {
  companyKpisCache.attach(new MemoryPluginPersistence());
  const paneType = guidance ? "company-guidance" : "company-kpis";
  const id = `${paneType}:test`;
  const state = createInitialState(createTestPaneConfig("/tmp/company-kpis-test", {
    paneId: paneType, instanceId: id, binding: { kind: "fixed", symbol: "EXAMPLE:LSE" }, settings: { tab },
  }));
  state.tickers.set("EXAMPLE:LSE", createTestTicker("EXAMPLE:LSE", "Example Company"));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    const Component = guidance ? CompanyGuidancePane : CompanyKpisPane;
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={height} flexDirection="column">
        <Box height={height - 1}><Component paneId={id} paneType={paneType} width={width} height={height - 1} focused /></Box>
        <PaneFooterBar footer={footer} width={width} focused /><PaneFooterKeys paneId={id} footer={footer} focused />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
}

test("preview keeps real values and evidence navigable at narrow size while locked rows use the shared upgrade", async () => {
  setCloudApiFetchTransport(async () => Response.json(kpisPayload({ access: "preview", lockedRows: 8, truncated: true, previewRows: 3, totalRows: 9 })));
  await mount({ width: 80, height: 20 });
  const frame = await tui.waitForFrameToContain("Annual recurring revenue");
  expect(frame).toContain("125.00M");
  expect(frame).toContain("Unlock with Pro");
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("Annualized recurring");
  expect(detail).toContain("GBP");
  expect(detail).toContain("2026-04-01 to 2026-06-30");
  await tui.emitKeypress({ name: "escape" });
  expect(await tui.waitForFrameToContain("METRIC")).toContain("125.00M");
});

test("guidance history exposes matched actuals and evidence without substituting a range midpoint", async () => {
  setCloudApiFetchTransport(async () => Response.json(guidancePayload()));
  await mount({ guidance: true, tab: "history", width: 150 });
  const frame = await tui.waitForFrameToContain("Beat");
  expect(frame).toContain("125.00M");
  expect(frame).toContain("110.00M");
  await tui.emitKeypress({ name: "e" });
  const detail = await tui.waitForFrameToContain("Source range");
  expect(detail).toContain("GBP 110 million to GBP 120 million");
  expect(detail).toContain("Later actual");
});

test("chart with too little comparable history reports collection state and keeps the observation table", async () => {
  setCloudApiFetchTransport(async () => Response.json(kpisPayload()));
  await mount({ tab: "chart" });
  expect(await tui.waitForFrameToContain("Two comparable disclosures")).toContain("125.00M");
});
