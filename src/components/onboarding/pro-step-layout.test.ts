import { describe, expect, test } from "bun:test";
import { planProFeatureRows, planProStep, wrappedActionRows } from "./pro-step-layout";

describe("planProFeatureRows", () => {
  test("degrades from the bottom of the ranking: descriptions go first, then whole features", () => {
    const descriptions = [1, 1, 1, 2];
    expect(planProFeatureRows(9, descriptions)).toEqual([2, 2, 2, 3]);
    // The first three keep their description; the fourth needs two spare rows and has one.
    expect(planProFeatureRows(8, descriptions)).toEqual([2, 2, 2, 1]);
    expect(planProFeatureRows(5, descriptions)).toEqual([2, 1, 1, 1]);
    expect(planProFeatureRows(4, descriptions)).toEqual([1, 1, 1, 1]);
    expect(planProFeatureRows(2, descriptions)).toEqual([1, 1, 0, 0]);
    expect(planProFeatureRows(-3, descriptions)).toEqual([0, 0, 0, 0]);
  });
});

describe("wrappedActionRows", () => {
  test("starts a new row for the first button that does not fit beside the one before it", () => {
    // 20 + 1 + 20 is 41 cells.
    expect(wrappedActionRows([20, 20], 41)).toBe(1);
    expect(wrappedActionRows([20, 20], 40)).toBe(2);
    expect(wrappedActionRows([20, 10, 10], 41)).toBe(2);
    expect(wrappedActionRows([30, 30], 10)).toBe(2);
    expect(wrappedActionRows([], 40)).toBe(1);
  });
});

describe("planProStep", () => {
  const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");
  // At 62 columns: one row for the first five, two for the last.
  const descriptions = [words(10), words(10), words(10), words(10), words(10), words(20)];
  const plan = (rows: number, extra: Partial<Parameters<typeof planProStep>[0]> = {}) => planProStep({
    rows, columns: 64, note: "A note.", interval: true, error: null, actions: [20, 20], descriptions, ...extra,
  });

  test("keeps the usual blank rows only while every feature fits whole", () => {
    // 9 rows of chrome (blank rows included) around 13 rows of features.
    expect(plan(22)).toEqual({ compact: false, featureRows: [2, 2, 2, 2, 2, 3] });
    // One row short: the blank rows go before any description does.
    expect(plan(21)).toEqual({ compact: true, featureRows: [2, 2, 2, 2, 2, 3] });
  });

  test("hands the list only the rows the chrome, the error line and the actions leave", () => {
    // Compact chrome is 6 rows: header, step, price, note, control, actions.
    expect(plan(14).featureRows).toEqual([2, 2, 1, 1, 1, 1]);
    expect(plan(6).featureRows).toEqual([0, 0, 0, 0, 0, 0]);
    expect(plan(14, { error: "Unable to save." }).featureRows).toEqual([2, 1, 1, 1, 1, 1]);
    expect(plan(14, { interval: false }).featureRows).toEqual([2, 2, 2, 1, 1, 1]);
    // A note that wraps to three rows takes two more.
    expect(plan(14, { note: words(30) }).featureRows).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test("keeps a row for every row the wrapped actions take", () => {
    expect(plan(14, { actions: [40, 40] }).featureRows).toEqual([2, 1, 1, 1, 1, 1]);
    expect(plan(14, { actions: [40, 40, 40] }).featureRows).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
