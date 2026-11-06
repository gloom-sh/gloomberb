import { expect, test } from "bun:test";
import { alertListing } from "./format";
import { alertListingKey, alertPriceText } from "./price-text";
import { readAlertLevel } from "./price";
import { farTargetMessage, levelInQuoteUnit } from "./quotes";
import { sameLevelRule } from "./alert-engine";
import type { AlertRule } from "./types";

const rule = (symbol: string, exchange: string | undefined, extra: Partial<AlertRule> = {}): AlertRule =>
  ({ id: symbol, symbol, exchange, condition: "below", targetPrice: 1, createdAt: 0, status: "active", ...extra });

test("an alert's price is written at its instrument's precision, a London line's in the pence its quote shows", () => {
  expect(alertPriceText(rule("GBPUSD=X", "CCY", { lastQuoteCurrency: "USD" }), 1.3375)).toBe("1.33750");
  expect(alertPriceText(rule("VOD:LSE", "LSE", { lastQuoteCurrency: "GBP", lastQuotePence: true }), 0.7)).toBe("70.00p");
  expect(alertPriceText(rule("7203:JPX", "JPX", { lastQuoteCurrency: "JPY" }), 2800)).toBe("2,800");
  expect(alertPriceText(rule("AAPL", undefined, { lastQuoteCurrency: "USD" }), 250)).toBe("250.00");
});

test("70p is pence on a line quoted in pence, a bare 70 there too when 70 pounds is ten times off, and pence elsewhere is refused", () => {
  const vod = { currency: "GBP", providerPriceDivisor: 100, price: 1.194 };
  expect(readAlertLevel("70p")).toEqual({ price: 0.7, pence: true });
  expect(levelInQuoteUnit({ ...readAlertLevel("70p"), typed: "70p" }, vod, "VOD:LSE")).toEqual({ price: 0.7, pence: true, note: null });
  expect(levelInQuoteUnit({ price: 70, typed: "70" }, vod, "VOD:LSE")).toEqual({ price: 0.7, pence: true, note: "Read 70 as 70p: VOD:LSE is quoted in pence." });
  // A level that reads as pounds stays in pounds.
  expect(levelInQuoteUnit({ price: 1.15, typed: "1.15" }, vod, "VOD:LSE").price).toBe(1.15);
  expect(() => levelInQuoteUnit({ price: 0.7, pence: true }, { currency: "USD", price: 250 }, "AAPL")).toThrow("AAPL trades in USD; pence (p) only apply to London prices.");
  // Refused far off, both in the pence the line trades in.
  expect(farTargetMessage("VOD:LSE", 70, 1.194, null, true)).toBe("A target of 7,000p is more than 10 times VOD:LSE's last price of 119.4p. Check the price and the symbol.");
});

test("one key per listing: 7203.T and 7203:JPX are one alert, shown as 7203:JPX, and a pair names itself", () => {
  const suffixed = rule("7203.T", "JPX", { targetPrice: 2800 });
  const keyed = rule("7203:JPX", "JPX", { targetPrice: 2800 });
  expect([alertListingKey(suffixed), alertListingKey(keyed)]).toEqual(["7203:JPX", "7203:JPX"]);
  expect(sameLevelRule(suffixed, keyed)).toBe(true);
  expect(alertListing(suffixed)).toBe("7203:JPX");
  expect(alertListing(rule("GBPUSD=X", "CCY"))).toBe("GBPUSD=X");
  expect(alertListing(rule("AZN.L", "LSE"))).toBe("AZN:LSE");
});
