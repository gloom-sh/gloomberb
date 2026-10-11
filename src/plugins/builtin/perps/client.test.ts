import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { PerpMarketPayload } from "../../../api-client/perps";
import { cachedPerpSelection, fetchPerpsBoard, fetchPerpsCompare, fetchPerpSelection, loadPerpSelection, loadPerpsBoard, loadPerpsEquities, loadPerpsEquity, loadPerpsHistoryForRange,
  perpsCache, perpsListCache, perpsMarketCache, perpsHistoryCache, validatePerpsBoard, validatePerpsEquities, validatePerpsHistory, validatePerpsRankings } from "./client";
import { equitiesPayload, equityBoard, longShort, longShortPoint, okxLongShort, perpBoard, perpHistory, perpRankings, perpRow, venueRow } from "./test-fixture";
const market = (patch: Partial<PerpMarketPayload> = {}): PerpMarketPayload => ({ ...perpBoard({ rows: [perpRow()] }), evidence: [], methodologyUrl: "https://gloom.sh/docs/perpetuals", ...patch });

test("boundary refuses invalid intervals, non-finite funding, wrong market and duplicate identities while retaining null baselines", () => {
  expect(validatePerpsBoard(perpBoard()).rows[0]!.oiChange24h).toBeNull();
  for (const row of [perpRow({ fundingIntervalHours: 0 }), perpRow({ fundingRate: NaN }), perpRow({ observedAt: "invalid" })]) {
    expect(() => validatePerpsBoard(perpBoard({ rows: [row] }))).toThrow("unreadable");
  }
  expect(() => validatePerpsBoard(perpBoard({ rows: [perpRow(), perpRow()] }))).toThrow("unreadable");
  expect(() => validatePerpsHistory(perpHistory(), "another-market")).toThrow("unreadable");
  expect(validatePerpsHistory(perpHistory({ locked: true, access: "preview" })).rows).toEqual([]);
});

test("long/short readings: an older server's rows and history still read, out-of-range shares do not", () => {
  // The captured rows predate the series and carry neither field.
  expect(perpRow()).not.toHaveProperty("longShortRatio");
  expect(validatePerpsBoard(perpBoard()).rows).toHaveLength(perpBoard().rows.length);
  expect(validatePerpsHistory(perpHistory()).longShortRatio).toBeUndefined();
  const rows = [venueRow("binance", { longShortRatio: longShort(), longShortRatioReason: null }), venueRow("okx", { marketId: "okx:BTC-USD-SWAP", longShortRatio: okxLongShort }),
    perpRow({ longShortRatio: null, longShortRatioReason: "unsupported" }), venueRow("bybit", { longShortRatio: longShort({ venue: "bybit", shortShare: 0, ratio: null }) })];
  expect(validatePerpsBoard(perpBoard({ rows })).rows).toHaveLength(4);
  for (const bad of [longShort({ longShare: 1.2 }), longShort({ shortShare: -0.1 }), longShort({ ratio: Number.POSITIVE_INFINITY }), longShort({ bucketAt: "soon" })]) {
    expect(() => validatePerpsBoard(perpBoard({ rows: [venueRow("binance", { longShortRatio: bad })] }))).toThrow("unreadable");
  }
  expect(validatePerpsHistory(perpHistory({ longShortRatio: [longShortPoint("2026-10-09T11:00:00.000Z", 0.6183)] })).longShortRatio).toHaveLength(1);
  expect(() => validatePerpsHistory(perpHistory({ longShortRatio: [longShortPoint("2026-10-09T11:00:00.000Z", Number.NaN)] }))).toThrow("unreadable");
  expect(() => validatePerpsHistory({ ...perpHistory(), longShortRatio: {} } as never)).toThrow("unreadable");
});

test("the board's long-share order asks the server for its default order and ranks what comes back, readings first", async () => {
  const queries: unknown[] = [];
  const rows = [venueRow("bybit", { longShortRatio: longShort({ venue: "bybit", longShare: 0.55 }) }), perpRow({ longShortRatio: null, longShortRatioReason: "unsupported" }),
    venueRow("okx", { marketId: "okx:BTC-USD-SWAP", longShortRatio: okxLongShort }), venueRow("binance", { longShortRatio: longShort() })];
  const board = await fetchPerpsBoard({ assetClass: "crypto", sort: "long-short" }, { getCloudPerpsBoard: async (query) => { queries.push(query); return perpBoard({ rows }); } });
  expect(queries).toEqual([{ assetClass: "crypto", sort: "oi" }]);
  expect(board.rows.map((row) => row.marketId)).toEqual(["okx:BTC-USD-SWAP", "binance:BTCUSDT", "bybit:BTCUSDT", "hyperliquid:default:BTC"]);
});

