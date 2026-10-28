import { expect, spyOn, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { debugLog } from "../../../utils/debug-log";
import { loadReturnSeries } from "./data-panes/returns-history";

test("a rejected listing read keeps the returns window anchored to now and logs no rejection details", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "ticker-detail.data-panes.returns-history") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const provider = createTestDataProvider({
      getQuoteMetadata: async () => { throw new Error("token=private https://fixture.invalid/?secret=private"); },
      getDetailedPriceHistoryWithMetadata: async () => ({ points: [], resolution: "1h" }),
    });
    // Sunday, with no exchange on the ticker: without the quote's listing the window ends now.
    const now = Date.parse("2026-10-11T15:00:00Z");
    const series = await loadReturnSeries(provider, { symbol: "VTI", exchange: "", range: "5D", resolution: "1h", support: [], now });
    expect(series.venue).toBe("");
    expect(series.visibleTo).toBe(now);
    expect(logged).toEqual([["warn", expect.stringMatching(/^Read return session venue failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    clock.mockRestore();
  }
});
