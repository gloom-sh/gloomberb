import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import { testRender, settleFrame, emitKeypress, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { ShortInterestView } from "./pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy()); setup = undefined;
  restore?.(); restore = undefined;
});

test("reported percentages fit at normal width and dated rows remain usable through narrow scroll and refresh", async () => {
  let updated = false;
  const cloud = spyOn(apiClient, "getCloudShortInterest").mockRejectedValue(new Error("Controlled history unavailable"));
  const yahoo = spyOn(YahooHttpClient.prototype, "fetchJsonWithCrumb").mockImplementation(async () => ({ quoteSummary: { result: [{ defaultKeyStatistics: {
    dateShortInterest: updated ? "2026-09-15" : "2026-08-31", sharesShort: { raw: 20_000_000 },
    sharesShortPreviousMonthDate: "2026-08-14", sharesShortPriorMonth: { raw: 10_000_000 },
    shortRatio: { raw: 2.3 }, shortPercentOfFloat: { raw: .25 }, floatShares: { raw: 100_000_000 },
  } }] } }));
  restore = () => { cloud.mockRestore(); yahoo.mockRestore(); };
  const config = createTestPaneConfig("/tmp/short-interest-test-unused", { instanceId: "si", paneId: "short-interest" });
  const state = createInitialState(config); state.focusedPaneId = "si";
  state.paneState.si = { cursorSymbol: "TEST" }; state.tickers.set("TEST", createTestTicker("TEST", "Controlled issuer", { assetCategory: "STK" }));
  let resize: (value: number) => void = () => {};
  function Harness() {
    const [width, setWidth] = useState(100); resize = setWidth;
    return <TestPaneProvider state={state} paneId="si" pluginId="ticker-research" runtime={{}}>
      <ShortInterestView focused width={width} height={23} />
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width: 100, height: 23 }); });
  await settleFrame(setup!, 10);
  expect(setup!.captureCharFrame()).toContain("% FLOAT");
  expect(setup!.captureCharFrame()).toContain("25.00%");
  await exportPaneTable("si", "full.csv"); const full = takeSavedTextFile()!.text;
  expect(full).toContain("2026-08-31,20M,2.30,'-,25.00%");
  await act(async () => { resize(48); setup!.resize(48, 23); });
  await settleFrame(setup!, 6);
  for (let i = 0; i < 4; i++) await emitKeypress(setup!, { name: "right", ctrl: true });
  await settleFrame(setup!, 6);
  expect(setup!.captureCharFrame()).toContain("2026-08-31");
  expect(setup!.captureCharFrame()).toContain("2026-08-14");
  expect(setup!.captureCharFrame()).toContain("25.00%");
  await exportPaneTable("si", "narrow.csv"); expect(takeSavedTextFile()!.text).toBe(full);
  updated = true;
  await emitKeypress(setup!, { name: "r" }); await settleFrame(setup!, 10);
  expect(setup!.captureCharFrame()).toContain("2026-09-15");
  expect(yahoo).toHaveBeenCalledTimes(2);
  await emitKeypress(setup!, { name: "r", ctrl: true }); await settleFrame(setup!, 6);
  expect(yahoo).toHaveBeenCalledTimes(2);
});

test("the table owns every row below the chart, and short panes drop the chart for the table", async () => {
  const points = Array.from({ length: 18 }, (_, index) => ({ settlementDate: `2026-${String(1 + Math.floor(index / 2)).padStart(2, "0")}-${index % 2 ? "28" : "14"}`,
    sharesShort: 10_000_000 + index * 1_000_000, previousSharesShort: null, averageDailyVolume: 5_000_000,
    daysToCover: 2 + index / 10, changePercent: null, revised: false }));
  const cloud = spyOn(apiClient, "getCloudShortInterest").mockResolvedValue({ status: "success", data: { symbol: "TEST", issueName: null, points } });
  restore = () => cloud.mockRestore();
  const config = createTestPaneConfig("/tmp/short-interest-test-unused", { instanceId: "si", paneId: "short-interest" });
  const state = createInitialState(config); state.focusedPaneId = "si";
  state.paneState.si = { cursorSymbol: "TEST" }; state.tickers.set("TEST", createTestTicker("TEST", "Controlled issuer", { assetCategory: "STK" }));
  let resize: (value: number) => void = () => {};
  function Harness() {
    const [height, setHeight] = useState(23); resize = setHeight;
    return <TestPaneProvider state={state} paneId="si" pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <ShortInterestView focused width={88} height={height} />
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width: 88, height: 23 }); });
  await settleFrame(setup!, 10);
  expect(setup!.captureCharFrame()).toContain("Jan 14 2026");
  // Blank row, chart, blank row, then a table that ends on the pane's last row:
  // the cursor on the 14th settlement scrolls it into view.
  for (let i = 0; i < 13; i++) await emitKeypress(setup!, { name: "down" });
  await settleFrame(setup!, 6);
  expect(setup!.captureCharFrame()).toContain("2026-03-14");
  await act(async () => { resize(15); setup!.resize(88, 15); });
  await settleFrame(setup!, 6);
  const lines = setup!.captureCharFrame().split("\n");
  expect(lines[0]).toContain("DATE");
  expect(lines.join("\n")).not.toContain("Jan 14 2026");
});
