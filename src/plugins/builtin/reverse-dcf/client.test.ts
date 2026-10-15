import { expect, test } from "bun:test";
import { unavailableText } from "../../../components/ui/status";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { loadReverseDcfInputs } from "./client";

test("a failed fundamentals load uses the shared unavailable sentence", async () => {
  const snapshot = await loadReverseDcfInputs(
    { instrument: { symbol: "AAPL", exchange: "NASDAQ" } },
    createTestDataProvider({
      getTickerFinancials: async () => { throw new Error("Fundamentals exploded"); },
    }),
  );
  expect(snapshot.financials).toBeNull();
  expect(snapshot.error).toBe(unavailableText("Reverse DCF"));
  expect(snapshot.error).not.toContain("exploded");
});
