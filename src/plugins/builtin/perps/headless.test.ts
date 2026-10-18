import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import type { PerpMarketPayload } from "../../../api-client/perps";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { perpsHeadless } from "./headless";
import { longShort, longShortPoint, okxLongShort, perpBoard, perpHistory, perpRankings, perpRow, venueRow } from "./test-fixture";

const iso = "2026-10-03T23:20:09Z";
const market = perpRow({ priceChange24h: -0.00123456789, premium: -0.000411228603072, fundingRate: -0.0000504956, openInterestUsd: 1_234_567_890 });
const bare = perpRow({ marketId: "hyperliquid:xyz:TSLA", dex: "xyz", baseAsset: "TSLA", markPrice: null, fundingRate: null, fundingApr: null, premium: null, openInterestUsd: null, priceChange24h: null });
const point = { time: "2026-10-03T22:00:00Z", resolution: "hour" as const, markPrice: 84724.5, oraclePrice: 84700, premium: 0.000289, fundingRate: 8.2984e-06, fundingIntervalHours: 1,
  openInterestBase: 100, openInterestUsd: 3_129_363_818.7, sampleCount: 58, firstObservedAt: iso, lastObservedAt: iso };
const history = perpHistory({ rows: [point, { ...point, markPrice: null, premium: null, fundingRate: null, fundingIntervalHours: null, openInterestUsd: null }],
  funding: [{ marketId: market.marketId, time: iso, rate: -0.0000504956, intervalHours: 1, premium: -0.000411228603072, observedAt: iso, sourceUrl: "https://example.test" }],
  candles: [{ marketId: market.marketId, time: iso, interval: "1h", open: 84700, high: 84900.5, low: 84600, close: 84724, volumeBase: 1234.5, trades: 5100, observedAt: iso, sourceUrl: "https://example.test" }],
  longShortRatio: [longShortPoint("2026-10-03T22:00:00.000Z", 0.631, { ratio: 1.71 }), longShortPoint("2026-10-03T23:00:00.000Z", 0.6183, { ratio: 1.6199 })] });
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
  expect(json.sections.map((section) => section.title)).toEqual(["Latest market", "Own observations", "Paid funding", "Hourly candles", "Long/short history"]);
  expect(json.sections[0]!.rows).toEqual([market]);
  expect(json.sections[1]!.rows).toEqual(history.rows);
  expect(json.sections[2]!.rows).toEqual(history.funding);
  expect(json.sections[3]!.rows).toEqual(history.candles);
  expect(json.sections[4]!.rows).toEqual(history.longShortRatio!);
  expect(text).toMatch(/2026-10-03 23:00 UTC\s+61\.83%\s+38\.17%\s+1\.62\s+Published/);
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

test("evidence reads an OKX reading as derived from its ratio, keeps raw fractions in JSON, and a venue that publishes none says why", async () => {
  const okx = venueRow("okx", { marketId: "okx:BTC-USD-SWAP", symbol: "BTC-USD-SWAP", longShortRatio: okxLongShort, longShortRatioReason: null });
  const { result, text } = await report("evidence", [okx]);
  expect(text).toMatch(/Long accounts\s+67\.98%/);
  expect(text).toMatch(/Short accounts\s+32\.02%/);
  expect(text).toMatch(/Long \/ short ratio\s+2\.1229/);
  expect(text).toContain("Derived from the published ratio");
  expect(text).toContain("2026-10-09 11:00 UTC · OKX 1h");
  expect(longest(text)).toBeLessThanOrEqual(140);
  const json = serializeHeadlessPaneResult(perpsHeadless, result) as { sections: Array<{ title: string; entries?: Array<{ key: string; value: unknown }> }> };
  expect(json.sections.find((section) => section.title === "Positioning")!.entries!.find((entry) => entry.key === "longShare")!.value).toBe(okxLongShort.longShare);

  const hyperliquid = await report("evidence", [perpRow({ longShortRatio: null, longShortRatioReason: "unsupported" })]);
  expect(hyperliquid.text).toMatch(/Long accounts\s+This venue publishes no per-contract account ratio/);
  // A server older than the series sends neither field: no Positioning lines at all.
  expect((await report("evidence", [perpRow()])).text).not.toContain("Long accounts");
});

