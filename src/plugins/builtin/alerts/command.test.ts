import { expect, test } from "bun:test";
import { parseAlertCommandValues, parseAlertShortcutValues } from "./command";

test("the SA shortcut reads its price as alerts add reads it, and never as the digits before a comma or a k", () => {
  const price = (text: string) => parseAlertShortcutValues(`BTC-USD below ${text}`).price;
  expect(["81k", "1.5k", "2m", "$250", "1.350,5", "1,350.5", "1234,5", "81000"].map(price)).toEqual(["81000", "1500", "2000000", "250", "1350.5", "1350.5", "1234.5", "81000"]);
  expect(() => price("81,000")).toThrow("81,000 could be 81000 (thousands) or 81 (decimal comma); type 81000 or 81");
  expect(() => price("1,500k")).toThrow("1,500k could be 1500000 (thousands) or 1500 (decimal comma)");
  expect(() => price("0,01%")).toThrow('Alert price must be a number, got "0,01%"; type 81000 or 81k.');
  expect(() => price("abc")).toThrow('Alert price must be a number, got "abc"; type 81000 or 81k.');
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