test("opaque canonical market identities preserve case and bypass board discovery for every venue", async () => {
  const queries: string[] = [];
  const client = {
    getCloudPerpsBoard: async () => { throw new Error("Unexpected board lookup"); },
    getCloudPerpsMarket: async (id: string) => { queries.push(id); return market(); },
  };
  for (const id of ["hyperliquid:xyz:TSLA", "hyperliquid:default:kPEPE", "binance:BTCUSDT", "kraken:PF_XBTUSD"]) await fetchPerpSelection(id, client);
  expect(queries).toEqual(["hyperliquid:xyz:TSLA", "hyperliquid:default:kPEPE", "binance:BTCUSDT", "kraken:PF_XBTUSD"]);
});

test("symbol resolution prefers default crypto and xyz stocks, including individual previews outside the board preview", async () => {
  const calls: string[] = [];
  const client = {
    getCloudPerpsBoard: async () => perpBoard({ access: "preview", rows: [], locked: 300 }),
    getCloudPerpsMarket: async (id: string) => {
      calls.push(id); return market({ rows: id === "hyperliquid:xyz:TSLA" ? [perpRow({ marketId: id, baseAsset: "TSLA" })] : [], access: "preview" });
    },
  };
  expect((await fetchPerpSelection("tsla", client)).rows[0]!.marketId).toBe("hyperliquid:xyz:TSLA");
  expect(calls).toEqual(["hyperliquid:default:TSLA", "hyperliquid:xyz:TSLA"]);
  calls.length = 0;
  const discovered = { ...client, getCloudPerpsBoard: async () => perpBoard({ rows: [perpRow({ marketId: "hyperliquid:xyz:BTC", dex: "xyz" }), perpRow()] }) };
  await fetchPerpSelection("BTC", discovered);
  expect(calls[0]).toBe(perpRow().marketId);
});

test("a Market column label resolves to the market it names and no free text reaches a market id", async () => {
  const sp500 = perpRow({ marketId: "hyperliquid:xyz:SP500", dex: "xyz", baseAsset: "SP500", symbol: "xyz:SP500" });
  const searches: unknown[] = [];
  const ids: string[] = [];
  const client = {
    getCloudPerpsBoard: async (query: unknown) => { searches.push(query); return perpBoard({ rows: (query as { search: string }).search === "xyz:SP500" ? [sp500] : [] }); },
    getCloudPerpsMarket: async (id: string) => { ids.push(id); return market({ rows: id === sp500.marketId ? [sp500] : [] }); },
  };
  // The label the board prints and the identity typed by hand are one market.
  for (const input of ["SP500 · XYZ", "SP500·XYZ", "xyz:SP500"]) expect((await fetchPerpSelection(input, client)).rows[0]!.marketId).toBe(sp500.marketId);
  expect(searches).toEqual([{ search: "xyz:SP500" }, { search: "xyz:SP500" }, { search: "xyz:SP500" }]);
  // Outside the board's preview, the builder dex names its own market; a label nothing carries, or free text, is no market and never a request.
  ids.length = 0;
  const preview = { ...client, getCloudPerpsBoard: async () => perpBoard({ access: "preview", rows: [], locked: 300 }) };
  expect((await fetchPerpSelection("SP500 · XYZ", preview)).rows[0]!.marketId).toBe(sp500.marketId);
  expect((await fetchPerpSelection("FOO · XYZ", preview)).rows).toEqual([]);
  expect((await fetchPerpSelection("what is a perp", preview)).rows).toEqual([]);
  expect(ids).toEqual(["hyperliquid:xyz:SP500", "hyperliquid:xyz:FOO"]);
});

