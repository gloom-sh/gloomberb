import { describe, expect, test } from "bun:test";
import {
  quoteFormatOptions,
  withCurrencyMinorDigits,
  formatMarketChangeWithCurrency,
  formatMarketCost,
  formatMarketCostWithCurrency,
  formatCompactMarketPriceWithCurrency,
  formatMarketPrice,
  formatPriceObservation,
  formatMarketPriceWithCurrency,
  formatMarketQuantity,
  formatSignedMarketPrice,
  liveQuoteFormatOptions,
  resolveAssetDisplayKind,
  stablePriceFractionDigits,
} from "./format";

describe("resolveAssetDisplayKind", () => {
  test("prefers explicit cash balances", () => {
    expect(resolveAssetDisplayKind({ isCashBalance: true, assetCategory: "STK" })).toBe("cash");
  });

  test("maps common broker security types", () => {
    for (const assetCategory of ["CRYPTO", "CRYPTOCURRENCY", "Digital Currency"]) {
      expect(resolveAssetDisplayKind({ assetCategory })).toBe("crypto");
    }
    expect(resolveAssetDisplayKind({ assetCategory: "STK" })).toBe("equity");
    expect(resolveAssetDisplayKind({ contractSecType: "OPT" })).toBe("contract");
    expect(resolveAssetDisplayKind({ assetCategory: "FOREX" })).toBe("cash");
    expect(resolveAssetDisplayKind({ assetCategory: "CURRENCY" })).toBe("cash");
    expect(resolveAssetDisplayKind({ assetCategory: "CCY" })).toBe("cash");
  });

  test("falls back to contract formatting when only a multiplier is present", () => {
    expect(resolveAssetDisplayKind({ multiplier: 100 })).toBe("contract");
  });
});

describe("formatMarketQuantity", () => {
  test("preserves additional FX precision while trimming trailing zeroes", () => {
    expect(formatMarketQuantity(-351957.025, { isCashBalance: true })).toBe("-351,957.025");
    expect(formatMarketQuantity(-303029.144938754, { isCashBalance: true })).toBe("-303,029.144939");
  });

  test("shows whole equities without decimals and fractional equities with up to four decimals", () => {
    expect(formatMarketQuantity(10, { assetCategory: "STK" })).toBe("10");
    expect(formatMarketQuantity(10.125, { assetCategory: "STK" })).toBe("10.125");
    expect(formatMarketQuantity(10.123456, { assetCategory: "STK" })).toBe("10.1235");
  });

  test("uses higher precision for crypto quantities", () => {
    expect(formatMarketQuantity(0.123456789, { assetCategory: "CRYPTO" })).toBe("0.12345679");
  });
});

