import type { GpuBoardPayload, GpuBoardRow, GpuEvent } from "../../../api-client/gpu";

export function gpuRow(overrides: Partial<GpuBoardRow> = {}): GpuBoardRow {
  const row = {
    source: "azure-list", skuKey: "h100-sxm-80", provider: "Azure", providerClass: "hyperscaler",
    region: "eastus", gpuModel: "H100", gpuCount: 8, formFactor: "SXM", memoryGb: 80,
    basis: "list", pricePerGpuHr: 6.98, priceNodeHr: 55.84, currency: "USD", availability: null,
    observedAt: "2026-10-03T19:00:00.000Z", effectiveAt: null,
    label: "H100 80GB SXM", sourceLabel: "Azure", change1d: null, change7d: null, change30d: null,
    stale: false, lastError: null,
    ...overrides,
  } satisfies Omit<GpuBoardRow, "id">;
  return { ...row, id: overrides.id ?? `${row.source}:${row.skuKey}` };
}

export function gpuBoard(overrides: Partial<GpuBoardPayload> = {}): GpuBoardPayload {
  return {
    generatedAt: "2026-10-03T19:01:00.000Z", asOf: "2026-10-03T19:00:00.000Z",
    status: "available", stale: false, gaps: [], rows: [gpuRow()], ...overrides,
  };
}

export function gpuEvent(overrides: Partial<GpuEvent> = {}): GpuEvent {
  return {
    id: "azure-list:h100-sxm-80:2026-10-02", kind: "price", source: "azure-list", skuKey: "h100-sxm-80",
    provider: "Azure", gpuModel: "H100", formFactor: "SXM", memoryGb: 80, basis: "list",
    observedAt: "2026-10-02T19:00:00.000Z", effectiveAt: "2026-10-01T00:00:00.000Z",
    oldPrice: 7, newPrice: 6.98, changePct: -0.285714, oldMembers: null, newMembers: null,
    ...overrides,
  };
}
