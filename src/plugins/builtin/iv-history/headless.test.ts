import { describe, expect, test } from "bun:test";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessBundleResult, HeadlessPaneApiClient } from "../../../types/headless";
import type { IvMethod, IvScreenPayload, IvScreenRow } from "./client";
import { ivScreenHeadless } from "./headless";

const reading = (date: string, method: IvMethod, iv30: number) => ({
  date, method, capturedAt: `${date}T19:55:00Z`, spot: 100, iv7: null, iv30, iv60: null, iv90: iv30 + 0.01, iv180: null, iv365: null,
});
/** A screened symbol: its stored latest reading and the trade close its rank is measured on. */
const row = (symbol: string, latest: ReturnType<typeof reading>, rankDate: string, rank = 40): IvScreenRow => ({
  symbol, status: "ready", latest,
  iv30: { value: 0.3, date: rankDate, method: "trade-close", rank, percentile: rank, low: 0.2, high: 0.4, samples: 250, windowStart: "2025-10-08" },
  iv90: null, skew: null,
});
const load = async (rows: IvScreenRow[]) => {
  // The response's own date is the day it was fetched, a day after the newest session.
  const payload: IvScreenPayload = { version: 1, asOf: "2026-10-10", rows };
  const apiClient = { impliedVolatility: async () => payload } as unknown as HeadlessPaneApiClient;
  const result = await ivScreenHeadless.load(createTestHeadlessArgs({ symbols: rows.map((entry) => entry.symbol) }),
    createTestHeadlessContext({ apiClient })) as HeadlessBundleResult;
  const section = result.sections[0]! as Extract<HeadlessBundleResult["sections"][number], { rows: unknown[] }>;
  const cell = (key: string, index: number) => {
    const column = section.columns!.find((entry) => entry.key === key)!;
    const value = section.rows[index]![key];
    return column.format ? column.format(value, section.rows[index]!) : String(value);
  };
  const footer = formatFreshnessLine(deriveHeadlessFreshness(ivScreenHeadless, result, Date.parse("2026-10-10T02:40:00Z")));
  return { title: section.title, keys: section.columns!.map((column) => column.key), cell, footer, result };
};

describe("VCA dates", () => {
  test("a quote reading and the close it is ranked on are each dated once, and the footer agrees", async () => {
    const { title, keys, footer } = await load([
      row("NVDA", reading("2026-10-09", "quote-mid", 0.293), "2026-10-09"),
      row("AAPL", reading("2026-10-09", "quote-mid", 0.265), "2026-10-09"),
    ]);
    expect(title).toContain("IV30 2026-10-09 quote · IVR/IVP vs 52 weeks to 2026-10-09 close");
    expect(title).not.toContain("live");
    expect(keys).not.toContain("date");
    expect(keys).not.toContain("rankDate");
    expect(footer).toBe("Source: Gloom Cloud | As of 2026-10-09 | Not a live feed (daily implied volatility)");
  });

  test("a trade-close reading on its rank date says so once", async () => {
    const { title } = await load([row("SPY", reading("2026-10-09", "trade-close", 0.123), "2026-10-09")]);
    expect(title.endsWith("· 2026-10-09 close")).toBe(true);
  });

  test("rows on different readings or rank dates get a column each, and the footer is the newest reading", async () => {
    const { title, keys, cell, footer } = await load([
      row("NVDA", reading("2026-10-09", "quote-mid", 0.293), "2026-10-09"),
      row("XLF", reading("2026-10-09", "trade-close", 0.171), "2026-10-09"),
      row("IWM", reading("2026-10-08", "quote-mid", 0.182), "2026-10-08"),
    ]);
    expect(title).toBe("Rich/cheap · Custom symbols");
    expect(keys).toContain("date");
    expect(keys).toContain("rankDate");
    expect([0, 1, 2].map((index) => cell("date", index))).toEqual(["2026-10-09 quote", "2026-10-09 close", "2026-10-08 quote"]);
    expect([0, 1, 2].map((index) => cell("rankDate", index))).toEqual(["2026-10-09 close", "2026-10-09 close", "2026-10-08 close"]);
    expect(footer).toContain("As of 2026-10-09 |");
  });

  test("a quote ahead of its rank says which close the rank is on", async () => {
    const { title, keys } = await load([
      row("NVDA", reading("2026-10-09", "quote-mid", 0.293), "2026-10-08"),
      row("AAPL", reading("2026-10-09", "quote-mid", 0.265), "2026-10-08"),
    ]);
    expect(title).toContain("IV30 2026-10-09 quote · IVR/IVP vs 52 weeks to 2026-10-08 close");
    expect(keys).not.toContain("rankDate");
  });

  test("skew from an older capture than the reading is dated", async () => {
    const stale = { ...row("NVDA", reading("2026-10-09", "trade-close", 0.293), "2026-10-09"),
      skew: { date: "2026-10-08", put25: 0.3, call25: 0.28, skew: 0.02 } };
    const { keys, cell } = await load([stale]);
    expect(keys).toContain("skewDate");
    expect(cell("skewDate", 0)).toBe("2026-10-08");
  });
});
