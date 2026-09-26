import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { cacheRouterResource, listCachedResources } from "./cache";
import { createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";
import { parseCompanyFactsFinancialStatements } from "../sec-edgar";
import { mergeFinancialStatementRows } from "../../utils/financial-statements";
import { buildYahooStatements } from "../yahoo-finance/financials";
import fixture from "../fixtures/sec-operating-expenses.json";

afterEach(removeTempDbFiles);

test("repaired SHOP operating ownership survives disk reopen and stale-first merges", () => {
  const path = createTempDbPath("operating-cohorts");
  let persistence = new AppPersistence(path);
  const policy = { staleMs: 60_000, expireMs: 120_000 };
  const key = { namespace: "market", kind: "financials", entityKey: "SHOP", variantKey: "exchange=NASDAQ", sourceKey: "provider:yahoo" };
  const vendor = buildYahooStatements({
    annualOperatingIncome: [{ asOfDate: "2025-12-31", currency: "USD", value: 1_885_000_000 }],
    annualOperatingExpense: [{ asOfDate: "2025-12-31", currency: "USD", value: 3_670_000_000 }],
    annualGrossProfit: [{ asOfDate: "2025-12-31", currency: "USD", value: 5_555_000_000 }],
    annualEBITDA: [{ asOfDate: "2025-12-31", currency: "USD", value: 1_916_000_000 }],
  }, "annual", true)[0]!;
  const direct = parseCompanyFactsFinancialStatements(fixture.shop).annualStatements;
  const old = createTestFinancials({ quote: createTestQuote({ symbol: "SHOP", exchangeName: "NASDAQ", currency: "USD" }),
    financialCurrency: "USD", annualStatements: [{ ...vendor, operatingResult: undefined }], quarterlyStatements: [] });
  const read = () => listCachedResources(persistence.resources, "financials", "SHOP", [key.variantKey], [key.sourceKey], true);
  const corrected = { ...old, annualStatements: mergeFinancialStatementRows([vendor], direct) };
  cacheRouterResource(persistence.resources, "financials", "SHOP", key.variantKey, key.sourceKey, corrected, policy);
  persistence.close();
  persistence = new AppPersistence(path);
  const hydrated = read()[0]!.value as typeof corrected;
  expect(hydrated.annualStatements[0]!.operatingIncome).toBe(1_468_000_000);
  expect(hydrated.annualStatements[0]!.ebitda).toBe(1_916_000_000);
  expect(hydrated.annualStatements[0]!.operatingResult).toEqual(corrected.annualStatements[0]!.operatingResult);
  const staleFirst = mergeFinancialStatementRows(old.annualStatements, hydrated.annualStatements)[0]!;
  expect(staleFirst.operatingIncome).toBe(1_468_000_000);
  expect(staleFirst.operatingResult?.provider?.ebitda).toBeUndefined();
  persistence.close();
});
