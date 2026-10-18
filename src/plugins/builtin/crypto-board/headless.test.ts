import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { headlessReportTables, type LoadedHeadlessPaneModel, renderHeadlessPaneText, reportCoverage } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";
import type { HeadlessPaneContext } from "../../../types/headless";
import { cryptoBoardHeadless } from "./headless";
import { CRYPTO_FIXTURE_NOW, cryptoFixture, stablecoinSupplyFixture } from "./test-fixture";

const ARGS = { rawArgument: "", argument: null, symbols: [], options: { list: "stablecoin" } };

beforeEach(() => setSystemTime(new Date(CRYPTO_FIXTURE_NOW)));
afterEach(() => setSystemTime());

function load(getCloudStablecoinSupply: () => Promise<unknown>) {
  const apiClient = { getCloudCryptoMarkets: async () => cryptoFixture(), getCloudStablecoinSupply };
  return cryptoBoardHeadless.load(ARGS, { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
}

test("the stablecoin list states the total, adds each coin's supply, and exports the daily series", async () => {
  const result = await load(async () => stablecoinSupplyFixture());
  const freshness = deriveHeadlessFreshness(cryptoBoardHeadless, result, CRYPTO_FIXTURE_NOW);
  const text = renderHeadlessPaneText(cryptoBoardHeadless, result, ARGS, "CRYP", freshness);
  expect(text).toContain("Total supply 300.00B · 7D -1.50B (-0.50%) · 30D +1.80B (+0.60%) · as of 2026-09-23");
  expect(text).toMatch(/Supply\s+Supply 7D %\s+Supply 7D\s+Supply 30D %\s+Supply 30D\s+Share/);
  expect(text).toMatch(/USDT .* 180\.00B\s+-0\.33%\s+-600\.00M\s+\+0\.11%\s+\+200\.00M\s+60\.00%/);

  const csv = renderReportCsv(headlessReportTables(cryptoBoardHeadless, result, ARGS, "CRYP", freshness, { complete: true, unavailableSymbols: [] }), freshness);
  const series = csv.slice(csv.indexOf("# section: Stablecoin supply")).split("\n");
  expect(series[1]).toBe("Date,Total,USDT,USDC,Other,symbol_or_series,currency_or_unit,interval,source,as_of");
  expect(series[2]).toStartWith("2026-09-19,296000000000,178000000000,,118000000000,,USD,1d,");
  expect(series[4]).toStartWith("2026-09-21,,,71000000000,,,USD,1d,");
});

test("a supply outage is a note: the prices stay a complete report, with the market cap and no blank supply", async () => {
  const result = await load(async () => {
    throw new ApiRequestError("Unavailable", 503);
  });
  expect(result.rows[0]).toMatchObject({ code: "USDT", price: 0.9998, supply: null, supplyShare: null });
  expect(result.errors).toEqual([]);
  expect(result.notes).toEqual(["Stablecoin supply is temporarily unavailable; the prices are complete without it."]);
  expect(reportCoverage({ definition: cryptoBoardHeadless, args: ARGS, result } as LoadedHeadlessPaneModel).complete).toBe(true);
  expect(result.metadata).not.toHaveProperty("notices");
  expect("exportTables" in result).toBe(false);
  const freshness = deriveHeadlessFreshness(cryptoBoardHeadless, result, CRYPTO_FIXTURE_NOW);
  const text = renderHeadlessPaneText(cryptoBoardHeadless, result, ARGS, "CRYP", freshness);
  expect(text).toMatch(/Vol 24h  Market cap\n/);
  expect(text).not.toMatch(/Supply\s/);
});
