import { describe, expect, test } from "bun:test";
import { CloudDataApi } from "../../../api-client/data";
import { DEFAULT_GRAPH_OPTIONS, type GraphEvidence, type GraphPayload } from "../../../api-client/supply-chain-graph";
import { capabilityPaneSettings, getPaneFunctionCapability, normalizeCapabilityOptions } from "../../../cli/pane-functions/capabilities";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext, PaneDef } from "../../../types/plugin";
import { graphOptions, validateGraph } from "./graph-client";
import { graphEvidenceRow } from "./graph-evidence";
import { supplyScreenshotEvidence } from "./evidence";
import { supplyChainHeadless } from "./headless";
import { entity, supplyPayload, supplyRow } from "./test-fixture";

function graphPayload(): GraphPayload {
  const a = entity("A"), b = entity("B"), c = entity("C");
  const disclosure = (id: string, from: typeof a, to: typeof a, pct: number): GraphEvidence => ({
    id, fromEntity: from.id, toEntity: to.id, reportingEntity: from.id, from, to, reporter: from,
    role: "customer", sourceKind: "filing_text", tier: "primary", jurisdiction: "US",
    filingUrl: `https://www.sec.gov/Archives/${id}.htm`, filedDate: "2026-02-25", period: "2025-12-31", asOf: "2025-12-31",
    pctOfRevenue: pct, pctBasis: "revenue", confidence: .95, quote: `${to.name} represented ${pct}% of our revenue.`, quoteMatchMode: "exact",
  });
  const evidence = [disclosure("e1", a, b, 20), disclosure("e2", b, c, 30)];
  const links = evidence.map(item => ({ id: `link-${item.id}`, from: item.from.id, to: item.to.id, relationship: "commerce" as const,
    evidence: [item], primaryEvidenceId: item.id, confidence: item.confidence, weight: item.confidence * item.pctOfRevenue! / 100 }));
  const path = { id: "downstream|link-e1|link-e2", nodeIds: [a.id, b.id, c.id], linkIds: links.map(link => link.id), hops: 2,
    score: links[0]!.weight * links[1]!.weight, confidence: .9025,
    exposure: { pct: 6, basis: "revenue" as const, period: "2025-12-31", denominatorEntityId: a.id, estimated: true as const } };
  return { symbol: "A", entity: a, target: null, status: "available", nodes: [a, b, c], links,
    upstream: [], downstream: [{ entityId: c.id, direction: "downstream", hops: 2, bestPath: path, shortestPath: path }], related: [], paths: [],
    options: { ...DEFAULT_GRAPH_OPTIONS }, requestedDepth: 2, access: "full", maxDepth: 4, truncated: false,
    search: { complete: true, reasons: [], exploredStates: 3, maxStates: 50000 }, asOf: "2025-12-31", snapshotAt: "2026-10-04T09:00:00Z",
    methodology: "Scores rank routes, not probabilities. Chained percentages are estimates.",
  };
}
const args = (options: Record<string, string | number | boolean>) => createTestHeadlessArgs({ rawArgument: "A", argument: "A", symbols: ["A"], options });
const context = (payload: GraphPayload, requests: string[]) => createTestHeadlessContext({
  apiClient: new CloudDataApi(async <T>(path: string) => { requests.push(path); return payload as T; }) as unknown as HeadlessPaneContext["apiClient"],
});

