import { expect, test } from "bun:test";
import { unavailableText } from "../../../components/ui/status";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { loadSeasonalityHistory } from "./client";

test("a failed price history load uses the shared unavailable sentence", async () => {
  const provider = createTestDataProvider({
    getPriceHistory: async () => { throw new Error("Gloom Cloud price history exploded"); },
  });
  const daily = await loadSeasonalityHistory(
    { instrument: { symbol: "AAPL", exchange: "NASDAQ" }, cadence: "daily" },
    provider,
  );
  expect(daily.history).toEqual([]);
  expect(daily.error).toBe(unavailableText("Daily price history"));
  expect(daily.error).not.toContain("exploded");
  const monthly = await loadSeasonalityHistory(
    { instrument: { symbol: "AAPL", exchange: "NASDAQ" }, cadence: "monthly" },
    provider,
  );
  expect(monthly.error).toBe(unavailableText("Monthly price history"));
});
