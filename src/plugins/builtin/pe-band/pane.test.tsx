import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { Quote } from "../../../types/financials";
import * as client from "./client";
import { peBandHeadless } from "./headless";
import { PeBandPane } from "./pane";

const tui = createOpenTuiTestHarness();
let loadSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { loadSpy?.mockRestore(); });

function inputs(priorEps: number): client.PeBandInputs {
  return { financials: { quarterlyStatements: [], annualStatements: [
    { date: "2024-12-31", eps: priorEps, currency: "USD", fieldAvailability: { eps: "2025-02-01" } },
    { date: "2025-12-31", eps: 2, currency: "USD", fieldAvailability: { eps: "2026-02-01" } },
  ], priceHistory: [], quote: { price: 30, currency: "USD" } as Quote },
  history: ["2025-03-03", "2026-03-02"].map((date) => ({ date: new Date(date), close: 30 })),
  reports: [], fx: new Map(), fxError: null, error: null, historyError: null, stale: false, fetchedAt: Date.now() };
}

async function render() {
  const id = "pe-band:TEST";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-pe-band-test", {
    instanceId: id, paneId: "pe-band", binding: { kind: "fixed", symbol: "TEST" },
  }));
  state.tickers.set("TEST", createTestTicker("TEST", "Test", { exchange: "NASDAQ" }));
  const marketData = createTestDataProvider();
  await act(async () => {
    await tui.render(<TestPaneFrame width={140} height={31} state={state} paneId={id} pluginId="pe-band"
      runtime={createTestPluginRuntime({ getMarketData: () => marketData })}>
      {(body) => <PeBandPane paneId={id} paneType="pe-band" width={body.width} height={body.height} focused />}
    </TestPaneFrame>, { width: 140, height: 31 });
  });
  for (let index = 0; index < 6; index += 1) await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
}

test("YoY without a positive base is omitted, but a covered comparison restores it and raw exports keep nulls", async () => {
  loadSpy = spyOn(client, "loadPeBandInputs").mockResolvedValue(inputs(-1));
  await render();
  expect(tui.frame()).toContain("FY Dec 2025");
  expect(tui.frame()).not.toContain("YOY");
  await exportPaneTable("pe-band:TEST", "pe.csv");
  expect(takeSavedTextFile()?.text).toContain("YoY");
  const result = await peBandHeadless.load(createTestHeadlessArgs({ symbols: ["TEST"] }), createTestHeadlessContext());
  const section = result.sections.find((entry) => entry.title === "Trailing EPS")!;
  expect(section.columns?.some((column) => column.key === "yoy")).toBe(true);
  expect(section.rows?.map((row) => row.yoy)).toEqual([null, null]);
  await tui.destroy();
  loadSpy.mockResolvedValue(inputs(1));
  await render();
  expect(tui.frame()).toContain("YOY");
  expect(tui.frame()).toContain("+100.0%");
  expect(tui.frame().split("\n").find((line) => line.includes("FY Dec 2024"))).toContain("—");
});
