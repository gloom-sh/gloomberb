import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { debugLog } from "../../../utils/debug-log";
import { fetchProviderDividendData } from "./provider-client";

afterEach(() => setSystemTime());

test("a failed reference quote keeps cash history and the supplied-price fallback while logging once without rejection contents", async () => {
  setSystemTime(new Date("2027-06-01T12:00:00Z"));
  const source = "dividend-yield.provider-client";
  const before = debugLog.getEntries({ source }).length;
  const provider = createTestDataProvider({
    getCorporateActions: async () => ({
      symbol: "FUND", currency: "EUR", coverage: { dividends: "available" },
      dividends: [{ exDate: "2027-05-01", amount: 4 }], splits: [], earnings: [],
    }),
    getQuote: async () => { throw new Error("private-quote-payload"); },
  });

  const supplied = await fetchProviderDividendData(provider, "FUND", 100, "AMS", "EUR");
  const unavailable = await fetchProviderDividendData(provider, "FUND", null, "AMS");
  expect(supplied).toMatchObject({ price: 100, historyAvailable: true, metrics: { trailingRate: 4, trailingYield: 0.04 } });
  expect(unavailable).toMatchObject({ price: null, historyAvailable: true, metrics: { trailingRate: 4, trailingYield: null } });
  expect(unavailable.payments).toEqual(supplied.payments);
  const entries = debugLog.getEntries({ source }).slice(before);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    level: "warn", source,
    message: expect.stringMatching(/^Read dividend reference quote failed(?: \(suppressed repeats: \d+\))?$/),
    data: undefined,
  });
  expect(JSON.stringify(entries)).not.toContain("private-quote-payload");
});
