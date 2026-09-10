import { describe, expect, test } from "bun:test";
import { convertCurrency, displayWidth, formatCompact, formatCurrency, formatNumber, formatPercent, formatPercentRaw, formatTimeAgo, padTo, truncateToDisplayWidth } from "./format";
import { normalizeTimestamp } from "./timestamp";

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

describe("formatTimeAgo", () => {
  test("handles UTC ISO timestamps with explicit offsets", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString().replace("Z", "+00:00");
    expect(formatTimeAgo(fiveMinutesAgo)).toBe("5m ago");
  });

  test("treats space-separated chat timestamps without a timezone as UTC", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString().replace("T", " ").replace("Z", "");
    expect(formatTimeAgo(fiveMinutesAgo)).toBe("5m ago");
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
