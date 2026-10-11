import { expect, test } from "bun:test";
import { importSource, notionalPositions, rankThirteenFLines } from "./import-13f";

// Rows as `fn 13F <manager>` reports them.
const line = (overrides: Record<string, unknown>) => ({ cusip: "x", ticker: "X", issuer: "X Corp", titleOfClass: "COM", putCall: "", shareType: "SH", value: 0, shares: 0, action: "held", ...overrides });

test("13F lines rank by reported value; options, principal amounts and untickered CUSIPs say why they are not positions", () => {
  expect(rankThirteenFLines([
    line({ cusip: "a", ticker: "AAA", value: 300, shares: 3 }),
    line({ cusip: "a", ticker: "AAA", putCall: "Call", value: 400, shares: 10 }),
    line({ cusip: "b", ticker: "", issuer: "Unmapped Inc", value: 200, shares: 4 }),
    line({ cusip: "n", ticker: "NOTE", shareType: "PRN", value: 150, shares: 150 }),
    line({ cusip: "p", ticker: "BRKRP", titleOfClass: "6.375 PREF SER A", value: 120, shares: 1 }),
    line({ cusip: "w", ticker: "XYZWS", titleOfClass: "*W EXP 06/30/202", value: 110, shares: 1 }),
    // Two CUSIPs the source maps to one ticker are one position; an exit holds nothing.
    line({ cusip: "c1", ticker: "CCC", value: 60, shares: 1 }),
    line({ cusip: "c2", ticker: "CCC", value: 40, shares: 1 }),
    line({ cusip: "z", ticker: "ZZZ", value: null, shares: null, action: "exit" }),
  ]).map(({ ticker, issuer, value, shares, skip }) => [ticker || issuer, value, shares, skip])).toEqual([
    ["AAA", 400, 10, "call option, not shares"],
    ["AAA", 300, 3, null],
    ["Unmapped Inc", 200, 4, "CUSIP b has no ticker"],
    ["NOTE", 150, 150, "principal amount, not shares"],
    ["BRKRP", 120, 1, "preferred stock, not common stock"],
    ["XYZWS", 110, 1, "warrant, not common stock"],
    ["CCC", 100, 2, null],
  ]);
  expect(importSource({ cik: "0001067983", fund: "Fund", latestPeriod: "2026-06-30", latestFiled: "2026-08-14" }))
    .toEqual({ kind: "13f", cik: "0001067983", name: "Fund", period: "2026-06-30", filed: "2026-08-14" });
  // Without a filing date there is nothing for PORT --since filed to measure from.
  expect(importSource({ cik: "0001067983", fund: "Fund", latestPeriod: "2026-06-30", latestFiled: null })).toBeNull();
});

test("imported weights come from reported value and the shares add up to the notional at the filing's prices", () => {
  const positions = notionalPositions([
    { ticker: "AAA", issuer: "A", value: 750, shares: 3 },
    { ticker: "CCC", issuer: "C", value: 250, shares: 10 },
  ], 10_000, 2_000);
  expect(positions).toEqual([
    { ticker: "AAA", issuer: "A", weight: 0.75, filingWeight: 0.375, shares: 30, avgCost: 250 },
    { ticker: "CCC", issuer: "C", weight: 0.25, filingWeight: 0.125, shares: 100, avgCost: 25 },
  ]);
  expect(positions.reduce((sum, row) => sum + row.shares * row.avgCost, 0)).toBe(10_000);
  // A filing without a complete total still imports; its share of the filing is unknown.
  expect(notionalPositions([{ ticker: "AAA", issuer: "A", value: 750, shares: 3 }], 100, null)[0]).toMatchObject({ weight: 1, filingWeight: null, shares: 0.4 });
});
