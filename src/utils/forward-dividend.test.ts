import { expect, test } from "bun:test";
import { forwardDividendBasis, forwardDividendNote } from "./forward-dividend";

test("a forward rate is never as of a day that has not come: an ex-date ahead names the declared distribution", () => {
  const now = new Date("2026-10-13T17:00:00Z");
  // The latest distribution's ex-date has passed, today included.
  expect(forwardDividendBasis("2026-08-20", { now })).toBe("latest distribution annualized, as of 2026-08-20");
  expect(forwardDividendBasis("2026-10-13", { now, payDate: "2026-11-05" })).toBe("latest distribution annualized, as of 2026-10-13");
  // MSFT once its next quarter is declared: Gloom Cloud dates the rate by the coming ex-date.
  expect(forwardDividendBasis("2026-11-19", { now, payDate: new Date("2026-12-10T00:00:00Z") }))
    .toBe("annualized from the declared distribution payable 2026-12-10, ex 2026-11-19");
  expect(forwardDividendBasis("2026-11-19", { now })).toBe("annualized from the declared distribution, ex 2026-11-19");
  expect(forwardDividendBasis(null, { now })).toBe("latest distribution annualized");
  expect([forwardDividendNote("2026-08-20", now), forwardDividendNote("2026-11-19", now)]).toEqual(["as of 2026-08-20", "declared"]);
});
