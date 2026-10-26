import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { seasonalityHeadless } from "./headless";

afterEach(() => setSystemTime());

/** Monthly bars as the data service serves them: each dated by the first day of its month. */
const months = ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"].map((date, index) => ({ date: new Date(`${date}T00:00:00Z`), close: 100 + index * 5 }));

async function line(exchange: string, now: string) {
  setSystemTime(new Date(now));
  const result = await seasonalityHeadless.load(
    createTestHeadlessArgs({ symbols: [`AAPL:${exchange}`], options: { tab: "returns" } }),
    createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "AAPL", exchange }),
      marketData: createTestDataProvider({ getPriceHistoryForResolution: async () => months, getPriceHistory: async () => months }),
    }),
  );
  return formatFreshnessLine(deriveHeadlessFreshness(seasonalityHeadless, result, Date.now()));
}

test("the running month's bar, dated by its first day, is dated by how far the month has run, and a finished month by its last session", async () => {
  // Monday before the open: October's bar runs through Friday's session, and is no close dated 1 Oct.
  expect(await line("NASDAQ", "2026-10-26T08:52:00Z")).toBe("Source: Gloom Cloud · month to date, through Fri 23 Oct 2026 · not a live feed (monthly closes)");
  // Once the month's last session has closed, the close is that session's.
  expect(await line("NASDAQ", "2026-10-31T12:00:00Z")).toBe("Source: Gloom Cloud · Fri 30 Oct 2026 · not a live feed (monthly closes)");
  // A venue whose sessions are unknown says the month has run, not a day it cannot name.
  expect(await line("ZZZ", "2026-10-26T08:52:00Z")).toBe("Source: Gloom Cloud · Oct 2026 to date · not a live feed (monthly closes)");
});
