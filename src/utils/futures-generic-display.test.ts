import { describe, expect, test } from "bun:test";
import type { CloudQuotePayload } from "../api-client";
import { formatChartLegendValue } from "../components/chart/composite/format";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice, formatThirtySeconds, liveQuoteFormatOptions } from "../market-data/market/format";
import { priceSeriesUnit } from "../market-data/market/index-level";
import { mapQuote } from "../sources/gloomberb-cloud/normalizers";
import { futuresGenericPriceBasis, futuresListingPriceBasis, parseFuturesGeneric } from "./futures-generic";

const quotePayload = (symbol: string, fields: Partial<CloudQuotePayload> = {}): CloudQuotePayload => ({
  symbol, price: 104.484375, currency: "USD", change: -0.375, changePercent: -0.3576,
  lastUpdated: 0, instrumentType: "FUTURE", providerId: "gloomberb-cloud", dataSource: "delayed", ...fields,
});

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

  test("a generic's cloud quote carries its basis; a crude contract's does not", () => {
    expect(mapQuote(quotePayload("VX1")).priceBasis).toBe("points");
    expect(mapQuote(quotePayload("TY1")).priceBasis).toBe("thirty-seconds");
    expect(mapQuote(quotePayload("CL1")).priceBasis).toBeUndefined();
    expect(mapQuote(quotePayload("CLZ26.NYM")).priceBasis).toBeUndefined();
  });

  test.each([
    ["ZT", "TU"], ["ZF", "FV"], ["ZN", "TY"], ["ZB", "US"], ["UB", "WN"],
  ])("%s continuous and listed quotes use the same 32nds as %s generics", (root, alias) => {
    for (const symbol of [`${alias}1`, `${root}=F`, `${root}Z26.CBT`, `${root}H27`]) {
      for (const exchangeName of [undefined, "CBT", "CBOT"]) {
        expect(futuresListingPriceBasis(symbol, exchangeName)).toBe("thirty-seconds");
        const quote = mapQuote(quotePayload(symbol, { exchangeName }));
        expect(quote.priceBasis).toBe("thirty-seconds");
        expect(quote.price).toBe(104.484375);
        expect(quote.currency).toBe("USD");
        const options = liveQuoteFormatOptions(quote, quote.currency);
        expect(formatMarketPriceWithCurrency(quote.price, quote.currency, options)).toBe("104-15½");
        expect(formatSignedMarketPrice(quote.change, options)).toBe("-0-12");
        const unit = priceSeriesUnit(quote.currency, quote.instrumentType, quote.priceBasis);
        expect(formatChartLegendValue(quote.price, unit, `price:${unit}`, quote.instrumentType)).toBe("104-15½");
      }
    }
  });

  test("Treasury-like symbols on another venue or declared as securities keep their currency basis", () => {
    for (const symbol of ["ZN=F", "ZNZ26.CBT", "TY1", "UB"]) {
      for (const exchange of ["NYSE", "CME"]) expect(futuresListingPriceBasis(symbol, exchange)).toBeNull();
    }
    for (const instrumentType of ["EQUITY", "ETF", "BOND"]) {
      for (const symbol of ["TY1", "ZN=F", "ZNZ26.CBT"]) {
        const quote = mapQuote(quotePayload(symbol, { instrumentType, priceBasis: "per-unit" }));
        expect(quote.priceBasis).toBe("per-unit");
        expect(formatMarketPriceWithCurrency(quote.price, quote.currency, liveQuoteFormatOptions(quote, quote.currency))).toBe("$104.48");
      }
    }
    expect(mapQuote(quotePayload("ZN=F", { exchangeName: "CBT", listingExchangeName: "NYSE" })).priceBasis).toBeUndefined();
  });
});
