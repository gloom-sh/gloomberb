import { describe, expect, test } from "bun:test";
import { holderShareBasisNote, holderValueBasis, holdersHeaderLine, moneyColumnHeader, nonUsHolderCaveat } from "./report-header";

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

  test("names the values' own unit and price when they are not the listing's", () => {
    // Gloom Cloud prices BHP London's 13F rows in dollars at the period end; the line still quotes in pence.
    expect(holdersHeaderLine({
      name: "BHP Group Limited", symbol: "BHP.L", exchange: "LSE", currency: "USD", listingCurrency: "GBp", shown: 4, reported: 4,
    })).toBe("BHP Group Limited (BHP.L) | LSE | values in USD | top 4 reported");
    expect(holderValueBasis("2026-06-30", "period_end_price", "USD")).toBe("shares reported at 2026-06-30 x period-end price (USD)");
    expect(holderValueBasis("2026-06-30", "latest_price", "USD")).toBe("shares reported at 2026-06-30 x latest price");
    // An older service states neither.
    expect(holdersHeaderLine({ symbol: "BHP.L", exchange: "LSE", currency: "GBp", shown: 4, reported: 4 })).toBe("BHP.L | LSE | GBp (pence) | top 4 reported");
    expect(holderValueBasis("2026-06-30")).toBe("shares reported at 2026-06-30 x latest price");
  });

  test("says which rows are receipts, or that a receipt line's rows all are", () => {
    const home = [{ shareBasis: "ordinary" }, { shareBasis: "depositary_receipt" }];
    expect(holderShareBasisNote({ adrRatio: 2 }, home)).toBe("ADR: shares held as depositary receipts (1 ADR = 2 ordinary shares).");
    expect(holderShareBasisNote({ shareBasis: "depositary_receipt", adrRatio: 2 }, [{}, {}])).toBe("Shares are depositary receipts (1 ADR = 2 ordinary shares).");
    expect(holderShareBasisNote({ shareBasis: "ordinary" }, [{ shareBasis: "ordinary" }])).toBeNull();
    expect(holderShareBasisNote({}, [{}])).toBeNull();
  });

  test("warns that positions on a listing outside the US are not that market's register", () => {
    expect(nonUsHolderCaveat("ASX", "AUD")).toContain("not the ASX share register");
    // A venue the app does not know still counts as foreign by its currency.
    expect(nonUsHolderCaveat("Toronto", "CAD")).toContain("not the local share register");
    expect(nonUsHolderCaveat("NasdaqGS", "USD")).toBeNull();
    expect(nonUsHolderCaveat(undefined, "USD")).toBeNull();
  });
});
