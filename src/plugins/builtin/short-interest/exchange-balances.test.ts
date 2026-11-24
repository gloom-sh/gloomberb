import { expect, test } from "bun:test";
import { balanceListing } from "./exchange-balances";

test("Taiwan's two trading venues keep their own balances, including vendor suffixes", () => {
  expect(balanceListing("2454:TPE")).toEqual({symbol:"2454", exchange:"TWSE"});
  expect(balanceListing("6488.TWO")).toEqual({symbol:"6488", exchange:"TPEX"});
  expect(balanceListing("00400A", "TWSE")).toEqual({symbol:"00400A", exchange:"TWSE"});
  for (const key of ["6488.TWO:TWSE","2454.TW:JPX","2454","TSM:NYSE"]) expect(balanceListing(key)).toBeNull();
});

test("mainland balances require six digits and matching exchange qualifiers", () => {
  expect(balanceListing("300750.SZ")).toEqual({ symbol: "300750", exchange: "SZSE" });
  expect(balanceListing("600519.SS:SSE")).toEqual({ symbol: "600519", exchange: "SSE" });
  for (const key of ["300750.SZ:SSE", "600519.SS:HKEX", "300750", "30075:SSE"]) expect(balanceListing(key)).toBeNull();
});

test("Korean stock codes retain their market and preferred-share suffix", () => {
  expect(balanceListing("00680K.KS")).toEqual({symbol: "00680K", exchange: "KRX"});
  expect(balanceListing("196170.KQ:KOSDAQ")).toEqual({symbol: "196170", exchange: "KOSDAQ"});
  expect(balanceListing("005930.KS:KOSDAQ")).toBeNull();
});
