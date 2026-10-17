import { afterAll, beforeAll, spyOn } from "bun:test";
import { apiClient } from "../../../api-client";

/**
 * `portfolio show` reads every share and fund's dividends from Gloom Cloud, as
 * DVD does. Tests that show a portfolio answer each read offline with a full
 * history that paid nothing, so Income reads $0.00 and no request leaves.
 */
export function answerDividendReadsOffline(): void {
  let spy: { mockRestore(): void } | undefined;
  beforeAll(() => {
    spy = spyOn(apiClient, "getMarketDividends").mockImplementation(async (symbol: string) => ({
      status: "success",
      data: {
        actions: { providerId: "gloomberb-cloud", symbol, currency: "USD", dividends: [], splits: [], earnings: [], coverage: { dividends: "available" } },
        quote: null,
        summary: null,
      },
    }));
  });
  afterAll(() => spy?.mockRestore());
}
