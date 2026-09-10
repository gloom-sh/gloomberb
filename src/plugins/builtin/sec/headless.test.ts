import { describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { SecFilingItem } from "../../../types/data-provider";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createSecHeadless } from "./headless";
import { buildSecFilingRows, secAcceptanceTimestamp } from "./model";

const filings: SecFilingItem[] = [
  {
    accessionNumber: "0000320193-26-000100",
    form: "8-K",
    filingDate: new Date("2026-08-25T00:00:00.000Z"),
    primaryDocDescription: "8-K Results of Operations",
    items: "2.02,9.01",
    cik: "0000320193",
    filingUrl: "https://www.sec.gov/filing/one",
  },
  {
    accessionNumber: "0000320193-26-000099",
    form: "10-Q",
    filingDate: new Date("2026-08-20T00:00:00.000Z"),
    cik: "0000320193",
    filingUrl: "https://www.sec.gov/filing/two",
  },
];

function context(): HeadlessPaneContext {
  return {
    marketData: createTestDataProvider(),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloomberb-headless-sec"),
    signal: new AbortController().signal,
  };
}

function args(limit: number): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AAPL",
    argument: "AAPL",
    symbols: ["AAPL"],
    options: { limit },
  };
}

describe("SEC headless model", () => {
  test("projects filing rows and honors the page limit", async () => {
    const requestedLimits: number[] = [];
    const headless = createSecHeadless({
      loadFilings: async (_symbol, limit) => {
        requestedLimits.push(limit);
        return filings;
      },
    });

    const first = await headless.load(args(1), context());
    expect(first.rows).toEqual([{
      filedAt: "2026-08-25T00:00:00.000Z",
      acceptedAt: null,
      acceptedAtRaw: null,
      acceptanceReported: null,
      form: "8-K",
      filing: "8-K | Results of Operations | Current Report",
      items: "2.02,9.01",
      accessionNumber: "0000320193-26-000100",
      primaryDocument: null,
      cik: "0000320193",
      companyName: null,
      url: "https://www.sec.gov/filing/one",
    }]);

    const both = await headless.load(args(2), context());
    expect(both.rows).toHaveLength(2);
    expect(requestedLimits).toEqual([1, 2]);
  });
});

test("ticker reuse preserves the actual filing issuer rather than the requested ticker's former company", async () => {
  const headless = createSecHeadless({ loadFilings: async () => [{
    ...filings[0]!, cik: "0001826011", companyName: "Banzai International, Inc."
  }] });
  const result = await headless.load({ ...args(1), argument: "PARA", symbols: ["PARA"] }, context());
  expect(result.rows[0]).toMatchObject({ cik: "0001826011", companyName: "Banzai International, Inc." });
  expect(result.metadata?.issuers).toEqual([{ cik: "0001826011", companyName: "Banzai International, Inc." }]);
});

test("accepted timestamps survive persisted JSON rows and invalid cached values remain unknown", () => {
  const filing = { ...filings[0]!, acceptedAt: new Date("2025-03-20T20:10:11.000Z") };
  const restored = JSON.parse(JSON.stringify(filing)) as SecFilingItem;
  expect(secAcceptanceTimestamp(restored.acceptedAt)).toBe("2025-03-20T20:10:11.000Z");
  expect(buildSecFilingRows([restored])[0]?.acceptedAt).toBe("2025-03-20T20:10:11.000Z");
  const compact = { ...restored, acceptedAt: undefined, acceptedAtRaw: "20250320161011" };
  expect(buildSecFilingRows([compact])[0]).toMatchObject({ acceptedAt: null, acceptedAtRaw: "20250320161011", acceptanceReported: "20250320161011 (timezone unspecified)" });
  expect(secAcceptanceTimestamp("2025-03-20T16:10:11")).toBeNull();
  const naive = JSON.parse(JSON.stringify({ ...filing, acceptedAt: "2025-03-20T16:10:11" })) as SecFilingItem;
  expect(buildSecFilingRows([naive])[0]).toMatchObject({ acceptedAt: null, acceptanceReported: "2025-03-20T16:10:11 (timezone unspecified)" });
  expect(secAcceptanceTimestamp("invalid")).toBeNull();
  expect(secAcceptanceTimestamp(undefined)).toBeNull();
});
