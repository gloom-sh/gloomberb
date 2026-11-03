import { expect, test } from "bun:test";
import { formatPerShareNumber, formatReportedMoney } from "./reported-money";

test("reported per-share values retain small profit/loss signs and explicit monetary units", () => {
  const values = [0.004125, -0.004125, 0.0001234, -0.0001234, 0.00000254, -0.00000254, Number.MIN_VALUE];
  for (const value of values) {
    const amount = formatPerShareNumber(value);
    expect(Math.sign(Number(amount))).toBe(Math.sign(value));
    expect(Number(amount)).toBe(value);
    expect(amount.length).toBeLessThanOrEqual(11);
    for (const currency of [undefined, "GBp", "GBX", "ILA", "ZAc"]) {
      // No currency: the bare amount, never a guess or a placeholder unit.
      expect(formatReportedMoney(value, currency, true)).toBe(currency ? `${amount} ${currency}` : amount);
    }
  }
  expect(formatReportedMoney(0.004125, "USD", true)).toBe("$0.004125");
  expect(formatReportedMoney(-0.004125, "CNY", true)).toBe("-CN¥0.004125");
  expect(formatReportedMoney(-0.00000254, "USD", true)).toBe("-2.54e-6 USD");
  expect(formatReportedMoney(-0, "USD", true)).toBe("$0.00");
  expect(formatReportedMoney(2.5, "JPY", true)).toBe("¥2.50");
  expect(formatReportedMoney(1_000_000, "USD")).toBe("1M USD");
  for (const value of [undefined, Number.NaN, Infinity, -Infinity]) {
    expect(formatPerShareNumber(value)).toBe("—");
    expect(formatReportedMoney(value, "USD", true)).toBe("—");
  }
});
