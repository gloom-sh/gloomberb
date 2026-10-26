import { expect, test } from "bun:test";
import { flowStrikeRows, flowTideMoves, flowTidePoints, flowTideRows, formatSignedFlowPremium } from "./flow-session";

const MINUTES = 60_000;
const OPEN = Date.parse("2026-10-26T13:30:00Z");

test("the tide runs the bought-less-sold premium of calls against puts through the session", () => {
  const rows = flowTideRows({
    session: "2026-10-26",
    bucketMs: 5 * MINUTES,
    // Out of order on purpose: the totals run in time order.
    buckets: [
      { at: OPEN + 15 * MINUTES, callAsk: 0, callBid: 0, putAsk: 400_000, putBid: 0 },
      { at: OPEN, callAsk: 1_000_000, callBid: 250_000, putAsk: 100_000, putBid: 300_000 },
      // Mid prints only: the bucket is on the chart and moves nothing.
      { at: OPEN + 20 * MINUTES, callAsk: 0, callBid: 0, putAsk: 0, putBid: 0 },
    ],
  } as never);
  expect(rows.map(({ at, netCalls, netPuts, net, change }) => ({ at, netCalls, netPuts, net, change }))).toEqual([
    // Calls 1M bought less 250K sold; puts 100K bought less 300K sold: the tide is +950K.
    { at: OPEN, netCalls: 750_000, netPuts: -200_000, net: 950_000, change: 950_000 },
    { at: OPEN + 15 * MINUTES, netCalls: 750_000, netPuts: 200_000, net: 550_000, change: -400_000 },
    { at: OPEN + 20 * MINUTES, netCalls: 750_000, netPuts: 200_000, net: 550_000, change: 0 },
  ]);
  expect(flowTideMoves(rows).map((row) => row.at)).toEqual([OPEN, OPEN + 15 * MINUTES]);
  // A quiet stretch holds the totals flat rather than sloping across it.
  expect(flowTidePoints(rows, 5 * MINUTES).map((point) => [point.at - OPEN, point.net])).toEqual([
    [0, 950_000], [5 * MINUTES, 950_000], [10 * MINUTES, 950_000], [15 * MINUTES, 550_000], [20 * MINUTES, 550_000],
  ]);
  expect(formatSignedFlowPremium(550_000)).toBe("+$550K");
  expect(formatSignedFlowPremium(-1_250_000)).toBe("-$1.3M");
  expect(formatSignedFlowPremium(0)).toBe("$0");
});

test("a strike's net uses the same side rule", () => {
  expect(flowStrikeRows({
    session: "2026-10-26", bucketMs: 5 * MINUTES, buckets: [],
    strikes: [{ expiry: "2026-10-30", strike: 200, callPremium: 900_000, putPremium: 500_000,
      callAsk: 600_000, callBid: 100_000, putAsk: 0, putBid: 400_000, prints: 6 }],
  })[0]).toMatchObject({ id: "2026-10-30:200", net: 900_000 });
});
