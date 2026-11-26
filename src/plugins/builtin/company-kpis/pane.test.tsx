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
import { guide, guidancePayload, kpisPayload, observation } from "./test-fixture";

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
  expect(detail).toContain("01 Apr 2026 to 30 Jun 2026");
  await tui.emitKeypress({ name: "escape" });
  expect(await tui.waitForFrameToContain("METRIC")).toContain("125.00M");
});

test.each([46, 52, 60])("a %s-column guide keeps its value and wraps its access and older-issue notices", async (width) => {
  setCloudApiFetchTransport(async () => Response.json(guidancePayload({ access: "preview", lockedRows: 8, truncated: true,
    guidance: [guide({ issuedDate: "2026-05-20" }), guide({ id: "newer", issuedDate: "2026-08-19", seriesKey: "other" })] })));
  await mount({ guidance: true, width, height: 30 });
  const frame = await tui.waitForFrameToContain("110.00M");
  expect(frame).toContain("120.00M");
  expect(frame).toContain("20 May 2026");
  expect(frame.replace(/\s+/g, " ")).toContain("Gloom Pro");
});

test.each([46, 52, 60])("a %s-column EPS range keeps its accounting basis beside the number", async (width) => {
  const base = guide();
  const eps = guide({ metricId: "eps", metric: { ...base.metric, id: "eps", name: "Earnings per share" },
    low: 7.5, high: 8.5, unit: "currency_per_share", currency: "USD", basis: "adjusted", seriesKey: "eps:adjusted:USD" });
  setCloudApiFetchTransport(async () => Response.json(guidancePayload({ guidance: [eps] })));
  await mount({ guidance: true, width });
  const frame = await tui.waitForFrameToContain("EPS · Adjusted");
  expect(frame).toContain("7.50 – 8.50 USD/sh");
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

test("a company with no guidance says so plainly and names one that has some, in the shared empty state", async () => {
  setCloudApiFetchTransport(async () => Response.json(guidancePayload({ guidance: [], history: [], totalRows: 0 })));
  await mount({ guidance: true });
  const frame = await tui.waitForFrameToContain("Guidance for EXAMPLE:LSE is not yet available.");
  expect(frame).toContain("Try GUIDE WMT.");
  expect(frame).not.toContain("No disclosed observations");
});

test("the tracker keeps Issued in view at 90 cells and says what the guide did in plain words", async () => {
  setCloudApiFetchTransport(async () => Response.json(guidancePayload()));
  await mount({ guidance: true, width: 90 });
  const frame = await tui.waitForFrameToContain("Raised");
  expect(frame).toContain("ISSUED");
  expect(frame).toContain("01 Feb 2026");
});

test("quarterly and annual KPIs are separate views, each with its own change column", async () => {
  const quarter = observation();
  const year = observation({ id: "actual:fy", seriesKey: "arr:reported:GBP:year", value: 480_000_000,
    period: { start: "2025-07-01", end: "2026-06-30", kind: "year", fiscalYear: 2026, fiscalQuarter: null, label: "FY2026" } });
  const series = (latest: typeof quarter) => ({ key: latest.seriesKey, metric: latest.metric, unit: latest.unit, currency: latest.currency, basis: latest.basis, dimensions: {}, latest, observations: [latest] });
  setCloudApiFetchTransport(async () => Response.json(kpisPayload({ series: [series(year), series(quarter)], totalRows: 2 })));
  await mount();
  const frame = await tui.waitForFrameToContain("125.00M");
  expect(frame).toContain("Q/Q CHANGE");
  expect(frame).not.toContain("480.00M");
  expect(frame).toContain("Annual");
});
