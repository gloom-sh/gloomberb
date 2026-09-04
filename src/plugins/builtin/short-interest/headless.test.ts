import { describe, expect, test } from "bun:test";
import { CloudDataApi } from "../../../api-client/data";
import type { CloudMarketResponse, CloudShortInterestPayload } from "../../../api-client/types";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { fetchShortInterest } from "./client";
import { createShortInterestHeadless } from "./headless";

const records = [
  {
    settlementDate: new Date("2026-08-15T00:00:00.000Z"),
    sharesShort: 12_000_000,
    shortRatio: 2.5,
    averageDailyVolume: 4_800_000,
    shortPercentFloat: 3.2,
  },
  {
    settlementDate: new Date("2026-08-31T00:00:00.000Z"),
    sharesShort: 15_000_000,
    shortRatio: 3,
    averageDailyVolume: 5_000_000,
    shortPercentFloat: 4.1,
  },
];

function context(): HeadlessPaneContext {
  return {
    marketData: createTestDataProvider(),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloomberb-headless-short-interest"),
    signal: new AbortController().signal,
  };
}

function args(overrides: Partial<HeadlessPaneLoadArgs["options"]> = {}): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AMD",
    argument: "AMD",
    symbols: ["AMD"],
    options: { order: "newest", limit: 24, ...overrides },
  };
}

describe("short interest client", () => {
  test("uses the served market route for FINRA history", async () => {
    const paths: string[] = [];
    const dataApi = new CloudDataApi(async <T>(path: string): Promise<T> => {
      paths.push(path);
      return {
        status: "success",
        data: {
          symbol: "AAPL",
          issueName: "Apple Inc.",
          points: [{
            settlementDate: "2026-08-31",
            sharesShort: 15_000_000,
            previousSharesShort: 12_000_000,
            averageDailyVolume: 5_000_000,
            daysToCover: 3,
            changePercent: 25,
            revised: false,
          }],
        },
      } as CloudMarketResponse<CloudShortInterestPayload> as T;
    });

    const result = await fetchShortInterest("aapl", dataApi);

    expect(paths).toEqual(["/market/short-interest?symbol=AAPL"]);
    expect(result[0]).toMatchObject({ sharesShort: 15_000_000, shortRatio: 3 });
  });
});

describe("short interest headless model", () => {
  test("projects raw settlement values and applies order and limit", async () => {
    const headless = createShortInterestHeadless({
      loadRecords: async () => records,
    });

    const newest = await headless.load(args({ limit: 1 }), context());
    expect(newest.rows).toEqual([{
      settlementDate: "2026-08-31",
      sharesShort: 15_000_000,
      daysToCover: 3,
      averageDailyVolume: 5_000_000,
      shortPercentFloat: 4.1,
    }]);

    const oldest = await headless.load(args({ order: "oldest", limit: 1 }), context());
    expect(oldest.rows[0]).toMatchObject({
      settlementDate: "2026-08-15",
      sharesShort: 12_000_000,
    });
  });
});
