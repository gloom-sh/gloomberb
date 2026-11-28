import { expect, test } from "bun:test";
import type { CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import type { HeadlessPaneContext } from "../../../types/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { cryptoEtfFlowsHeadless } from "./headless";

test("a revised ETF price statistic does not change or inherit the flow snapshot's provenance", async () => {
  const date = "2026-11-27";
  const fetchedAt = "2026-11-28T05:14:11.870Z";
  const report = (priceChangePct: number) => {
    const payload: CryptoEtfFlowsPayload = {
      asset: "BTC", unit: "USD millions", asOf: date, fetchedAt, stale: false,
      source: { publisher: "Example Flow Research", url: "https://flows.example.test/btc/" },
      funds: [{ ticker: "IBIT", name: null, issuer: null }, { ticker: "FBTC", name: null, issuer: null }],
      days: [{ date, flows: { IBIT: -327.2, FBTC: null }, total: -389, pending: [], priceChangePct }],
    };
    return cryptoEtfFlowsHeadless.load({ rawArgument: "", argument: null, symbols: [], options: { from: date, to: date } }, {
      signal: new AbortController().signal,
      config: {} as HeadlessPaneContext["config"],
      marketData: createTestDataProvider(),
      apiClient: { getCloudCryptoEtfFlows: async () => payload } as Pick<HeadlessPaneContext["apiClient"], "getCloudCryptoEtfFlows"> as HeadlessPaneContext["apiClient"],
    });
  };
  const before = await report(-0.61), after = await report(-0.63);
  expect(before.rows).toEqual([{ date, total: -389, IBIT: -327.2, FBTC: null, pending: [], priceChangePct: -0.61 }]);
  expect(after.rows).toEqual([{ ...before.rows[0], priceChangePct: -0.63 }]);
  expect(after.freshness).toEqual(before.freshness);
  expect(after.freshness).toMatchObject({ asOf: date, retrievedAt: fetchedAt, publisher: "Example Flow Research" });
  expect(after.metadata?.priceChangeProvenance).toEqual({ sessionDate: "row date", asOf: null, retrievedAt: null, fundCoverage: null });
  expect(after.notes?.join(" ")).toContain("flow as-of and retrieval apply only to flows");
});
