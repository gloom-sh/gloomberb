import { expect, test } from "bun:test";
import {
  formatHolderOwnershipPercent,
  holderStakeMarketCap,
  holderValueCurrency,
  resolveHolderOwnershipPercent,
} from "./format";

test("resolves holder ownership from provider percent before value over market cap", () => {
  expect(resolveHolderOwnershipPercent({ percentHeld: 0.085, value: 120 }, 1_000)).toBe(0.085);
  expect(resolveHolderOwnershipPercent({ value: 120 }, 1_000)).toBe(0.12);
  expect(resolveHolderOwnershipPercent({ value: 120 }, undefined)).toBeUndefined();
  expect(formatHolderOwnershipPercent(0.085)).toBe("8.50%");
});

test("divides a value only by a market cap in the values' currency", () => {
  // BHP London: dollar values from the 13F filings, a sterling market cap.
  const valueCurrency = holderValueCurrency({ currency: "GBp", valueCurrency: "USD" });
  expect(valueCurrency).toBe("USD");
  expect(holderStakeMarketCap(110e9, "GBP", valueCurrency)).toBeUndefined();
  expect(holderStakeMarketCap(215e9, "USD", valueCurrency)).toBe(215e9);
  // An older service: the values are in the listing's currency.
  expect(holderValueCurrency({ currency: "GBp" })).toBe("GBp");
  expect(holderStakeMarketCap(110e9, undefined, "GBp")).toBe(110e9);
  // A stake that two decimals would round away is not shown as a zero.
  expect(formatHolderOwnershipPercent(0.000013)).toBe("<0.01%");
  expect(formatHolderOwnershipPercent(0)).toBe("0.00%");
});
