import { expect, test } from "bun:test";
import {
  buyAndHoldReturns,
  concentration,
  historicalTail,
  pairedReturns,
  regressReturns,
  rollingBasketRisk,
  rollingBeta,
  sinceBasketRisk,
  subtractReturns,
} from "./risk-math";
import type { DatedReturn } from "./metrics";
function returns(length = 140): DatedReturn[] {
  const start = Date.parse("2025-01-01");
  return Array.from({ length }, (_, index) => ({
    startDateKey: new Date(start + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
    dateKey: new Date(start + (index + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    value: Math.sin(index) / 100,
  }));
}
test("historical VaR uses the declared tail and expected shortfall retains tail losses", () => {
  const tail = historicalTail([...Array(57).fill(0.01), -0.03, -0.02, -0.01])!;
  expect(tail.var).toBe(0.01);
  expect(tail.expectedShortfall).toBeCloseTo(0.02, 12);
  expect(historicalTail(Array(59).fill(0))).toBeNull();
  expect(historicalTail(Array(60).fill(0.01))).toEqual({
    var: 0,
    expectedShortfall: 0,
  });
});
test("beta matches both interval endpoints and refuses a constant explanatory series", () => {
  const factor = returns(),
    asset = factor.map((row) => ({ ...row, value: 0.001 + 2 * row.value }));
  const result = regressReturns(asset, factor)!;
  expect(result.beta).toBeCloseTo(2, 12);
  expect(result.intercept).toBeCloseTo(0.001, 12);
  expect(result.rSquared).toBeCloseTo(1, 12);
  expect(
    regressReturns(
      asset,
      factor.map((row) => ({ ...row, value: 0 })),
    ),
  ).toBeNull();
  const wrong = factor.map((row) => ({ ...row, startDateKey: "2024-01-01" }));
  expect(pairedReturns(asset, wrong)).toEqual([]);
  expect(regressReturns(asset, wrong)).toBeNull();
  expect(subtractReturns(asset, factor)[0]!.value).toBeCloseTo(
    0.001 + factor[0]!.value,
    12,
  );
});
test("rolling risk preserves missing intervals and computes same-horizon historical percentiles", () => {
  const asset = returns(),
    sample = pairedReturns(asset, asset);
  const result = rollingBasketRisk(sample);
  expect(result.find((row) => row.id === "active")!.value).toBe(0);
  expect(result.find((row) => row.id === "active")!.rank.percentile).toBe(50);
  expect(result.find((row) => row.id === "tracking")!.value).toBe(0);
  expect(
    result.every(
      (row) =>
        row.samples === 60 && row.startDate === sample.at(-60)!.startDateKey,
    ),
  ).toBe(true);
  const missing = sample.filter((_, index) => index !== 100);
  expect(rollingBasketRisk(missing).every((row) => row.value === null)).toBe(
    true,
  );
  expect(rollingBeta(asset, asset, "Market", "market").value).toBeCloseTo(
    1,
    12,
  );
  expect(rollingBeta(asset, asset, "Market", "market").rank.percentile).toBe(
    50,
  );
});
test("risk since a filing date runs from the last close on or before it, over the trailing unbroken sessions", () => {
  // Weekday sessions only: 2025-05-10 is a Saturday, so the window starts at Friday's close.
  const sessions = returns(200).filter((row) => ![0, 6].includes(new Date(row.dateKey).getUTCDay()));
  const sample = pairedReturns(
    sessions.map((row, index) => ({ ...row, startDateKey: sessions[index - 1]?.dateKey ?? row.startDateKey })),
    sessions.map((row, index) => ({ ...row, startDateKey: sessions[index - 1]?.dateKey ?? row.startDateKey, value: 0.001 })),
  );
  const rows = sinceBasketRisk(sample, "2025-05-10");
  const window = sample.filter((row) => row.dateKey > "2025-05-10");
  const value = (id: string) => rows.find((row) => row.id === id)!;
  expect(window[0]!.startDateKey).toBe("2025-05-09");
  expect(value("return")).toMatchObject({ label: "Basket return since 2025-05-09", startDate: "2025-05-09", samples: window.length });
  expect(value("return").value).toBeCloseTo(100 * (window.reduce((wealth, row) => wealth * (1 + row.value), 1) - 1), 10);
  expect(value("benchmark").label).toBe("Benchmark return (SPY) since 2025-05-09");
  expect(value("return").rank.percentile).toBeNull();
  expect(value("return").history.at(-1)!.value).toBe(value("return").value);
  // Fewer than 60 sessions: no tail estimate.
  expect(window.length).toBeLessThan(60);
  expect(value("var")).toMatchObject({ label: "1D VaR 95% (since 2025-05-09)", value: null });
  // A missing session after the filing restarts the window after the gap.
  const gapped = sample.filter((row) => row.dateKey !== window[3]!.dateKey);
  expect(sinceBasketRisk(gapped, "2025-05-10")[0]!.startDate).toBe(window[4]!.startDateKey);
});
test("a held basket starts at the close on or before the filing, holds a halted holding flat until its return lands, and names what ends it", () => {
  const point = (startDateKey: string, dateKey: string, value: number) => ({ startDateKey, dateKey, value });
  // Filed on Saturday 15 Aug: bought at Friday's close, valued on the benchmark's sessions.
  const calendar = [point("2026-08-13", "2026-08-14", 0), point("2026-08-14", "2026-08-17", 0), point("2026-08-17", "2026-08-18", 0), point("2026-08-18", "2026-08-19", 0), point("2026-08-19", "2026-08-20", 0)];
  const a = [point("2026-08-13", "2026-08-14", 0.5), point("2026-08-14", "2026-08-17", 0.1), point("2026-08-17", "2026-08-18", 0), point("2026-08-18", "2026-08-19", 0.2), point("2026-08-19", "2026-08-20", 0)];
  // B is halted on 19 Aug: no close that day, then one return over both days.
  const b = [point("2026-08-13", "2026-08-14", -0.5), point("2026-08-14", "2026-08-17", -0.1), point("2026-08-17", "2026-08-18", 0.1), point("2026-08-18", "2026-08-20", 0.1)];
  const held = buyAndHoldReturns([{ weight: 0.5, returns: a }, { weight: 0.5, returns: b }], "2026-08-15", calendar);
  expect(held.returns.map((row) => `${row.startDateKey}/${row.dateKey}`)).toEqual(["2026-08-14/2026-08-17", "2026-08-17/2026-08-18", "2026-08-18/2026-08-19", "2026-08-19/2026-08-20"]);
  // 1.1 and 0.9 after the first session; B's 10% lands on its 0.495 share on the 20th, flat the day before.
  expect(held.returns.map((row) => row.value)).toEqual([0, 0.045, 1.155 / 1.045 - 1, 1.2045 / 1.155 - 1].map((value) => expect.closeTo(value, 12) as unknown as number));
  // Over the run, the basket is worth each holding's weight times its own price move: 0.5 x 1.32 + 0.5 x 1.089.
  expect(held.returns.reduce((wealth, row) => wealth * (1 + row.value), 1)).toBeCloseTo(1.2045, 12);
  expect(held).toMatchObject({ cutShort: null, unpriced: [] });

  // C's closes stop on the 18th, so the basket stops there and says so; D has no close by the filing and is left out.
  const c = a.slice(0, 3);
  const d = [point("2026-08-17", "2026-08-18", 0.3)];
  const short = buyAndHoldReturns([{ weight: 0.5, returns: a }, { weight: 0.3, returns: c }, { weight: 0.2, returns: d }], "2026-08-15", calendar);
  expect(short.returns.at(-1)!.dateKey).toBe("2026-08-18");
  expect(short).toMatchObject({ cutShort: { holding: 1, date: "2026-08-18" }, unpriced: [2] });
});

test("concentration uses gross signed exposure and never renormalizes an unvalued holding", () => {
  const result = concentration([
    { id: "a", value: 60 },
    { id: "b", value: -40 },
  ])!;
  expect(result.gross).toBe(100);
  expect(result.net).toBe(20);
  expect(result.hhi).toBeCloseTo(0.52, 12);
  expect(result.top).toBe(0.6);
  expect(
    concentration([
      { id: "a", value: 60 },
      { id: "b", value: null },
    ]),
  ).toBeNull();
});
