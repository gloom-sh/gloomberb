export type GpuBasis = "list" | "spot" | "ask" | "reserved" | "index";

type GpuProvenance = "archive" | "official-history" | "live";
interface GpuAccess { tier: "pro" | "preview"; preview: boolean; locked: boolean }

export interface GpuObservation {
  source: string;
  skuKey: string;
  provider: string;
  providerClass: "hyperscaler" | "neocloud" | "marketplace" | "aggregate";
  region: string;
  gpuModel: string;
  gpuCount: number;
  formFactor: string | null;
  memoryGb: number | null;
  basis: GpuBasis;
  pricePerGpuHr: number;
  priceNodeHr: number | null;
  currency: "USD";
  availability: string | null;
  observedAt: string;
  effectiveAt: string | null;
  provenance?: GpuProvenance;
  provenanceLabel?: string;
  evidenceUrl?: string | null;
  sourceUrl?: string | null;
  stats?: {
    n: number; min: number; max: number;
    p25?: number; p75?: number;
    constituents?: string[];
    rawMedian?: number;
    chainFactor?: number;
    constituentPrices?: Record<string, number>;
  };
}

export interface GpuBoardRow extends GpuObservation {
  id: string;
  label: string;
  sourceLabel: string;
  change1d: number | null;
  change7d: number | null;
  change30d: number | null;
  stale: boolean;
  lastError: string | null;
}

export interface GpuBoardPayload {
  access?: GpuAccess;
  generatedAt: string;
  status: "available" | "partial" | "unavailable";
  asOf: string | null;
  stale: boolean;
  gaps: string[];
  rows: GpuBoardRow[];
}

export interface GpuHistoryPayload {
  access?: GpuAccess;
  generatedAt: string;
  points: GpuObservation[];
  /** Provider effective dates are separate from observations collected by Gloom. */
  effectivePoints: GpuObservation[];
}

export interface GpuEvent {
  id: string;
  origin?: "published" | "observed";
  kind: "price" | "membership" | "availability";
  provenance?: GpuProvenance;
  provenanceLabel?: string;
  evidenceUrl?: string | null;
  sourceUrl?: string | null;
  oldAvailability?: string | null;
  newAvailability?: string | null;
  source: string;
  skuKey: string;
  provider: string;
  gpuModel: string;
  formFactor: string | null;
  memoryGb: number | null;
  basis: GpuBasis;
  observedAt: string;
  effectiveAt: string | null;
  oldPrice: number;
  newPrice: number;
  changePct: number;
  oldMembers: string[] | null;
  newMembers: string[] | null;
}

export interface GpuEventsPayload { access?: GpuAccess; generatedAt: string; events: GpuEvent[] }
export interface GpuHistoryQuery { gpuModel?: string; basis?: GpuBasis; seriesId?: string; from?: string; to?: string; limit?: number }
