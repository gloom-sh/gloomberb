import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { FuturesContract, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { futuresCurveCache } from "./client";
import { FuturesCurvePane } from "./pane";

const first: FuturesContract = { symbol: "ESZ26.CME", label: "Dec 2026", expiration: "2026-12-18",
  price: 6600, asOf: "2026-09-22T15:00:00Z", currency: "USD", quoteUnit: "index points", volume: 1000, openInterest: 5000, delayMinutes: 10,
  stale: false, percentile: 50, samples: 200, historyStart: "2025-09-22", historyEnd: "2026-09-21" };
const CONTRACTS = ["ESZ26", "ESH27", "ESM27", "ESU27", "ESZ27", "ESH28", "ESM28", "ESU28"].map((code, index) => ({ ...first,
  symbol: `${code}.CME`, expiration: new Date(Date.UTC(2026, 11 + index * 3, 18)).toISOString().slice(0, 10), price: 6600 + index * 40 }));
// Listed, but past any chart horizon: the Contracts tab shows it, the Curve tab does not.
const FAR: FuturesContract = { ...first, symbol: "ESZ40.CME", expiration: "2040-12-21", price: 9000 };
function payload(contracts: FuturesContract[] = CONTRACTS): FuturesCurvePayload {
  return { root: "ES", name: "E-mini S&P 500", source: "yahoo", currency: "USD", quoteUnit: "index points", asOf: first.asOf,
    fetchedAt: "2026-09-22T15:05:00Z", status: "available", stale: false,
    catalogue: { method: "bounded-search", complete: true, horizonEnd: "2029-09-01" }, contracts,
    ghosts: [{ label: "1W", requestedDate: "2026-09-15", asOf: "2026-09-15", points: contracts.map((row) => ({
      symbol: row.symbol, expiration: row.expiration, price: row.price! - 50, asOf: "2026-09-15" })) },
    { label: "1M", requestedDate: "2026-08-22", asOf: "2026-08-22", points: contracts.map((row) => ({
      symbol: row.symbol, expiration: row.expiration, price: row.price! + 25, asOf: "2026-08-22" })) }],
    slope: { frontSymbol: "ESZ26.CME", nextSymbol: "ESH27.CME", value: 40, annualizedRollYield: 2.4, percentile: 60, rollPercentile: 55,
      samples: 200, historyStart: "2025-09-22", historyEnd: "2026-09-21", asOf: first.asOf, state: "contango" },
    gaps: [],
  };
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let spy: { mockRestore(): void } | undefined;
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  spy?.mockRestore(); spy = undefined;
  // Each test serves its own curve rather than the last one's cached copy.
  futuresCurveCache.reset();
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
}

async function render(width: number, height: number, tab = "curve"): Promise<string[]> {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-futures-curve-test", { instanceId: "ctm", paneId: "futures-curve", binding: { kind: "none" } }));
  initial.focusedPaneId = "ctm";
  initial.paneState = { ctm: { pluginState: { "futures-curve": { tab } } } };
  function Harness() {
    // The selected contract is pane state, so moving it needs a reducer.
    const [state, setState] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setState((current) => appReducer(current, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="ctm" pluginId="futures-curve" runtime={createTestPluginRuntime()} width={width} height={height}>
      {(body) => <FuturesCurvePane paneId="ctm" paneType="futures-curve" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width, height }); });
  await settle();
  return setup!.captureCharFrame().split("\n");
}

test("a short curve tab lists the contracts once, and a tall one ends on the last contract", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
  const short = (await render(40, 10)).join("\n");
  expect(short).not.toContain("TENOR");
  expect(short).toContain("CONTRACT");
  expect(short).toContain("ESU27.CME");
  const lines = await render(96, 29);
  expect(lines.join("\n")).toContain("Latest");
  expect(lines[27]).toContain("ESU28.CME");
  expect(lines[28]).toContain("10m delayed");
});

test("the curve names what it plots, and its rows add the moves the chart only shows as ghosts", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload([...CONTRACTS, FAR]));
  const lines = await render(98, 30);
  const frame = lines.join("\n");
  const header = lines.findIndex((line) => line.includes("CONTRACT"));
  // The caption carries the unit; the legend names each curve.
  expect(lines.slice(0, header).some((line) => line.includes("Index points by contract month") && line.includes("● Latest")
    && line.includes("● 1W ago"))).toBe(true);
  // The readout names the selected contract by month, with its moves in the table's units.
  expect(frame).toContain("Dec 26 6600.00  1W ago +50.00  1M ago -25.00");
  // Change columns replace the quote time every row repeated.
  expect(lines[header]).toContain("VS 1W");
  expect(lines[header]).toContain("VS 1M");
  expect(lines[header]).not.toContain("AS OF");
  expect(lines.find((line) => line.includes("ESH27.CME"))).toMatch(/6640\.00\s+\+50\.00\s+-25\.00/);
  // Only the contracts the chart plots.
  expect(frame).not.toContain("ESZ40.CME");
  expect(frame).toContain("ESU28.CME");

  const contracts = (await render(98, 30, "contracts")).join("\n");
  expect(contracts).toContain("ESZ40.CME");
  expect(contracts).toContain("AS OF UTC");
  expect(contracts).not.toContain("VS 1W");
  expect(contracts).not.toContain("by contract month");
});

test("the selected contract is the curve's point", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
  await render(98, 30);
  expect(setup!.captureCharFrame()).toContain("Dec 26 6600.00");
  await act(async () => { setup!.mockInput.pressArrow("down"); await setup!.renderOnce(); });
  await settle();
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("Mar 27 6640.00  1W ago +50.00");
  expect(frame).not.toContain("Dec 26 6600.00");
});

test("a short pane keeps the contracts and shrinks the curve to a strip, then drops it", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
  // Sixteen rows: tabs, figures, a curve that still reads, then the header and four contracts.
  let lines = await render(60, 17);
  let header = lines.findIndex((line) => line.includes("CONTRACT"));
  // Too narrow for the caption and all three names, so the caption gives way:
  // every line drawn keeps its name.
  expect(lines.slice(0, header).some((line) => /● Latest +● 1W ago +● 1M ago/.test(line))).toBe(true);
  expect(lines.slice(header + 1).filter((line) => /ES[HMUZ]\d\d\.CME/.test(line)).length).toBeGreaterThanOrEqual(4);
  // Ten rows: the curve becomes one strip line and the table keeps its rows.
  lines = await render(40, 11);
  header = lines.findIndex((line) => line.includes("CONTRACT"));
  expect(lines[header - 1]).toContain("● Price");
  expect(lines[header - 1]).toContain("Dec 26 6600.00");
  expect(lines.slice(header + 1).filter((line) => /ES[HMUZ]\d\d\.CME/.test(line)).length).toBeGreaterThanOrEqual(4);
  // Too narrow for a chart: no band at all.
  lines = await render(22, 11);
  expect(lines.join("\n")).not.toContain("●");
  expect(lines.join("\n")).toContain("ESZ26");
});
