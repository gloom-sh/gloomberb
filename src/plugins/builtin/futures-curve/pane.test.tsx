import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { FuturesContract, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { FuturesCurvePane } from "./pane";

const first: FuturesContract = { symbol: "ESZ26.CME", label: "Dec 2026", expiration: "2026-12-18",
  price: 6600, asOf: "2026-09-22T15:00:00Z", currency: "USD", quoteUnit: "index points", volume: 1000, openInterest: 5000, delayMinutes: 10,
  stale: false, percentile: 50, samples: 200, historyStart: "2025-09-22", historyEnd: "2026-09-21" };
const CONTRACTS = ["ESZ26", "ESH27", "ESM27", "ESU27", "ESZ27", "ESH28", "ESM28", "ESU28"].map((code, index) => ({ ...first,
  symbol: `${code}.CME`, expiration: new Date(Date.UTC(2026, 11 + index * 3, 18)).toISOString().slice(0, 10), price: 6600 + index * 40 }));
function payload(): FuturesCurvePayload {
  return { root: "ES", name: "E-mini S&P 500", source: "yahoo", currency: "USD", quoteUnit: "index points", asOf: first.asOf,
    fetchedAt: "2026-09-22T15:05:00Z", status: "available", stale: false,
    catalogue: { method: "bounded-search", complete: true, horizonEnd: "2029-09-01" }, contracts: CONTRACTS,
    ghosts: [{ label: "1W", requestedDate: "2026-09-15", asOf: "2026-09-15", points: CONTRACTS.map((row) => ({
      symbol: row.symbol, expiration: row.expiration, price: row.price - 50, asOf: "2026-09-15" })) }],
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
});

async function render(width: number, height: number): Promise<string[]> {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-futures-curve-test", { instanceId: "ctm", paneId: "futures-curve", binding: { kind: "none" } }));
  state.focusedPaneId = "ctm";
  await act(async () => { setup = await testRender(<TestPaneFrame state={state} paneId="ctm" pluginId="futures-curve" runtime={createTestPluginRuntime()} width={width} height={height}>
    {(body) => <FuturesCurvePane paneId="ctm" paneType="futures-curve" focused {...body} />}
  </TestPaneFrame>, { width, height }); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
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
