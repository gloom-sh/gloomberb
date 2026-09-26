import { apiClient } from "../../api-client";
import { GloomberbCloudProvider } from "../gloomberb-cloud";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { TickerFinancials } from "../../types/financials";
import { withdrawKnownProviderStatements } from "../../utils/statement-observations";
import { parseReportedEarningsCohorts, promoteReportedEarningsResults } from "../../utils/reported-earnings-result";
import { YahooFinanceClient } from "../yahoo-finance";
import { mapCloudFinancials } from "../gloomberb-cloud/normalizers";
import { cacheRouterResource, listCachedResources } from "./cache";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";
import fixture from "../../test-support/fixtures/asml-earnings.json";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const policy = { staleMs: 3_600_000, expireMs: 604_800_000 };
const target = { symbol: "ASML", exchange: "AMS" };
const raw = () => structuredClone(fixture.provider.AMS) as unknown as TickerFinancials;
const eps = (value: TickerFinancials) => value.annualStatements.filter(row => ["2022-12-31", "2023-12-31"].includes(row.date)).map(row => row.eps);
afterEach(() => { setSystemTime(); removeTempDbFiles(); });

test("native optional SEC earnings retries an outage, shares concurrent acquisition, and leaves statement history unsupported", async () => {
  setSystemTime(NOW);
  const client = new YahooFinanceClient() as any;
  client.secClient.loadLookup = async () => new Map([["ASML", { cik: "0000937966", exchange: "NASDAQ" }]]);
  let calls = 0, failed = true;
  client.secClient.fetchJson = async () => { calls++; if (failed) throw new Error("SEC unavailable"); return fixture.companyfacts; };
  const request = async (symbol = "ASML") => withdrawKnownProviderStatements(
    await client.supplementSecStatements(symbol, "AMS", raw(), true), target, "provider:yahoo");
  const [a, b] = await Promise.all([request(), request("ASML.AS")]);
  expect(calls).toBe(1); expect(eps(a)).toEqual([undefined, undefined]); expect(eps(b)).toEqual(eps(a));
  expect(a.earningsHistoryRetryAt).toBe(NOW + 60_000);
  expect(a.statementHistory?.status).toBe("unsupported");
  expect(a.quarterlyStatements).toEqual(raw().quarterlyStatements);
  failed = false;
  expect(eps(await request())).toEqual([undefined, undefined]); expect(calls).toBe(1);
  setSystemTime(NOW + 60_001);
  const recovered = await request();
  expect(calls).toBe(2); expect(eps(recovered)).toEqual([14.13, 19.89]);
  expect(recovered.earningsHistoryRetryAt).toBeUndefined();
  expect(recovered.statementHistory?.status).toBe("unsupported");
  expect(eps(await request())).toEqual([14.13, 19.89]); expect(calls).toBe(2);
  const unrelated = await client.supplementSecStatements("OTHER", "AMS", raw(), true);
  expect(eps(unrelated)).toEqual([16.07, 20.59]); expect(calls).toBe(2);
});

test("native SEC rejects mismatched companyfacts issuer and retries only the optional acquisition", async () => {
  setSystemTime(NOW);
  const client = new YahooFinanceClient() as any;
  client.secClient.loadLookup = async () => new Map([["ASML", { cik: "0000937966", exchange: "NASDAQ" }]]);
  client.secClient.fetchJson = async () => ({ ...fixture.companyfacts, cik: 320193 });
  const value = await client.supplementSecStatements("ASML", "AMS", raw(), false);
  expect(value.earningsHistoryRetryAt).toBe(NOW + 60_000);
  expect(value.annualStatements).toEqual(raw().annualStatements);
  expect(value.statementHistory).toBeUndefined();
});

test("Cloud/native stored withdrawals stay stable and successful EPS recovery clears retry TTL after restart", () => {
  setSystemTime(NOW);
  const path = createTempDbPath("asml-earnings-cache");
  let store = new AppPersistence(path);
  try {
    for (const source of ["provider:yahoo", "provider:gloomberb-cloud"]) {
      const read = () => listCachedResources<TickerFinancials>(store.resources, "financials", "ASML", ["exchange=AMS"], [source], true)[0]!;
      cacheRouterResource(store.resources, "financials", "ASML", "exchange=AMS", source, raw(), policy);
      const first = read();
      expect(first.stale).toBe(true); expect(eps(first.value)).toEqual([undefined, undefined]);
      const stable = { ...first.value, earningsHistoryRetryAt: NOW + 60_000 };
      cacheRouterResource(store.resources, "financials", "ASML", "exchange=AMS", source, stable, policy);
      expect(read().stale).toBe(false); expect(read().staleAt).toBe(NOW + 60_000);
      expect(read().expiresAt).toBe(NOW + policy.expireMs);
      expect(read().value).toEqual(stable);
      store.close(); store = new AppPersistence(path);
      expect(read().value).toEqual(stable); expect(read().stale).toBe(false);
      setSystemTime(NOW + 60_001);
      expect(read().stale).toBe(true);
      const sourceRows = promoteReportedEarningsResults(raw().annualStatements, parseReportedEarningsCohorts(fixture.companyfacts, "0000937966"), "annual");
      const recovered = mapCloudFinancials({ ...raw(), annualStatements: sourceRows } as any, undefined, target);
      cacheRouterResource(store.resources, "financials", "ASML", "exchange=AMS", source, recovered, policy);
      expect(eps(read().value)).toEqual([14.13, 19.89]); expect(read().stale).toBe(false);
      expect(read().staleAt).toBe(NOW + 60_001 + policy.staleMs);
      expect(read().value.earningsHistoryRetryAt).toBeUndefined();
      setSystemTime(NOW);
    }
  } finally { store.close(); }
});


