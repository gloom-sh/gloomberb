import { expect, test } from "bun:test";
import type { apiClient } from "../../../api-client";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { Quote } from "../../../types/financials";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { companyHeadless } from "./headless";
import { guidancePayload, kpisPayload, observation } from "./test-fixture";

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

test("a metric the free preview does not have says so and names the ones it has, never another metric's rows", async () => {
  const requests: unknown[] = [];
  const backlog = { ...observation().metric, id: "backlog", name: "Order backlog" };
  // The preview ignores the metric it was asked for and answers with its fixed rows.
  const payload = kpisPayload({ access: "preview", truncated: true, lockedRows: 2, totalRows: 3, dictionary: [observation().metric, backlog] });
  const client = { getCloudCompanyKpis: async (_symbol: string, options: unknown) => { requests.push(options); return payload; } } as unknown as typeof apiClient;
  const load = (metric: string) => companyHeadless("kpis").load(createTestHeadlessArgs({ symbols: [payload.symbol], options: { metric } }), createTestHeadlessContext({ apiClient: client }));
  const missing = await load("backlog");
  expect(missing.sections.every((section) => section.rows?.length === 0)).toBe(true);
  expect(missing.sections[0]).toMatchObject({ empty: expect.stringMatching(/no Order backlog \(backlog\).*arr \(Annual recurring revenue\)/) });
  await expect(load("backlgo")).rejects.toThrow(/backlgo is not a known metric id.*arr \(Annual recurring revenue\)/);
  // A name is not an id the server takes, so it is not sent.
  await expect(load("net sales")).rejects.toThrow("not a known metric id");
  expect(requests).toEqual([{ metric: "backlog" }, { metric: "backlgo" }, {}]);
});

test("the text report prints the pane's fiscal labels and compact values and says how old a preview is; exports keep the whole number", async () => {
  const latest = observation({ asOf: "2025-02-01T00:00:00Z" });
  const payload = kpisPayload({ access: "preview", truncated: true, lockedRows: 2, totalRows: 3, asOf: "2026-08-05T12:00:00Z",
    series: [{ ...kpisPayload().series[0]!, latest, observations: [latest] }] });
  const definition = companyHeadless("kpis");
  const args = createTestHeadlessArgs({ symbols: [payload.symbol], options: {} });
  const result = await definition.load(args, createTestHeadlessContext({ apiClient: { getCloudCompanyKpis: async () => payload } as unknown as typeof apiClient }));
  const freshness = deriveHeadlessFreshness(definition, result);
  const text = renderHeadlessPaneText(definition, result, args, "KPIS", freshness);
  expect(text).toContain("Q2 FY2026");
  expect(text).toContain("125.00M GBP");
  expect(text).not.toContain("{");
  expect(result.notes).toEqual([expect.stringContaining("as of 2025-02-01")]);
  const csv = renderReportCsv(headlessReportTables(definition, result, args, "KPIS", freshness, { complete: false, unavailableSymbols: [] }));
  expect(csv).toContain("125000000");
  expect(result.sections[0]?.rows?.[0]).toEqual({ ...latest });
});