test("a market nothing matches fails with markets that work, and no market says which one it showed", async () => {
  const args = (argument: string | null) => createTestHeadlessArgs({ argument, rawArgument: argument ?? "", options: { tab: "history", days: "7", metric: "funding" } });
  await expect(perpsHeadless.load(args("XYZZY"), context([]))).rejects.toThrow('No perpetual market matches "XYZZY". Try BTC, ETH, SP500, xyz:SP500.');

  const shown = await perpsHeadless.load(args(null), context([market]));
  expect(shown.metadata).toMatchObject({ defaultArgument: "BTC", notices: ["Showing BTC. Try fn PERP ETH."] });
  expect(renderHeadlessPaneText(perpsHeadless, shown, createTestHeadlessArgs(), "PERP")).toContain("Showing BTC. Try fn PERP ETH.");
  const named = await perpsHeadless.load(args("BTC"), context([market]));
  expect(named.metadata).not.toHaveProperty("notices");
});

test("a named market with no tab still reports its history, and no market reports the board", async () => {
  const args = (argument: string | null, options: Record<string, string> = {}) => createTestHeadlessArgs({ argument, rawArgument: argument ?? "", options: { days: "7", metric: "funding", ...options } });
  const named = await perpsHeadless.load(args("BTC"), context([market]));
  expect(named.sections.map((section) => section.title)).toEqual(["Latest market", "Own observations", "Paid funding", "Hourly candles", "Long/short history"]);
  const queries: unknown[] = [];
  const rows = [market, venueRow("bybit", { fundingRate: 0.0002, oiChange24h: 0.1234, observedAt: "2026-10-03T23:11:40Z" }), venueRow("binance", { assetClass: "metals", marketId: "binance:XAUUSDT", baseAsset: "XAU" })];
  const boardContext = createTestHeadlessContext({ apiClient: { getCloudPerpsBoard: async (query: unknown) => { queries.push(query); return perpBoard({ rows, access: "preview", locked: 2501 }); } } as never });
  const board = await perpsHeadless.load(args(null, { "asset-class": "all", venue: "all", sort: "oi" }), boardContext);
  expect(queries).toEqual([{ sort: "oi" }]);
  const text = renderHeadlessPaneText(perpsHeadless, board, args(null), "PERP");
  expect(text).toContain("Perpetual markets");
  expect(text).toMatch(/BTC\s+Bybit\s+84,724.00 USDT\s+\+0.02000% \/8h/);
  expect(text).toContain("+12.34%");
  expect(text).toContain("2,501 more markets need Gloom Pro");
  // Each venue is dated by its own newest row, not the board's newest stamp, and aged by the one furthest behind.
  expect(text).toContain("Sat 3 Oct 2026 · Binance 23:20 · Bybit 23:11 · Hyperliquid 23:20 UTC · oldest");
  expect(deriveHeadlessFreshness(perpsHeadless, board, Date.parse("2026-10-03T23:30:00Z"))).toMatchObject({ source: "Binance, Bybit, Hyperliquid", oldestAgeMinutes: 18,
    sources: [{ source: "Binance", asOf: "2026-10-03T23:20:09.000Z" }, { source: "Bybit", asOf: "2026-10-03T23:11:40.000Z" }, { source: "Hyperliquid", asOf: "2026-10-03T23:20:09.000Z" }] });
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
    getCloudPerpsCompare: async (base: string) => perpBoard({ rows: base === "BTC" ? [venueRow("binance", { fundingRate8h: 0.00003, longShortRatio: longShort() }),
      venueRow("bybit", { fundingRate8h: 0.0001, longShortRatio: longShort({ venue: "bybit", longShare: 0.5521, shortShare: 0.4479, ratio: 1.2326 }) })] : [] }),
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
  expect(compareText).toMatch(/Binance\s+BTCUSDT.*61\.8%/);
  expect(compareText).toMatch(/Bybit\s+BTCUSDT.*55\.2%/);
  // A canonical identity compares its own base asset; an asset no venue lists names ones that work.
  const canonical = await perpsHeadless.load(args("okx:BTC-USDT-SWAP", "compare"), createTestHeadlessContext({ apiClient }));
  expect(canonical.metadata).toMatchObject({ baseAsset: "BTC" });
  await expect(perpsHeadless.load(args("XYZZY", "compare"), createTestHeadlessContext({ apiClient }))).rejects.toThrow('No perpetual market matches "XYZZY". Try BTC, ETH, SP500, xyz:SP500.');
});

