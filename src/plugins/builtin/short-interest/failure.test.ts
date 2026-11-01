import { expect, spyOn, test } from "bun:test";
import { debugLog } from "../../../utils/debug-log";
import { loadShortInterestWithFloat } from "./watch-client";

test("a failed float snapshot keeps the settlements and logs no rejection details", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "short-interest.watch-client") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const point = { settlementDate: "2026-09-30", sharesShort: 42_670_000, daysToCover: 3.98, averageDailyVolume: null, previousSharesShort: null, changePercent: null, revised: false };
    const result = await loadShortInterestWithFloat("TEST", {
      client: { getCloudShortInterest: async () => ({ status: "success" as const, data: { symbol: "TEST", issueName: null, source: "finra" as const, points: [point] } }) },
      loadSnapshots: async () => { throw new Error("account=private token=private https://fixture.invalid/?secret=private"); },
    });
    expect(result.records.map((record) => [record.sharesShort, record.shortPercentFloat])).toEqual([[42_670_000, null]]);
    expect(logged).toEqual([["warn", expect.stringMatching(/^Load float snapshots failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
