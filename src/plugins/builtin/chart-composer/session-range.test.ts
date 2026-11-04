import { expect, test } from "bun:test";
import { sessionRangeReport, usBarCoverageNotice } from "./session-range";

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

// GPK's one-minute bars on Tue 3 Nov 2026 went from 14:31 to 14:33 UTC, and nothing said a minute was missing.
test("a US line's bars say how many of the regular session's spans had no price-setting print", () => {
  const minutes = (times: string[]) => times.map((time) => bar(`2026-11-03T${time}:00Z`, 10.2, 10.3));
  const trading = minutes(["14:29", "14:30", "14:31", "14:33", "14:34"]);
  const basis = "Bars are of every US venue's prints that set a price; odd lots and special-condition prints count only in volume.";
  // While the session trades, it counts to its newest bar; a pre-market bar is not the regular session's.
  expect(usBarCoverageNotice([{ symbol: "GPK", exchange: "NYSE", points: trading, resolution: "1m" }], Date.parse("2026-11-03T14:50:00Z")))
    .toBe(`${basis} 1 of 5 minutes had none, so no bar.`);
  // A closed session counts to its 16:00 close (21:00 UTC in November).
  const closed = usBarCoverageNotice([{ symbol: "GPK", exchange: "NYSE", points: trading, resolution: "1m" }], Date.parse("2026-11-04T12:00:00Z"));
  expect(closed).toBe(`${basis} 386 of 390 minutes had none, so no bar.`);
  // Several lines name each; five-minute bars count spans; a line abroad or a future says nothing.
  expect(usBarCoverageNotice([
    { symbol: "GPK", exchange: "NYSE", points: trading, resolution: "1m" },
    { symbol: "AAPL", exchange: "NASDAQ", points: minutes(["14:30", "14:40"]), resolution: "5m" },
  ], Date.parse("2026-11-03T14:50:00Z"))).toBe(`${basis} GPK:XNYS: 1 of 5 minutes had none, so no bar. AAPL:XNAS: 1 of 3 5-minute spans had none, so no bar.`);
  expect(usBarCoverageNotice([{ symbol: "D05", exchange: "SGX", points: trading, resolution: "1m" }])).toBeNull();
  expect(usBarCoverageNotice([{ symbol: "ESZ26", exchange: "CME", points: trading, resolution: "1m" }])).toBeNull();
});

test("a US line's range is its regular session's, as quote reads the day's", () => {
  // GPK traded 9.33 the evening before; the session's low is 10.17.
  const points = [bar("2026-11-03T00:52:00Z", 9.33, 9.33), bar("2026-11-03T14:30:00Z", 10.17, 10.62), bar("2026-11-03T18:40:00Z", 11.1, 11.19)];
  const report = sessionRangeReport([{ symbol: "GPK", exchange: "NYSE", points, sessionDates: ["2026-11-03"] }]);
  expect(report.entries.map((entry) => [entry.label, entry.formatted])).toEqual([
    ["GPK:XNYS regular-session low", "10.17 at 2026-11-03 14:30 UTC"],
    ["GPK:XNYS regular-session high", "11.19 at 2026-11-03 18:40 UTC"],
  ]);
});

test("on an early close, prints after the 13:00 close are not the regular session's", () => {
  // Fri 27 Nov 2026 closes at 13:00 New York (18:00 UTC); a 14:10 after-hours print is not the session's low.
  const points = [bar("2026-11-27T14:30:00Z", 10.17, 10.62), bar("2026-11-27T17:59:00Z", 10.4, 11.19), bar("2026-11-27T19:10:00Z", 9.8, 11.5)];
  const report = sessionRangeReport([{ symbol: "GPK", exchange: "NYSE", points, sessionDates: ["2026-11-27"] }]);
  expect(report.entries.map((entry) => entry.formatted)).toEqual(["10.17 at 2026-11-27 14:30 UTC", "11.19 at 2026-11-27 17:59 UTC"]);
  // Its minutes are counted to 13:00: 210 of them.
  expect(usBarCoverageNotice([{ symbol: "GPK", exchange: "NYSE", points, resolution: "1m" }], Date.parse("2026-11-30T12:00:00Z")))
    .toContain("208 of 210 minutes had none");
});
