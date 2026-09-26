import { afterEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AppPersistence } from "../../data/app-persistence";
import { apiClient, type CloudFinancialsPayload } from "../../api-client";
import type { DataProvider, MarketDataRequestContext } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import { YahooFinanceClient } from "../yahoo-finance";
import { GloomberbCloudProvider } from "../gloomberb-cloud";
import { mapCloudFinancials } from "../gloomberb-cloud/normalizers";
import fixture from "../fixtures/sec-operating-expenses.json";
import { AssetDataRouter } from "./index";
import { cacheRouterResource, listCachedResources } from "./cache";
import { createTestFinancials, createTestQuote, fallbackProvider } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

const NOW = Date.parse("2026-09-14T18:00:00Z");
const ordinaryPolicy = { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 };
const originalQ4 = 745_000_000;
const originalCloudFinancials = apiClient.getCloudFinancials;
const q4 = (financials: TickerFinancials) => financials.quarterlyStatements.find(row => row.date === "2025-12-31");
const vendorFinancials = (symbol = "SHOP", exchange = "NASDAQ", currency = "USD") => createTestFinancials({
  quote: createTestQuote({ symbol, listingExchangeName: exchange, exchangeName: exchange, currency }),
  financialCurrency: currency,
  profile: { description: "Company profile" },
  annualStatements: Array.from({ length: 5 }, (_, index) => ({ date: `${2021 + index}-12-31`, currency, inventory: 5 })),
  quarterlyStatements: [{ date: "2025-12-31", currency, operatingIncome: originalQ4 }],
});

afterEach(() => { apiClient.getCloudFinancials = originalCloudFinancials; setSystemTime(); removeTempDbFiles(); });

for (const extended of [false, true]) {
  test(`native ${extended ? "extended" : "default"} financial cache reaches a completed background SEC table after restart`, async () => {
    setSystemTime(NOW);
    const path = createTempDbPath("operating-background");
    let persistence = new AppPersistence(path);
    const native = new YahooFinanceClient() as any;
    const secClient = native.secClient;
    let calls = 0;
    let documentCalls = 0;
    let finishDocuments!: () => void;
    const documents = new Promise<void>(resolve => { finishDocuments = resolve; });
    secClient.loadLookup = async () => new Map([["SHOP", { cik: "0001594805", exchange: "NASDAQ" }]]);
    secClient.fetchJson = async (url: string) => url.includes("companyfacts") ? fixture.shop : {
      cik: "1594805", filings: { recent: {
        accessionNumber: ["0001594805-26-000047", "0001594805-26-000007"],
        form: ["10-Q", "10-K"], filingDate: ["2026-08-05", "2026-02-11"],
        primaryDocument: ["shop-20260630.htm", "shop-20251231.htm"],
      } },
    };
    secClient.fetchText = async (url: string) => {
      documentCalls++;
      await documents;
      return { body: readFileSync(new URL(`../fixtures/shop-${url.includes("20260630") ? "20260630" : "20251231"}-quarterly-summary.html`, import.meta.url), "utf8") };
    };
    const provider: DataProvider = { ...fallbackProvider, id: "yahoo", async getTickerFinancials(symbol, exchange, context) {
      calls++;
      return native.supplementSecStatements(symbol, exchange, vendorFinancials(), context?.statementHistory === "extended");
    } };
    const context: MarketDataRequestContext | undefined = extended ? { statementHistory: "extended" } : undefined;
    const variantKey = `exchange=NASDAQ${extended ? ";history=extended:v1" : ""}`;
    const read = () => listCachedResources<TickerFinancials>(persistence.resources, "financials", "SHOP", [variantKey], ["provider:yahoo"], true)[0]!;
    try {
      let router = new AssetDataRouter(provider, [], persistence.resources);
      const first = await router.getTickerFinancials("SHOP", "NASDAQ", context);
      expect(q4(first)?.operatingIncome).toBe(originalQ4);
      expect(first.operatingHistoryRetryAt).toBe(NOW + 60_000);
      expect(read().staleAt).toBe(NOW + 60_000);
      expect(read().expiresAt).toBe(NOW + ordinaryPolicy.expireMs);
      if (extended) expect(first.statementHistory?.status).toBe("available");

      finishDocuments();
      await secClient.shopOperatingTablesPromise;
      expect(secClient.getOperatingTablesRetryAt("SHOP")).toBeUndefined();
      persistence.close();
      persistence = new AppPersistence(path);
      router = new AssetDataRouter(provider, [], persistence.resources);
      setSystemTime(NOW + 30_000);
      expect(q4(await router.getTickerFinancials("SHOP", "NASDAQ", context))?.operatingIncome).toBe(originalQ4);
      expect(calls).toBe(1);

      setSystemTime(NOW + 60_001);
      const recovered = await router.getTickerFinancials("SHOP", "NASDAQ", context);
      expect(q4(recovered)?.operatingIncome).toBe(631_000_000);
      expect(q4(recovered)?.operatingResult?.reported?.accessionNumber).toBe("0001594805-26-000007");
      expect(recovered.operatingHistoryRetryAt).toBeUndefined();
      expect(calls).toBe(2);
      expect(documentCalls).toBe(2);
      expect(read().staleAt).toBe(NOW + 60_001 + ordinaryPolicy.staleMs);
      expect(read().value.operatingHistoryRetryAt).toBeUndefined();
      await router.getTickerFinancials("SHOP", "NASDAQ", context);
      expect(calls).toBe(2);
    } finally { persistence.close(); }
  });
}