test("Cloud single and batch responses enforce identical listing-bound outage and source-recovery behavior", async () => {
  const single = apiClient.getCloudFinancials, batch = apiClient.getCloudFinancialsBatch;
  let ready = false;
  const data = (exchange: string | undefined) => {
    const value = structuredClone(fixture.provider[exchange === "AMS" ? "AMS" : "NASDAQ"]) as unknown as TickerFinancials;
    return { ...value, annualStatements: ready ? promoteReportedEarningsResults(value.annualStatements,
      parseReportedEarningsCohorts(fixture.companyfacts, "0000937966"), "annual") : value.annualStatements };
  };
  try {
    apiClient.getCloudFinancials = async (_, exchange) => ({ status: "success", data: data(exchange) }) as any;
    apiClient.getCloudFinancialsBatch = async requests => ({ status: "success", data: { items: requests.map(target => ({
      ...target, status: "success", data: data(target.exchange),
    })) } }) as any;
    const provider = new GloomberbCloudProvider();
    const targets = [{ symbol: "ASML", exchange: "AMS" }, { symbol: "ASML", exchange: "NASDAQ" }];
    for (ready of [false, true]) {
      const singles = await Promise.all(targets.map(target => provider.getTickerFinancials(target.symbol, target.exchange)));
      const batches = await provider.getTickerFinancialsBatch(targets);
      expect(batches.map(item => eps(item.financials!))).toEqual(singles.map(eps));
      expect(singles.map(eps)).toEqual(ready ? [[14.13, 19.89], [14.13, 19.89]] : [[undefined, undefined], [undefined, undefined]]);
      expect(batches.map(item => item.financials?.quote?.currency)).toEqual(["EUR", "USD"]);
    }
  } finally { apiClient.getCloudFinancials = single; apiClient.getCloudFinancialsBatch = batch; }
});


test("slow optional native filings leave provider statements usable and finish in the shared background request", async () => {
  const client = new YahooFinanceClient() as any;
  client.secClient.loadLookup = async () => new Map([["ASML", { cik: "0000937966", exchange: "NASDAQ" }]]);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  client.secClient.fetchJson = async () => { calls++; await pending; return fixture.companyfacts; };
  try {
    const partial = await client.supplementSecStatements("ASML", "AMS", raw(), false);
    expect(partial.annualStatements).toEqual(raw().annualStatements);
    expect(partial.earningsHistoryRetryAt).toBeGreaterThan(Date.now());
    expect(calls).toBe(1);
    finish(); await client.secClient.asmlEarningsPromise;
    const recovered = await client.supplementSecStatements("ASML", "AMS", raw(), false);
    expect(eps(recovered)).toEqual([14.13, 19.89]); expect(recovered.earningsHistoryRetryAt).toBeUndefined();
    expect(calls).toBe(1);
  } finally { finish(); await client.secClient.asmlEarningsPromise; }
});

test("native partial filings retain bounded prior evidence while rejecting an explicit same-accession contradiction", async () => {
  setSystemTime(NOW);
  const client = new YahooFinanceClient() as any;
  client.secClient.loadLookup = async () => new Map([["ASML", { cik: "0000937966", exchange: "NASDAQ" }]]);
  let payload: any = fixture.companyfacts;
  client.secClient.fetchJson = async () => payload;
  const load = () => client.secClient.getFinancialStatements("ASML", { reportedEarningsResults: true });
  expect((await load()).reportedEarningsResults).toHaveLength(6);
  payload = structuredClone(fixture.companyfacts);
  const entries = payload.facts["us-gaap"].EarningsPerShareBasic.units["EUR/shares"];
  const challenged = entries.find((entry: any) => entry.end === "2023-12-31");
  payload.facts["us-gaap"].EarningsPerShareBasic.units["EUR/shares"] = [
    ...entries.filter((entry: any) => entry.end === "2022-12-31"), challenged, { ...challenged, val: 999 },
  ];
  setSystemTime(NOW + 6 * 3_600_000 + 1);
  const partial = await load();
  expect(partial.reportedEarningsResults).toHaveLength(5);
  expect(partial.reportedEarningsResults.some((group: any) => group.endDate === "2023-12-31" && group.accessionNumber === challenged.accn)).toBe(false);
  expect(client.secClient.getEarningsHistoryRetryAt()).toBe(Date.now() + 60_000);
  const repaired = await client.supplementSecStatements("ASML", "AMS", raw(), false);
  expect(eps(repaired)).toEqual([14.13, 19.89]);
  setSystemTime(NOW + 24 * 3_600_000 + 1);
  const expired = await load();
  expect(expired.reportedEarningsResults).toHaveLength(3);
  expect(expired.reportedEarningsResults.every((group: any) => group.endDate === "2022-12-31")).toBe(true);
});
