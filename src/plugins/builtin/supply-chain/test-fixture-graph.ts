import { DEFAULT_GRAPH_OPTIONS, type GraphEvidence, type GraphPath, type GraphPayload } from "../../../api-client/supply-chain-graph";
import { entity } from "./test-fixture";
export function graphPayload(): GraphPayload {
  const nodes = [entity("1", "Focus"), { ...entity("2", "Private supplier"), ticker: null, kind: "private" as const }, entity("3", "Tier two")];
  const evidence = (id: string, from: number, to: number): GraphEvidence => ({ id, fromEntity: nodes[from]!.id, toEntity: nodes[to]!.id, reportingEntity: nodes[to]!.id,
    from: nodes[from]!, to: nodes[to]!, reporter: nodes[to]!, role: "supplier", sourceKind: "filing_text", tier: "primary", jurisdiction: "US", filingUrl: "https://www.sec.gov/example", period: "2026", asOf: "2026-01-01", confidence: .9, quote: "We depend on this supplier." });
  const links = [{ id: "a", from: "2", to: "1", relationship: "commerce" as const, evidence: [evidence("a1", 1, 0)], primaryEvidenceId: "a1", confidence: .9, weight: .5 },
    { id: "b", from: "3", to: "2", relationship: "commerce" as const, evidence: [evidence("b1", 2, 1)], primaryEvidenceId: "b1", confidence: .8, weight: .4 }];
  const path = (two: boolean): GraphPath => ({ id: `upstream|${two ? "a|b" : "a"}`, nodeIds: two ? ["1", "2", "3"] : ["1", "2"], linkIds: two ? ["a", "b"] : ["a"], hops: two ? 2 : 1, score: two ? .2 : .5, confidence: two ? .72 : .9,
    exposure: two ? { pct: 20, basis: "revenue", period: "2026", denominatorEntityId: "1", estimated: true } : null });
  return { symbol: "FOCUS", entity: nodes[0]!, target: null, status: "available", nodes, links, upstream: [false, true].map(two => ({ entityId: two ? "3" : "2", direction: "upstream", hops: two ? 2 : 1, bestPath: path(two), shortestPath: path(two) })), downstream: [], related: [], paths: [], options: { ...DEFAULT_GRAPH_OPTIONS }, requestedDepth: 2, access: "full", maxDepth: 4, truncated: false, search: { complete: true, reasons: [], exploredStates: 3, maxStates: 50_000 }, asOf: "2026-01-01", snapshotAt: "2026-01-02T00:00:00Z", methodology: "Disclosed relationships." };
}