test("a Market column label opens its market, and a label nothing carries fails in plain words", async () => {
  const sp500 = perpRow({ marketId: "hyperliquid:xyz:SP500", dex: "xyz", baseAsset: "SP500", symbol: "xyz:SP500" });
  const apiClient = {
    getCloudPerpsBoard: async (query: { search?: string }) => perpBoard({ rows: query.search === "xyz:SP500" ? [sp500] : [] }),
    getCloudPerpsMarket: async (id: string) => ({ ...perpBoard({ rows: id === sp500.marketId ? [sp500] : [] }), evidence: [], methodologyUrl: "" }),
    getCloudPerpsHistory: async () => perpHistory({ marketId: sp500.marketId }),
  } as never;
  const args = (argument: string, tab = "history") => createTestHeadlessArgs({ argument, rawArgument: argument, options: { tab, days: "7", metric: "funding" } });
  const opened = await perpsHeadless.load(args("SP500 · XYZ"), createTestHeadlessContext({ apiClient }));
  expect(opened.metadata).toMatchObject({ marketId: sp500.marketId });
  expect((await perpsHeadless.load(args("SP500 · XYZ", "board"), createTestHeadlessContext({ apiClient }))).sections[0]).toMatchObject({ rows: [sp500] });
  await expect(perpsHeadless.load(args("FOO · XYZ"), createTestHeadlessContext({ apiClient }))).rejects.toThrow('No perpetual market matches "FOO · XYZ". Try BTC, ETH, SP500, xyz:SP500.');
});

test("a pair or plain name opens the market it stands for, and a name nothing matches names the nearest board markets", async () => {
  const bz = perpRow({ marketId: "binance:BZUSDT", venue: "binance", dex: "", symbol: "BZUSDT", baseAsset: "BZ", displayName: "Brent Crude", assetClass: "energy", quoteCurrency: "USDT" });
  const brentoil = perpRow({ marketId: "hyperliquid:xyz:BRENTOIL", dex: "xyz", symbol: "xyz:BRENTOIL", baseAsset: "BRENTOIL", displayName: "BRENTOIL", assetClass: "energy" });
  const eth = venueRow("binance", { marketId: "binance:ETHUSDT", symbol: "ETHUSDT", baseAsset: "ETH", displayName: "Ethereum" });
  const listed = [market, bz, brentoil, eth];
  const requests: string[] = [];
  const apiClient = {
    // The server finds the text inside a symbol, base asset or name; the board never spells "bitcoin" or "brent" as a symbol.
    getCloudPerpsBoard: async (query: { search?: string }) => perpBoard({ rows: listed.filter((row) => !query.search
      || `${row.symbol} ${row.baseAsset} ${row.displayName}`.toUpperCase().includes(query.search.toUpperCase())) }),
    getCloudPerpsMarket: async (id: string) => ({ ...perpBoard({ rows: listed.filter((row) => row.marketId === id) }), evidence: [], methodologyUrl: "" }),
    getCloudPerpsHistory: async (query: { marketId: string }) => perpHistory({ marketId: query.marketId }),
    getCloudPerpsCompare: async (base: string) => { requests.push(base); return perpBoard({ rows: listed.filter((row) => row.baseAsset === base) }); },
  } as never;
  const load = async (argument: string, tab = "history") => {
    const args = createTestHeadlessArgs({ argument, rawArgument: argument, options: { tab, days: "7", metric: "funding" } });
    const result = await perpsHeadless.load(args, createTestHeadlessContext({ apiClient }));
    return { result, text: renderHeadlessPaneText(perpsHeadless, result, args, "PERP"), metadata: result.metadata as Record<string, unknown> };
  };
  // Pairs, quote-currency spellings and plain names each reach the market they stand for, and say so.
  for (const typed of ["BTC-USD", "BTC/USD", "BTCUSD", "btc-usdt", "Bitcoin"]) {
    expect((await load(typed)).metadata, typed).toMatchObject({ marketId: market.marketId, notices: [`Showing BTC for "${typed}".`] });
  }
  expect((await load("ethereum")).metadata).toMatchObject({ marketId: eth.marketId });
  // A symbol or base asset as typed is not reread: BTCUSDT is Binance's contract and BRENTOIL is its own market.
  expect((await load("ETHUSDT")).metadata).toMatchObject({ marketId: eth.marketId });
  expect((await load("BRENTOIL")).metadata).not.toHaveProperty("notices");
  // Brent is BZ on the Binance board and BRENTOIL on Hyperliquid's xyz dex: the nearest is shown and the other named.
  const brent = await load("brent");
  expect(brent.metadata).toMatchObject({ marketId: bz.marketId, notices: ['Showing BZ for "brent". Also on the board: BRENTOIL · XYZ.'] });
  expect(brent.text).toContain('Showing BZ for "brent". Also on the board: BRENTOIL · XYZ.');
  // The same names compare their base asset across venues, and the comparison says which it read.
  const compared = await load("Bitcoin", "compare");
  expect(compared.metadata).toMatchObject({ baseAsset: "BTC", notices: ['Showing BTC for "Bitcoin".'] });
  expect(requests).toEqual(["BITCOIN", "BTC"]);
  expect((await load("btc", "compare")).metadata).not.toHaveProperty("notices");
  // A pair searches the board by its base asset.
  expect(((await load("BTC-USD", "board")).result.sections[0] as { rows: unknown[] }).rows).toEqual([market]);

  // A name nothing matches suggests the board markets nearest it, as the Market column writes them; free text and an unknown name keep the examples.
  await expect(load("brentt")).rejects.toThrow('No perpetual market matches "brentt". Try BZ, BRENTOIL · XYZ.');
  await expect(load("brentt", "compare")).rejects.toThrow('No perpetual market matches "brentt". Try BZ, BRENTOIL · XYZ.');
  await expect(load("ethereun")).rejects.toThrow('No perpetual market matches "ethereun". Try ETH.');
  await expect(load("XYZZY")).rejects.toThrow('No perpetual market matches "XYZZY". Try BTC, ETH, SP500, xyz:SP500.');
  await expect(load("what is a perp")).rejects.toThrow('No perpetual market matches "what is a perp". Try BTC, ETH, SP500, xyz:SP500.');
});

