import { expect, test } from "bun:test";
import { draftFromCalculatorInputs, parseCashDividends } from "./inputs";
import { draftFromParams } from "./model";

test("dividend schedule parsing retains immediate, fractional-day and expiry payments", () => {
  expect(parseCashDividends("0:1; 10.5 : 0.25;30:0", 30)).toEqual([
    { days: 0, amount: 1 }, { days: 10.5, amount: .25 }, { days: 30, amount: 0 },
  ]);
  expect(parseCashDividends("", 0)).toEqual([]);
  for (const value of ["10", "10:1;", "10:", ":1", "10:1:2", "-1:1", "1:-1", "NaN:1", "1:Infinity", "31:1"]) {
    expect(() => parseCashDividends(value, 30)).toThrow();
  }
});

test("calculator settings convert display percentages once and preserve old decimal params", () => {
  const base = draftFromParams({ symbol: "AAPL", volatility: ".32", rate: ".045", dividendYield: ".01", days: "30" });
  expect(draftFromCalculatorInputs({}, base)).toMatchObject({ volatility: .32, rate: .045, dividendYield: .01 });
  expect(draftFromCalculatorInputs({ model: "american", volatility: "25", rate: "-1", dividendYield: "1.5",
    dividends: "10:1;20:1", steps: "400", spot: "0" }, base)).toMatchObject({ pricingModel: "american",
    volatility: .25, rate: -.01, dividendYield: .015, steps: 400, spot: 0, dividends: [{ days: 10, amount: 1 }, { days: 20, amount: 1 }] });
  for (const settings of [{ rate: "4percent" }, { volatility: -1 }, { steps: 0 }, { steps: 2.5 }, { days: "" }, { spot: true }]) {
    expect(() => draftFromCalculatorInputs(settings, base)).toThrow();
  }
});
