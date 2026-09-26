import { expect, test } from "bun:test";
import type { IncomeStatementSource } from "../../types/financials";
import { AppPersistence } from "../../data/app-persistence";
import { parseCompanyFactsFinancialStatements } from "../sec-edgar";
import { deriveQuarterlyStatements } from "../../time-series/fundamentals";
import { computeTTM } from "../../plugins/builtin/ticker-detail/financials/aggregation";
import { mergeFinancialStatementRows } from "../../utils/financial-statements";
import { redactWithdrawnStatement, withdrawKnownProviderStatements } from "../../utils/statement-observations";
import { AssetDataRouter } from "./index";
import { cacheRouterResource, listCachedResources } from "./cache";
import { createTestFinancials, createTestQuote, fallbackProvider } from "../../test-support/data-provider";
import fixture from "./fixtures/quarterly-source-disagreements.json";

const target = { symbol: "BAC", exchange: "NYSE" };
const policy = { staleMs: 60_000, expireMs: 600_000 };
const q4 = <T extends { date: string }>(rows: T[]) => rows.find(row => row.date === "2025-12-31")!;
const captured = (symbol: "BAC" | "O" = "BAC") => createTestFinancials({ ...fixture.issuers[symbol].financials,
  quote: createTestQuote({ symbol, listingExchangeName: "NYSE", currency: "USD", providerId: "gloomberb-cloud" }),
  profile: { description: "Recorded issuer" },
});

test("BAC operating-revenue conflict cannot return through legacy caches or sparse merges", () => {
  const raw = captured();
  raw.quarterlyStatements = raw.quarterlyStatements.map(row => row.date === "2025-12-31"
    ? { ...row, operatingRevenue: 31_180_000_000, normalizedIncome: 7_528_000_000 } : row);
  const clean = withdrawKnownProviderStatements(raw, target, "provider:gloomberb-cloud");
  const quarter = q4(clean.quarterlyStatements);
  expect(quarter.operatingRevenue).toBeUndefined();
  expect(quarter.withdrawnObservations).toContain("bac-2025q4-operating-revenue");
  expect(quarter.normalizedIncome).toBe(7_528_000_000); // Different, unverified definition.
  for (const rows of [
    mergeFinancialStatementRows(clean.quarterlyStatements, raw.quarterlyStatements),
    mergeFinancialStatementRows(raw.quarterlyStatements, clean.quarterlyStatements),
  ]) {
    expect(q4(JSON.parse(JSON.stringify(rows))).operatingRevenue).toBeUndefined();
    expect(computeTTM(rows)?.operatingRevenue).toBeUndefined();
  }
  const store = new AppPersistence(":memory:");
  try {
    cacheRouterResource(store.resources, "financials", "BAC", "exchange=NYSE", "provider:gloomberb-cloud", raw, policy);
    const cached = listCachedResources<typeof raw>(store.resources, "financials", "BAC", ["exchange=NYSE"], ["provider:gloomberb-cloud"], true)[0]!;
    expect(q4(cached.value.quarterlyStatements).operatingRevenue).toBeUndefined();
  } finally { store.close(); }
  const restored = q4(mergeFinancialStatementRows(clean.quarterlyStatements,
    [{ date: "2025-12-31", currency: "USD", operatingRevenue: 28_367_000_000 }]));
  expect(restored.operatingRevenue).toBe(28_367_000_000);
  expect(restored.withdrawnObservations).not.toContain("bac-2025q4-operating-revenue");
  for (const [value, request, source] of [
    [raw, { ...target, exchange: "LSE" }, "provider:yahoo"],
    [raw, { ...target, symbol: "JPM" }, "provider:yahoo"],
    [raw, target, "broker:account"],
    [{ ...raw, quarterlyStatements: raw.quarterlyStatements.map(row => ({ ...row, currency: "CAD" })) }, target, "provider:yahoo"],
    [{ ...raw, annualStatements: [], quarterlyStatements: [{ ...q4(raw.quarterlyStatements), date: "2025-09-30" }] }, target, "provider:yahoo"],
  ] as const) expect(withdrawKnownProviderStatements(value, request, source)).toBe(value);
  expect(clean.annualStatements).toBe(raw.annualStatements);
});

