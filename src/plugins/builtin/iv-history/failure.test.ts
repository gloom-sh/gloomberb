import { expect, spyOn, test } from "bun:test";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import { NO_FATE } from "../../../tickers/listing-fate";
import type { PricePoint } from "../../../types/financials";
import { debugLog } from "../../../utils/debug-log";
import { loadScreenVolatilities } from "./client";

test("one symbol's failed history leaves its HV blank, the rest load, and no rejection details are logged", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "iv-history.client") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const closes: PricePoint[] = Array.from({ length: 30 }, (_, index) => {
      const close = 100 + (index % 3);
      return { date: new Date(Date.UTC(2026, 8, 1 + index)), open: close, high: close + 1, low: close - 1, close, volume: 1000 };
    });
    const entry: QueryEntry<PricePoint[]> = { ...createIdleEntry<PricePoint[]>(), phase: "ready", data: closes };
    const { hv } = await loadScreenVolatilities([{ symbol: "FAIL" }, { symbol: "OK" }], Promise.resolve([]), 5, {}, {
      loadChart: async (request) => {
        if (request.instrument.symbol === "FAIL") throw new Error("token=private https://fixture.invalid/?secret=private");
        return entry;
      },
      loadFate: async () => NO_FATE,
    });
    expect(hv.get("FAIL")).toBeNull();
    expect(hv.get("OK")?.value).toEqual(expect.any(Number));
    expect(logged).toEqual([["warn", expect.stringMatching(/^Load screen price history failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
