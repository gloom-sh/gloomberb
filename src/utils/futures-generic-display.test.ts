import { describe, expect, test } from "bun:test";
import { formatChartLegendValue } from "../components/chart/composite/format";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice, formatThirtySeconds } from "../market-data/market/format";
import { mapQuote } from "../sources/gloomberb-cloud/normalizers";
import { futuresGenericPriceBasis, parseFuturesGeneric } from "./futures-generic";

describe("generic futures read in their own units", () => {
  test("Treasury prices read in 32nds, with the eighth-of-a-32nd tick as a fraction", () => {
    expect(formatThirtySeconds(104.484375)).toBe("104-15½");
    expect(formatThirtySeconds(112.25)).toBe("112-08");
    expect(formatThirtySeconds(103.0078125)).toBe("103-00¼");
    expect(formatThirtySeconds(109.9921875)).toBe("109-31¾");
    expect(formatThirtySeconds(-0.375)).toBe("-0-12");
    // An adjusted generic off the tick grid keeps its 32nds to two decimals.
    expect(formatThirtySeconds(104.49)).toBe("104-15.68");
  });

  test("VX and index generics read in points, Treasury generics in 32nds, others in their currency", () => {
    expect(futuresGenericPriceBasis(parseFuturesGeneric("VX1")!)).toBe("points");
    expect(futuresGenericPriceBasis(parseFuturesGeneric("ES2")!)).toBe("points");
    expect(futuresGenericPriceBasis(parseFuturesGeneric("TY1")!)).toBe("thirty-seconds");
    expect(futuresGenericPriceBasis(parseFuturesGeneric("CL1")!)).toBeNull();
    expect(formatMarketPriceWithCurrency(17.5046, "USD", { priceBasis: "points", assetCategory: "FUTURE", fixedFractionDigits: 4 })).toBe("17.5046");
    expect(formatMarketPriceWithCurrency(104.484375, "USD", { priceBasis: "thirty-seconds" })).toBe("104-15½");
    expect(formatSignedMarketPrice(-0.375, { priceBasis: "thirty-seconds", fixedFractionDigits: 6 })).toBe("-0-12");
    expect(formatChartLegendValue(17.5046, "points", "price:points", "FUTURE")).toBe("17.5046");
    expect(formatChartLegendValue(104.484375, "32nds", "price:32nds", "FUTURE")).toBe("104-15½");
  });

  test("a generic's cloud quote carries its basis; a contract's does not", () => {
    const quote = (symbol: string) => ({ symbol, price: 17.5, currency: "USD", change: 0.1, changePercent: 0.5, lastUpdated: 0, instrumentType: "FUTURE" });
    expect(mapQuote(quote("VX1") as never).priceBasis).toBe("points");
    expect(mapQuote(quote("TY1") as never).priceBasis).toBe("thirty-seconds");
    expect(mapQuote(quote("CL1") as never).priceBasis).toBeUndefined();
    expect(mapQuote(quote("CLZ26.NYM") as never).priceBasis).toBeUndefined();
  });
});
