import { expect, test } from "bun:test";
import { sessionRangeReport } from "./session-range";

const bar = (at: string, low: number, high: number, close = (low + high) / 2) => ({ date: new Date(at), low, high, close });

test("a session's low and high are the bars' own extremes, each at the first bar that reached it", () => {
  const points = [
    bar("2026-10-17T11:29:00Z", 0.9984, 0.9986),
    // The low is this bar's low, not any close.
    bar("2026-10-17T11:30:00Z", 0.9983299970626831, 0.9985),
    bar("2026-10-17T15:00:00Z", 0.9983299970626831, 0.9986),
    bar("2026-10-17T21:39:00Z", 0.9986, 0.9988099932670593),
    { date: new Date("2026-10-17T22:00:00Z"), close: 0.9987 },
  ];
  const report = sessionRangeReport([{ symbol: "USDT-USD", exchange: "CCC", points, sessionDates: ["2026-10-17"], quote: { currency: "USD" } }]);
  expect(report.ranges).toEqual([{
    symbol: "USDT-USD", exchange: "CCC", low: 0.99833, lowAt: "2026-10-17T11:30:00.000Z", high: 0.99881, highAt: "2026-10-17T21:39:00.000Z",
  }]);
  expect(report.entries.map((entry) => [entry.label, entry.formatted])).toEqual([
    ["USDT-USD:CCC session low", "0.99833 at 2026-10-17 11:30 UTC"],
    ["USDT-USD:CCC session high", "0.99881 at 2026-10-17 21:39 UTC"],
  ]);
  // A week of sessions says low and high; a window with no bars says nothing.
  const week = sessionRangeReport([{ symbol: "BTC-USD", exchange: "CCC", points, sessionDates: ["2026-10-16", "2026-10-17"] },
    { symbol: "ETH-USD", exchange: "CCC", points: [] }]);
  expect(week.entries.map((entry) => entry.label)).toEqual(["BTC-USD:CCC low", "BTC-USD:CCC high"]);
});
