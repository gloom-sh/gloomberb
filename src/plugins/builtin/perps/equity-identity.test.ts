import { expect, test } from "bun:test";
import { perpEquityIdentity } from "./equity-identity";

test("perpetual comparisons retain the chosen venue, preserve share classes, and reject conflicts", () => {
  for (const [key, saved, symbol, exchange] of [
    ["NET:XNYS", "NYSE", "NET", "NYSE"], ["NET:XLON", "LSE", "NET", "LSE"],
    ["NET.L", "", "NET", "LSE"], ["NET", "LSE", "NET", "LSE"],
    ["AAPL", "NASDAQ", "AAPL", "NASDAQ"], ["AAPL:XNAS", "", "AAPL", "NASDAQ"],
    ["BRK.B", "NYSE", "BRK.B", "NYSE"], ["NET.UNKNOWN", "NYSE", "NET.UNKNOWN", "NYSE"],
  ] as const) expect(perpEquityIdentity(key!, saved!)).toEqual({ symbol, exchange });
  for (const [key, saved] of [["NET:XLON", "NYSE"], ["NET.L", "NYSE"], ["NET.L:XNYS", ""], ["NET", ""], ["NET:", "NYSE"]]) {
    expect(perpEquityIdentity(key!, saved!)).toBeNull();
  }
});
