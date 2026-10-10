import { expect, test } from "bun:test";
import type { apiClient } from "../../../api-client";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { Quote } from "../../../types/financials";
import { companyHeadless } from "./headless";
import { guidancePayload, kpisPayload } from "./test-fixture";

test("headless request preserves publication cutoff and every evidence field while reporting preview limits", async () => {
  const requests: unknown[] = [];
  const payload = kpisPayload({ access: "preview", truncated: true, lockedRows: 5, totalRows: 6, previewRows: 3 });
  const client = { getCloudCompanyKpis: async (symbol: string, options: unknown) => { requests.push({ symbol, options }); return payload; },
    getCloudCompanyGuidance: async () => guidancePayload() } as unknown as typeof apiClient;
  const result = await companyHeadless("kpis").load(createTestHeadlessArgs({ symbols: [payload.symbol], options: { metric: "arr", asOf: "2026-09-30", from: "2026-01-01", basis: "reported", tab: "chart" } }), createTestHeadlessContext({ apiClient: client }));
  expect(requests).toEqual([{ symbol: payload.symbol, options: { metric: "arr", basis: "reported", from: "2026-01-01", asOf: "2026-09-30" } }]);
  expect(result.complete).toBe(false);
  expect(result.metadata).toMatchObject({ access: "preview", lockedRows: 5 });
  expect(result.sections[0]?.rows?.[0]).toMatchObject({ currency: "GBP", evidence: [{ quote: payload.series[0]!.latest.evidence[0]!.quote, quoteOffset: 0, quoteMatchMode: "exact" }] });
});

test("a report on a listing abroad names the saved venue and the company from that listing's own quote", async () => {
  const listings: unknown[] = [];
  const client = { getCloudCompanyKpis: async (_symbol: string, _options: unknown, listing: unknown) => { listings.push(listing); return kpisPayload({ symbol: "AI" }); },
    getCloudCompanyGuidance: async () => guidancePayload() } as unknown as typeof apiClient;
  const report = (quote: Partial<Quote>) => companyHeadless("kpis").load(createTestHeadlessArgs({ symbols: ["AI"] }), createTestHeadlessContext({
    apiClient: client, resolveInstrument: async (symbol) => ({ symbol, exchange: "XPAR" }),
    marketData: createTestDataProvider({ getQuote: async () => createTestQuote({ symbol: "AI", name: "Air Liquide S.A.", ...quote }) }),
  }));
  await report({ listingExchangeName: "PAR" });
  // A quote that prices another venue names another listing's company.
  await report({ exchangeName: "NYSE" });
  expect(listings).toEqual([{ exchange: "EPA", name: "Air Liquide S.A." }, { exchange: "EPA" }]);
});
