import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import type { SupplyEvidenceItem } from "../../../api-client/supply-chain";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { cachedSupplyChain, loadSupplyChain, supplyChainCache, validateSupplyChain } from "./client";
import { flowBands, flowGroups, percentage, shareParts } from "./model";
import { supplyPayload, supplyRow } from "./test-fixture";
import { matchesSupplyOptions, supplyOptions } from "./trust";
import { supplyChainHeadless } from "./headless";
import { supplyScreenshotEvidence } from "./evidence";

const evidence = (overrides: Partial<SupplyEvidenceItem> = {}): SupplyEvidenceItem => ({ id: "news:1", tier: 4, claimType: "reported", url: "https://example.com/story", title: "A customer relationship", publisher: "Publisher", publishedAt: "2026-09-28T10:00:00Z", fetchedAt: "2026-09-28T10:30:00Z", quote: "Private source quote", quoteRights: "link_only", textOrigin: "publisher_text", quoteLanguage: "zh", englishGloss: "Private translated quote", originKey: "outlet:publisher:1", confidence: .9, status: "active", valueKind: null, value: null, valueUnit: null, currency: null, ...overrides });
afterEach(() => { setCloudApiFetchTransport(null); supplyChainCache.reset(); });

test("restricted and snippet evidence is stripped before storage, including row quote and gloss", async () => {
  supplyChainCache.attach(new MemoryPluginPersistence());
  for (const item of [evidence(), evidence({ quoteRights: "short", textOrigin: "snippet" })]) {
    const data = supplyPayload({ says: [supplyRow("restricted", { tier: 4, quote: "Private source quote", quoteGloss: "Private row translation", evidence: [item] })] });
    setCloudApiFetchTransport(async () => Response.json(data));
    const loaded = await loadSupplyChain("FOCUS", "alice:full", true);
    expect(loaded.payload.says[0]?.quote).toBe("");
    expect(loaded.payload.says[0]?.quoteGloss).toBeNull();
    expect(loaded.payload.says[0]?.pctOfRevenue).toBeNull();
    expect(JSON.stringify(cachedSupplyChain("FOCUS", "alice:full"))).not.toContain("Private");
    expect(loaded.payload.says[0]?.evidence?.[0]?.url).toBe(item.url);
  }
  const leadOptions = supplyOptions("unconfirmed");
  for (const leadStatus of ["lead", "stale", "rejected"] as const) {
    const filedLead = supplyRow("filed-lead", { tier: 1, leadStatus, usd: 42, usdBasis: "disclosed", nativeAmount: 5, nativeCurrency: "KRW", nativeScale: 1_000_000,
      lastConfirmedAt: "2026-09-28T10:00:00Z", evidence: [evidence({ tier: 1, quoteRights: "full", value: 42, valueKind: "investment", currency: "USD" })] });
    setCloudApiFetchTransport(async () => Response.json(supplyPayload({ says: [filedLead] })));
    await loadSupplyChain("FOCUS", "alice:full", true, leadOptions);
    const cachedLead = cachedSupplyChain("FOCUS", "alice:full", leadOptions)?.payload.says[0];
    expect(cachedLead).toMatchObject({ pctOfRevenue: null, pctBasis: null, pctScope: null, usd: null, usdBasis: null,
      nativeAmount: null, nativeCurrency: null, nativeScale: null, lastConfirmedAt: null });
    const leadReport = await supplyChainHeadless.load(createTestHeadlessArgs({ symbols: ["FOCUS"], options: { tiers: "unconfirmed" } }), createTestHeadlessContext({ apiClient }));
    if (leadStatus === "lead") expect(leadReport.sections[0]?.rows?.[0]).toMatchObject({ pct: null, usd: null,
      nativeAmount: null, nativeCurrency: null, nativeScale: null, lastConfirmedAt: null });
    else expect(leadReport.sections).toEqual([]);
    expect(cachedLead?.evidence?.[0]?.value).toBe(42);
  }
  const publicItem = evidence({ tier: 1, quoteRights: "short", claimType: "disclosed", quote: "公開來源原文", quoteLanguage: "zh",
    englishGloss: "Public source translation" });
  const clear = validateSupplyChain(supplyPayload({ says: [supplyRow("clear", { quoteLanguage: "ko", quoteGloss: "Previous row translation",
    evidence: [evidence({ id: "old", status: "superseded" }), publicItem] })] }));
  expect(clear.says[0]).toMatchObject({ quote: publicItem.quote, quoteLanguage: publicItem.quoteLanguage, quoteGloss: publicItem.englishGloss });
  const legacy = supplyPayload({ says: [supplyRow("legacy", { evidence: [] })] });
  expect(validateSupplyChain(validateSupplyChain(legacy))).toEqual(legacy);
});