test("a venue opens its own contract: from the board, by its identity when the free preview lacks it, and otherwise the usual one", async () => {
  // The free preview lists Binance alone; every contract a venue carries can still be fetched by its identity.
  const contracts = [venueRow("binance"), venueRow("bybit"), perpRow(), venueRow("okx", { marketId: "okx:BTC-USD-SWAP", symbol: "BTC-USD-SWAP" })];
  const ids: string[] = [];
  let boardRows = [contracts[0]!];
  const client = {
    getCloudPerpsBoard: async () => perpBoard({ rows: boardRows, access: "preview", locked: 13 }),
    getCloudPerpsMarket: async (id: string) => { ids.push(id); return market({ access: "preview", rows: contracts.filter((row) => row.marketId === id) }); },
  };
  const venueOf = async (venue?: string) => (await fetchPerpSelection("BTC", client, venue)).rows[0]!.venue;
  expect(await venueOf("hyperliquid")).toBe("hyperliquid");
  expect(ids).toEqual(["hyperliquid:default:BTC"]);
  ids.length = 0;
  expect(await venueOf("bybit")).toBe("bybit");
  expect(ids).toEqual(["bybit:BTCUSDT"]);
  ids.length = 0;
  // OKX lists the USDT contract first; the USD one is the next identity tried.
  expect(await venueOf("okx")).toBe("okx");
  expect(ids).toEqual(["okx:BTC-USDT-SWAP", "okx:BTC-USD-SWAP"]);
  ids.length = 0;
  // A venue Gloom Cloud does not collect has no contract to open, and no lookup is made for it.
  expect(await venueOf("kraken")).toBe("binance");
  expect(ids).toEqual(["binance:BTCUSDT"]);
  ids.length = 0;
  expect(await venueOf()).toBe("binance");
  // A board that lists the venue's contract is enough.
  boardRows = [contracts[0]!, contracts[1]!];
  ids.length = 0;
  expect(await venueOf("bybit")).toBe("bybit");
  expect(ids).toEqual(["bybit:BTCUSDT"]);
});

test("paid caches are isolated per account/plan and failures preserve data except access refusal", async () => {
  perpsMarketCache.reset();
  const data = market();
  const request = spyOn(apiClient, "getCloudPerpsMarket").mockResolvedValue(data);
  const id = perpRow().marketId;
  try {
    await loadPerpSelection(id, "account-a:pro");
    expect(cachedPerpSelection(id, "account-b:preview")).toBeNull();
    request.mockRejectedValue(new ApiRequestError("Gateway unavailable", 502));
    expect(await loadPerpSelection(id, "account-a:pro", true)).toMatchObject({ payload: data, stale: true, refreshError: "Gateway unavailable" });
    request.mockRejectedValue(new ApiRequestError("Session expired", 401));
    await expect(loadPerpSelection(id, "account-a:pro", true)).rejects.toThrow("Session expired");
  } finally { request.mockRestore(); perpsMarketCache.reset(); }
});

test("refresh advances the history lookback and uses the requested market's own resource", async () => {
  perpsHistoryCache.reset();
  const request = spyOn(apiClient, "getCloudPerpsHistory").mockResolvedValue(perpHistory());
  const now = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T00:00:00Z"));
  try {
    await loadPerpsHistoryForRange(perpRow().marketId, 7, "account-a:pro", true);
    now.mockReturnValue(Date.parse("2026-10-04T00:00:00Z"));
    await loadPerpsHistoryForRange(perpRow().marketId, 7, "account-a:pro", true);
    expect(request.mock.calls.map(([query]) => query.from)).toEqual(["2026-09-26T00:00:00.000Z", "2026-09-27T00:00:00.000Z"]);
    expect(request.mock.calls.every(([query]) => query.marketId === perpRow().marketId && query.limit === 5000)).toBe(true);
  } finally { now.mockRestore(); request.mockRestore(); perpsHistoryCache.reset(); }
});

test("equity caches separate listings and accounts from legacy rows, and validate network and stale identities", async () => {
  perpsCache.reset();
  const nyse = { symbol: "NET", exchange: "NYSE" };
  const london = { symbol: "NET", exchange: "LSE" };
  const data = equityBoard(nyse);
  const request = spyOn(apiClient, "getCloudPerpsEquity").mockResolvedValue(data);
  try {
    await perpsCache.load("equity:NET:account-a:pro", async () => perpBoard());
    expect((await loadPerpsEquity(nyse, "account-a:pro")).payload).toEqual(data);
    expect(request.mock.calls).toEqual([["NET", "NYSE"]]);
    await expect(loadPerpsEquity(london, "account-a:pro")).rejects.toThrow("another listing");
    request.mockResolvedValue(perpBoard());
    await expect(loadPerpsEquity(nyse, "account-b:preview")).rejects.toThrow("another listing");
    request.mockRejectedValue(new ApiRequestError("Gateway unavailable", 502));
    expect(await loadPerpsEquity(nyse, "account-a:pro", true)).toMatchObject({ payload: data, stale: true });
    await expect(loadPerpsEquity(london, "account-a:pro", true)).rejects.toThrow("Gateway unavailable");
    request.mockRejectedValue(new ApiRequestError("Session expired", 401));
    await expect(loadPerpsEquity(nyse, "account-a:pro", true)).rejects.toThrow("Session expired");
    // A matching envelope cannot authorize a row associated with another listing.
    request.mockResolvedValue({ ...data, listing: london });
    await expect(loadPerpsEquity(london, "account-a:pro", true)).rejects.toThrow("another listing");
  } finally { request.mockRestore(); perpsCache.reset(); }
});

