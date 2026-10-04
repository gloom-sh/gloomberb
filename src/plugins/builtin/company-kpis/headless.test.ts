import { expect, test } from "bun:test";
import type { apiClient } from "../../../api-client";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
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
