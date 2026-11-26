import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { scopedNyseCloseFixture } from "../../../test-support/scoped-earnings";
import * as chartCursor from "../../../components/chart/composite/cursor-source";
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
  history: ["2025-03-03", "2026-03-02"].map((date) => ({ date: new Date(date), close: 30 })), daily: [],
  reports: [], fx: new Map(), fxError: null, error: null, historyError: null, stale: false, fetchedAt: Date.now() };
}

async function render(symbol = "TEST", exchange = "NASDAQ") {
  const id = `pe-band:${symbol}`;
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-pe-band-test", {
    instanceId: id, paneId: "pe-band", binding: { kind: "fixed", symbol },
  }));
  state.tickers.set(symbol, createTestTicker(symbol, "Test", { exchange }));
  const marketData = createTestDataProvider();
  await act(async () => {
    await tui.render(<TestPaneFrame width={140} height={31} state={state} paneId={id} pluginId="pe-band"
      runtime={createTestPluginRuntime({ getMarketData: () => marketData })}>
      {(body) => <PeBandPane paneId={id} paneType="pe-band" width={body.width} height={body.height} focused />}
    </TestPaneFrame>, { width: 140, height: 31 });
  });
  for (let index = 0; index < 6; index += 1) await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
}

test("the scoped band selects the first eligible close and keeps the row there as the session closes", async () => {
  const { data, onFilingDay } = scopedNyseCloseFixture();
  loadSpy = spyOn(client, "loadPeBandInputs").mockImplementation(async () => ({
    financials: data, history: [{ date: new Date("2028-02-14"), close: 999 }], daily: data.priceHistory,
    reports: [], fx: new Map(), fxError: null, error: null, historyError: null, stale: true, fetchedAt: Date.now(),
  }));
  const cursor = spyOn(chartCursor, "createCompositeCursorSource");
  const row = () => tui.frame().split("\n").find(line => line.includes("Dec 2027"));
  try {
    setSystemTime(onFilingDay(17));
    await render("VYLR", "NYSE");
    expect(row()).toMatch(/3\.25\s+—\s+—/);
    expect(cursor).not.toHaveBeenCalled();
    for (const hour of [20, 21]) {
      setSystemTime(onFilingDay(hour));
      await tui.emitKeypress({ name: "r" }, { afterCommit: true });
      await tui.waitForFrameToContain("Price $65.00");
      expect(row()).toMatch(/3\.25\s+65\.00\s+20\.0x/);
      const result = cursor.mock.results.at(-1);
      const scene = result?.type === "return" ? result.value.scene() : null;
      const prices = scene?.panels[0]?.series.find(entry => entry.source.id === "price")?.points;
      expect(prices?.map(point => [point.point.date, point.value])).toEqual(hour === 20
        ? [[onFilingDay(18), 65]] : [[onFilingDay(18), 65], [onFilingDay(21), 78]]);
      expect(scene?.cursorDate).toEqual(onFilingDay(18));
      expect(scene?.cursorValues.find(entry => entry.seriesId === "price")?.value).toBe(65);
    }
  } finally { cursor.mockRestore(); setSystemTime(); }
});

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
