import { describe, expect, test } from "bun:test";
import { holdersHeaderLine, moneyColumnHeader, nonUsHolderCaveat } from "./report-header";

describe("holder report header", () => {
  test("names the listing, spells out a sub-unit currency and says the list is the source's top holders", () => {
    expect(holdersHeaderLine({
      name: "BHP Group Limited",
      symbol: "BHP.L",
      exchange: "LSE",
      currency: "GBp",
      asOf: "2026-06-30",
      shown: 4,
      reported: 4,
    })).toBe("BHP Group Limited (BHP.L) | LSE | GBp (pence) | as of 2026-06-30 | top 4 reported");
    expect(moneyColumnHeader("Value", "GBp")).toBe("Value (GBp)");
    expect(moneyColumnHeader("Mkt value", "AUD")).toBe("Mkt value (AUD)");
  });

  test("counts what is shown against the source's cap, or against its total when it gives one", () => {
    const facts = { symbol: "AAPL", exchange: "NasdaqGS", currency: "USD" };
    expect(holdersHeaderLine({ ...facts, shown: 3, reported: 10 })).toBe("AAPL | NASDAQ | USD | 3 of top 10 reported");
    expect(holdersHeaderLine({ ...facts, shown: 10, reported: 10, total: 4123 })).toBe("AAPL | NASDAQ | USD | 10 of 4,123 holders");
    expect(holdersHeaderLine({ name: "Apple Inc.", shown: 0, reported: 0 })).toBe("Apple Inc. | none reported");
  });

  test("warns that positions on a listing outside the US are not that market's register", () => {
    expect(nonUsHolderCaveat("ASX", "AUD")).toContain("not the ASX share register");
    // A venue the app does not know still counts as foreign by its currency.
    expect(nonUsHolderCaveat("Toronto", "CAD")).toContain("not the local share register");
    expect(nonUsHolderCaveat("NasdaqGS", "USD")).toBeNull();
    expect(nonUsHolderCaveat(undefined, "USD")).toBeNull();
  });
});
