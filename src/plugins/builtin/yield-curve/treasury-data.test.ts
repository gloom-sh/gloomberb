import { expect, test } from "bun:test";
import { curveAsOf, spreadBasisPoints, isInverted, type YieldPoint } from "./treasury-data";

function point(maturity: string, years: number, value: number | null, asOf?: string | null): YieldPoint {
  return { maturity, maturityYears: years, yield: value, asOf };
}

test("does not date a mixed-date curve as a single session", () => {
  expect(curveAsOf([
    point("2Y", 2, 4.19, "2026-08-15"),
    point("10Y", 10, 4.72, "2026-08-17"),
    point("30Y", 30, 5.31, "2026-08-17"),
  ])).toBeNull();
});

test("does not infer an undated tenor date from a different tenor", () => {
  expect(curveAsOf([
    point("2Y", 2, 4.19, null),
    point("10Y", 10, 4.72, "2026-08-17"),
  ])).toBeNull();
});

test("reports no date when the server predates the field", () => {
  expect(curveAsOf([point("2Y", 2, 4.19), point("10Y", 10, 4.72)])).toBeNull();
});


test("curve spreads require same-date yields and preserve basis-point units", () => {
  const same = [point("2Y", 2, 4.39, "2026-09-08"), point("10Y", 10, 4.80, "2026-09-08")];
  expect(curveAsOf(same)).toBe("2026-09-08");
  expect(spreadBasisPoints(same)).toBe(41);
  expect(isInverted(same)).toBe(false);
  expect(spreadBasisPoints([same[0]!, { ...same[1]!, asOf: "2026-09-09" }])).toBeNull();
  expect(isInverted([same[0]!, { ...same[1]!, yield: null }])).toBeNull();
});