describe("supply chain graph headless integration", () => {
  test("CLI filters preserve validated values through settings and the graph request", async () => {
    const capability = getPaneFunctionCapability(undefined, { id: "supply-chain", name: "Supply Chain", headless: supplyChainHeadless } as PaneDef);
    const options = normalizeCapabilityOptions(capability, { tab: "graph", depth: "3", direction: "upstream", roles: "supplier", sources: "xbrl,filing_text",
      tiers: "structured,primary", "min-pct": "2.5", "min-confidence": "0.85", limit: "12", "as-of": "2025-12-31", ranking: "shortest" }, { strict: true });
    expect(graphOptions(capabilityPaneSettings(capability, options))).toEqual(graphOptions(options));
    const requests: string[] = [];
    await supplyChainHeadless.load(args(options), context(graphPayload(), requests));
    const url = new URL(requests[0]!, "https://example.test");
    expect(url.pathname).toBe("/cloud/supply-chain/A/graph");
    expect(Object.fromEntries(url.searchParams)).toEqual({ depth: "3", direction: "upstream", roles: "supplier", sources: "xbrl,filing_text",
      tiers: "structured,primary", minPct: "2.5", minConfidence: "0.85", limit: "12", ranking: "shortest", asOf: "2025-12-31" });
    expect(() => normalizeCapabilityOptions(capability, { depth: "5" }, { strict: true })).toThrow();
    expect(() => normalizeCapabilityOptions(capability, { limit: "1.5" }, { strict: true })).toThrow();
    const invalidFilters: Record<string, string>[] = [{ "min-pct": "101" }, { "min-confidence": "NaN" }, { tiers: "unknown" }, { "as-of": "2025-02-29" }];
    for (const invalid of invalidFilters) {
      await expect(supplyChainHeadless.load(args({ tab: "graph", ...invalid }), context(graphPayload(), requests))).rejects.toThrow("Invalid supply chain graph filters");
    }
    expect(requests).toHaveLength(1);
  });

  test("reports retain every hop and exposure denominator without turning the rank into probability", async () => {
    const payload = graphPayload();
    const report = await supplyChainHeadless.load(args({ tab: "graph" }), context(payload, []));
    expect(report.complete).toBe(true);
    const row = report.sections[1]!.rows![0]!;
    expect(row.route).toBe("A → B → C");
    expect(row.exposureLabel).toBe("6% est. of A revenue");
    expect(row.exposure).toEqual({ ...payload.downstream[0]!.bestPath.exposure, denominatorEntity: payload.entity });
    expect(row.evidence).toMatchObject([
      { hop: 1, primaryEvidenceId: "e1", disclosures: [{ quote: "B represented 20% of our revenue." }] },
      { hop: 2, primaryEvidenceId: "e2", disclosures: [{ filingUrl: "https://www.sec.gov/Archives/e2.htm" }] },
    ]);
    expect(report.sections[3]!.rows).toHaveLength(2);
    expect(report.metadata?.graph).toEqual(validateGraph(payload));
    expect(row.score).toBe(payload.downstream[0]!.bestPath.score);
  });

  test("target searches return routes for Graph and Path, preserve identity encoding, and require a Path target", async () => {
    const payload = graphPayload();
    payload.target = payload.nodes[2]!;
    payload.paths = [payload.downstream[0]!.bestPath];
    payload.downstream = [];
    const requests: string[] = [];
    for (const tab of ["graph", "path"]) {
      const report = await supplyChainHeadless.load(args({ tab, to: "2330:TWSE", depth: 4 }), context(payload, requests));
      expect(report.sections[0]!.rows![0]!.route).toBe("A → B → C");
      expect(report.complete).toBe(true);
    }
    expect(new URL(requests[0]!, "https://example.test").searchParams.get("to")).toBe("2330:TWSE");
    expect(requests[0]).toStartWith("/cloud/supply-chain/paths?from=A&to=2330%3ATWSE&");
    await expect(supplyChainHeadless.load(args({ tab: "path" }), context(payload, requests))).rejects.toThrow("Path requires a target company");
    expect(requests).toHaveLength(2);
    const empty = { ...payload, status: "unavailable" as const, nodes: [payload.entity!], links: [], paths: [] };
    expect((await supplyChainHeadless.load(args({ tab: "path", to: "C" }), context(empty, []))).complete).toBe(true);
  });

  test("preview depth and interrupted searches never claim complete coverage", async () => {
    const payload = graphPayload();
    payload.access = "preview";
    payload.maxDepth = 1;
    payload.requestedDepth = 3;
    payload.options.depth = 1;
    payload.search = { ...payload.search, complete: false, reasons: ["state_limit", "node_limit"] };
    payload.truncated = true;
    const report = await supplyChainHeadless.load(args({ tab: "graph", depth: 3 }), context(payload, []));
    expect(report.complete).toBe(false);
    expect(report.metadata).toMatchObject({ access: "preview", maxDepth: 1, requestedDepth: 3, search: payload.search });
    expect(report.errors).toEqual(["Graph search incomplete: state limit", "Graph search incomplete: node limit", "Gloom Pro is required for full graph depth and results"]);
    payload.requestedDepth = 1; payload.truncated = false; payload.search = { ...payload.search, complete: true, reasons: [] };
    expect((await supplyChainHeadless.load(args({ tab: "graph", depth: 1 }), context(payload, []))).complete).toBe(false);
  });
});

