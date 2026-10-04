import type { SupplyEntity, SupplyRole, SupplyRow, SupplyTier } from "./supply-chain";

type GraphTier = "structured" | "primary" | "secondary" | "imported";
export interface GraphOptions {
  depth: number; direction: "upstream" | "downstream" | "both";
  roles: SupplyRole[]; sources: SupplyRow["sourceKind"][]; tiers: GraphTier[];
  minPct: number; minConfidence: number; limit: number; ranking: "score" | "shortest"; asOf?: string;
}
export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { depth: 2, direction: "both", roles: [], sources: [], tiers: [], minPct: 0, minConfidence: 0, limit: 50, ranking: "score" };
export interface GraphEvidence extends Pick<SupplyRow, "claimType" | "corroboration" | "leadStatus" | "firstSeenAt" | "lastSeenAt" | "lastConfirmedAt" | "whyUnconfirmed" | "evidence"> {
  /** Source trust tier, distinct from the graph evidence class in tier. */
  trustTier?: SupplyTier;
  id: string; fromEntity: string; toEntity: string; reportingEntity: string;
  from: SupplyEntity; to: SupplyEntity; reporter: SupplyEntity;
  role: SupplyRole; sourceKind: SupplyRow["sourceKind"]; tier: GraphTier;
  jurisdiction: string; filingUrl: string; accession?: string | null; documentId?: string | null;
  form?: string | null; filedDate?: string | null; period: string; fiscalYear?: string | null; asOf: string;
  pctOfRevenue?: number | null; pctBasis?: SupplyRow["pctBasis"]; pctScope?: string | null;
  usd?: number | null; usdBasis?: SupplyRow["usdBasis"]; nativeAmount?: number | null; nativeCurrency?: string | null;
  confidence: number; quote: string; quoteLanguage?: string | null; quoteMatchMode?: SupplyRow["quoteMatchMode"];
}
interface GraphLink {
  id: string; from: string; to: string; relationship: "commerce" | "partner" | "competitor" | "investee";
  evidence: GraphEvidence[]; primaryEvidenceId: string; confidence: number; weight: number;
}
export interface GraphPath {
  id: string; nodeIds: string[]; linkIds: string[]; hops: number; score: number; confidence: number;
  exposure: { pct: number; basis: NonNullable<SupplyRow["pctBasis"]>; period: string; denominatorEntityId: string; estimated: true } | null;
}
interface GraphReach { entityId: string; direction: "upstream" | "downstream"; hops: number; bestPath: GraphPath; shortestPath: GraphPath; }
export interface GraphPayload {
  symbol: string; entity: SupplyEntity | null; target: SupplyEntity | null; status: "available" | "unavailable";
  nodes: SupplyEntity[]; links: GraphLink[]; upstream: GraphReach[]; downstream: GraphReach[]; related: GraphReach[]; paths: GraphPath[];
  options: GraphOptions; requestedDepth: number; access: "full" | "preview"; maxDepth: number; truncated: boolean;
  search: { complete: boolean; reasons: string[]; exploredStates: number; maxStates: number };
  asOf: string | null; snapshotAt: string; methodology: string;
}
export function supplyGraphQuery(options: Partial<GraphOptions>): string {
  return new URLSearchParams(Object.entries(options).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0)).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)])).toString();
}