describe("formatMarketPrice", () => {
  test("uses semantic precision for equities, cash, and crypto", () => {
    expect(formatMarketPrice(190.2, { assetCategory: "STK" })).toBe("190.2");
    expect(formatMarketPrice(259.7499, { assetCategory: "STK" })).toBe("259.75");
    expect(formatMarketPrice(1.084567, { isCashBalance: true })).toBe("1.084567");
    expect(formatMarketPrice(1.17364, { assetCategory: "CURRENCY" })).toBe("1.17364");
    // Float32 provider rates: the seventh significant digit ends the display.
    expect(formatMarketPrice(157.8800048828125, { assetCategory: "CURRENCY" })).toBe("157.88");
    expect(formatMarketPrice(0.000123456789, { assetCategory: "CRYPTO" })).toBe("0.00012346");
  });

  test("scales crypto precision by magnitude instead of always spending eight decimals", () => {
    expect(formatMarketPrice(109556.1640625, { assetCategory: "CRYPTO" })).toBe("109,556.16");
    expect(formatMarketPrice(118531.39161566, { assetCategory: "CRYPTO" })).toBe("118,531.39");
    expect(formatMarketPrice(3421.8843212, { assetCategory: "CRYPTO" })).toBe("3,421.88");
    expect(formatMarketPrice(2.44190216, { assetCategory: "CRYPTO" })).toBe("2.4419");
    expect(formatMarketPrice(0.8618999719619751, { assetCategory: "CRYPTO" })).toBe("0.86189997");
    expect(formatMarketPrice(0.00000526, { assetCategory: "CRYPTO" })).toBe("0.00000526");
  });

  test("keeps tiny nonzero quotes, ranges and signed changes meaningful without asset metadata", () => {
    expect(formatMarketPriceWithCurrency(0.000005100000180391362, "USD")).toBe("$0.0000051");
    expect(formatMarketPriceWithCurrency(0.000005259999852569308, "USD")).toBe("$0.00000526");
    expect(formatSignedMarketPrice(-0.00000015256411960863806)).toBe("-0.0000001526");
    expect(formatMarketPrice(0.0000051, { maxWidth: 7 })).toBe("5.1e-6");
    expect(formatMarketPrice(1.234e-25)).toBe("1.234e-25");
    expect(formatMarketPrice(0)).toBe("0");
    expect(formatMarketPriceWithCurrency(0, "USD")).toBe("$0");
  });

  test("can adapt chart precision to the visible price range", () => {
    expect(formatMarketPrice(1.167815, { assetCategory: "CURRENCY", priceRange: 0.12 })).toBe("1.17");
    expect(formatMarketPrice(1.167815, { assetCategory: "CURRENCY", priceRange: 0.0024 })).toBe("1.1678");
    expect(formatMarketPrice(259.7499, {
      assetCategory: "STK",
      minimumFractionDigits: 2,
      precisionOffset: 1,
      priceRange: 80,
    })).toBe("259.75");
  });

  test("can lock price displays to a specific number of decimals", () => {
    expect(formatMarketPrice(18, { assetCategory: "STK", fixedFractionDigits: 1 })).toBe("18.0");
    expect(formatMarketPriceWithCurrency(18, "USD", { assetCategory: "STK", fixedFractionDigits: 2 })).toBe("$18.00");
  });

  test("fits within the supplied width before falling back to truncation elsewhere", () => {
    expect(formatMarketPrice(1.084567, { isCashBalance: true, maxWidth: 6 })).toBe("1.0846");
    expect(formatMarketQuantity(123456.789, { assetCategory: "CRYPTO", maxWidth: 7 })).toBe("123,457");
  });

  test("formats signed price changes without double signs", () => {
    expect(formatSignedMarketPrice(0.123456, { isCashBalance: true })).toBe("+0.123456");
    expect(formatSignedMarketPrice(-0.123456, { isCashBalance: true })).toBe("-0.123456");
  });
});

describe("formatMarketCost", () => {
  test("keeps equity cost displays conservative while preserving FX and crypto precision", () => {
    expect(formatMarketCost(119.3687, { assetCategory: "STK" })).toBe("119.37");
    expect(formatMarketCost(1.084567, { isCashBalance: true })).toBe("1.084567");
    expect(formatMarketCost(113905.720075, { assetCategory: "CRYPTO" })).toBe("113,905.720075");
  });
});

describe("formatMarketPriceWithCurrency", () => {
  test("renders price-like values with a symbol and variable decimals", () => {
    expect(formatMarketPriceWithCurrency(190.25, "USD", { assetCategory: "STK" })).toBe("$190.25");
    expect(formatMarketPriceWithCurrency(1.084567, "EUR", { isCashBalance: true })).toBe("€1.084567");
    expect(formatMarketPriceWithCurrency(1.17364, "USD", { assetCategory: "CURRENCY" })).toBe("$1.17364");
  });

  test("preserves chart-style compact notation for large values", () => {
    expect(formatCompactMarketPriceWithCurrency(21_970, "JPY")).toBe("¥22.0K");
    expect(formatCompactMarketPriceWithCurrency(12_340, "HKD")).toBe("HK$12.3K");
    expect(formatCompactMarketPriceWithCurrency(79_432.18, "USD", { assetCategory: "CRYPTO" })).toBe("$79.4K");
  });

  test("keeps full price precision for legend-style values", () => {
    expect(formatMarketPriceWithCurrency(79_432.18, "USD", { assetCategory: "CRYPTO" })).toBe("$79,432.18");
    expect(formatMarketPriceWithCurrency(79_432.18, "USD", { assetCategory: "STK" })).toBe("$79,432.18");
    expect(formatMarketPriceWithCurrency(1.084567, "USD", { isCashBalance: true })).toBe("$1.084567");
  });

  test("formats position cost values with tighter equity precision", () => {
    expect(formatMarketCostWithCurrency(119.3687, "HKD", { assetCategory: "STK" })).toBe("HK$119.37");
    expect(formatMarketCostWithCurrency(50.9507, "USD", { assetCategory: "OPT", multiplier: 100 })).toBe("$50.9507");
    // Money costs keep the currency's minor unit.
    expect(formatMarketCostWithCurrency(189.2, "USD", { assetCategory: "STK" })).toBe("$189.20");
    expect(formatMarketCostWithCurrency(1520, "JPY", { assetCategory: "STK" })).toBe("¥1,520");
  });
});