test("tier filters exclude leads by default and isolate all leads behind explicit Unconfirmed", () => {
  const reported = supplyRow("reported", { tier: 4, corroboration: 2 });
  const lead = supplyRow("lead", { tier: 4, leadStatus: "lead" });
  const rumor = supplyRow("rumor", { tier: 6, claimType: "rumored" });
  expect(matchesSupplyOptions(reported, supplyOptions())).toBe(false);
  expect(matchesSupplyOptions(reported, supplyOptions("reported"))).toBe(true);
  expect(matchesSupplyOptions(lead, supplyOptions("reported"))).toBe(false);
  for (const row of [lead, rumor]) expect(matchesSupplyOptions(row, supplyOptions("unconfirmed"))).toBe(true);
  expect(matchesSupplyOptions(lead, supplyOptions([]))).toBe(false);
  expect(matchesSupplyOptions({ ...lead, leadStatus: "stale" }, supplyOptions("unconfirmed"))).toBe(false);
  expect(() => supplyOptions("company,bogus")).toThrow("Evidence tiers");
});

test("confirmed filing concentrations alone set ribbon widths and unconfirmed never becomes a node", () => {
  const rows = [supplyRow("filing", { pctOfRevenue: 20 }), supplyRow("company", { tier: 2, pctOfRevenue: 90, usd: 1e12 }),
    supplyRow("reported", { tier: 4, pctOfRevenue: 95 }), supplyRow("lead", { tier: 4, leadStatus: "lead" }), supplyRow("rumor", { tier: 6 })];
  const nodes = flowBands(rows, 8, {}, "FOCUS").customers;
  expect(nodes.map((node) => node.id)).not.toContain("lead");
  expect(nodes.map((node) => node.id)).not.toContain("rumor");
  expect(nodes.find((node) => node.id === "filing")?.weight).toBe(1);
  expect(nodes.filter((node) => node.id !== "filing").every((node) => node.weight === null)).toBe(true);
  for (const row of rows.slice(1)) {
    expect(shareParts(row, "FOCUS")).toBeNull();
    expect(percentage(row)).toBe("--");
  }
  const primary = rows[0]!;
  const newerReport = { ...primary, id: "newer-report", tier: 4 as const, asOf: "2026-10-04" };
  expect(flowBands([newerReport, primary], 8, {}, "FOCUS").customers.map((node) => node.id)).toEqual(["filing"]);
  const aggregateLead = { ...rows[3]!, counterparty: { ...rows[3]!.counterparty, aggregate: true } };
  expect(flowGroups([aggregateLead])).toEqual([]);
});

test("request and cache identity preserve tier selection without crossing accounts or preview access", async () => {
  supplyChainCache.attach(new MemoryPluginPersistence());
  const urls: string[] = [];
  setCloudApiFetchTransport(async (request) => { urls.push(String(request)); return Response.json(supplyPayload()); });
  const options = supplyOptions("unconfirmed,company");
  await loadSupplyChain("NVDA", "alice:full", false, options);
  expect(urls[0]).toContain("tiers=company%2Cunconfirmed&includeLeads=1");
  expect(cachedSupplyChain("NVDA", "alice:full", supplyOptions("company,unconfirmed"))).not.toBeNull();
  expect(cachedSupplyChain("NVDA", "alice:full")).toBeNull();
  expect(cachedSupplyChain("NVDA", "alice:preview", options)).toBeNull();
  expect(cachedSupplyChain("NVDA", "bob:full", options)).toBeNull();
});

test("headless and screenshot boundaries retain public provenance and separate opted-in leads", async () => {
  const data = supplyPayload({ says: [supplyRow("confirmed"), supplyRow("lead", { tier: 4, leadStatus: "lead", quoteGloss: "Private row translation",
    nativeAmount: 5, nativeCurrency: "KRW", nativeScale: 1_000_000, evidence: [evidence()] })], totalRows: 2 });
  data.counts.says.customer = 2;
  setCloudApiFetchTransport(async () => Response.json(data));
  const args = createTestHeadlessArgs({ symbols: ["FOCUS"], options: { tiers: "sec,unconfirmed" } });
  const result = await supplyChainHeadless.load(args, createTestHeadlessContext({ apiClient }));
  expect(result.sections.map((section) => section.title)).toEqual(["FOCUS says", "FOCUS says | Unconfirmed"]);
  expect(JSON.stringify(result)).not.toContain("Private");
  expect(result.sections[1]?.rows?.[0]).toMatchObject({ quoteGloss: null, quoteGlossKind: null, nativeAmount: null, nativeCurrency: null, nativeScale: null });
  expect(result.sections[1]?.rows?.[0]?.evidence).toEqual([{ ...evidence(), quote: null, englishGloss: null }]);
  const rendered = { kind: "supply-chain", version: 1, complete: true, plottedValueCount: 2, payload: data, tab: "table", view: "says", rowIds: ["confirmed", "lead"], evidenceId: "lead", tiers: ["sec", "unconfirmed"] };
  const screenshot = supplyScreenshotEvidence.read(rendered);
  expect(screenshot?.payload.says[1]).toMatchObject({ quoteGloss: null, nativeAmount: null, nativeCurrency: null, nativeScale: null });
  expect(JSON.stringify(screenshot)).not.toContain("Private");
  expect(supplyScreenshotEvidence.read({ ...rendered, tab: "flow" })).toBeNull();
});
