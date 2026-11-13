import { expect, test } from "bun:test";
import { FRED_CATALOG_SERIES, fredSeriesIdForName } from "../plugins/builtin/econ/fred-catalog";
import { moneyMarketsModule } from "../plugins/builtin/money-markets";
import { findCatalogSeries } from "./series-search";
import { treasuryBillLine, treasuryYieldTenor } from "./treasury-yields";

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

// "t-bill" and its spellings found nothing, and "3 month t-bill" pointed at the constant-maturity yield alone, a
// different number from the bill rate.
test("bill words reach the bill rates: the money-markets function, the FRED bill series and the gap line", () => {
  const bill = (text: string) => {
    const tenor = treasuryYieldTenor(text);
    return tenor ? treasuryBillLine(text, tenor) : null;
  };
  expect(bill("3 month t-bill")).toBe("US 3-month Treasury bill: gloom fn BTMM --tab bills (bill rates), gloom fred DTB3 (daily). "
    + "Constant-maturity yield, the curve's basis: gloom fred DGS3MO.");
  expect(bill("6 month tbill")).toContain("gloom fred DTB6");
  expect(bill("US3M")).toBeNull();
  expect(["3 month t-bill", "3-month treasury bill", "six month t-bills", "1 year tbill"].map(fredSeriesIdForName))
    .toEqual(["DTB3", "DTB3", "DTB6", "DTB1YR"]);
  expect(fredSeriesIdForName("treasury bill")).toBeNull();
  for (const query of ["t-bill", "t-bills", "tbill", "money market"]) {
    expect([query, findCatalogSeries([{ series: FRED_CATALOG_SERIES }], query).map((match) => match.id).slice(0, 2)])
      .toEqual([query, ["fred:DTB4WK", "fred:DTB3"]]);
    expect([query, moneyMarketsModule.paneTemplates!.some((template) => template.keywords?.includes(query))]).toEqual([query, true]);
  }
});