test("nominal quantity and percent-of-par prices retain their units in narrow existing cells", () => {
  const options = { assetCategory: "BOND", priceBasis: "percent-of-par" as const };
  expect(formatMarketQuantity(1000, { ...options, quantityCurrency: "EUR", maxWidth: 11 })).toBe("1k EUR face");
  expect(formatMarketQuantity(1000, { ...options, maxWidth: 8 })).toBe("1k face");
  expect(formatMarketPriceWithCurrency(86.359375, "EUR", { ...options, maxWidth: 9 })).toBe("86.4% par");
  expect(formatMarketCostWithCurrency(87.742, "USD", options)).toBe("87.74% par");
  expect(formatMarketPriceWithCurrency(86.359375, "EUR", { assetCategory: "BOND" })).toBe("—");
});

test("a line quoted in pence keeps its pence decimals once shown in pounds", () => {
  const pence = quoteFormatOptions({ instrumentType: "EQUITY", providerPriceDivisor: 100 });
  expect(formatMarketPriceWithCurrency(1.2295, "GBP", { ...pence, minimumFractionDigits: 2 })).toBe("£1.2295");
  expect(formatMarketPriceWithCurrency(35.365, "GBP", { ...pence, minimumFractionDigits: 2 })).toBe("£35.365");
  expect(formatMarketPriceWithCurrency(35.1, "GBP", { ...pence, minimumFractionDigits: 2 })).toBe("£35.10");
  expect(formatMarketChangeWithCurrency(-0.0165, "GBP", pence)).toBe("-£0.0165");
  const pounds = quoteFormatOptions({ instrumentType: "EQUITY", providerPriceDivisor: 1 });
  expect(formatMarketPriceWithCurrency(1.2295, "GBP", pounds)).toBe("£1.23");
  expect(formatMarketChangeWithCurrency(-0.0165, "GBP", pounds)).toBe("-£0.02");
});

// Metadata is descriptive, while the quote declares the price convention.
test("quote formatting uses metadata only to withhold unknown bond units", () => {
  const unknown = quoteFormatOptions({}, "BOND", "STK");
  expect(formatMarketPriceWithCurrency(87, "USD", unknown)).toBe("—");
  expect(formatMarketChangeWithCurrency(1, "USD", unknown)).toBe("—");
  const declared = quoteFormatOptions({ instrumentType: "STK" }, "BOND", "BOND");
  expect(formatMarketPriceWithCurrency(87, "USD", declared)).toBe("$87");
  expect(formatMarketChangeWithCurrency(-1, "USD", declared)).toBe("-$1.00");
  const par = quoteFormatOptions({ priceBasis: "percent-of-par" }, "STK");
  expect(formatMarketChangeWithCurrency(-1, "USD", par)).toBe("-1% par");
  // A sub-cent coin's whole day move must not round to -$0.00.
  const crypto = { assetCategory: "CRYPTOCURRENCY" };
  expect(formatMarketChangeWithCurrency(-2.6955e-8, "USD", crypto, 6.312e-6)).toBe("-$0.00000002696");
  expect(formatMarketChangeWithCurrency(-0.37, "USD", crypto, 109556.16)).toBe("-$0.37");
  // Float residue from price - previousClose on a cent-quoted asset stays $0.00.
  const stock = { assetCategory: "STK" };
  expect(formatMarketChangeWithCurrency(1.52587890625e-5, "USD", stock, 259.75)).toBe("$0.00");
  expect(formatMarketChangeWithCurrency(-2.842170943040401e-14, "USD", stock, 172.47)).toBe("$0.00");
  expect(formatMarketChangeWithCurrency(1.52587890625e-5, "USD", stock, 0.5)).toBe("$0.00");
  expect(formatMarketChangeWithCurrency(3e-14, "USD", crypto, 6.312e-6)).toBe("$0.00");
});

