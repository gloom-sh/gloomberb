import { expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../types/financials";
import { valueOption } from "../../plugins/builtin/shared/volatility";
import {
  chainWithModelFigures,
  formatExpiryList,
  formatOptionDeltaCell,
  formatOptionIvCell,
  missingExpiryMessage,
  optionRows,
} from "./options-chain";

const at = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

test("a missing expiry names the listed dates nearest the one asked for, in date order", () => {
  const listed = ["2026-10-16", "2027-01-15", "2027-12-17", "2028-03-17", "2028-06-16", "2028-12-15", "2029-01-19"].map(at);
  const miss = missingExpiryMessage("AAPL", at("2028-01-21"), listed);
  expect(miss.message).toBe("no expiry 2028-01-21 for AAPL; available: 2027-12-17, 2028-03-17, 2028-06-16, 2028-12-15 (+3 more)");
  expect(miss.details).toContain("gloomberb options AAPL");
});

test("a missing expiry says so when the chain lists none, and when the date is listed but empty", () => {
  expect(missingExpiryMessage("AAPL", at("2028-01-21"), []).message).toBe("no expiry 2028-01-21 for AAPL; the chain lists no expiries");
  const listed = missingExpiryMessage("AAPL", at("2028-01-21"), [at("2028-01-21"), at("2028-03-17")]).message;
  expect(listed).toContain("no option contracts returned for AAPL expiry 2028-01-21");
  expect(listed).toContain("2028-03-17");
  expect(listed).not.toContain("2028-01-21,");
});

test("the expiry list wraps to the terminal and counts what it leaves out", () => {
  const dates = Array.from({ length: 50 }, (_, index) => at("2026-10-01") + index * 7 * 86_400);
  const lines = formatExpiryList(dates, 60).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  expect(lines[0]).toContain("Expiries (50, nearest 40 shown, last 2027-09-09)");
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(60);
  expect(formatExpiryList([], 60)).toBe("");
});

test("delta and IV cells print a dash for what could not be valued, never a zero", () => {
  expect(formatOptionDeltaCell(0.5234)).toBe("0.52");
  expect(formatOptionDeltaCell(-0.5234)).toBe("-0.52");
  expect(formatOptionDeltaCell(-0.0003)).toBe("0.00");
  for (const missing of [null, undefined, Number.NaN, "x"]) expect(formatOptionDeltaCell(missing)).toBe("—");
  expect(formatOptionIvCell(0.3171)).toBe("31.7%");
  for (const missing of [null, 0, Number.NaN]) expect(formatOptionIvCell(missing)).toBe("—");
});

function contract(side: "C" | "P", strike: number, expiration: number, volatility: number): OptionContract {
  // A quote priced by the app's own pricer, one year out at the test's valuation time.
  const mid = valueOption({ side: side === "C" ? "call" : "put", spot: 100, strike, daysToExpiry: 365, rate: 0.04, volatility, dividendYield: 0 }).price;
  return {
    contractSymbol: `XYZ${side}${strike}`, strike, currency: "USD", lastPrice: mid, change: 0, percentChange: 0,
    bid: mid - 0.05, ask: mid + 0.05, impliedVolatility: 0, inTheMoney: false, expiration, lastTradeDate: 0,
  };
}

test("rows carry the pane's solved IV and signed delta, and nulls where none can be valued", () => {
  const expiration = at("2027-01-15");
  const now = Date.parse("2026-01-15T21:00:00Z");
  const strikes = [90, 100, 110];
  const chain: OptionsChain = {
    underlyingSymbol: "XYZ",
    expirationDates: [expiration],
    calls: strikes.map((strike) => contract("C", strike, expiration, 0.25)),
    puts: strikes.map((strike) => contract("P", strike, expiration, 0.25)),
  };
  const rows = optionRows(chainWithModelFigures(chain, { spot: 100, dividendYield: 0, now }));
  const call = rows.find((row) => row.contract === "XYZC100")!;
  const put = rows.find((row) => row.contract === "XYZP100")!;
  expect(call.iv!).toBeGreaterThan(0.23);
  expect(call.iv!).toBeLessThan(0.27);
  expect(call.delta!).toBeGreaterThan(0.5);
  expect(call.delta!).toBeLessThan(0.7);
  expect(put.delta!).toBeGreaterThan(-0.5);
  expect(put.delta!).toBeLessThan(-0.3);

  for (const row of optionRows(chainWithModelFigures(chain, { now }))) expect([row.iv, row.delta]).toEqual([null, null]);
  // An expiry already past has no time left to value.
  const expired = { ...chain, calls: chain.calls.map((c) => ({ ...c, expiration: at("2020-01-17") })), puts: [] };
  for (const row of optionRows(chainWithModelFigures(expired, { spot: 100, now }))) expect([row.iv, row.delta]).toEqual([null, null]);
});
