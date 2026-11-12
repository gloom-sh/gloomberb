import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { CentralBankRatesPayload, CentralBankRow } from "../../../api-client/central-bank-rates";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { centralBankRatesCache } from "./client";
import { CentralBankRatesPane } from "./pane";

const PANE_ID = "central-bank-rates";

function row(overrides: Partial<CentralBankRow>): CentralBankRow {
  return { id: "US", label: "United States", countryCodes: ["US"], centralBank: "Federal Reserve", instrument: "Target midpoint",
    source: "fred", sourceUrl: "https://fred.stlouisfed.org/series/DFEDTARL", sourceSeriesIds: ["DFEDTARL", "DFEDTARU"], unit: "percent",
    publicationFrequency: "daily", value: 3.875, range: { lower: 3.75, upper: 4 }, asOf: "2026-11-11", lagDays: 1,
    fetchedAt: "2026-11-12T10:00:00Z", changeBps: -25, lastChangeDate: "2026-10-29", previousValue: 4.125, previousAsOf: "2026-10-28", direction: "cut",
    percentile: { value: 10, rank: 2, sampleCount: 20, windowStart: "2025-11-11", windowEnd: "2026-11-11", min: 3.875, max: 4.375, mean: 4.1 },
    history: [{ date: "2026-10-28", value: 4.125 }, { date: "2026-10-29", value: 3.875 }, { date: "2026-11-11", value: 3.875 }],
    status: "available", unavailableReason: null, notes: [], nextMeeting: null, ...overrides };
}

/** The Fed from FRED, and Egypt from the CBE's own decisions, as the board serves them on Thu 12 Nov 2026. */
const board: CentralBankRatesPayload = { generatedAt: "2026-11-12T10:00:00Z", status: "available", gaps: [], rows: [
  row({}),
  row({ id: "EG", label: "Egypt", countryCodes: ["EG"], centralBank: "Central Bank of Egypt", instrument: "Overnight deposit rate",
    source: null, sourceUrl: "https://www.cbe.org.eg/en/monetary-policy/mpc-decisions", sourceSeriesIds: [], value: 20, range: null,
    asOf: "2026-11-12", lagDays: 0, changeBps: 100, lastChangeDate: "2026-10-29", previousValue: 19, previousAsOf: "2026-10-28", direction: "hike",
    computedFrom: "CBE's published rates", history: [{ date: "2026-10-28", value: 19 }, { date: "2026-10-29", value: 20 }, { date: "2026-11-12", value: 20 }],
    nextMeeting: { date: "2026-12-17", sourceUrl: "https://www.cbe.org.eg/en/monetary-policy/mpc-schedule", verifiedAt: "2026-11-12T10:00:00Z" } }),
] };

const tui = createOpenTuiTestHarness();
afterEach(() => {
  setCloudApiFetchTransport(null);
  centralBankRatesCache.reset();
});

async function opened(width: number): Promise<string> {
  centralBankRatesCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(board));
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: PANE_ID, paneId: PANE_ID, binding: { kind: "none" } }));
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: AppAction) => setState((current) => appReducer(current, action));
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="central-bank-rates"
        runtime={createTestPluginRuntime({ getMarketData: () => null })} width={width} height={24}>
        {(body) => <CentralBankRatesPane paneId={PANE_ID} paneType={PANE_ID} focused {...body} />}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width, height: 24 }); });
  return await tui.waitForFrameToContain("Egypt");
}

// CBR's footer said only "just now": not where the rates are from, nor what day they are.
test("the CBR footer names its sources and the rates' day, as `fn CBR` ends, and keeps AS OF at 100 columns", async () => {
  const frame = await opened(100);
  const footer = frame.split("\n").filter((line) => line.trim()).at(-1)!;
  expect(footer).toMatch(/FRED and central banks · Thu 12 Nov 2026/);
  expect(frame).toContain("AS OF");
  expect(frame).toContain("2026-11-12");
});

// The CBE's terms ask that a figure computed from its rates say so.
test("Egypt's move and percentile say they are computed from the CBE's published rates", async () => {
  await opened(100);
  await act(async () => { await tui.clickFrameText("Egypt"); });
  await act(async () => { tui.setup().mockInput.pressEnter(); await tui.setup().renderOnce(); });
  const detail = await tui.waitForFrameToContain("Next meeting");
  expect(detail.match(/computed from CBE's published rates/g)?.length).toBe(2);
});