for (const extended of [false, true]) {
  test(`Cloud ${extended ? "extended" : "default"} financial cache retries explicit pending SEC acquisition after restart`, async () => {
    setSystemTime(NOW);
    const path = createTempDbPath("operating-cloud-retry");
    let persistence = new AppPersistence(path);
    let ready = false;
    let calls = 0;
    apiClient.getCloudFinancials = async (_ticker, _exchange, statementHistory) => {
      calls++;
      const vendor = vendorFinancials();
      const data: CloudFinancialsPayload = {
        ...vendor,
        quote: { ...vendor.quote!, providerId: "gloomberb-cloud", dataSource: "delayed" },
        operatingHistoryRetryAt: ready ? undefined : NOW + 60_000,
        quarterlyStatements: [{ date: "2025-12-31", currency: "USD", operatingIncome: ready ? 631_000_000 : originalQ4 }],
        statementHistory: statementHistory === "extended" ? {
          mode: "extended", source: "sec", status: "available", fetchedAt: new Date().toISOString(),
        } : undefined,
      };
      return { status: ready ? "success" : "partial", data };
    };
    const context: MarketDataRequestContext | undefined = extended ? { statementHistory: "extended" } : undefined;
    const variantKey = `exchange=NASDAQ${extended ? ";history=extended:v1" : ""}`;
    const read = () => listCachedResources<TickerFinancials>(persistence.resources, "financials", "SHOP", [variantKey], ["provider:gloomberb-cloud"], true)[0]!;
    try {
      let router = new AssetDataRouter(new GloomberbCloudProvider(), [], persistence.resources);
      expect(q4(await router.getTickerFinancials("SHOP", "NASDAQ", context))?.operatingIncome).toBe(originalQ4);
      expect(read().value.operatingHistoryRetryAt).toBe(NOW + 60_000);
      expect(read().staleAt).toBe(NOW + 60_000);
      expect(read().expiresAt).toBe(NOW + ordinaryPolicy.expireMs);
      ready = true;
      persistence.close();
      persistence = new AppPersistence(path);
      router = new AssetDataRouter(new GloomberbCloudProvider(), [], persistence.resources);
      setSystemTime(NOW + 30_000);
      expect(q4(await router.getTickerFinancials("SHOP", "NASDAQ", context))?.operatingIncome).toBe(originalQ4);
      expect(calls).toBe(1);
      setSystemTime(NOW + 60_001);
      expect(q4(await router.getTickerFinancials("SHOP", "NASDAQ", context))?.operatingIncome).toBe(631_000_000);
      expect(calls).toBe(2);
      expect(read().value.operatingHistoryRetryAt).toBeUndefined();
      expect(read().staleAt).toBe(NOW + 60_001 + ordinaryPolicy.staleMs);
      await router.getTickerFinancials("SHOP", "NASDAQ", context);
      expect(calls).toBe(2);
    } finally { persistence.close(); }
  });
}

