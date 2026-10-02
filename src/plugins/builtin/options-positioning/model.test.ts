import { expect, test } from "bun:test";
import { chartWindow, expiryAxis, formatDistance, strikeAxis } from "./model";

const rows = (entries: Array<[number, number]>) => entries.map(([strike, weight]) => ({ strike, weight }));
const weight = (row: { weight: number }) => row.weight;

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