describe("supply chain screenshot evidence", () => {
  test("graph and path IDs must belong to their frozen graph and cannot duplicate counts", () => {
    const payload = graphPayload();
    payload.paths = [payload.downstream[0]!.bestPath];
    const graph = { kind: "supply-chain", version: 1, complete: true, payload, tab: "graph", plottedValueCount: 2, rowIds: payload.links.map(link => link.id) };
    expect(supplyScreenshotEvidence.read(graph)).not.toBeNull();
    expect(supplyScreenshotEvidence.read({ ...graph, evidenceOpen: true, evidenceId: payload.paths[0]!.id })).not.toBeNull();
    expect(supplyScreenshotEvidence.read({ ...graph, evidenceOpen: true, evidenceId: "missing" })).toBeNull();
    expect(supplyScreenshotEvidence.read({ ...graph, rowIds: ["forged", "link-e2"] })).toBeNull();
    expect(supplyScreenshotEvidence.read({ ...graph, rowIds: ["link-e1", "link-e1"] })).toBeNull();
    expect(supplyScreenshotEvidence.read({ ...graph, tab: "path" })).toBeNull();
    expect(supplyScreenshotEvidence.read({ ...graph, tab: "path", plottedValueCount: 1, rowIds: [payload.paths[0]!.id] })).not.toBeNull();
    const malformed = structuredClone(graph);
    malformed.payload.paths[0]!.nodeIds[1] = "unknown";
    expect(supplyScreenshotEvidence.read(malformed)).toBeNull();
  });

  test("legacy disclosure screenshots retain view eligibility and rendered counts", () => {
    const payload = supplyPayload();
    const table = { kind: "supply-chain", version: 1, complete: true, payload, tab: "table", view: "says", plottedValueCount: 1, rowIds: [payload.says[0]!.id] };
    expect(supplyScreenshotEvidence.read(table)).not.toBeNull();
    expect(supplyScreenshotEvidence.read({ ...table, evidenceOpen: true, evidenceId: payload.says[0]!.id })).not.toBeNull();
    expect(supplyScreenshotEvidence.read({ ...table, evidenceOpen: true, evidenceId: "missing" })).toBeNull();
    expect(supplyScreenshotEvidence.read({ ...table, tab: "flow", view: "names" })).not.toBeNull();
    expect(supplyScreenshotEvidence.read({ ...table, view: "names" })).toBeNull();
    expect(supplyScreenshotEvidence.read({ ...table, plottedValueCount: 2 })).toBeNull();
  });
});

test("headless reports keep original evidence and unconverted native units with translation provenance", async () => {
  const row = supplyRow("japan", { nativeAmount: 228_273, nativeCurrency: "JPY", nativeScale: 1_000_000,
    quote: "金額 (百万円) 割合 (%) NVIDIA INTERNATIONAL, INC. - - 228,273 20.2", quoteLanguage: "ja",
    quoteGloss: "NVIDIA INTERNATIONAL: JPY 228,273 million, 20.2% of revenue.", jurisdiction: "JP", entityScope: "entity", sectionRef: "販売実績" });
  const context = createTestHeadlessContext();
  context.apiClient = { ...context.apiClient, getCloudSupplyChain: async () => supplyPayload({ says: [row] }) };
  const result = await supplyChainHeadless.load(createTestHeadlessArgs({ symbols: ["6857.T"] }), context);
  expect(result.sections[0]?.rows?.[0]).toMatchObject({ nativeAmount: 228_273, nativeCurrency: "JPY", nativeScale: 1_000_000, usd: null,
    quote: row.quote, quoteLanguage: "ja", quoteGloss: row.quoteGloss, quoteGlossKind: "machine_translation", jurisdiction: "JP", entityScope: "entity", sectionRef: "販売実績", filingUrl: row.filingUrl });
});

test("graph boundaries preserve global filing scale and provenance and reject uninterpretable native amounts", async () => {
  const payload = graphPayload();
  // Synthetic contract fixture: these amounts are not a claim about a real route.
  const global = { nativeAmount: 315_813, nativeCurrency: "JPY", nativeScale: 1_000_000,
    quote: "販売高には企業集団に属する顧客に対する販売高を含めております。", quoteLanguage: "ja",
    quoteGloss: "Sales include customers in the same corporate group.", jurisdiction: "JP", entityScope: "group" as const,
    sectionRef: "販売実績", sourceAttribution: "EDINET PDL1.0; extracted data edited by Gloom." };
  const disclosure = payload.links[0]!.evidence[0]!;
  Object.assign(disclosure, global);
  disclosure.reporter.identifiers = { edinet: "E00001", tickers: [{ ticker: "8035", exchange: "TSE" }] };
  expect(graphEvidenceRow(disclosure)).toMatchObject(global);
  const normalized = validateGraph(payload);
  expect(normalized.links[0]!.evidence[0]).toMatchObject(global);
  expect(normalized.links[0]!.evidence[0]!.reporter.identifiers).toEqual(disclosure.reporter.identifiers);
  expect(validateGraph(normalized)).toEqual(normalized);
  const report = await supplyChainHeadless.load(args({ tab: "graph" }), context(payload, []));
  expect(report.sections[3]!.rows![0]).toMatchObject({ ...global, quoteGlossKind: "machine_translation" });
  const screenshot = supplyScreenshotEvidence.read({ kind: "supply-chain", version: 1, complete: true, payload,
    tab: "graph", plottedValueCount: 2, rowIds: payload.links.map(link => link.id) });
  expect(screenshot?.payload).toEqual(normalized);
  for (const invalid of [{ nativeScale: null }, { nativeScale: 0 }, { nativeScale: Infinity }, { nativeAmount: -1 },
    { nativeAmount: Number.MAX_VALUE, nativeScale: 2 }, { nativeCurrency: "yen" }, { jurisdiction: "Japan" }, { entityScope: "parent" }]) {
    const malformed = structuredClone(payload); Object.assign(malformed.links[0]!.evidence[0]!, invalid);
    expect(() => validateGraph(malformed)).toThrow("unreadable");
  }
});