test("Cloud retry metadata requires a finite deadline and qualified SHOP identity", () => {
  const vendor = vendorFinancials();
  const value: CloudFinancialsPayload = { ...vendor, quote: { ...vendor.quote!, providerId: "gloomberb-cloud", dataSource: "delayed" } };
  for (const retryAt of [null, "123", Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    expect(mapCloudFinancials({ ...value, operatingHistoryRetryAt: retryAt } as any).operatingHistoryRetryAt).toBeUndefined();
  }
  const flagged = { ...value, operatingHistoryRetryAt: NOW + 60_000 };
  expect(mapCloudFinancials(flagged, undefined, { symbol: "SHOP", exchange: "NASDAQ" }).operatingHistoryRetryAt).toBe(NOW + 60_000);
  expect(mapCloudFinancials(flagged, undefined, { symbol: "SHOP", exchange: "TSX" }).operatingHistoryRetryAt).toBeUndefined();
  expect(mapCloudFinancials({ ...flagged, financialCurrency: "CAD" }).operatingHistoryRetryAt).toBeUndefined();
  expect(mapCloudFinancials({ ...flagged, quote: { ...flagged.quote!, symbol: "MSFT" } }).operatingHistoryRetryAt).toBeUndefined();
});

test("secondary native operating retries survive the provider cache projection", async () => {
  setSystemTime(NOW);
  const persistence = new AppPersistence(createTempDbPath("operating-secondary"));
  let calls = 0;
  const primary: DataProvider = { ...fallbackProvider, id: "primary", priority: 1,
    async getTickerFinancials() { return { ...vendorFinancials(), annualStatements: [], quarterlyStatements: [] }; },
  };
  const native: DataProvider = { ...fallbackProvider, id: "yahoo", priority: 2,
    async getTickerFinancials() { calls++; return { ...vendorFinancials(), operatingHistoryRetryAt: NOW + 60_000 }; },
  };
  const router = new AssetDataRouter(native, [primary], persistence.resources);
  try {
    await router.getTickerFinancials("SHOP", "NASDAQ");
    const record = listCachedResources<TickerFinancials>(persistence.resources, "financials", "SHOP", ["exchange=NASDAQ"], ["provider:yahoo"], true)[0]!;
    expect(record.value.quote).toBeUndefined();
    expect(record.value.operatingHistoryRetryAt).toBe(NOW + 60_000);
    expect(record.staleAt).toBe(NOW + 60_000);
    setSystemTime(NOW + 60_001);
    await router.getTickerFinancials("SHOP", "NASDAQ");
    expect(calls).toBe(2);
  } finally { persistence.close(); }
});

test("retry deadlines only shorten qualified native or Cloud SHOP staleness and retain usable financials", () => {
  setSystemTime(NOW);
  const persistence = new AppPersistence(createTempDbPath("operating-retry-scope"));
  try {
    for (const [sourceKey, symbol, exchange, currency] of [
      ["provider:yahoo", "SHOP", "NASDAQ", "USD"], ["provider:yahoo", "SHOP", "TSX", "CAD"],
      ["provider:gloomberb-cloud", "SHOP", "NASDAQ", "USD"], ["provider:gloomberb-cloud", "SHOP", "TSX", "CAD"],
      ["provider:yahoo", "MSFT", "NASDAQ", "USD"], ["provider:independent", "SHOP", "NASDAQ", "USD"],
    ]) {
      const value = { ...vendorFinancials(symbol, exchange, currency), operatingHistoryRetryAt: NOW + 60_000 };
      const variantKey = `exchange=${exchange}`;
      cacheRouterResource(persistence.resources, "financials", symbol!, variantKey, sourceKey!, value, ordinaryPolicy);
      const record = listCachedResources(persistence.resources, "financials", symbol!, [variantKey], [sourceKey!], true)[0]!;
      const scoped = ["provider:yahoo", "provider:gloomberb-cloud"].includes(sourceKey!) && symbol === "SHOP" && exchange === "NASDAQ";
      expect(record.staleAt).toBe(NOW + (scoped ? 60_000 : ordinaryPolicy.staleMs));
      expect(record.expiresAt).toBe(NOW + ordinaryPolicy.expireMs);
    }
  } finally { persistence.close(); }
});