test("recorded quarter conflicts survive both sparse merge orders and JSON without erasing corroborated O income", () => {
  for (const symbol of ["BAC", "O"] as const) {
    const raw = captured(symbol);
    const value = withdrawKnownProviderStatements(raw, { ...target, symbol }, "provider:gloomberb-cloud");
    expect(q4(value.quarterlyStatements).totalRevenue).toBeUndefined();
    if (symbol === "BAC") {
      for (const field of ["netIncome", "netIncomeCommonStockholders", "pretaxIncome", "taxProvision"] as const) expect(q4(value.quarterlyStatements)[field]).toBeUndefined();
    } else {
      expect(q4(value.quarterlyStatements).netIncome).toBe(296_085_000);
      expect(q4(value.quarterlyStatements).taxProvision).toBe(21_800_000);
    }
    for (const primary of [true, false]) {
      const rows = mergeFinancialStatementRows(primary ? value.quarterlyStatements : raw.quarterlyStatements, primary ? raw.quarterlyStatements : value.quarterlyStatements);
      expect(q4(JSON.parse(JSON.stringify(rows))).totalRevenue).toBeUndefined();
      expect(computeTTM(rows)?.totalRevenue).toBeUndefined();
    }
    expect(withdrawKnownProviderStatements(value, { ...target, symbol }, "provider:gloomberb-cloud")).toBe(value);
  }
});

test("actual SEC projection cannot recreate the known mixed-revision BAC quarter, but reported corrections restore it", () => {
  const parsed = parseCompanyFactsFinancialStatements(fixture.issuers.BAC.companyfacts);
  const derived = deriveQuarterlyStatements(parsed.quarterlyStatements, parsed.annualStatements);
  const gap = q4(derived);
  expect(gap.totalRevenue).toBeUndefined(); expect(gap.netIncome).toBeUndefined(); expect(gap.netIncomeCommonStockholders).toBeUndefined();
  expect(gap.withdrawnObservations?.length).toBe(3);
  const neighbor = { date: "2025-12-30", currency: "USD", totalAssets: 500, availableAt: "2026-06-01" };
  for (const rows of [[...parsed.quarterlyStatements, neighbor], mergeFinancialStatementRows([neighbor], parsed.quarterlyStatements)]) {
    const withNeighbor = deriveQuarterlyStatements(rows, parsed.annualStatements);
    expect(q4(withNeighbor).totalRevenue).toBeUndefined();
    expect(q4(withNeighbor).withdrawnObservations?.length).toBe(3);
    expect(withNeighbor.find(row => row.date === neighbor.date)?.withdrawnObservations).toBeUndefined();
  }
  const corrected = { date: "2025-12-31", currency: "USD", totalRevenue: 28_367_000_000, netIncome: 7_647_000_000, netIncomeCommonStockholders: 7_319_000_000 };
  const restored = q4(mergeFinancialStatementRows(derived, [corrected]));
  expect(restored).toMatchObject(corrected); expect(restored.withdrawnObservations).toBeUndefined();
  expect(q4(deriveQuarterlyStatements([...parsed.quarterlyStatements.filter(row => row.date !== corrected.date), corrected], parsed.annualStatements))).toMatchObject(corrected);
});

test("fresh, legacy cached and batch-only statement observations are withdrawn and a later correction is cached without a refresh loop", async () => {
  const store = new AppPersistence(":memory:");
  try {
    let value = captured();
    const provider = { ...fallbackProvider, id: "gloomberb-cloud", getTickerFinancials: async () => value,
      getTickerFinancialsBatch: async (targets: typeof target[]) => targets.map(target => ({ target, financials: value })),
    };
    const router = new AssetDataRouter(provider, [], store.resources);
    cacheRouterResource(store.resources, "financials", target.symbol, "exchange=NYSE", "provider:gloomberb-cloud", value, policy);
    expect(q4(router.getCachedFinancialsForTargets([target]).get("BAC")!.quarterlyStatements).totalRevenue).toBeUndefined();
    cacheRouterResource(store.resources, "financials", "contract:12345", "exchange=NYSE", "provider:gloomberb-cloud", value, policy);
    expect(q4(listCachedResources<typeof value>(store.resources, "financials", "contract:12345", ["exchange=NYSE"], ["provider:gloomberb-cloud"], true)[0]!.value.quarterlyStatements).totalRevenue).toBeUndefined();
    expect(q4((await router.getTickerFinancials("BAC", "NYSE", { cacheMode: "refresh" })).quarterlyStatements).netIncome).toBeUndefined();
    expect(q4((await router.getTickerFinancialsBatch([target], { forceRefresh: true }))[0]!.financials!.quarterlyStatements).taxProvision).toBeUndefined();
    const clean = withdrawKnownProviderStatements(value, target, "provider:gloomberb-cloud");
    cacheRouterResource(store.resources, "financials", "BAC", "exchange=NYSE", "provider:gloomberb-cloud", clean, policy);
    expect(listCachedResources(store.resources, "financials", "BAC", ["exchange=NYSE"], ["provider:gloomberb-cloud"], true)[0]!.stale).toBe(false);
    value = { ...value, quarterlyStatements: value.quarterlyStatements.map(row => row.date === "2025-12-31" ? { ...row,
      totalRevenue: 28_367_000_000, netIncome: 7_647_000_000, netIncomeCommonStockholders: 7_319_000_000,
      pretaxIncome: 9_622_000_000, taxProvision: 1_975_000_000 } : row) };
    const corrected = await router.getTickerFinancials("BAC", "NYSE", { cacheMode: "refresh" });
    expect(q4(corrected.quarterlyStatements).totalRevenue).toBe(28_367_000_000);
    expect(q4(corrected.quarterlyStatements).withdrawnObservations).toBeUndefined();
  } finally { store.close(); }
});

