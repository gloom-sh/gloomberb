import { expect, test } from "bun:test";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import type { PerpMarketPayload } from "../../../api-client/perps";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { perpsHeadless } from "./headless";
import { perpBoard, perpHistory, perpRankings, perpRow, venueRow } from "./test-fixture";

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

test("a market nothing matches fails with markets that work, and no market says which one it showed", async () => {
  const args = (argument: string | null) => createTestHeadlessArgs({ argument, rawArgument: argument ?? "", options: { tab: "history", days: "7", metric: "funding" } });
  await expect(perpsHeadless.load(args("XYZZY"), context([]))).rejects.toThrow('No perpetual market matches "XYZZY". Try BTC, ETH, SOL.');

  const shown = await perpsHeadless.load(args(null), context([market]));
  expect(shown.metadata).toMatchObject({ defaultArgument: "BTC", notices: ["Showing BTC. Try fn PERP ETH."] });
  expect(renderHeadlessPaneText(perpsHeadless, shown, createTestHeadlessArgs(), "PERP")).toContain("Showing BTC. Try fn PERP ETH.");
  const named = await perpsHeadless.load(args("BTC"), context([market]));
  expect(named.metadata).not.toHaveProperty("notices");
});

test("a named market with no tab still reports its history, and no market reports the board", async () => {
  const args = (argument: string | null, options: Record<string, string> = {}) => createTestHeadlessArgs({ argument, rawArgument: argument ?? "", options: { days: "7", metric: "funding", ...options } });
  const named = await perpsHeadless.load(args("BTC"), context([market]));
  expect(named.sections.map((section) => section.title)).toEqual(["Latest market", "Own observations", "Paid funding", "Hourly candles"]);
  const queries: unknown[] = [];
  const rows = [market, venueRow("bybit", { fundingRate: 0.0002, oiChange24h: 0.1234 }), venueRow("binance", { assetClass: "metals", marketId: "binance:XAUUSDT", baseAsset: "XAU" })];
  const boardContext = createTestHeadlessContext({ apiClient: { getCloudPerpsBoard: async (query: unknown) => { queries.push(query); return perpBoard({ rows, access: "preview", locked: 2501 }); } } as never });
  const board = await perpsHeadless.load(args(null, { "asset-class": "all", venue: "all", sort: "oi" }), boardContext);
  expect(queries).toEqual([{ sort: "oi" }]);
  const text = renderHeadlessPaneText(perpsHeadless, board, args(null), "PERP");
  expect(text).toContain("Perpetual markets");
  expect(text).toMatch(/BTC\s+Bybit\s+84,724.00 USDT\s+\+0.02000% \/8h/);
  expect(text).toContain("+12.34%");
  expect(text).toContain("2,501 more markets need Gloom Pro");
  expect(text).toContain("Source: Binance, Bybit, Hyperliquid");
  expect(longest(text)).toBeLessThanOrEqual(140);
  // The venue narrows what the server returned; asset class, search and order go to the server.
  const narrowed = await perpsHeadless.load(args("btc", { tab: "board", "asset-class": "crypto", venue: "bybit", sort: "funding" }), boardContext);
  expect(queries.at(-1)).toEqual({ assetClass: "crypto", search: "btc", sort: "funding" });
  const json = serializeHeadlessPaneResult(perpsHeadless, narrowed) as { sections: Array<{ rows: unknown[] }>; metadata: { locked: number } };
  // JSON keeps the whole row, rates as fractions.
  expect(json.sections[0]!.rows).toEqual([rows[1]!]);
  expect(json.metadata.locked).toBe(2501);
});

test("rankings and comparisons name the figure they rank and the venues a spread runs between", async () => {
  const args = (argument: string | null, tab: string) => createTestHeadlessArgs({ argument, rawArgument: argument ?? "", options: { tab } });
  const top = Array.from({ length: 12 }, (_, index) => perpRow({ marketId: `hyperliquid:default:M${index}`, baseAsset: `M${index}` }));
  const apiClient = {
    getCloudPerpsRankings: async () => perpRankings({ fundingPositive: top, closedMarketDislocations: [perpRow({ closedMarketPremium: 0.07681 })] }),
    getCloudPerpsCompare: async (base: string) => perpBoard({ rows: base === "BTC" ? [venueRow("binance", { fundingRate8h: 0.00003 }), venueRow("bybit", { fundingRate8h: 0.0001 })] : [] }),
    getCloudPerpsBoard: async () => perpBoard({ rows: [venueRow("okx", { marketId: "okx:BTC-USDT-SWAP", symbol: "BTC-USDT-SWAP" })] }),
    getCloudPerpsMarket: async () => ({ ...perpBoard({ rows: [venueRow("okx", { marketId: "okx:BTC-USDT-SWAP", symbol: "BTC-USDT-SWAP" })] }), evidence: [], methodologyUrl: "" }),
  } as never;
  const rankings = await perpsHeadless.load(args(null, "rankings"), createTestHeadlessContext({ apiClient }));
  expect(rankings.sections.map((section) => section.title)).toEqual(["Highest Funding 8h", "Lowest Funding 8h", "OI Surges 24h", "Premium Dislocations", "Closed-Market Dislocations"]);
  expect(rankings.sections[0]!.rows).toHaveLength(10);
  const rankingText = renderHeadlessPaneText(perpsHeadless, rankings, args(null, "rankings"), "PERP");
  expect(rankingText).toContain("Funding 8h %");
  expect(rankingText).toContain("Closed-market premium %");
  expect(rankingText).toContain("+7.681%");

  const compare = await perpsHeadless.load(args(null, "compare"), createTestHeadlessContext({ apiClient }));
  expect(compare.metadata).toMatchObject({ baseAsset: "BTC", notices: ["Showing BTC. Try fn PERP ETH --tab compare."], fundingSpread8h: expect.closeTo(0.00007, 10) });
  const compareText = renderHeadlessPaneText(perpsHeadless, compare, args(null, "compare"), "PERP");
  expect(compareText).toContain("0.0070pp Bybit over Binance");
  expect(compareText).toContain("+0.0100%");
  // A canonical identity compares its own base asset; an asset no venue lists names ones that work.
  const canonical = await perpsHeadless.load(args("okx:BTC-USDT-SWAP", "compare"), createTestHeadlessContext({ apiClient }));
  expect(canonical.metadata).toMatchObject({ baseAsset: "BTC" });
  await expect(perpsHeadless.load(args("XYZZY", "compare"), createTestHeadlessContext({ apiClient }))).rejects.toThrow('No perpetual market matches "XYZZY". Try BTC, ETH, SOL.');
});
