import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import { createOpenTuiTestHarness, settleFrame, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { ShortInterestView } from "./pane";

const tui = createOpenTuiTestHarness();
let restore: (() => void) | undefined;
afterEach(() => {
  
  restore?.(); restore = undefined;
});

test("reported percentages fit at normal width and dated rows remain usable through narrow scroll and refresh", async () => {
  let updated = false;
  const cloud = spyOn(apiClient, "getCloudShortInterest").mockRejectedValue(new Error("Controlled history unavailable"));
  const yahoo = spyOn(YahooHttpClient.prototype, "fetchJsonWithCrumb").mockImplementation(async <T,>() => ({ quoteSummary: { result: [{ defaultKeyStatistics: {
    dateShortInterest: updated ? "2026-09-15" : "2026-08-31", sharesShort: { raw: 20_000_000 },
    sharesShortPreviousMonthDate: "2026-08-14", sharesShortPriorMonth: { raw: 10_000_000 },
    shortRatio: { raw: 2.3 }, shortPercentOfFloat: { raw: .25 }, floatShares: { raw: 100_000_000 },
  } }] } }) as T);
  restore = () => { cloud.mockRestore(); yahoo.mockRestore(); };
  const config = createTestPaneConfig("/tmp/short-interest-test-unused", { instanceId: "si", paneId: "short-interest" });
  const state = createInitialState(config); state.focusedPaneId = "si";
  state.paneState.si = { cursorSymbol: "TEST" }; state.tickers.set("TEST", createTestTicker("TEST", "Controlled issuer", { assetCategory: "STK" }));
  let resize: (value: number) => void = () => {};
  function Harness() {
    const [width, setWidth] = useState(100); resize = setWidth;
    return <TestPaneProvider state={state} paneId="si" pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <ShortInterestView focused width={width} height={23} />
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 23 }); });
  await settleFrame(tui.setup(), 10);
  expect(tui.frame()).toContain("% FLOAT");
  expect(tui.frame()).toContain("25.00%");
  await exportPaneTable("si", "full.csv"); const full = takeSavedTextFile()!.text;
  expect(full).toContain("2026-08-31,20000000,2.30,,25.00");
  await act(async () => { resize(48); tui.setup().resize(48, 23); });
  await settleFrame(tui.setup(), 6);
  for (let i = 0; i < 4; i++) await tui.emitKeypress({ name: "right", ctrl: true });
  await settleFrame(tui.setup(), 6);
  expect(tui.frame()).toContain("2026-08-31");
  expect(tui.frame()).toContain("2026-08-14");
  expect(tui.frame()).toContain("25.00%");
  await exportPaneTable("si", "narrow.csv"); expect(takeSavedTextFile()!.text).toBe(full);
  updated = true;
  await tui.emitKeypress({ name: "r" }); await settleFrame(tui.setup(), 10);
  expect(tui.frame()).toContain("2026-09-15");
  expect(yahoo).toHaveBeenCalledTimes(2);
  await tui.emitKeypress({ name: "r", ctrl: true }); await settleFrame(tui.setup(), 6);
  expect(yahoo).toHaveBeenCalledTimes(2);
});

test("the settlements table drives the shares-short chart and keeps its rows in a short pane", async () => {
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
  await act(async () => { await tui.render(<Harness />, { width: 88, height: 23 }); });
  await settleFrame(tui.setup(), 10);
  let frame = tui.frame();
  // Figures lead with the latest settlement, then the legend names the plotted series.
  expect(frame.split("\n")[0]).toMatch(/Shares short\s+27M\s+2026-09-28/);
  expect(frame).toMatch(/Change\s+\+3\.8%\s+\+1M/);
  expect(frame).toContain("● Shares short 27M");
  expect(frame).toMatch(/\d+M\s*\n/);
  // The selected settlement is the chart's cursor.
  await tui.emitKeypress({ name: "down" });
  await settleFrame(tui.setup(), 6);
  expect(tui.frame()).toContain("● Shares short 26M");
  await tui.emitKeypress({ name: "left" });
  await settleFrame(tui.setup(), 6);
  expect(tui.frame()).toContain("● Shares short 25M");
  for (let i = 0; i < 12; i++) await tui.emitKeypress({ name: "down" });
  await settleFrame(tui.setup(), 200);
  frame = tui.frame();
  expect(frame).toContain("2026-02-28");
  expect(frame).toContain("● Shares short 13M");
  // Ten rows: one row of figures, the strip, and the table keeps its rows.
  await act(async () => { resize(10); tui.setup().resize(88, 10); });
  await settleFrame(tui.setup(), 6);
  frame = tui.frame();
  const lines = frame.split("\n");
  const header = lines.findIndex((line) => line.includes("DATE"));
  expect(header).toBe(2);
  expect(lines[1]).toMatch(/^ ● [⠀-⣿]/);
  expect(lines.slice(header + 1).filter((line) => /\d{4}-\d{2}-\d{2}/.test(line)).length).toBeGreaterThanOrEqual(4);
  expect(frame).not.toContain("● Shares short");
});
