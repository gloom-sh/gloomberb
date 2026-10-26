import { describe, expect, test } from "bun:test";
import { convertCurrency, displayWidth, formatCompact, formatCurrency, formatNumber, formatPercent, formatPercentRaw, formatSignificant, padTo, truncateToDisplayWidth } from "./format";
import { normalizeTimestamp } from "./timestamp";
import { fxRateCurrencies } from "./currency-units";

test("currency conversion never presents a missing or invalid FX leg as parity", () => {
  const rates = new Map([["EUR", 1.2], ["JPY", 0.008]]);
  expect(convertCurrency(100, "EUR", "USD", rates)).toBe(120);
  expect(convertCurrency(120, "USD", "EUR", rates)).toBe(100);
  expect(convertCurrency(100, "EUR", "JPY", rates)).toBe(15_000);
  expect(convertCurrency(100, "EUR", "EUR", new Map())).toBe(100);
  expect(convertCurrency(0, "EUR", "USD", new Map())).toBe(0);

  for (const invalidRate of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = invalidRate === undefined ? new Map<string, number>() : new Map([["EUR", invalidRate]]);
    expect(convertCurrency(100, "EUR", "USD", invalid)).toBeNaN();
    expect(convertCurrency(100, "USD", "EUR", invalid)).toBeNaN();
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    for (const format of [formatCurrency, formatCompact, formatNumber, formatPercent, formatPercentRaw]) {
      expect(format(value)).toBe("—");
    }
  }
});

test("money in a minor unit converts at a hundredth of its major currency's rate, which the rates loaded include", () => {
  // The rates useFxRatesMap holds for these holdings: what it asks for (fxRateCurrencies), less what Gloom Cloud
  // does not serve (no GBX or ILA rate). ZAC it serves, per South African cent.
  const served = new Map([["USD", 1], ["EUR", 1.1], ["GBP", 1.25], ["ZAR", 0.055], ["ZAC", 0.00055], ["ILS", 0.27]]);
  const rates = new Map(fxRateCurrencies(["GBp", "GBX", "ZAc", "ILA", "EUR"]).flatMap((code) => served.has(code) ? [[code, served.get(code)!] as const] : []));
  expect(convertCurrency(7_000, "GBp", "USD", rates)).toBeCloseTo(87.5, 9);
  expect(convertCurrency(7_000, "GBX", "EUR", rates)).toBeCloseTo(70 * 1.25 / 1.1, 9);
  expect(convertCurrency(10_000, "ZAc", "USD", rates)).toBeCloseTo(5.5, 9);
  expect(convertCurrency(10_000, "ILA", "USD", rates)).toBeCloseTo(27, 9);
  expect(convertCurrency(87.5, "USD", "GBp", rates)).toBeCloseTo(7_000, 9);
  // GBP is pounds: its rate is never read as the penny's.
  expect(convertCurrency(70, "GBP", "USD", rates)).toBeCloseTo(87.5, 9);
  // Without the major currency's rate a minor unit is not converted, never valued at parity.
  expect(convertCurrency(7_000, "GBX", "USD", new Map([["USD", 1]]))).toBeNaN();
});

describe("formatCurrency", () => {
  test("shows the thousandth currencies to the mill, from below one unit up", () => {
    expect(formatCurrency(1.366, "OMR")).toBe("OMR\u00a01.366");
    expect(formatCurrency(0.462, "OMR")).toBe("OMR\u00a00.462");
    expect(formatCurrency(1, "BHD")).toBe("BHD\u00a01.000");
    expect(formatCurrency(0.315, "KWD")).toBe("KWD\u00a00.315");
    expect(formatCurrency(12.5, "JOD")).toBe("JOD\u00a012.500");
    expect(formatCurrency(-9.876, "TND")).toBe("-TND\u00a09.876");
    expect(formatCurrency(1234567.891, "OMR")).toBe("OMR\u00a01,234,567.891");
    expect(formatCurrency(1.366, "omr")).toBe("OMR\u00a01.366");
    // An explicit count still wins, so a caller that wants whole units gets them.
    expect(formatCurrency(1234.567, "OMR", 0)).toBe("OMR\u00a01,235");
  });

  test("leaves every other currency as it was", () => {
    expect(formatCurrency(1.366, "USD")).toBe("$1.37");
    expect(formatCurrency(1234.5, "EUR")).toBe("€1,234.50");
    expect(formatCurrency(3025, "JPY")).toBe("¥3,025.00");
    expect(formatCurrency(1.366, "USD", 6)).toBe("$1.366");
    expect(formatCurrency(1.366, "IQD")).toBe("IQD\u00a01.37");
  });

  test("writes a minor unit after the amount rather than as its major currency", () => {
    // Intl reads GBp as GBP, which would print pence as pounds.
    expect(formatCurrency(412.5, "GBp")).toBe("412.50p");
    expect(formatCurrency(412.5, "GBP")).toBe("£412.50");
    expect(formatCurrency(-314.95, "USX")).toBe("-314.95¢");
    expect(formatCurrency(-0.001, "USX")).toBe("0.00¢");
  });
});

describe("normalizeTimestamp", () => {
  test("parses Twitter API timestamps", () => {
    expect(normalizeTimestamp("Wed Apr 29 03:20:20 +0000 2026")).toBe("2026-04-29T03:20:20.000Z");
  });
});

describe("padTo", () => {
  test("pads and truncates by display width instead of UTF-16 length", () => {
    expect(displayWidth("🇺🇸")).toBe(2);
    expect(padTo("🇺🇸", 2)).toBe("🇺🇸");
    expect(padTo("🇺🇸", 3)).toBe("🇺🇸 ");
    expect(padTo("🇺🇸", 1)).toBe(" ");
    expect(padTo("🇺🇸 CPI", 6)).toBe("🇺🇸 CPI");
  });
});

describe("truncateToDisplayWidth", () => {
  test("preserves grapheme clusters and stays within the terminal cell budget", () => {
    expect(displayWidth("📈")).toBe(2);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(truncateToDisplayWidth("投资组合分析面板", 9)).toBe("投资组...");
    expect(displayWidth(truncateToDisplayWidth("👨‍👩‍👧‍👦 family", 7))).toBeLessThanOrEqual(7);
  });
});

test("significant digits keep a small ratio's leading digits and round up across a power of ten", () => {
  expect(formatSignificant(0.000566381920406)).toBe("0.0005664");
  expect(formatSignificant(0.0885172499569)).toBe("0.08852");
  expect(formatSignificant(1.23456)).toBe("1.235");
  expect(formatSignificant(1234.5678)).toBe("1,235");
  expect(formatSignificant(9.9996)).toBe("10.00");
  expect(formatSignificant(-0.000123456, 3)).toBe("-0.000123");
  expect(formatSignificant(0)).toBe("0");
  expect(formatSignificant(Number.NaN)).toBe(formatNumber(undefined));
});