test("withdrawals require source, listing, reporting currency and quarter; malformed metadata cannot erase other observations", () => {
  const raw = captured();
  for (const [value, request, source] of [
    [raw, { ...target, exchange: "LSE" }, "provider:yahoo"],
    [raw, { ...target, symbol: "OTHER" }, "provider:yahoo"],
    [raw, target, "broker:account"],
    [{ ...raw, quoteMetadata: { symbol: "JPM", listingExchangeName: "NYSE" } }, target, "provider:yahoo"],
    [{ ...raw, quarterlyStatements: raw.quarterlyStatements.map(row => ({ ...row, currency: "GBP" })) }, target, "provider:yahoo"],
  ] as const) expect(withdrawKnownProviderStatements(value, request, source)).toBe(value);
  const row = q4(raw.quarterlyStatements);
  for (const metadata of ["bac-2025q4-revenue", ["unknown"], [null], {}]) {
    expect(redactWithdrawnStatement({ ...row, withdrawnObservations: metadata as any }).totalRevenue).toBe(row.totalRevenue);
  }
  expect(redactWithdrawnStatement({ ...row, date: "2024-12-31", withdrawnObservations: ["bac-2025q4-revenue"] }).totalRevenue).toBe(row.totalRevenue);
});

test("direct SEC income that matches a rejected vendor number stays stable through repeated withdrawals and cache reads", () => {
  const evidence: IncomeStatementSource = { source: "sec", concept: "NetIncomeLoss", basis: "parent", unit: "USD",
    startDate: "2025-10-01", endDate: "2025-12-31", filed: "2026-02-25", accessionNumber: "controlled-direct-fact" };
  const raw = captured();
  raw.quarterlyStatements = raw.quarterlyStatements.map(row => row.date === evidence.endDate
    ? { ...row, fieldSources: { netIncome: evidence } } : row);
  const cleaned = withdrawKnownProviderStatements(raw, target, "provider:gloomberb-cloud");
  const row = q4(cleaned.quarterlyStatements);
  expect(row.netIncome).toBe(7_528_000_000);
  expect(row.fieldSources?.netIncome).toEqual(evidence);
  expect(row.withdrawnObservations).toEqual(["bac-2025q4-revenue", "bac-2025q4-common-income", "bac-2025q4-pretax", "bac-2025q4-tax"]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const repeated = withdrawKnownProviderStatements(cleaned, target, "provider:gloomberb-cloud");
    expect(repeated).toBe(cleaned);
    expect(q4(repeated.quarterlyStatements)).toBe(row);
  }
  const store = new AppPersistence(":memory:");
  try {
    cacheRouterResource(store.resources, "financials", "BAC", "exchange=NYSE", "provider:gloomberb-cloud", cleaned, policy);
    const record = listCachedResources<typeof cleaned>(store.resources, "financials", "BAC", ["exchange=NYSE"], ["provider:gloomberb-cloud"], true)[0]!;
    expect(record.stale).toBe(false);
    expect(q4(record.value.quarterlyStatements).fieldSources?.netIncome).toEqual(evidence);
  } finally { store.close(); }
});
