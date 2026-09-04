import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { loadParsedInsiderFilings } from "./client";
import { createInsiderHeadless } from "./headless";
import type { ParsedInsiderFiling } from "./model";

const parsed: ParsedInsiderFiling[] = [
  {
    filing: {
      accessionNumber: "one",
      form: "4",
      filingDate: new Date("2026-08-26T00:00:00.000Z"),
      cik: "0000002488",
      filingUrl: "https://www.sec.gov/one",
    },
    transaction: {
      filingDate: new Date("2026-08-25T00:00:00.000Z"),
      reportedName: "SU LISA T",
      title: "Chief Executive Officer",
      transactionType: "P",
      shares: 25_000,
      pricePerShare: 150,
      totalValue: 3_750_000,
      sharesOwned: 4_000_000,
      form: "4",
    },
    isLoading: false,
  },
  {
    filing: {
      accessionNumber: "two",
      form: "4",
      filingDate: new Date("2026-08-24T00:00:00.000Z"),
      cik: "0000002488",
      filingUrl: "https://www.sec.gov/two",
    },
    transaction: {
      filingDate: new Date("2026-08-23T00:00:00.000Z"),
      reportedName: "OTHER OFFICER",
      title: "Officer",
      transactionType: "S",
      shares: 1_000,
      pricePerShare: 155,
      totalValue: 155_000,
      sharesOwned: 20_000,
      form: "4",
    },
    isLoading: false,
  },
];

function context(): HeadlessPaneContext {
  return {
    marketData: createTestDataProvider(),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloomberb-headless-insider"),
    signal: new AbortController().signal,
  };
}

function args(name = "", limit = 20): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AMD",
    argument: "AMD",
    symbols: ["AMD"],
    options: { name, limit },
  };
}

describe("insider client", () => {
  test("scans Form 4 filings and loads their content sequentially", async () => {
    let activeContentLoads = 0;
    let maxActiveContentLoads = 0;
    const filingRequests: Array<{ symbol: string; count: number; exchange: string | undefined }> = [];
    const provider = createTestDataProvider({
      getSecFilings: async (symbol, count, exchange) => {
        filingRequests.push({ symbol, count, exchange });
        return parsed.map(({ filing }) => filing);
      },
      getSecFilingContent: async () => {
        activeContentLoads += 1;
        maxActiveContentLoads = Math.max(maxActiveContentLoads, activeContentLoads);
        await Bun.sleep(1);
        activeContentLoads -= 1;
        return null;
      },
    });

    const result = await loadParsedInsiderFilings(provider, "NVDA", { limit: 2 });

    expect(filingRequests).toEqual([{ symbol: "NVDA", count: 20_000, exchange: "" }]);
    expect(result).toHaveLength(2);
    expect(maxActiveContentLoads).toBe(1);
  });
});

describe("insider headless model", () => {
  test("projects parsed Form 4 values and applies the owner filter", async () => {
    const requestedLimits: number[] = [];
    const headless = createInsiderHeadless({
      loadParsed: async (_symbol, limit) => {
        requestedLimits.push(limit);
        return parsed.slice(0, limit);
      },
    });

    const all = await headless.load(args("", 2), context());
    expect(all.rows[0]).toMatchObject({
      insider: "SU LISA T",
      side: "BUY",
      shares: 25_000,
      totalValue: 3_750_000,
    });

    const filtered = await headless.load(args("other officer", 2), context());
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]).toMatchObject({ insider: "OTHER OFFICER", side: "SELL" });
    expect(requestedLimits).toEqual([2, 2]);
  });
});
