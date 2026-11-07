import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchPortfolioRiskMarket, RISK_FACTOR_INSTRUMENTS, validateRiskHistory } from "./risk-client";
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
  expect(result.histories.filter((row) => !row.error)).toHaveLength(RISK_FACTOR_INSTRUMENTS.length - 1);
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

test("a holding that is a factor proxy shares the proxy's history however its venue is named", async () => {
  // SPY held without its venue was read again beside the factor's ARCA:SPY, and the TRY pair once per reader.
  const reads: string[] = [];
  const client = {
    getCloudQuotesBatch: async (requested: Array<{ symbol: string; exchange: string }>) => ({
      status: "success",
      data: { items: requested.map((row) => ({ ...row, status: "success", data: riskQuote(row.symbol, "ARCA") })) },
    }),
    getCloudHistory: async (symbol: string, exchange: string) => {
      reads.push(`${exchange}:${symbol}`);
      const history = riskHistory();
      history.providerMeta!.normalizedSymbol = symbol;
      history.providerMeta!.normalizedExchange = "ARCA";
      return history;
    },
    getCloudFredSeries: async () => {
      throw new Error("FRED unavailable");
    },
    getCloudExchangeRate: async () => ({ status: "success", data: { rate: 0.0237 } }),
  };
  await fetchPortfolioRiskMarket(
    [{ symbol: "SPY", exchange: "", quantity: 10 }, { symbol: "IWM", exchange: "NYSEARCA", quantity: 5 }],
    client as any,
    now,
    undefined,
    "TRY",
  );
  const counts = new Map<string, number>();
  for (const read of reads) counts.set(read.split(":")[1]!, (counts.get(read.split(":")[1]!) ?? 0) + 1);
  expect([...counts].filter(([, count]) => count > 1)).toEqual([]);
  expect(counts.get("SPY")).toBe(1);
  expect(counts.get("IWM")).toBe(1);
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

test("a cancelled load stops requesting histories, which go out batched; its other requests carry the signal", async () => {
  const controller = new AbortController();
  const requested: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const historyOptions: unknown[] = [];
  const client = {
    getCloudQuotesBatch: async (
      targets: Array<{ symbol: string; exchange: string }>,
      _mode: string,
      options?: { signal?: AbortSignal },
    ) => {
      signals.push(options?.signal);
      return { status: "success", data: { items: targets.map((row) => ({ ...row, status: "success", data: riskQuote(row.symbol, row.exchange) })) } };
    },
    getCloudHistory: async (
      symbol: string,
      _exchange: string,
      _params: unknown,
      options?: { signal?: AbortSignal; batch?: boolean },
    ) => {
      requested.push(symbol);
      historyOptions.push(options);
      // The turn is cancelled while the first history is loading.
      controller.abort();
      return riskHistory();
    },
    getCloudFredSeries: async (_id: string, _params: unknown, options?: { signal?: AbortSignal }) => {
      signals.push(options?.signal);
      throw new Error("FRED unavailable");
    },
  };
  const holdings = Array.from({ length: 40 }, (_, index) => ({ symbol: `H${index}`, exchange: "NASDAQ" }));

  await expect(fetchPortfolioRiskMarket(holdings, client as any, now, controller.signal)).rejects.toThrow();

  // The factor proxies' histories go out with the quotes; once cancelled, no holding's history is asked for.
  expect(requested.filter((symbol) => /^H\d+$/.test(symbol))).toEqual([]);
  expect(requested.length).toBeLessThanOrEqual(RISK_FACTOR_INSTRUMENTS.length);
  expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  // Shared with other reads in a batch request, a history is not stopped by one load's signal.
  expect(historyOptions.every((options) => JSON.stringify(options) === JSON.stringify({ batch: true }))).toBe(true);
});