test("a list's perpetuals take one request per hundred listings, cached per list and account, with each contract proven for its row", async () => {
  perpsListCache.reset();
  const listings = Array.from({ length: 230 }, (_, index) => ({ symbol: `S${index}`, exchange: "NASDAQ" }));
  const pages: number[] = [];
  const request = spyOn(apiClient, "getCloudPerpsEquities").mockImplementation(async (page) => {
    pages.push(page.length);
    return equitiesPayload(page, (listing) => listing.symbol === "S7" || listing.symbol === "S150");
  });
  try {
    const first = await loadPerpsEquities(listings, "account-a:pro");
    expect(pages).toEqual([100, 100, 30]);
    expect(first.payload.results.map((result) => result.market?.marketId ?? null).filter(Boolean)).toEqual(["hyperliquid:xyz:S7", "hyperliquid:xyz:S150"]);
    // Within a minute the same list reads its cache; a 30-row list is one request.
    await loadPerpsEquities(listings, "account-a:pro");
    await loadPerpsEquities(listings.slice(0, 30), "account-a:pro");
    expect(pages).toEqual([100, 100, 30, 30]);
    request.mockRejectedValue(new ApiRequestError("Gateway unavailable", 502));
    expect(await loadPerpsEquities(listings, "account-a:pro", true)).toMatchObject({ payload: first.payload, stale: true });
    request.mockRejectedValue(new ApiRequestError("Session expired", 401));
    await expect(loadPerpsEquities(listings, "account-a:pro", true)).rejects.toThrow("Session expired");
  } finally { request.mockRestore(); perpsListCache.reset(); }
  // Answers follow the request's order, and a contract counts only with its proof for that row's listing.
  const [apple, cloudflare] = [{ symbol: "AAPL", exchange: "NASDAQ" }, { symbol: "NET", exchange: "NYSE" }];
  const answer = equitiesPayload([apple, cloudflare], () => true);
  expect(validatePerpsEquities(answer, [apple, cloudflare]).results).toHaveLength(2);
  expect(() => validatePerpsEquities(answer, [cloudflare, apple])).toThrow("another listing");
  expect(() => validatePerpsEquities(answer, [apple])).toThrow("another listing");
  expect(() => validatePerpsEquities({ ...answer, results: [answer.results[0]!, { listing: cloudflare, market: answer.results[0]!.market }] }, [apple, cloudflare])).toThrow("another listing");
  expect(validatePerpsEquities(equitiesPayload([apple, cloudflare], () => false), [apple, cloudflare]).results.every((result) => !result.market)).toBe(true);
});

test("rankings may repeat a market across lists but not within one, and a comparison holds only its base asset", async () => {
  const kaia = venueRow("binance", { marketId: "binance:KAIAUSDT", symbol: "KAIAUSDT", baseAsset: "KAIA" });
  expect(validatePerpsRankings(perpRankings({ fundingNegative: [kaia], premiumDislocations: [kaia] })).premiumDislocations).toEqual([kaia]);
  expect(() => validatePerpsRankings(perpRankings({ oiSurges: [kaia, kaia] }))).toThrow("unreadable");
  expect(() => validatePerpsRankings(perpRankings({ fundingPositive: [perpRow({ fundingRate: NaN })] }))).toThrow("unreadable");
  expect(() => validatePerpsRankings({ ...perpRankings(), closedMarketDislocations: undefined } as never)).toThrow("unreadable");
  const client = { getCloudPerpsCompare: async () => perpBoard({ rows: [venueRow("bybit"), kaia] }) };
  await expect(fetchPerpsCompare("btc", client)).rejects.toThrow("another asset");
});

test("board caches keep each query and each plan apart", async () => {
  perpsCache.reset();
  const request = spyOn(apiClient, "getCloudPerpsBoard").mockImplementation(async (query = {}) => perpBoard({ rows: query.assetClass === "metals" ? [perpRow({ marketId: "hyperliquid:xyz:GOLD", assetClass: "metals" })] : [perpRow()] }));
  try {
    await loadPerpsBoard({ sort: "oi" }, "account-a:preview");
    await loadPerpsBoard({ assetClass: "metals", sort: "oi" }, "account-a:preview");
    await loadPerpsBoard({ sort: "oi" }, "account-a:pro");
    expect(request.mock.calls.map(([query]) => query)).toEqual([{ sort: "oi" }, { assetClass: "metals", sort: "oi" }, { sort: "oi" }]);
    expect((await loadPerpsBoard({ assetClass: "metals", sort: "oi" }, "account-a:preview")).payload.rows[0]!.assetClass).toBe("metals");
    expect(request).toHaveBeenCalledTimes(3);
  } finally { request.mockRestore(); perpsCache.reset(); }
});