test("contract price precision does not change units, signed/zero/missing semantics, quantity or cost", () => {
  for (const assetCategory of ["FUT", "FUTURE", "FUTURES", "FOP", "OPT"]) {
    const options = { assetCategory };
    expect(formatMarketPriceWithCurrency(1.17485, "USD", options)).toBe("$1.17485");
    expect(formatMarketChangeWithCurrency(-0.0000005, "USD", options)).toBe("-$0.0000005");
    expect(formatMarketChangeWithCurrency(0, "USD", options)).toBe("$0.00");
    expect(formatMarketChangeWithCurrency(undefined, "USD", options)).toBe("—");
    expect(formatMarketChangeWithCurrency(NaN, "USD", options)).toBe("—");
    expect(formatMarketPriceWithCurrency(-37.63, "USD", options)).toBe("-$37.63");
    expect(formatMarketChangeWithCurrency(.25, "USX", options)).toContain("USX");
    expect(formatMarketQuantity(1.123456, options)).toBe("1.1235");
    expect(formatMarketCost(1.123456, options)).toBe("1.1235");
  }
  expect(formatMarketPriceWithCurrency(259.7499, "USD", { assetCategory: "STK" })).toBe("$259.75");
  expect(formatMarketChangeWithCurrency(1, "USD", { assetCategory: "STK" })).toBe("+$1.00");
  expect(formatMarketChangeWithCurrency(.001, "USD", { assetCategory: "BOND" })).toBe("—");
});

test("untyped observations retain source decimals with bounded widths and missing/zero distinctions", () => {
  expect(formatPriceObservation(-37.63001)).toBe("-37.63001");
  expect(formatPriceObservation(0, { minimumFractionDigits: 2 })).toBe("0.00");
  expect(formatPriceObservation(NaN)).toBe("—");
  expect(formatPriceObservation(Infinity)).toBe("—");
  expect(formatPriceObservation(.0123456)).toBe("0.0123456");
  expect(formatPriceObservation(1.1602274179458618)).toBe("1.16022742");
  expect(formatPriceObservation(.0062825, { maxWidth: 10 })).toBe("0.0062825");
  expect(formatPriceObservation(.0000051, { maxWidth: 7 })).toBe("5.1e-6");
  expect(formatPriceObservation(1.234e-25, { maxWidth: 10 })).toBe("1.234e-25");
  expect(formatPriceObservation(1234567.891, { maxWidth: 8 }).length).toBeLessThanOrEqual(8);
});

test("money prices pad to the currency's minor unit without cutting crypto, FX or par precision", () => {
  const pad = (value: number, currency: string, options = {}) =>
    formatMarketPriceWithCurrency(value, currency, withCurrencyMinorDigits(options, currency));
  expect(pad(309.9, "USD", { assetCategory: "EQUITY" })).toBe("$309.90");
  expect(pad(83859.3, "USD", { assetCategory: "CRYPTOCURRENCY" })).toBe("$83,859.30");
  expect(pad(0.00000563, "USD", { assetCategory: "CRYPTOCURRENCY" })).toBe("$0.00000563");
  expect(pad(1.138045, "USD", { assetCategory: "CURRENCY" })).toBe("$1.138045");
  expect(pad(3025, "JPY", { assetCategory: "EQUITY" })).toBe("¥3,025");
  expect(pad(87, "USD", { assetCategory: "BOND", priceBasis: "percent-of-par" })).toBe("87% par");
});

