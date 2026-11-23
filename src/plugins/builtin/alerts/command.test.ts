import { expect, test } from "bun:test";
import { parseAlertCommandValues, parseAlertShortcutValues } from "./command";
import { parseAlertAddArgs } from "./cli";
import { assertAlertCurrency, levelInQuoteUnit } from "./quotes";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import type { DataProvider } from "../../../types/data-provider";
import { useAlertTestClock } from "./test-fixture";

useAlertTestClock();

test("the SA shortcut reads its price as alerts add reads it, and never as the digits before a comma or a k", () => {
  const price = (text: string) => parseAlertCommandValues({ shortcut: `BTC-USD below ${text}` })?.price;
  expect(["81k", "1.5k", "2m", "$250", "1.350,5", "1,350.5", "1234,5", "81000"].map(price)).toEqual([81000, 1500, 2000000, 250, 1350.5, 1350.5, 1234.5, 81000]);
  expect(() => price("81,000")).toThrow("81,000 could be 81000 (thousands) or 81 (decimal comma); type 81000 or 81");
  expect(() => price("1,500k")).toThrow("1,500k could be 1500000 (thousands) or 1500 (decimal comma)");
  expect(() => price("0,01%")).toThrow('Alert price must be a number, got "0,01%"; type 81000 or 81k.');
  expect(() => price("abc")).toThrow('Alert price must be a number, got "abc"; type 81000 or 81k.');
});

/** `alerts add ' spy ' crosses '$757.75'` was refused over the dollar sign SA had always taken. */
test("SA and alerts add read the same dollar prices, a comma in one grouping thousands", () => {
  const forms: Array<[string[], number]> = [
    [["$757.75"], 757.75], [["$1,000.00"], 1000], [["$1,000"], 1000], [["$", "757.75"], 757.75], [["757.75", "USD"], 757.75],
    [["US$ 1,000.50"], 1000.5], [["1 000.50"], 1000.5], [["$81k"], 81000],
  ];
  for (const [words, value] of forms) {
    expect(parseAlertCommandValues({ shortcut: ` spy  crosses ${words.join(" ")}` })?.price).toBe(value);
    expect(parseAlertAddArgs([" spy ", "crosses", ...words], undefined)).toMatchObject({ kind: "price", price: value });
  }
  // Without a dollar sign nothing says which a comma is.
  expect(() => parseAlertShortcutValues("SPY crosses 1,000")).toThrow("could be 1000 (thousands) or 1 (decimal comma)");
  expect(() => parseAlertAddArgs(["SPY", "crosses", "1,000"], undefined)).toThrow("could be 1000 (thousands) or 1 (decimal comma)");
  expect(() => parseAlertShortcutValues("SPY crosses 757.75 extra")).toThrow("Use SA SYMBOL above|below|crosses PRICE.");
});

test("explicit alert currencies survive CLI, shortcut and form parsing and cannot set a rule in a different unit", async () => {
  const quote = createTestQuote({ symbol: "AVGO", currency: "USD" });
  const asOf = Date.parse("2026-11-20T11:00:00Z");
  const provider = createTestDataProvider({ getCachedQuery: (() => ({ load: async () => ({ value: 0.125, asOf,
    staleAt: Date.now() + 60_000 }) })) as unknown as DataProvider["getCachedQuery"] });
  for (const input of [parseAlertAddArgs(["AVGO", "below", "2560", "HKD"], undefined),
    parseAlertCommandValues({ shortcut: "AVGO below 2560 HKD" }),
    parseAlertCommandValues({ symbol: "AVGO", condition: "below", price: "2560 HKD" })]) {
    expect(input).toMatchObject({ price: 2560, currency: "HKD" });
    await expect(assertAlertCurrency(input as { price: number; currency: string }, quote, "AVGO", provider))
      .rejects.toThrow(/quoted in USD, not HKD.*About 320\.00 USD \(USD\/HKD 8 · Fri 20 Nov 11:00 UTC\)/);
  }
  expect(levelInQuoteUnit({ price: 320, currency: "USD" }, quote, "AVGO").price).toBe(320);
});

test("a form or shortcut value that is missing is null, and one that reads two ways throws instead of being cut at the comma", () => {
  const values = { symbol: "btc-usd", condition: "below" };
  expect(parseAlertCommandValues({ ...values, price: "81k" })).toEqual({ symbol: "BTC-USD", condition: "below", price: 81000 });
  expect(parseAlertCommandValues({ shortcut: "BTC-USD below 250.5" })).toEqual({ symbol: "BTC-USD", condition: "below", price: 250.5 });
  expect(parseAlertCommandValues({ ...values, price: "" })).toBeNull();
  expect(parseAlertCommandValues({ ...values, condition: "sideways", price: "250" })).toBeNull();
  expect(() => parseAlertCommandValues({ ...values, price: "81,000" })).toThrow("81,000 could be 81000 (thousands) or 81 (decimal comma)");
  expect(() => parseAlertCommandValues({ ...values, price: "abc" })).toThrow('Alert price must be a number, got "abc"');
});
