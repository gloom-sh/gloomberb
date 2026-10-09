import { expect, test } from "bun:test";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import type { PerpMarketPayload } from "../../../api-client/perps";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { perpsHeadless } from "./headless";
import { perpBoard, perpHistory, perpRow } from "./test-fixture";

const iso = "2026-10-03T23:20:09Z";
const market = perpRow({ priceChange24h: -0.00123456789, premium: -0.000411228603072, fundingRate: -0.0000504956, openInterestUsd: 1_234_567_890 });
const bare = perpRow({ marketId: "hyperliquid:xyz:TSLA", dex: "xyz", baseAsset: "TSLA", markPrice: null, fundingRate: null, fundingApr: null, premium: null, openInterestUsd: null, priceChange24h: null });
const point = { time: "2026-10-03T22:00:00Z", resolution: "hour" as const, markPrice: 84724.5, oraclePrice: 84700, premium: 0.000289, fundingRate: 8.2984e-06, fundingIntervalHours: 1,
  openInterestBase: 100, openInterestUsd: 3_129_363_818.7, sampleCount: 58, firstObservedAt: iso, lastObservedAt: iso };
const history = perpHistory({ rows: [point, { ...point, markPrice: null, premium: null, fundingRate: null, fundingIntervalHours: null, openInterestUsd: null }],
  funding: [{ marketId: market.marketId, time: iso, rate: -0.0000504956, intervalHours: 1, premium: -0.000411228603072, observedAt: iso, sourceUrl: "https://example.test" }],
  candles: [{ marketId: market.marketId, time: iso, interval: "1h", open: 84700, high: 84900.5, low: 84600, close: 84724, volumeBase: 1234.5, trades: 5100, observedAt: iso, sourceUrl: "https://example.test" }] });
const evidence: PerpMarketPayload["evidence"] = [
  { kind: "funding", period_at: iso, received_at: iso, superseded_at: "2026-10-04T01:00:00Z", fingerprint: "9f2c41d7a0b35e88c1", payload: { ...history.funding[0]! } },
  { kind: "market", period_at: iso, received_at: iso, superseded_at: null, fingerprint: "ab12", payload: market },
];
const context = (rows: typeof market[]) => createTestHeadlessContext({ apiClient: {
  getCloudPerpsBoard: async () => perpBoard({ rows }),
  getCloudPerpsMarket: async () => ({ ...perpBoard({ rows }), evidence, methodologyUrl: "https://gloom.sh/docs/perpetuals" }),
  getCloudPerpsHistory: async () => history,
} as never });

async function report(tab: string, rows = [market]) {
  const result = await perpsHeadless.load(createTestHeadlessArgs({ argument: "BTC", rawArgument: "BTC", options: { tab, days: "7", metric: "funding" } }), context(rows));
  return { result, text: renderHeadlessPaneText(perpsHeadless, result, createTestHeadlessArgs(), "PERP") };
}
const longest = (text: string) => Math.max(...text.split("\n").map((line) => line.length));

test("history report reads as units and the rows keep every raw field", async () => {
  const { result, text } = await report("history");
  expect(text).toContain("84,724.00 USDC");
  expect(text).toContain("-0.00505% /1h");
  expect(text).toContain("-0.041%");
  expect(text).toContain("1.23B");
  expect(text).toContain("-0.12%");
  expect(text).toContain("2026-10-03 23:20 UTC");
  // A missing figure is "--", never undefined, NaN or a stray hyphen.
  expect(text).toMatch(/--\s+--\s+--\s+--\s/);
  expect(text).not.toMatch(/undefined|NaN|\d\.\d{9,}/);
  expect(longest(text)).toBeLessThanOrEqual(140);
  const json = serializeHeadlessPaneResult(perpsHeadless, result) as { sections: Array<{ title: string; rows: unknown[] }>; metadata: { rates: string } };
  expect(json.metadata.rates).toBe("fraction");
  expect(json.sections.map((section) => section.title)).toEqual(["Latest market", "Own observations", "Paid funding", "Hourly candles"]);
  expect(json.sections[0]!.rows).toEqual([market]);
  expect(json.sections[1]!.rows).toEqual(history.rows);
  expect(json.sections[2]!.rows).toEqual(history.funding);
  expect(json.sections[3]!.rows).toEqual(history.candles);
});

test("an underlying without data and the revision payloads stay short and honest", async () => {
  const { result, text } = await report("evidence", [bare]);
  expect(text).toContain("TSLA · XYZ");
  expect(text).toContain("Superseded 2026-10-04 01:00 UTC");
  expect(text).toContain("9f2c41d7");
  expect(text).not.toContain("9f2c41d7a0");
  expect(text).not.toMatch(/undefined|NaN|payload|\d\.\d{9,}/);
  expect(longest(text)).toBeLessThanOrEqual(140);
  const json = serializeHeadlessPaneResult(perpsHeadless, result) as { sections: Array<{ rows: unknown[] }> };
  expect(json.sections[1]!.rows).toEqual(evidence);
});
