import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { OPTIONS_QUOTE_EXCHANGE } from "../options/live-quotes";
import { loadContractPremiumHistory, premiumSeries } from "./premium-history";

const original = apiClient.getCloudHistory;
afterEach(() => { apiClient.getCloudHistory = original; });

test("asks for the contract's daily closes and drops a bar with no price", async () => {
  let requested: unknown[] = [];
  apiClient.getCloudHistory = (async (...args: unknown[]) => {
    requested = args;
    return {
      status: "success",
      data: [
        { date: "2026-10-09T00:00:00.000Z", close: 11.2, volume: 10 },
        { date: "not-a-date", close: 12 },
        { date: "2026-10-12T00:00:00.000Z", close: Number.NaN },
        { date: "2026-10-13T00:00:00.000Z", close: 11.75 },
      ],
    };
  }) as typeof apiClient.getCloudHistory;

  const rows = await loadContractPremiumHistory("AAPL270115C00355000");
  expect(requested.slice(0, 3)).toEqual(["AAPL270115C00355000", OPTIONS_QUOTE_EXCHANGE, { interval: "1day", outputsize: 400 }]);
  expect(rows.map((row) => row.close)).toEqual([11.2, 11.75]);
  expect(premiumSeries(rows, "#fff")).toHaveLength(1);
  expect(premiumSeries(rows.slice(0, 1), "#fff")).toEqual([]);
});

test("an empty history is not a series", async () => {
  apiClient.getCloudHistory = (async () => ({ status: "success", data: [] })) as typeof apiClient.getCloudHistory;
  expect(await loadContractPremiumHistory("NONE")).toEqual([]);
});
