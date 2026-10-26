import { expect, spyOn, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { debugLog } from "../../../utils/debug-log";
import { loadSectorRows } from "./client";

test("a failed sector quote batch logs safely and retains individual quote recovery", async () => {
  // Give this integration boundary its own rate-limit window in a full test run.
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00Z"));
  const entries = debugLog.getEntries({ source: "sectors" }).length;
  const sectors = [{ name: "Technology", etf: "XLK" }];
  const quote = createTestQuote({ symbol: "XLK", changeSessionDate: "2026-09-10" });
  const retried: string[] = [];
  const provider = createTestDataProvider({
    getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote })),
    getQuote: async (symbol) => { retried.push(symbol); return quote; },
  });
  try {
    const expected = await loadSectorRows(sectors, provider);
    provider.getQuotesBatch = async () => {
      throw new Error("token=private https://example.test/?secret=private /home/private/config");
    };
    expect(await loadSectorRows(sectors, provider)).toEqual(expected);
    expect(retried).toEqual(["XLK"]);
    const logged = debugLog.getEntries({ source: "sectors" }).slice(entries);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "warn", source: "sectors", message: "Sector quote batch failed", data: undefined });
    expect(JSON.stringify(logged)).not.toContain("private");
  } finally {
    clock.mockRestore();
  }
});
