import { expect, test } from "bun:test";
import type { RatePathPayload } from "../../../api-client/rates";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { ratePathHeadless } from "./headless";

const metric = { value: 3.88, asOf: "2026-10-08", percentile: 86, samples: 251, source: "fred" as const, stale: false };
const payload = {
  asOf: "2026-10-09T20:55:00Z", fetchedAt: "2026-10-09T21:00:00Z", stale: false, status: "available",
  current: { effr: metric, targetLower: { ...metric, value: 3.75 }, targetUpper: { ...metric, value: 4, source: "nyfed" as const } },
  meetings: [], sofr: [], ghosts: [], gaps: [], probabilityAssumption: "Two outcomes",
  fedFunds: [{ symbol: "ZQV26.CBT", month: "2026-10", price: 96.118, impliedRate: 3.88, asOf: "2026-10-09T20:59:00Z", percentile: 92, samples: 251, status: "available", stale: true }],
  dotPlot: { asOf: "2026-09-16", sourceUrl: "https://www.federalreserve.gov", points: [] },
  schedule: { sourceUrl: "https://www.federalreserve.gov", verifiedAt: "2026-10-01", through: "2027-12-08" },
  slope: { valueBps: null, percentile: null, samples: 0, asOf: null },
} satisfies RatePathPayload;

test("text names the policy rates and says whether data is stale, while JSON keeps its keys and booleans", async () => {
  const context = createTestHeadlessContext({ apiClient: { getCloudRatePath: async () => payload } as never });
  const result = await ratePathHeadless.load(createTestHeadlessArgs(), context);
  const text = renderHeadlessPaneText(ratePathHeadless, result, createTestHeadlessArgs(), "WIRP");
  for (const label of ["Effective fed funds rate", "Target range lower", "Target range upper"]) expect(text).toContain(label);
  expect(text).not.toMatch(/\b(effr|targetLower|targetUpper)\b/);
  // Raw feed names stay out of the text; the staleness reads as words.
  expect(text).not.toMatch(/\b(fred|nyfed)\b/);
  expect(text).toContain("Data stale");
  expect(text).not.toMatch(/\b(true|false)\b/);
  const policy = result.sections[0] as { rows: Array<Record<string, unknown>> };
  expect(policy.rows.map((row) => [row.name, row.stale, row.source])).toEqual([["effr", false, "fred"], ["targetLower", false, "fred"], ["targetUpper", false, "nyfed"]]);
  const contract = text.split("\n").find((line) => line.startsWith("ZQV26.CBT"))!;
  expect(contract.trim().endsWith("available  yes")).toBe(true);
});

test("the status line names the CME futures and how far they are delayed", async () => {
  const context = createTestHeadlessContext({ apiClient: { getCloudRatePath: async () => payload } as never });
  const result = await ratePathHeadless.load(createTestHeadlessArgs(), context);
  const freshness = deriveHeadlessFreshness(ratePathHeadless, result, Date.parse("2026-10-09T21:00:00Z"));
  expect(freshness).toMatchObject({ source: "CME futures", status: "stale", feed: "delayed", delayMinutes: 10, staleCount: 1 });
  expect(formatFreshnessLine(freshness)).toBe("Source: CME futures · Fri 9 Oct 2026 20:59 UTC (oldest Thu 8 Oct 2026) · 10 min delayed, 1 of 4 stale");
  // Without a stale row it is a plain delayed feed, never live.
  const fresh = await ratePathHeadless.load(createTestHeadlessArgs(), createTestHeadlessContext({
    apiClient: { getCloudRatePath: async () => ({ ...payload, fedFunds: [{ ...payload.fedFunds[0], stale: false }] }) } as never,
  }));
  expect(formatFreshnessLine(deriveHeadlessFreshness(ratePathHeadless, fresh, Date.parse("2026-10-09T21:00:00Z"))))
    .toBe("Source: CME futures · Fri 9 Oct 2026 20:59 UTC (oldest Thu 8 Oct 2026) · 10 min delayed");
});