// Streamed quotes re-render several times a second. Decimals chosen from each
// tick made 150.10 print as 150.1 and a coin crossing $100 drop two digits, so
// the numbers visibly jumped.
describe("live quote precision", () => {
  const live = (values: number[], quote: Parameters<typeof liveQuoteFormatOptions>[0], currency = "USD") =>
    values.map((value) => formatMarketPrice(value, liveQuoteFormatOptions(quote, currency)));

  test("keeps one decimal count per instrument whatever the tick", () => {
    expect(live([150.1, 150.12, 150], { instrumentType: "EQUITY", previousClose: 149.99 }))
      .toEqual(["150.10", "150.12", "150.00"]);
    expect(live([0.9987, 1.0012, 1.01], { instrumentType: "EQUITY", previousClose: 0.9987 }))
      .toEqual(["0.9987", "1.0012", "1.0100"]);
    expect(live([99.9912, 100.01, 100], { instrumentType: "CRYPTOCURRENCY", previousClose: 101 }))
      .toEqual(["99.99", "100.01", "100.00"]);
    expect(live([0.16234, 0.16], { instrumentType: "CRYPTOCURRENCY", previousClose: 0.16234 }))
      .toEqual(["0.16234", "0.16000"]);
    expect(live([1.17364, 1.17], { instrumentType: "CURRENCY", previousClose: 1.17364 }))
      .toEqual(["1.17364", "1.17000"]);
    expect(live([153.554, 153.5], { instrumentType: "CURRENCY", previousClose: 153.5540008544922 }, "JPY"))
      .toEqual(["153.554", "153.500"]);
    expect(live([6012.25, 6012.5, 6013], { instrumentType: "FUTURE", previousClose: 6010.75 }))
      .toEqual(["6,012.25", "6,012.50", "6,013.00"]);
    expect(live([2.35, 2.4], { instrumentType: "OPTION", previousClose: 2.35 })).toEqual(["2.35", "2.40"]);
  });

  test("takes decimals from the currency's minor unit and from session prices, never from the tick", () => {
    expect(live([3025, 3026], { instrumentType: "EQUITY", previousClose: 3025 }, "JPY")).toEqual(["3,025", "3,026"]);
    expect(live([2710, 2710.5], { instrumentType: "EQUITY", previousClose: 2710, open: 2708.5 }, "JPY"))
      .toEqual(["2,710.0", "2,710.5"]);
    expect(live([35.365, 35.1], { instrumentType: "EQUITY", previousClose: 35.32, providerPriceDivisor: 100 }, "GBP"))
      .toEqual(["35.3650", "35.1000"]);
    // A provider's float32 close does not ask for its binary tail.
    expect(stablePriceFractionDigits({ assetCategory: "FUTURE", referencePrice: 157.8800048828125, sessionPrices: [157.8800048828125] }))
      .toBe(2);
  });

  test("a tick finer than the session prices keeps its digits, and a tiny move never prints as zero", () => {
    // A half-yen print after whole-yen closes is not rounded to a price that never traded.
    expect(live([1850.5], { instrumentType: "EQUITY", previousClose: 1850, open: 1851 }, "JPY")).toEqual(["1,850.5"]);
    const shib = liveQuoteFormatOptions({ instrumentType: "CRYPTOCURRENCY", previousClose: 0.00001234 }, "USD");
    expect(formatSignedMarketPrice(-0.00000036, { ...shib, maxWidth: 9 })).toBe("-3.6e-7");
  });

  test("changes use the price's decimals, and a move that rounds to zero is unsigned", () => {
    const options = liveQuoteFormatOptions({ instrumentType: "EQUITY", previousClose: 150 }, "USD");
    expect([0.135, 1.2, 0, -0.004, -0.5].map((change) => formatSignedMarketPrice(change, options)))
      .toEqual(["+0.14", "+1.20", "0.00", "0.00", "-0.50"]);
    expect(formatMarketChangeWithCurrency(-0.004, "USD", options)).toBe("$0.00");
    expect(formatMarketPriceWithCurrency(-0.001, "USD", options)).toBe("$0.00");
  });
});
