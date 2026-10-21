import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { loadReverseDcfInputs } from "./client";

test("a failed fundamentals load keeps the server failure", async () => {
  const snapshot = await loadReverseDcfInputs(
    { instrument: { symbol: "AAPL", exchange: "NASDAQ" } },
    createTestDataProvider({
      getTickerFinancials: async () => { throw new Error("Fundamentals exploded"); },
    }),
  );
  expect(snapshot.financials).toBeNull();
  expect(snapshot.error).toBe("Fundamentals exploded");
});