test("a report that shows the APR % column footnotes what it annualises, and the rankings that do not show it say nothing", async () => {
  // The market is Hyperliquid's, which funds hourly: its APR is the 1h rate × 24 × 365.
  const note = "APR = current 1h rate × 24 × 365: a simple annualisation of the current funding rate, not funding actually paid.";
  for (const tab of ["history", "evidence"]) {
    const { result, text } = await report(tab);
    expect(result.notes, tab).toEqual([note]);
    expect(text).toContain(`Notes: ${note}`);
  }
  const apiClient = { getCloudPerpsBoard: async () => perpBoard({ rows: [market] }), getCloudPerpsCompare: async () => perpBoard({ rows: [market] }),
    getCloudPerpsRankings: async () => perpRankings({ fundingPositive: [market] }) } as never;
  const load = (tab: string) => perpsHeadless.load(createTestHeadlessArgs({ argument: null, rawArgument: "", options: { tab } }), createTestHeadlessContext({ apiClient }));
  expect((await load("board")).notes).toEqual([note]);
  expect((await load("compare")).notes).toEqual([note]);
  expect((await load("rankings")).notes).toBeUndefined();
  // An empty table has no column to footnote.
  const empty = createTestHeadlessContext({ apiClient: { getCloudPerpsBoard: async () => perpBoard({ rows: [], access: "preview", locked: 5 }) } as never });
  expect((await perpsHeadless.load(createTestHeadlessArgs({ argument: null, rawArgument: "", options: { tab: "board" } }), empty)).notes).toBeUndefined();
});

