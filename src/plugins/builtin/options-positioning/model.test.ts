import { expect, test } from "bun:test";
import {
  chartWindow,
  expiryAxis,
  formatDistance,
  formatGammaTimes,
  formatPositioningSpot,
  gammaTimesFigure,
  gammaWalls,
  openInterestTotal,
  positioningSpotDetail,
  strikeAxis,
  strikeChartOpenInterest,
} from "./model";

const rows = (entries: Array<[number, number]>) => entries.map(([strike, weight]) => ({ strike, weight }));
const weight = (row: { weight: number }) => row.weight;

test("missing open interest stays blank and is not plotted as zero", () => {
  expect(openInterestTotal({ callOI: null, putOI: null })).toBeNull();
  expect(openInterestTotal({ callOI: 5, putOI: null })).toBeNull();
  expect(openInterestTotal({ callOI: null, putOI: 0 })).toBeNull();
  expect(openInterestTotal({ callOI: 0, putOI: 0 })).toBe(0);
  expect(openInterestTotal({ callOI: 5, putOI: 2 })).toBe(7);
  expect(strikeChartOpenInterest({ callOI: null, putOI: null })).toEqual({ call: null, put: null });
  const zero = strikeChartOpenInterest({ callOI: 0, putOI: 0 });
  expect(zero.call).toBe(0);
  expect(zero.put).toBe(-0);
  expect(strikeChartOpenInterest({ callOI: 4, putOI: 2 })).toEqual({ call: 4, put: -2 });
});

test("the chart keeps the strikes around spot, not the deep puts that hold open interest", () => {
  // Half the weight sits within 1% of spot, so the window is the 3% floor
  // either side, while a third of the open interest in puts 40% below would
  // otherwise set the axis.
  const strikes = rows([[400, 1_000], [700, 10], [740, 100], [760, 900], [770, 900], [790, 100], [800, 10], [900, 5]]);
  expect(chartWindow(strikes, weight, 765).map((row) => row.strike)).toEqual([760, 770]);
  // A level the chart marks stays in view.
  expect(chartWindow(strikes, weight, 765, [740]).map((row) => row.strike)).toEqual([740, 760, 770]);
  // Without spot, the middle 80% of the weight.
  expect(chartWindow(strikes, weight, null).map((row) => row.strike)).toEqual([400, 700, 740, 760, 770]);
});

test("axes read round strikes and thin expiry labels, naming a year once it changes", () => {
  const axis = strikeAxis([743, 789]);
  expect(axis.ticks(80).map((tick) => tick.label)).toEqual(["745", "750", "755", "760", "765", "770", "775", "780", "785"]);
  expect(axis.ratio(743)).toBe(0);
  expect(axis.at(1)).toBe(789);
  const expiries = expiryAxis(["2026-10-16", "2026-11-20", "2026-12-18", "2027-01-15"]);
  expect(expiries.ticks(80).map((tick) => tick.label)).toEqual(["Oct 16", "Nov 20", "Dec 18", "Jan 15 '27"]);
  expect(expiries.ticks(20).map((tick) => tick.label)).toEqual(["Oct 16", "Jan 15 '27"]);
  expect(expiries.at(0.7)).toBe("2026-12-18");
  expect(formatDistance(765, 765.54)).toBe("-0.1%");
  expect(formatDistance(765.4, 765.54)).toBe("0.0%");
});

test("the walls are the strikes with the most call and put gamma, ties to the lowest strike", () => {
  const strikes = [
    { strike: 790, calls: 5, puts: 0 },
    { strike: 760, calls: 1, puts: 9 },
    { strike: 770, calls: 5, puts: -9 },
    { strike: 780, calls: 2, puts: 3 },
  ];
  // Listed out of order: 770 beats 790 for calls and 760 beats 770 for puts on the tie, a signed put counting by its size.
  expect(gammaWalls(strikes)).toEqual({ callWall: 770, putWall: 760 });
  expect(gammaWalls([{ strike: 700, calls: 0, puts: 0 }])).toEqual({ callWall: null, putWall: null });
});

test("gamma's time and its quotes' read apart before the open, and an index outside its session reads as the close", () => {
  // SPY before the open: gamma at the pre-market print, volatilities from the last session's quotes.
  expect(formatGammaTimes("2026-10-27T10:55:00Z", "2026-10-26T20:14:59Z")).toBe("Tue 27 Oct 10:55 UTC, vols from Mon 26 Oct 20:14 UTC");
  expect(gammaTimesFigure("2026-10-27T10:55:00Z", "2026-10-26T20:14:59Z")).toEqual({
    label: "Gamma at", value: "Tue 10:55 UTC", detail: "vols from Mon 20:14 UTC",
    detailVariants: ["vols from Mon 20:14 UTC", "vols Mon 20:14 UTC", "vols Mon 20:14"],
  });
  // In the session the quotes are the same day's, so their day goes.
  expect(gammaTimesFigure("2026-10-27T14:05:00Z", "2026-10-27T14:01:10Z")?.detail).toBe("vols from 14:01 UTC");
  // An older server dates its quotes alone.
  expect(formatGammaTimes(undefined, "2026-10-26T20:14:59Z")).toBeNull();
  expect(gammaTimesFigure(undefined, "2026-10-26T20:14:59Z")).toEqual({ label: "Quotes as of", value: "Mon 20:14 UTC" });

  // SPX stamped at 20:43 after Monday's close is that close, not an after-hours print; a share's is after hours.
  expect(positioningSpotDetail(7722.6, "2026-10-26T20:00:00.000Z", undefined, "close").detail).toBe("close Mon 26 Oct");
  expect(formatPositioningSpot(7722.6, "2026-10-26T20:00:00.000Z", undefined, "close")).toBe("7,722.60 close Mon 26 Oct");
  expect(positioningSpotDetail(770.1, "2026-10-26T20:43:00.000Z").detail).toBe("after hours Mon 26 Oct 20:43 UTC");
});
