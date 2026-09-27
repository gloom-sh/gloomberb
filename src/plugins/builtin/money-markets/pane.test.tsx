import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { MoneyMarketRow, MoneyMarketsPayload } from "../../../api-client/money-markets";
import { testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { moneyMarketsCache } from "./client";
import { MoneyMarketsPane } from "./pane";

const DAY = 86_400_000;
const END = Date.parse("2026-09-24");

/** A FRED row with a month of daily history that drifts to its latest value. */
function row(id: string, label: string, value: number, overrides: Partial<MoneyMarketRow> = {}): MoneyMarketRow {
  const unit = overrides.unit ?? "percent";
  const history = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(END - (29 - index) * DAY).toISOString().slice(0, 10),
    value: Number((value - (29 - index) * (unit === "percent" ? 0.01 : 5)).toFixed(3)),
  }));
  return { id, label, seriesId: id.toUpperCase(), sourceSeriesIds: [id.toUpperCase()], sourceUrl: `https://fred.stlouisfed.org/series/${id}`,
    group: "rates", unit, frequency: "daily", value, asOf: "2026-09-24", previousValue: value - 0.01, previousAsOf: "2026-09-23",
    change: unit === "percent" ? 1 : 5, changeUnit: unit === "percent" ? "basis-points" : "usd-billions",
    percentile: { value: 80, rank: 24, sampleCount: 30, windowStart: history[0]!.date, windowEnd: "2026-09-24", min: history[0]!.value, max: value, mean: value },
    history, status: "available", fetchedAt: "2026-09-24T12:00:00Z", unavailableReason: null, notes: [], ...overrides };
}

const BILLS = [
  { tenor: "4W", seriesId: "DTB4WK", years: 28 / 365, value: 3.86 },
  { tenor: "3M", seriesId: "DTB3", years: 0.25, value: 4.08 },
  { tenor: "6M", seriesId: "DTB6", years: 0.5, value: 4.22 },
  { tenor: "1Y", seriesId: "DTB1YR", years: 1, value: 4.27 },
];

function payload(): MoneyMarketsPayload {
  const snapshot = (shift: number) => BILLS.map((bill) => ({ tenor: bill.tenor, maturityYears: bill.years, seriesId: bill.seriesId, value: Number((bill.value - shift).toFixed(2)) }));
  return {
    generatedAt: "2026-09-24T12:00:00Z", status: "available",
    rows: [
      row("sofr", "SOFR", 3.88), row("effr", "EFFR", 3.87),
      ...BILLS.map((bill) => row(`bill-${bill.tenor.toLowerCase()}`, `${bill.tenor} bill`, bill.value, { group: "bills", seriesId: bill.seriesId })),
      row("rrp", "Overnight RRP", 120, { group: "liquidity", unit: "usd-billions" }),
    ],
    netLiquidity: row("net-liquidity", "Net liquidity", 5800, { group: "liquidity", unit: "usd-billions", seriesId: null, sourceUrl: null }),
    billsCurve: { asOf: "2026-09-24", status: "available", basis: "discount", points: snapshot(0),
      comparisons: [
        { period: "1W", targetDate: "2026-09-17", asOf: "2026-09-17", points: snapshot(0.03) },
        { period: "1M", targetDate: "2026-08-24", asOf: "2026-08-24", points: snapshot(0.22) },
      ],
      slope: { valueBps: 41, asOf: "2026-09-24", percentile: row("slope", "slope", 41).percentile, history: [] } },
  };
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let spy: { mockRestore(): void } | undefined;
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  spy?.mockRestore(); spy = undefined;
  moneyMarketsCache.reset();
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
}

async function render(width: number, height: number, tab = "rates"): Promise<string[]> {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  spy ??= spyOn(apiClient, "getCloudMoneyMarkets").mockImplementation(async () => payload());
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-money-markets-test", {
    instanceId: "btmm", paneId: "money-markets", binding: { kind: "none" }, settings: { tab },
  }));
  initial.focusedPaneId = "btmm";
  function Harness() {
    // The selected row is pane state, so moving it needs a reducer.
    const [state, setState] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setState((current) => appReducer(current, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="btmm" pluginId="money-markets" runtime={createTestPluginRuntime()} width={width} height={height}>
      {(body) => <MoneyMarketsPane paneId="btmm" paneType="money-markets" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width, height }); });
  await settle();
  return setup!.captureCharFrame().split("\n");
}

async function pressDown() {
  await act(async () => { setup!.mockInput.pressArrow("down"); await setup!.renderOnce(); });
  await settle();
  return setup!.captureCharFrame().split("\n");
}

/** The lines above the board's header row. */
function band(lines: string[]): string[] {
  return lines.slice(0, lines.findIndex((line) => line.includes("INSTRUMENT")));
}

test("the rates chart follows the selected rate, and its legend names it", async () => {
  let lines = await render(88, 28);
  expect(band(lines).some((line) => line.includes("● SOFR 3.88%"))).toBe(true);
  lines = await pressDown();
  expect(band(lines).some((line) => line.includes("● EFFR 3.87%"))).toBe(true);
  expect(band(lines).join("\n")).not.toContain("SOFR");
  // Axis labels in the board's units.
  expect(band(lines).some((line) => /\d\.\d+%\s*$/.test(line))).toBe(true);
});

test("liquidity charts the selected balance in billions", async () => {
  let lines = await render(88, 28, "liquidity");
  expect(band(lines).some((line) => line.includes("● Net liquidity $5,800.0B"))).toBe(true);
  expect(band(lines).some((line) => /\$[\d,]+B\s*$/.test(line))).toBe(true);
  lines = await pressDown();
  expect(band(lines).some((line) => line.includes("● Overnight RRP $120.0B"))).toBe(true);
});

test("the bills curve names what it plots, and the selected bill is its point", async () => {
  let lines = await render(88, 28, "bills");
  expect(band(lines).some((line) => line.includes("Discount yield % by bill tenor") && line.includes("● Latest")
    && line.includes("● 1W ago"))).toBe(true);
  expect(band(lines).some((line) => line.includes("1Y-4W") && line.includes("+41.0bp"))).toBe(true);
  // The readout reads look-backs in basis points, like the board's change column.
  expect(band(lines).some((line) => line.includes("4W 3.86%  1W ago +3.0bp  1M ago +22.0bp"))).toBe(true);
  lines = await pressDown();
  expect(band(lines).some((line) => line.includes("3M 4.08%  1W ago +3.0bp"))).toBe(true);
});

test("a short pane keeps the board: the chart shrinks into the rows it leaves, becomes a strip, then goes", async () => {
  let lines = await render(40, 10);
  const header = lines.findIndex((line) => line.includes("INSTRUMENT"));
  // Two rates fit whole, so a compact chart takes the rows they leave.
  expect(lines.slice(0, header).some((line) => line.includes("● SOFR"))).toBe(true);
  expect(lines.slice(header + 1).filter((line) => /SOFR|EFFR/.test(line))).toHaveLength(2);
  lines = await render(40, 10, "bills");
  expect(band(lines).some((line) => line.includes("● Discount yield") && line.includes("4W 3.86%"))).toBe(true);
  expect(lines.filter((line) => /\d[WMY] bill/.test(line))).toHaveLength(4);
  lines = await render(22, 10);
  expect(lines.join("\n")).not.toContain("●");
  expect(lines.join("\n")).toContain("SOFR");
});
