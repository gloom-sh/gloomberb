import { expect, test } from "bun:test";
import type { FinancialStatement } from "../../types/financials";
import { AppPersistence } from "../../data/app-persistence";
import { mergeFinancialStatementRows } from "../../utils/financial-statements";
import { withdrawKnownProviderStatements } from "../../utils/statement-observations";
import { AssetDataRouter } from "./index";
import { cacheRouterResource } from "./cache";
import { createTestFinancials, createTestQuote, fallbackProvider } from "../../test-support/data-provider";

// O's Q4 2025 release p9 (USD thousands): consolidated301,636 minus
// NCI5,551 = parent/common296,085. The recorded TD adapter used consolidated
//301,636,000 as parent income. Provenance: quarterly-statement-revisions.md.
const target = { symbol: "O", exchange: "NYSE" };
const marker = "o-2025q4-parent-income";
const row: FinancialStatement = { date: "2025-12-31", currency: "USD", netIncome: 301_636_000,
  netIncomeCommonStockholders: 296_085_000, netIncomeIncludingNoncontrollingInterests: 301_636_000, eps: 0.32 };
const financials = () => createTestFinancials({ quote: createTestQuote({ symbol: "O", listingExchangeName: "NYSE", currency: "USD" }),
  profile: { description: "Realty Income" }, annualStatements: [], quarterlyStatements: [{ ...row }] });

test("O parent-income withdrawal survives wire metadata and sparse merges while preserving explicit income bases and EPS", () => {
  const wire: FinancialStatement = { date: row.date, currency: "USD", withdrawnObservations: [marker] };
  for (const [primary, fallback] of [[wire, row], [row, wire]]) {
    const merged = mergeFinancialStatementRows([primary!], [fallback!])[0]!;
    expect(merged.netIncome).toBeUndefined();
    expect(merged).toMatchObject({ netIncomeCommonStockholders: 296_085_000,
      netIncomeIncludingNoncontrollingInterests: 301_636_000, eps: 0.32, withdrawnObservations: [marker] });
    const corrected = mergeFinancialStatementRows([JSON.parse(JSON.stringify(merged))], [{ ...row, netIncome: 296_085_000 }])[0]!;
    expect(corrected.netIncome).toBe(296_085_000);
    expect(corrected.withdrawnObservations).toBeUndefined();
  }
});

test("fresh, batch and legacy cached O provider values cannot present consolidated income as parent income", async () => {
  const store = new AppPersistence(":memory:");
  try {
    const value = financials();
    const provider = { ...fallbackProvider, id: "gloomberb-cloud", getTickerFinancials: async () => value,
      getTickerFinancialsBatch: async (targets: typeof target[]) => targets.map(target => ({ target, financials: value })) };
    const router = new AssetDataRouter(provider, [], store.resources);
    cacheRouterResource(store.resources, "financials", "O", "exchange=NYSE", "provider:gloomberb-cloud", value,
      { staleMs: 60_000, expireMs: 600_000 });
    const cached = router.getCachedFinancialsForTargets([target]).get("O")!;
    const fresh = await router.getTickerFinancials("O", "NYSE", { cacheMode: "refresh" });
    const batch = (await router.getTickerFinancialsBatch([target], { forceRefresh: true }))[0]!.financials!;
    for (const result of [cached, fresh, batch]) {
      expect(result.quarterlyStatements[0]!.netIncome).toBeUndefined();
      expect(result.quarterlyStatements[0]!.withdrawnObservations).toContain(marker);
      expect(result.quarterlyStatements[0]!.netIncomeIncludingNoncontrollingInterests).toBe(301_636_000);
    }
  } finally { store.close(); }
});

test("the parent guard preserves other periods, listings, units, direct SEC facts and corrected observations", () => {
  const original = financials();
  for (const [value, request, source] of [
    [original, { ...target, exchange: "LSE" }, "provider:yahoo"],
    [original, target, "broker:account"],
    [{ ...original, quarterlyStatements: [{ ...row, date: "2024-12-31" }] }, target, "provider:yahoo"],
    [{ ...original, quarterlyStatements: [{ ...row, currency: "EUR" }] }, target, "provider:yahoo"],
    [{ ...original, quarterlyStatements: [{ ...row, netIncome: 296_085_000 }] }, target, "provider:yahoo"],
    [{ ...original, quarterlyStatements: [{ ...row, fieldSources: { netIncome: { source: "sec", concept: "NetIncomeLoss",
      basis: "parent", unit: "USD", endDate: row.date, filed: "2026-09-16", accessionNumber: "controlled-correction" } } }] }, target, "provider:yahoo"],
  ] as const) expect(withdrawKnownProviderStatements(value, request, source)).toBe(value);
});