test("a free account's locked tables are left out, and one Pro line says what free shows and what Pro adds, apart from the errors", async () => {
  const locked = perpHistory({ locked: true, access: "preview" });
  // The venues counted are those Gloom Cloud reports collecting; other sources are not venues.
  const sources = ["hyperliquid", "hyperliquid:xyz", "binance", "bybit", "underlying"].map((source) => ({ source, lastOkAt: null, failures: 0 }));
  const apiClient = { getCloudPerpsBoard: async () => perpBoard({ rows: [market] }), getCloudPerpsMarket: async () => ({ ...perpBoard({ rows: [market], access: "preview" }), sources, evidence: [], methodologyUrl: "" }),
    getCloudPerpsHistory: async () => locked } as never;
  const run = async (tab: string) => {
    const args = createTestHeadlessArgs({ argument: "BTC", rawArgument: "BTC", options: { tab, days: "7", metric: "funding" } });
    const result = await perpsHeadless.load(args, createTestHeadlessContext({ apiClient }));
    return { result, text: renderHeadlessPaneText(perpsHeadless, result, args, "PERP") };
  };
  const history = await run("history");
  const gate = "Pro: Free shows the latest funding, OI and premium (basis: fn CTM BTC). Gloom Pro adds Hyperliquid BTC history and every market on 3 venues · gloom.sh/cloud";
  expect(history.text).toContain(gate);
  expect(history.text.match(/Pro:/g)).toHaveLength(1);
  expect(history.text).not.toMatch(/Locked|No data|Errors|Own observations|Paid funding/);
  // JSON keeps the sections, marked locked, and the lock stays in errors for readers that only look there.
  const json = serializeHeadlessPaneResult(perpsHeadless, history.result) as { sections: Array<{ title: string; rows: unknown[]; locked?: boolean }>; errors: string[] };
  expect(json.sections.map((section) => section.title)).toEqual(["Latest market", "Own observations", "Paid funding", "Hourly candles", "Long/short history"]);
  expect(json.sections[1]).toMatchObject({ rows: [], locked: true });
  expect(json.sections[0]).not.toHaveProperty("locked");
  expect(json.errors).toEqual([gate.slice("Pro: ".length).replace(" · gloom.sh/cloud", ".")]);
  const evidence = await run("evidence");
  expect(evidence.text).not.toMatch(/Observation revisions|Locked/);
  expect(evidence.text).toContain("Pro: Free shows BTC's latest evidence and positioning. Gloom Pro adds its observation revisions · gloom.sh/cloud");
});

test("a venue filter names no count it does not have, and a venue with no contract to show is said", async () => {
  const rows = [venueRow("binance"), venueRow("bybit", { marketId: "bybit:BTCUSDT" })];
  // Hyperliquid's BTC is outside the free board preview, but an individual market is fetched whole.
  const known = [...rows, market];
  const clientFor = (access: "preview" | "pro") => ({
    getCloudPerpsBoard: async () => perpBoard({ rows, access, locked: access === "pro" ? 0 : 2501 }),
    getCloudPerpsMarket: async (id: string) => ({ ...perpBoard({ rows: known.filter((row) => row.marketId === id), access }), evidence: [], methodologyUrl: "" }),
    getCloudPerpsHistory: async (query: { marketId: string }) => perpHistory({ marketId: query.marketId, locked: access === "preview", access }),
  }) as never;
  const load = async (argument: string | null, options: Record<string, string>, access: "preview" | "pro" = "preview") => {
    const args = createTestHeadlessArgs({ argument, rawArgument: argument ?? "", options: { days: "7", metric: "funding", ...options } });
    const result = await perpsHeadless.load(args, createTestHeadlessContext({ apiClient: clientFor(access) }));
    return { result, text: renderHeadlessPaneText(perpsHeadless, result, args, "PERP") };
  };
  const all = await load(null, { tab: "board", venue: "all" });
  expect(all.text).toContain("Pro: 2,501 more markets need Gloom Pro");
  const bybit = await load(null, { tab: "board", venue: "bybit" });
  expect(bybit.text).toContain("Pro: Bybit markets beyond the free preview need Gloom Pro");
  expect(bybit.text).not.toContain("2,501");
  const none = await load(null, { tab: "board", venue: "kraken" });
  expect(none.text).toMatch(/Perpetual markets\n\nPro: Kraken markets beyond the free preview need Gloom Pro · gloom.sh\/cloud\n/);
  expect(none.text.match(/Pro:/g)).toHaveLength(1);
  expect(none.text).not.toContain("No data");

  // A market opens on the venue asked for, listed on the board or not; only a venue with no contract to open is said.
  for (const [venue, marketId] of [["bybit", "bybit:BTCUSDT"], ["hyperliquid", market.marketId]] as const) {
    const opened = (await load("BTC", { venue })).result.metadata;
    expect(opened).toMatchObject({ marketId });
    expect(opened).not.toHaveProperty("notices");
  }
  expect((await load("BTC", { venue: "kraken" })).result.metadata).toMatchObject({ marketId: "binance:BTCUSDT", notices: ["Kraken has no BTC contract in the free preview; showing Binance."] });
  expect((await load("BTC", { venue: "kraken" }, "pro")).result.metadata).toMatchObject({ notices: ["Kraken has no BTC contract; showing Binance."] });
  expect((await load("hyperliquid:default:BTC", { venue: "bybit" })).result.metadata).toMatchObject({ notices: ["hyperliquid:default:BTC is a Hyperliquid market, so the Bybit filter does not apply."] });
});
