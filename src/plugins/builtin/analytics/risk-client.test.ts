import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchPortfolioRiskMarket, validateRiskHistory } from "./risk-client";
import { now, instrument, riskQuote, riskHistory } from "./risk-test-data";
test("Cloud daily risk history rejects currency, listing, gap and duplicate ambiguity", () => {
  expect(
    validateRiskHistory(riskHistory(), instrument, riskQuote(), now).returns
      .length,
  ).toBeGreaterThan(60);
  const fx = riskHistory();
  fx.currency = "EUR";
  expect(() => validateRiskHistory(fx, instrument, riskQuote(), now)).toThrow(
    "currencies",
  );
  expect(() =>
    validateRiskHistory(
      riskHistory(),
      instrument,
      { ...riskQuote(), symbol: "QQQ" },
      now,
    ),
  ).toThrow("symbol");
  const gap = riskHistory();
  gap.data!.splice(-5, 1);
  expect(() =>
    validateRiskHistory(gap, instrument, riskQuote(), now),
  ).toThrow();
  const duplicate = riskHistory();
  duplicate.data!.push({ ...duplicate.data!.at(-1)!, close: 1 });
  expect(() =>
    validateRiskHistory(duplicate, instrument, riskQuote(), now),
  ).toThrow("contradictory");
  expect(() =>
    validateRiskHistory(
      riskHistory(),
      instrument,
      { ...riskQuote(), lastUpdated: 0 },
      now,
    ),
  ).toThrow("timestamp");
});
test("partial Cloud source failures stay local; permission rejection escapes the shared load", async () => {
  const client = {
    getCloudQuotesBatch: async (
      requested: Array<{ symbol: string; exchange: string }>,
    ) => ({
      status: "success",
      data: {
        items: requested.map((row) => ({
          ...row,
          status: "success",
          data: riskQuote(row.symbol, row.exchange),
        })),
      },
    }),
    getCloudHistory: async (symbol: string, exchange: string) => {
      if (symbol === "HYG") throw new Error("Credit history unavailable");
      const history = riskHistory();
      history.providerMeta!.normalizedSymbol = symbol;
      history.providerMeta!.normalizedExchange = exchange;
      return history;
    },
    getCloudFredSeries: async () => {
      throw new Error("FRED unavailable");
    },
  };
  const result = await fetchPortfolioRiskMarket([], client as any, now);
  expect(result.histories.filter((row) => !row.error)).toHaveLength(6);
  expect(
    result.histories.find((row) => row.instrument.symbol === "HYG")?.error,
  ).toContain("Credit");
  expect(result.yields).toBeNull();
  expect(result.warnings).toHaveLength(2);
  await expect(
    fetchPortfolioRiskMarket(
      [],
      {
        ...client,
        getCloudHistory: async () => {
          throw new ApiRequestError("Denied", 403);
        },
      } as any,
      now,
    ),
  ).rejects.toThrow("Denied");
});

test("without a current quote a dated USD history marks the holding at its latest close", () => {
  const history = riskHistory();
  const resolved = validateRiskHistory(history, instrument, null, now);
  const last = history.data!.at(-1)!;
  expect(resolved.closeMark).toEqual({ price: last.close, date: "2026-09-21", currency: "USD" });
  expect(validateRiskHistory(history, instrument, riskQuote(), now).closeMark).toBeNull();
  const unlabelled = riskHistory();
  delete unlabelled.providerMeta!.currency;
  // A US venue establishes USD; a foreign venue without a currency does not.
  expect(validateRiskHistory(unlabelled, instrument, null, now).closeMark?.currency).toBe("USD");
  delete unlabelled.providerMeta!.normalizedExchange;
  expect(() => validateRiskHistory(unlabelled, { symbol: "SPY", exchange: "LSE" }, null, now)).toThrow("Current USD listing identity unavailable");
});
