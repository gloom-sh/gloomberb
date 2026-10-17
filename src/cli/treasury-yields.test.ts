import { expect, test } from "bun:test";
import { treasuryYieldTenor } from "./treasury-yields";

test("a Treasury yield typed as a ticker or a phrase reads as its tenor, and anything that could be another market does not", () => {
  const series = (text: string) => treasuryYieldTenor(text)?.fred ?? null;
  for (const text of ["US10Y", "ust10y", "US10YR", "USGG10YR", "US10YT", "10Y", "10yr", "10-year", "TNX", "10 year yield", "U.S. 10-year Treasury", "yield on the 10y"]) {
    expect([text, series(text)]).toEqual([text, "DGS10"]);
  }
  expect(["US2Y", "US30Y", "TYX", "US3M", "3-month bill", "IRX"].map(series)).toEqual(["DGS2", "DGS30", "DGS30", "DGS3MO", "DGS3MO", "DGS3MO"]);
  // Only the tenors Cboe has an index for name one.
  expect(treasuryYieldTenor("US2Y")?.index).toBeUndefined();
  expect(treasuryYieldTenor("US30Y")?.index).toBe("^TYX");
  // 3M is the company, "10 year" names no market, ^TNX already quotes, the rest are spreads, other series or other markets.
  for (const text of ["3M", "10 year", "^TNX", "T10Y2Y", "5Y5Y", "2s10s", "DGS10", "german 10 year yield", "10 year bund", "US15Y", "10Y=F", "AAPL", ""]) {
    expect([text, series(text)]).toEqual([text, null]);
  }
});
